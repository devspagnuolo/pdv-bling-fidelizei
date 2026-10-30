import type { BlingCustomer, Coupon, FidelizeiCustomer, PaymentMethod, PaymentSplit, Product, SaleItem, Seller } from '../domain.js';
import { pool } from '../db.js';
import { getBlingAccessToken } from './credentials.js';

const BLING_API_URL = 'https://api.bling.com.br/Api/v3';
const FETCH_TIMEOUT_MS = 15_000;
const saoPauloDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const textValue = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return textValue(record.descricao ?? record.nome ?? record.id);
  }
  return undefined;
};
const numericValue = (value: unknown, fallback = 0) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const activeValue = (value: unknown) => value === undefined || value === null || value === true || value === 1 || ['A', 'ATIVO', 'ACTIVE', '1', 'TRUE'].includes(String(value).toUpperCase());
const records = (payload: unknown): Record<string, unknown>[] => {
  const body = payload as { data?: unknown };
  return Array.isArray(body?.data) ? body.data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
};
const blingRequest = async (path: string, init: RequestInit = {}) => {
  const token = await getBlingAccessToken();
  if (!token) throw new Error('Bling não conectado');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BLING_API_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'enable-jwt': '1', ...(init.headers ?? {}) },
      signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (response.status !== 429) return response;
    await delay(900 * (attempt + 1));
  }
  throw new Error('Limite temporário de consultas do Bling atingido');
};
const normalizeProduct = (raw: Record<string, unknown>): Product | undefined => {
  const id = textValue(raw.id);
  const name = textValue(raw.nome);
  if (!id || !name) return undefined;
  return {
    id,
    sku: textValue(raw.codigo) ?? id,
    name,
    price: numericValue(raw.preco ?? raw.precoVenda),
    stock: numericValue(raw.estoqueAtual ?? raw.estoque ?? (raw.saldo as Record<string, unknown> | undefined)?.saldoVirtualTotal),
    barcode: textValue(raw.gtin ?? raw.gtinPrincipal)
  };
};

let syncPromise: Promise<number> | undefined;
const syncProducts = () => {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    if (!pool) return 0;
    let total = 0;
    for (let page = 1; page <= 500; page += 1) {
      const response = await blingRequest(`/produtos?pagina=${page}&limite=100`);
      if (!response.ok) throw new Error(`Bling não retornou o catálogo (HTTP ${response.status})`);
      const rows = records(await response.json());
      const products = rows.map(normalizeProduct).filter((item): item is Product => Boolean(item));
      if (products.length) {
        await pool.query(
          `insert into bling_products (id, sku, name, price, stock, barcode, synced_at)
           select id, sku, name, price, stock, barcode, now()
           from jsonb_to_recordset($1::jsonb)
             as item(id text, sku text, name text, price numeric, stock numeric, barcode text)
           on conflict (id) do update set sku=excluded.sku, name=excluded.name, price=excluded.price,
             stock=excluded.stock, barcode=excluded.barcode, synced_at=now()`,
          [JSON.stringify(products.map(product => ({ ...product, barcode: product.barcode ?? null })))]
        );
      }
      total += products.length;
      if (rows.length < 100) break;
      await delay(550);
    }
    return total;
  })().finally(() => { syncPromise = undefined; });
  return syncPromise;
};
const searchProducts = async (query = ''): Promise<Product[]> => {
  const term = query.trim();
  if (!term) return [];
  if (pool) {
    const result = await pool.query(
      `select id, sku, name, price::float8 as price, stock::float8 as stock, barcode
       from bling_products
       where lower(sku)=lower($1) or barcode=$1 or name ilike $2 or sku ilike $2
       order by case when lower(sku)=lower($1) or barcode=$1 then 0 else 1 end, name
       limit 50`,
      [term, `%${term}%`]
    ) as { rows: Product[] };
    if (result.rows.length) return result.rows;
  }

  const url = new URL(`${BLING_API_URL}/produtos`);
  url.searchParams.set('pagina', '1');
  url.searchParams.set('limite', '100');
  if (/^\d{8,14}$/.test(term)) url.searchParams.append('gtins[]', term);
  else url.searchParams.set('pesquisa', term);
  const response = await blingRequest(url.pathname.replace('/Api/v3', '') + url.search);
  if (!response.ok) throw new Error(`Bling não retornou os produtos (HTTP ${response.status})`);
  const result = records(await response.json()).map(normalizeProduct).filter((item): item is Product => Boolean(item));
  void syncProducts().catch(error => console.error('Falha ao atualizar o catálogo após busca direta', error));
  return result;
};

let sellersCache: { expires: number; data: Seller[] } | undefined;
const fetchSellers = async (): Promise<Seller[]> => {
  if (sellersCache && sellersCache.expires > Date.now()) return sellersCache.data;
  const response = await blingRequest('/vendedores?pagina=1&limite=100');
  if (!response.ok) throw new Error(`Bling não retornou os vendedores (HTTP ${response.status})`);
  const data = records(await response.json()).map(row => ({
    id: textValue(row.id) ?? '',
    name: textValue(row.nome ?? (row.contato as Record<string, unknown> | undefined)?.nome) ?? '',
    active: activeValue(row.situacao ?? row.ativo)
  })).filter(item => item.id && item.name && item.active);
  sellersCache = { expires: Date.now() + 5 * 60_000, data };
  return data;
};
let paymentsCache: { expires: number; data: PaymentMethod[] } | undefined;
const fetchPayments = async (): Promise<PaymentMethod[]> => {
  if (paymentsCache && paymentsCache.expires > Date.now()) return paymentsCache.data;
  const response = await blingRequest('/formas-pagamentos?pagina=1&limite=100');
  if (!response.ok) throw new Error(`Bling não retornou as formas de pagamento (HTTP ${response.status})`);
  const data = records(await response.json()).map(row => ({
    id: textValue(row.id) ?? '',
    name: textValue(row.descricao ?? row.nome) ?? '',
    type: textValue(row.tipoPagamento ?? row.tipo ?? row.categoria) ?? 'OTHER',
    active: activeValue(row.situacao ?? row.ativo),
    isDefault: row.padrao === true || row.padrao === 1,
    source: 'BLING' as const
  })).filter(item => item.id && item.name && item.active && !/fornecedor|supplier|compra|contas a pagar/i.test(`${item.name} ${item.type}`));
  paymentsCache = { expires: Date.now() + 5 * 60_000, data };
  return data;
};
let salesChannelsCache: { expires: number; data: { id: string; name: string; businessUnitId?: string; businessUnitName?: string; active: boolean }[] } | undefined;
const fetchSalesChannels = async () => {
  if (salesChannelsCache && salesChannelsCache.expires > Date.now()) return salesChannelsCache.data;
  const response = await blingRequest('/canais-venda?pagina=1&limite=100');
  if (response.status === 401 || response.status === 403) {
    const data: { id: string; name: string; businessUnitId?: string; businessUnitName?: string; active: boolean }[] =
      [{ id: 'DEFAULT', name: 'Configuração padrão do Bling', active: true }];
    salesChannelsCache = { expires: Date.now() + 5 * 60_000, data };
    return data;
  }
  if (!response.ok) throw new Error(`Bling não retornou as lojas/canais de venda (HTTP ${response.status})`);
  const summaries = records(await response.json());
  const data = (await Promise.all(summaries.map(async row => {
    const id = textValue(row.id) ?? '';
    let detail = row;
    if (id) {
      const detailResponse = await blingRequest(`/canais-venda/${encodeURIComponent(id)}`);
      if (detailResponse.ok) {
        const detailBody = await detailResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
        detail = detailBody.data ?? row;
      }
    }
    const unit = detail.unidadeNegocio as Record<string, unknown> | undefined;
    return {
      id,
      name: textValue(detail.descricao ?? detail.nome) ?? '',
      businessUnitId: textValue(unit?.id ?? detail.idUnidadeNegocio),
      businessUnitName: textValue(unit?.nome ?? detail.nomeUnidadeNegocio),
      active: activeValue(detail.situacao ?? detail.ativo)
    };
  }))).filter(item => item.id && item.name && item.active);
  salesChannelsCache = { expires: Date.now() + 5 * 60_000, data };
  return data;
};
const findBlingCustomer = async (cpf: string): Promise<BlingCustomer | undefined> => {
  const document = cpf.replace(/\D/g, '');
  const find = async (query: string) => {
    const response = await blingRequest(`/contatos?pagina=1&limite=100&criterio=1&${query}`);
    if (!response.ok) throw new Error(`Bling não retornou o cliente (HTTP ${response.status})`);
    return records(await response.json()).find(row =>
      (textValue(row.numeroDocumento ?? row.cnpj ?? row.cpf) ?? '').replace(/\D/g, '') === document
    );
  };
  // criterio=1 é indispensável: o padrão do Bling lista somente os últimos incluídos
  // e pode ocultar um CPF antigo, levando a uma tentativa indevida de duplicação.
  const summary = await find(`numeroDocumento=${encodeURIComponent(document)}`)
    ?? await find(`pesquisa=${encodeURIComponent(document)}`);
  if (!summary) return undefined;
  const summaryId = textValue(summary.id);
  let raw = summary;
  if (summaryId) {
    const detailResponse = await blingRequest(`/contatos/${encodeURIComponent(summaryId)}`);
    if (detailResponse.ok) {
      const detailBody = await detailResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
      raw = detailBody.data ?? summary;
    }
  }
  const id = textValue(raw.id);
  const name = textValue(raw.nome ?? raw.fantasia);
  const detailDocument = textValue(raw.numeroDocumento ?? raw.cnpj ?? raw.cpf)?.replace(/\D/g, '');
  if (!id || !name || (detailDocument && detailDocument !== document)) return undefined;
  return { id, cpf: document, name, email: textValue(raw.email), phone: textValue(raw.celular ?? raw.telefone) };
};
type BlingCustomerAddress = { postalCode: string; street: string; number: string; complement?: string; neighborhood: string; city: string; state: string };
const createBlingCustomer = async (input: { name: string; cpf: string; phone?: string; email?: string; address: BlingCustomerAddress }) => {
  const cpf = input.cpf.replace(/\D/g, '');
  const existing = await findBlingCustomer(cpf);
  if (existing) return { ...existing, idempotent: true };
  const payload = {
    nome: input.name.trim(),
    situacao: 'A',
    numeroDocumento: cpf,
    tipo: 'F',
    indicadorIe: 9,
    celular: input.phone?.replace(/\D/g, '') || undefined,
    email: input.email?.trim() || undefined,
    endereco: {
      geral: {
        endereco: input.address.street,
        cep: input.address.postalCode,
        bairro: input.address.neighborhood,
        municipio: input.address.city,
        uf: input.address.state,
        numero: input.address.number,
        complemento: input.address.complement || undefined
      }
    }
  };
  const response = await blingRequest('/contatos', { method: 'POST', body: JSON.stringify(payload) });
  const body = await response.json().catch(() => ({})) as { data?: { id?: string | number }; message?: string; error?: unknown };
  if (!response.ok || !body.data?.id) {
    const detail = body.message ?? (body.error ? JSON.stringify(body.error) : JSON.stringify(body));
    // Uma corrida ou um contato antigo pode fazer o Bling acusar duplicidade mesmo
    // após a consulta. Nesse caso, recuperamos o contato e tratamos como idempotente.
    if (response.status === 400 && /CPF.*(?:já|ja).*cadastrad|documento.*(?:já|ja).*existe/i.test(detail)) {
      const duplicate = await findBlingCustomer(cpf);
      if (duplicate) return { ...duplicate, idempotent: true };
    }
    throw Object.assign(new Error(`Bling não cadastrou o cliente (HTTP ${response.status})${detail ? `: ${detail.slice(0, 700)}` : ''}`), { statusCode: response.status });
  }
  const createdId = String(body.data.id);
  let createdDocument: string | undefined;
  for (let attempt = 0; attempt < 3 && createdDocument !== cpf; attempt += 1) {
    if (attempt) await delay(350 * attempt);
    const createdResponse = await blingRequest(`/contatos/${encodeURIComponent(createdId)}`);
    if (!createdResponse.ok) continue;
    const createdBody = await createdResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
    createdDocument = textValue(createdBody.data?.numeroDocumento ?? createdBody.data?.cnpj ?? createdBody.data?.cpf)?.replace(/\D/g, '');
  }
  if (createdDocument !== cpf) throw new Error(`Bling cadastrou o contato ${createdId}, mas não confirmou o CPF solicitado; nenhuma venda deve ser vinculada a este contato`);
  console.info(JSON.stringify({ event: 'bling.customer.created', contactId: createdId }));
  return { id: createdId, cpf, name: payload.nome, phone: input.phone, email: input.email, idempotent: false };
};
// Todas as vendas sem identificação compartilham este único contato no Bling. Se alguém
// editar o Consumidor Final (por exemplo, para "cadastrar" um cliente novo), todos os
// pedidos vinculados a ele passam a exibir esses dados. Por isso o ID pode ser fixado em
// BLING_FINAL_CONSUMER_CONTACT_ID e o contato é sempre conferido antes de ser usado.
const findFinalConsumerId = async () => {
  const pinned = process.env.BLING_FINAL_CONSUMER_CONTACT_ID?.trim();
  let id = pinned || undefined;
  if (!id) {
    const response = await blingRequest('/contatos?pagina=1&limite=100&criterio=1&pesquisa=Consumidor%20Final');
    if (!response.ok) throw new Error(`Bling não retornou o Consumidor Final (HTTP ${response.status})`);
    const row = records(await response.json()).find(item =>
      (textValue(item.nome) ?? '').trim().toLocaleLowerCase('pt-BR') === 'consumidor final' &&
      !textValue(item.numeroDocumento ?? item.cnpj ?? item.cpf)?.replace(/\D/g, '')
    );
    id = row ? textValue(row.id) : undefined;
  }
  if (!id) throw new Error('Contato Consumidor Final sem CPF não encontrado no Bling; confira o cadastro antes de criar uma venda sem cliente');
  const detailResponse = await blingRequest(`/contatos/${encodeURIComponent(id)}`);
  if (!detailResponse.ok) throw new Error(`Não foi possível confirmar o contato Consumidor Final no Bling (HTTP ${detailResponse.status})`);
  const detailBody = await detailResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
  const detail = detailBody.data;
  if (!detail || (textValue(detail.nome) ?? '').trim().toLocaleLowerCase('pt-BR') !== 'consumidor final' ||
      textValue(detail.numeroDocumento ?? detail.cnpj ?? detail.cpf)?.replace(/\D/g, '')) {
    throw new Error('O contato Consumidor Final do Bling foi alterado; venda sem cliente bloqueada para evitar associação incorreta');
  }
  return id;
};
type SalesOrderInput = { customerId?: string; sellerId: string; salesChannelId?: string; businessUnitId?: string; categoryId?: string; items: SaleItem[]; discount: number; freight: number; observations?: string; payments: PaymentSplit[]; idempotencyKey: string; statusId?: string; clearDiscount?: boolean };
const buildOrderPayload = async (input: SalesOrderInput) => {
  const customerId = input.customerId ?? await findFinalConsumerId();
  const orderDate = saoPauloDate();
  const itemNotes = input.items.filter(item => item.comment?.trim()).map(item => `${item.sku}: ${item.comment?.trim()}`).join(' | ');
  const orderNotes = [input.observations?.trim(), itemNotes ? `Itens: ${itemNotes}` : undefined].filter(Boolean).join('\n');
  return {
    data: orderDate,
    dataSaida: orderDate,
    dataPrevista: orderDate,
    numeroLoja: input.idempotencyKey,
    contato: { id: Number(customerId) },
    vendedor: { id: Number(input.sellerId) },
    categoria: input.categoryId ? { id: Number(input.categoryId) } : undefined,
    loja: input.salesChannelId ? { id: Number(input.salesChannelId) } : undefined,
    unidadeNegocio: input.businessUnitId ? { id: Number(input.businessUnitId) } : undefined,
    situacao: input.statusId ? { id: Number(input.statusId) } : undefined,
    itens: input.items.map(item => ({
      produto: { id: Number(item.productId) },
      codigo: item.sku,
      descricao: item.name,
      quantidade: item.quantity,
      valor: item.unitPrice
    })),
    desconto: input.discount > 0 || input.clearDiscount
      ? { valor: Math.round(input.discount * 100) / 100, unidade: 'REAL' }
      : undefined,
    transporte: input.freight ? { fretePorConta: 0, frete: input.freight } : undefined,
    observacoes: orderNotes || undefined,
    parcelas: input.payments.map(payment => ({
      dataVencimento: orderDate,
      valor: payment.amount,
      formaPagamento: { id: Number(payment.paymentMethodId) }
    }))
  };
};
const readOrderDetails = async (id: string, isReady?: (details: Record<string, unknown>) => boolean) => {
  let details: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 3 && (!details || (isReady && !isReady(details))); attempt += 1) {
    if (attempt) await delay(350 * attempt);
    const detailResponse = await blingRequest(`/pedidos/vendas/${encodeURIComponent(id)}`);
    if (!detailResponse.ok) continue;
    const detailBody = await detailResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
    if (detailBody.data) details = detailBody.data;
  }
  return details;
};
const readOrderNumber = async (id: string) => textValue((await readOrderDetails(id, details => Boolean(textValue(details.numero))))?.numero);
const getOrderContact = async (orderId: string) => {
  const order = await readOrderDetails(orderId);
  if (!order) throw new Error(`Bling não retornou o pedido ${orderId} para conferência`);
  const linked = order.contato as Record<string, unknown> | undefined;
  const id = textValue(linked?.id);
  if (!id) throw new Error(`Bling não informou o contato do pedido ${orderId}`);
  const response = await blingRequest(`/contatos/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Bling não retornou o contato ${id} (HTTP ${response.status})`);
  const body = await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  const detail = body.data;
  if (!detail) throw new Error(`Bling retornou o contato ${id} sem dados`);
  return {
    id,
    name: textValue(detail.nome ?? linked?.nome) ?? 'Nome não informado',
    cpf: textValue(detail.numeroDocumento ?? detail.cnpj ?? detail.cpf)?.replace(/\D/g, '') || undefined
  };
};
const verifyOrderDiscount = (details: Record<string, unknown> | undefined, input: SalesOrderInput) => {
  if (input.discount <= 0 && !input.clearDiscount) return;
  if (!details) throw new Error('Bling aceitou a atualização, mas não foi possível confirmar o desconto salvo no pedido');
  const discount = details.desconto as Record<string, unknown> | undefined;
  const actualDiscount = numericValue(discount?.valor);
  const expectedDiscount = Math.round(input.discount * 100) / 100;
  if (Math.abs(actualDiscount - expectedDiscount) > 0.009) {
    throw new Error(`Bling não confirmou o desconto do pedido: esperado R$ ${expectedDiscount.toFixed(2)}, recebido R$ ${actualDiscount.toFixed(2)}`);
  }
  const actualTotal = numericValue(details.total, Number.NaN);
  if (Number.isFinite(actualTotal)) {
    const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const expectedTotal = Math.round(Math.max(0, subtotal - expectedDiscount + input.freight) * 100) / 100;
    if (Math.abs(actualTotal - expectedTotal) > 0.009) {
      throw new Error(`Bling salvou o desconto de R$ ${expectedDiscount.toFixed(2)}, mas o total do pedido diverge: esperado R$ ${expectedTotal.toFixed(2)}, recebido R$ ${actualTotal.toFixed(2)}`);
    }
  }
};
const createOrder = async (input: SalesOrderInput) => {
  const payload = await buildOrderPayload(input);
  const response = await blingRequest('/pedidos/vendas', { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': input.idempotencyKey } });
  const body = await response.json() as { data?: { id?: string | number }; error?: unknown; message?: string; retorno?: unknown };
  if (!response.ok || !body.data?.id) {
    const detail = body.message ??
      (body.error ? (typeof body.error === 'string' ? body.error : JSON.stringify(body.error)) :
        body.retorno ? JSON.stringify(body.retorno) : JSON.stringify(body));
    throw new Error(`Bling não criou o pedido (HTTP ${response.status})${detail ? `: ${detail.slice(0, 900)}` : ''}`);
  }
  const id = String(body.data.id);
  const number = await readOrderNumber(id);
  console.info(JSON.stringify({ event: 'bling.order.created', orderId: id, orderNumber: number, contactId: payload.contato.id, saleId: input.idempotencyKey }));
  return { id, number, status: 'CONFIRMED' as const };
};
const updateOrder = async (orderId: string, input: SalesOrderInput) => {
  const payload = await buildOrderPayload(input);
  const response = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}`, { method: 'PUT', body: JSON.stringify(payload) });
  if (!response.ok && response.status !== 204) return blingFailure(response, 'atualização do pedido em atendimento');
  const expectedDiscount = Math.round(input.discount * 100) / 100;
  const subtotal = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const expectedTotal = Math.round(Math.max(0, subtotal - expectedDiscount + input.freight) * 100) / 100;
  const details = await readOrderDetails(orderId, detail => {
    if (input.discount <= 0 && !input.clearDiscount) return true;
    const discount = detail.desconto as Record<string, unknown> | undefined;
    const actualDiscount = numericValue(discount?.valor);
    const actualTotal = numericValue(detail.total, Number.NaN);
    return Math.abs(actualDiscount - expectedDiscount) <= 0.009 &&
      (!Number.isFinite(actualTotal) || Math.abs(actualTotal - expectedTotal) <= 0.009);
  });
  verifyOrderDiscount(details, input);
  console.info(JSON.stringify({ event: 'bling.order.updated', orderId, orderNumber: textValue(details?.numero), contactId: payload.contato.id, saleId: input.idempotencyKey }));
  return { id: orderId, number: textValue(details?.numero), status: 'CONFIRMED' as const };
};

let categoriesCache: { expires: number; data: { id: string; name: string; type: number; active: boolean; isDefault: boolean }[] } | undefined;
const fetchFinancialCategories = async () => {
  if (categoriesCache && categoriesCache.expires > Date.now()) return categoriesCache.data;
  const response = await blingRequest('/categorias/receitas-despesas?pagina=1&limite=100&tipo=2&situacao=1');
  if (!response.ok) return blingFailure(response, 'consulta de categorias financeiras');
  const rows = records(await response.json());
  const data = rows.map(row => {
    const name = textValue(row.descricao ?? row.nome) ?? '';
    return {
      id: textValue(row.id) ?? '',
      name,
      type: numericValue(row.tipo),
      active: activeValue(row.situacao),
      isDefault: /vendas? de mercadorias/i.test(name)
    };
  }).filter(item => item.id && item.name && item.active);
  categoriesCache = { expires: Date.now() + 5 * 60_000, data };
  return data;
};

let attendedStatusCache: { expires: number; id: string } | undefined;
let cancelledStatusCache: { expires: number; id: string } | undefined;
let inServiceStatusCache: { expires: number; id: string } | undefined;
const findInServiceStatusId = async () => {
  const configured = process.env.BLING_IN_SERVICE_STATUS_ID?.trim();
  if (configured) return configured;
  if (inServiceStatusCache && inServiceStatusCache.expires > Date.now()) return inServiceStatusCache.id;
  const modulesResponse = await blingRequest('/situacoes/modulos');
  if (!modulesResponse.ok) return blingFailure(modulesResponse, 'consulta dos módulos de situação');
  const module = records(await modulesResponse.json()).find(row => /pedid.*venda|venda/i.test(`${textValue(row.nome) ?? ''} ${textValue(row.descricao) ?? ''}`));
  const moduleId = module ? textValue(module.id) : undefined;
  if (!moduleId) throw new Error('Bling não retornou o módulo de pedidos de venda');
  const situationsResponse = await blingRequest(`/situacoes/modulos/${encodeURIComponent(moduleId)}`);
  if (!situationsResponse.ok) return blingFailure(situationsResponse, 'consulta das situações de pedido');
  const situations = records(await situationsResponse.json());
  const situation = situations.find(row => /^(em atendimento|em andamento)$/i.test((textValue(row.nome) ?? '').trim()))
    ?? situations.find(row => /atendimento|andamento|em aberto/i.test((textValue(row.nome) ?? '').trim()));
  const id = situation ? textValue(situation.id) : undefined;
  if (!id) throw new Error('Crie ou disponibilize a situação Em atendimento para pedidos de venda no Bling');
  inServiceStatusCache = { expires: Date.now() + 10 * 60_000, id };
  return id;
};
const findAttendedStatusId = async () => {
  const configured = process.env.BLING_ATTENDED_STATUS_ID?.trim();
  if (configured) return configured;
  if (attendedStatusCache && attendedStatusCache.expires > Date.now()) return attendedStatusCache.id;
  const modulesResponse = await blingRequest('/situacoes/modulos');
  if (!modulesResponse.ok) return blingFailure(modulesResponse, 'consulta dos módulos de situação');
  const module = records(await modulesResponse.json()).find(row => /pedid.*venda|venda/i.test(`${textValue(row.nome) ?? ''} ${textValue(row.descricao) ?? ''}`));
  const moduleId = module ? textValue(module.id) : undefined;
  if (!moduleId) throw new Error('Bling não retornou o módulo de pedidos de venda');
  const situationsResponse = await blingRequest(`/situacoes/modulos/${encodeURIComponent(moduleId)}`);
  if (!situationsResponse.ok) return blingFailure(situationsResponse, 'consulta das situações de pedido');
  const attended = records(await situationsResponse.json()).find(row => /^atendid[oa]$/i.test((textValue(row.nome) ?? '').trim()));
  const id = attended ? textValue(attended.id) : undefined;
  if (!id) throw new Error('Crie ou disponibilize a situação Atendido para pedidos de venda no Bling');
  attendedStatusCache = { expires: Date.now() + 10 * 60_000, id };
  return id;
};
const findCancelledStatusId = async () => {
  const configured = process.env.BLING_CANCELLED_STATUS_ID?.trim();
  if (configured) return configured;
  if (cancelledStatusCache && cancelledStatusCache.expires > Date.now()) return cancelledStatusCache.id;
  const modulesResponse = await blingRequest('/situacoes/modulos');
  if (!modulesResponse.ok) return blingFailure(modulesResponse, 'consulta dos módulos de situação');
  const module = records(await modulesResponse.json()).find(row => /pedid.*venda|venda/i.test(`${textValue(row.nome) ?? ''} ${textValue(row.descricao) ?? ''}`));
  const moduleId = module ? textValue(module.id) : undefined;
  if (!moduleId) throw new Error('Bling não retornou o módulo de pedidos de venda');
  const situationsResponse = await blingRequest(`/situacoes/modulos/${encodeURIComponent(moduleId)}`);
  if (!situationsResponse.ok) return blingFailure(situationsResponse, 'consulta das situações de pedido');
  const cancelled = records(await situationsResponse.json()).find(row => /^cancelad[oa]$/i.test((textValue(row.nome) ?? '').trim()));
  const id = cancelled ? textValue(cancelled.id) : undefined;
  if (!id) throw new Error('Crie ou disponibilize a situação Cancelado para pedidos de venda no Bling');
  cancelledStatusCache = { expires: Date.now() + 10 * 60_000, id };
  return id;
};

const acceptOrderAction = async (response: Response, operation: string) => {
  if (response.ok || response.status === 204) return;
  const detail = await response.text();
  if (response.status === 409 && /já|ja|lançad|lancad|atendid/i.test(detail)) return;
  throw new Error(`Bling: ${operation} falhou (HTTP ${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`);
};
const rejectOrderReversal = async (response: Response, operation: string): Promise<never> => {
  const detail = await response.text();
  if (response.status === 403 && /insufficient_scope|higher privileges|escopo|permiss/i.test(detail)) {
    throw Object.assign(new Error(
      `O Bling não autorizou ${operation}. Libere no aplicativo Bling as permissões de escrita para Pedidos de venda, Estoque e Contas a receber e reconecte a integração. O pedido permaneceu ativo para proteger o financeiro e o estoque.`
    ), { statusCode: 403, code: 'BLING_INSUFFICIENT_SCOPE' });
  }
  throw Object.assign(new Error(
    `Bling: ${operation} falhou (HTTP ${response.status})${detail ? `: ${detail.slice(0, 500)}` : ''}`
  ), { statusCode: response.status >= 400 && response.status < 500 ? response.status : 502 });
};
const finalizeOrder = async (orderId: string) => {
  await acceptOrderAction(await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/lancar-estoque`, { method: 'POST' }), 'lançamento de estoque');
  await acceptOrderAction(await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/lancar-contas`, { method: 'POST' }), 'lançamento de contas');
  const statusId = await findAttendedStatusId();
  await acceptOrderAction(await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/situacoes/${encodeURIComponent(statusId)}`, { method: 'PATCH' }), 'alteração do pedido para Atendido');
  return { stockPosted: true, accountsPosted: true, attended: true, statusId };
};
const deleteOrder = async (orderId: string) => {
  const warnings: string[] = [];
  for (const action of ['estornar-contas', 'estornar-estoque']) {
    const actionResponse = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/${action}`, { method: 'POST' });
    if (!actionResponse.ok && ![204, 404, 409].includes(actionResponse.status)) {
      await rejectOrderReversal(actionResponse, action === 'estornar-contas' ? 'o estorno das contas a receber' : 'o estorno do estoque');
    }
  }
  const response = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204 && response.status !== 404) return blingFailure(response, 'exclusão do pedido');
  return { deleted: true, warnings };
};
const deleteDraftOrder = async (orderId: string) => {
  const response = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204 && response.status !== 404) return blingFailure(response, 'exclusão do pedido em atendimento');
  return { deleted: true, warnings: [] as string[] };
};
const cancelOrder = async (orderId: string) => {
  const warnings: string[] = [];
  for (const action of ['estornar-contas', 'estornar-estoque']) {
    const response = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/${action}`, { method: 'POST' });
    if (!response.ok && ![204, 404, 409].includes(response.status)) {
      await rejectOrderReversal(response, action === 'estornar-contas' ? 'o estorno das contas a receber' : 'o estorno do estoque');
    }
  }
  const statusId = await findCancelledStatusId();
  await acceptOrderAction(await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/situacoes/${encodeURIComponent(statusId)}`, { method: 'PATCH' }), 'alteração do pedido para Cancelado');
  return { cancelled: true, statusId, warnings };
};
const cancelDraftOrder = async (orderId: string) => {
  const statusId = await findCancelledStatusId();
  await acceptOrderAction(await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/situacoes/${encodeURIComponent(statusId)}`, { method: 'PATCH' }), 'alteração do pedido para Cancelado');
  return { cancelled: true, statusId, warnings: [] as string[] };
};
const generateNfce = async (orderId: string) => {
  const response = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}/gerar-nfce`, { method: 'POST' });
  if (!response.ok && response.status !== 204) throw new Error(`Bling não gerou a NFC-e (HTTP ${response.status})`);
  const body = response.status === 204 ? {} : await response.json().catch(() => ({})) as { data?: Record<string, unknown> };
  let fiscalId = textValue(body.data?.id);
  let documentUrl = textValue(body.data?.linkPDF ?? body.data?.linkDanfe ?? body.data?.url);
  for (let attempt = 0; attempt < 4 && !documentUrl; attempt += 1) {
    await delay(650 * (attempt + 1));
    if (!fiscalId) {
      const orderResponse = await blingRequest(`/pedidos/vendas/${encodeURIComponent(orderId)}`);
      if (orderResponse.ok) {
        const orderBody = await orderResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
        const fiscal = orderBody.data?.notaFiscal as Record<string, unknown> | undefined;
        const consumerFiscal = orderBody.data?.notaFiscalConsumidor as Record<string, unknown> | undefined;
        fiscalId = textValue(consumerFiscal?.id ?? fiscal?.id ?? orderBody.data?.idNotaFiscal);
      }
    }
    if (!fiscalId) continue;
    const fiscalResponse = await blingRequest(`/nfce/${encodeURIComponent(fiscalId)}`);
    if (!fiscalResponse.ok) continue;
    const fiscalBody = await fiscalResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
    documentUrl = textValue(fiscalBody.data?.linkPDF ?? fiscalBody.data?.linkDanfe);
  }
  return { status: 'REQUESTED' as const, fiscalId, documentUrl };
};
const blingFailure = async (response: Response, operation: string): Promise<never> => {
  const detail = await response.text();
  const reconnect = response.status === 401 || response.status === 403
    ? ' Reconecte o aplicativo autorizando Contas Financeiras e Caixas e Bancos.'
    : '';
  throw new Error(`Bling: ${operation} falhou (HTTP ${response.status}).${reconnect}${detail ? ` ${detail.slice(0, 240)}` : ''}`);
};

let accountsCache: { expires: number; data: { id: string; name: string; type: string; active: boolean }[] } | undefined;
const fetchFinancialAccounts = async () => {
  if (accountsCache && accountsCache.expires > Date.now()) return accountsCache.data;
  const response = await blingRequest('/contas-contabeis?pagina=1&limite=100&ordenacao=descricao');
  if (!response.ok) return blingFailure(response, 'consulta de contas financeiras');
  const data = records(await response.json()).map(row => ({
    id: textValue(row.id) ?? '',
    name: textValue(row.descricao ?? row.nome) ?? '',
    type: textValue(row.tipo ?? row.tipoConta) ?? 'Conta financeira',
    active: activeValue(row.situacao ?? row.ativo)
  })).filter(item => item.id && item.name && item.active);
  accountsCache = { expires: Date.now() + 5 * 60_000, data };
  return data;
};

const fetchCashEntries = async (date: string, accountId?: string) => {
  const all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const search = new URLSearchParams({ pagina: String(page), limite: '100', dataInicial: date, dataFinal: date });
    if (accountId) search.set('idContaFinanceira', accountId);
    const response = await blingRequest(`/caixas?${search.toString()}`);
    if (!response.ok) return blingFailure(response, 'consulta do movimento de caixa');
    const rows = records(await response.json());
    all.push(...rows);
    if (rows.length < 100) break;
    await delay(360);
  }
  return all.map(row => ({
    id: textValue(row.id) ?? '',
    direction: textValue(row.debCred) ?? '',
    status: textValue(row.situacao) ?? '',
    amount: numericValue(row.valor),
    date: textValue(row.data) ?? date,
    description: textValue(row.descricao ?? row.observacoes ?? row.origem) ?? 'Lançamento Bling',
    accountId: textValue((row.contaFinanceira as Record<string, unknown> | undefined)?.id),
    accountName: textValue((row.contaFinanceira as Record<string, unknown> | undefined)?.descricao)
  }));
};

const createCashEntry = async (input: { type: 'WITHDRAWAL' | 'SUPPLY' | 'OPENING'; amount: number; accountId: string; notes: string; date: string }) => {
  const payload = {
    data: input.date,
    valor: input.amount,
    debCred: input.type === 'WITHDRAWAL' ? 'D' : 'C',
    competencia: input.date,
    observacoes: input.notes,
    contaFinanceira: { id: Number(input.accountId) }
  };
  const response = await blingRequest('/caixas', { method: 'POST', body: JSON.stringify(payload) });
  if (!response.ok) return blingFailure(response, input.type === 'WITHDRAWAL' ? 'sangria' : input.type === 'SUPPLY' ? 'suprimento' : 'abertura de caixa');
  const body = await response.json().catch(() => ({})) as { data?: { id?: string | number } };
  return { id: body.data?.id ? String(body.data.id) : undefined, payload };
};

const getFiscalCapability = async () => {
  try {
    const response = await blingRequest('/nfce?pagina=1&limite=1');
    return { configured: response.ok, available: response.ok, source: 'BLING' as const, statusCode: response.status };
  } catch (error) {
    return { configured: false, available: false, source: 'BLING' as const, error: error instanceof Error ? error.message : 'Falha de conexão' };
  }
};

const fidelizeiConfig = () => {
  const configuredUrl = (process.env.FIDELIZEI_API_URL ?? 'https://api.fidelizaplus.com.br/public/v1').replace(/\/$/, '');
  const url = configuredUrl.endsWith('/public/v1') ? configuredUrl : `${configuredUrl}/public/v1`;
  const key = process.env.FIDELIZEI_API_KEY;
  if (!key) throw new Error('FIDELIZEI_API_KEY não configurada');
  return { url, key };
};
const fidelizeiFetch = async (path: string, init: RequestInit = {}, retry = true) => {
  const { url, key } = fidelizeiConfig();
  let response: Response | undefined;
  for (let attempt = 0; attempt < (retry ? 4 : 1); attempt += 1) {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      },
      signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (response.status !== 429 && response.status < 500) return response;
    await delay(700 * 2 ** attempt);
  }
  return response as Response;
};
const fidelizeiError = async (response: Response, operation: string): Promise<never> => {
  const detail = await response.text();
  if (response.status === 409 && operation === 'consumo do cupom' && /c[oó]digo.*j[aá].*utilizad/i.test(detail)) {
    throw new Error(`Fidelizei: o cupom informado já consta como utilizado; nenhum desconto foi aplicado a este pedido. Confira o histórico do cupom no Fidelizei antes de tentar novamente${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  const guidance: Record<number, string> = {
    400: 'dados inválidos',
    401: 'chave inválida, vencida ou revogada',
    403: operation === 'consumo do cupom'
      ? 'a chave do PDV não possui o escopo rewards:validate (recrie ou autorize a chave no Fidelizei e atualize FIDELIZEI_API_KEY)'
      : 'escopo ou plano não liberado',
    404: 'registro não pertence à loja ou não existe',
    409: 'conflito ou operação já utilizada',
    429: 'limite temporário de requisições atingido'
  };
  throw new Error(`Fidelizei: ${operation} falhou — ${guidance[response.status] ?? `HTTP ${response.status}`}${detail ? `: ${detail.slice(0, 180)}` : ''}`);
};
const unwrap = (payload: unknown) => (payload as { data?: unknown })?.data ?? payload;
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const parseCouponDiscount = (data: Record<string, unknown>, subtotal: number) => {
  const reward = asRecord(data.reward);
  const customer = asRecord(data.customer);
  const type = reward?.discountType;
  const value = reward?.discountValue;
  const minimumOrderCents = reward?.minimumOrderCents ?? 0;
  if ((type !== 'percent' && type !== 'fixed') || !Number.isInteger(value) || Number(value) <= 0 ||
      !Number.isInteger(minimumOrderCents) || Number(minimumOrderCents) < 0 ||
      (type === 'percent' && Number(value) > 100)) {
    throw new Error('Fidelizei: a recompensa não possui uma regra de desconto válida');
  }
  if (Math.round(subtotal * 100) < Number(minimumOrderCents)) {
    throw new Error(`Fidelizei: pedido abaixo do mínimo de R$ ${(Number(minimumOrderCents) / 100).toFixed(2)} exigido pelo cupom`);
  }
  const amount = type === 'percent' ? subtotal * Number(value) / 100 : Number(value) / 100;
  const discount = Math.round(Math.min(subtotal, amount) * 100) / 100;
  if (discount <= 0) throw new Error('Fidelizei: o cupom não possui desconto aplicável a este pedido');
  const customerCpf = textValue(customer?.cpf)?.replace(/\D/g, '');
  if (!customerCpf) throw new Error('Fidelizei: não foi possível confirmar a cliente dona do cupom');
  const expectedReward = { discountType: type as 'percent' | 'fixed', discountValue: Number(value), minimumOrderCents: Number(minimumOrderCents) };
  const coupon: Coupon = {
    id: textValue(data.id) ?? '',
    code: '',
    description: textValue(reward?.name) ?? 'Cupom Fidelizei',
    discount
  };
  return { coupon, customerCpf, expectedReward, status: textValue(data.status) };
};
const mapFidelizeiCustomer = (payload: unknown, cpf: string): FidelizeiCustomer | undefined => {
  const raw = unwrap(payload) as Record<string, unknown> | undefined;
  if (!raw || Array.isArray(raw)) return undefined;
  const id = textValue(raw.id);
  const name = textValue(raw.name);
  if (!id || !name) return undefined;
  const eligible = raw.eligibleForPoints === true;
  return {
    id,
    cpf,
    name,
    tier: eligible ? 'Participante' : 'Adesão pendente',
    points: numericValue(raw.pointsBalance),
    benefits: eligible ? ['Elegível para pontuação'] : [],
    coupons: [],
    welcomeEmailSent: raw.welcomeEmailSent === true || raw.emailSent === true,
    temporaryPasswordSent: raw.temporaryPasswordSent === true || raw.passwordEmailSent === true,
    onboardingMessage: textValue(raw.onboardingMessage ?? raw.message)
  };
};

export const getFidelizeiConnectionStatus = async () => {
  const configured = Boolean(process.env.FIDELIZEI_API_KEY);
  if (!configured) return { configured: false, connected: false, mode: 'api-key' as const };
  try {
    const response = await fidelizeiFetch('/customers/lookup?cpf=00000000000');
    return {
      configured: true,
      connected: response.status === 200 || response.status === 400 || response.status === 404,
      mode: 'api-key' as const,
      statusCode: response.status
    };
  } catch (error) {
    return { configured: true, connected: false, mode: 'api-key' as const, error: error instanceof Error ? error.message : 'Falha de conexão' };
  }
};

export const bling = { products: searchProducts, syncProducts, sellers: fetchSellers, paymentMethods: fetchPayments, financialCategories: fetchFinancialCategories, salesChannels: fetchSalesChannels, financialAccounts: fetchFinancialAccounts, cashEntries: fetchCashEntries, createCashEntry, findCustomer: findBlingCustomer, createCustomer: createBlingCustomer, createOrder, updateOrder, getOrderContact, findInServiceStatusId, finalizeOrder, cancelOrder, cancelDraftOrder, deleteOrder, deleteDraftOrder, generateNfce, getFiscalCapability };
export const fidelizei = {
  findCustomer: async (cpf: string) => {
    const normalized = cpf.replace(/\D/g, '');
    const response = await fidelizeiFetch(`/customers/lookup?cpf=${encodeURIComponent(normalized)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) return fidelizeiError(response, 'consulta de cliente');
    return mapFidelizeiCustomer(await response.json(), normalized);
  },
  upsertCustomer: async (input: { name: string; cpf: string; phone?: string; email?: string; programConsent: boolean }) => {
    const response = await fidelizeiFetch('/customers/upsert', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        cpf: input.cpf.replace(/\D/g, ''),
        phone: input.phone?.replace(/\D/g, ''),
        email: input.email,
        programConsent: input.programConsent,
        sendWelcomeEmail: Boolean(input.email),
        sendTemporaryPassword: Boolean(input.email)
      })
    });
    if (!response.ok) return fidelizeiError(response, 'cadastro da cliente');
    return mapFidelizeiCustomer(await response.json(), input.cpf.replace(/\D/g, ''));
  },
  previewCoupon: async (code: string, orderNumber: string, subtotal: number, customerCpf: string) => {
    const normalizedCode = code.trim().toUpperCase();
    const response = await fidelizeiFetch('/redemptions/preview', {
      method: 'POST',
      body: JSON.stringify({ code: normalizedCode, orderNumber, customerCpf, subtotalCents: Math.round(subtotal * 100) })
    });
    if (!response.ok) return fidelizeiError(response, 'consulta do cupom');
    const data = unwrap(await response.json()) as Record<string, unknown>;
    const preview = parseCouponDiscount(data, subtotal);
    if (preview.customerCpf !== customerCpf) throw new Error('Fidelizei: este cupom pertence a outra cliente');
    preview.coupon.id ||= normalizedCode;
    preview.coupon.code = normalizedCode;
    return preview;
  },
  consumeCoupon: async (code: string, orderNumber: string, subtotal: number, customerCpf: string, expectedReward: { discountType: 'percent' | 'fixed'; discountValue: number; minimumOrderCents: number }) => {
    const normalizedCode = code.trim().toUpperCase();
    const response = await fidelizeiFetch('/redemptions/consume', {
      method: 'POST',
      body: JSON.stringify({ code: normalizedCode, orderNumber, customerCpf, subtotalCents: Math.round(subtotal * 100), expectedReward })
    }, false);
    if (!response.ok) return fidelizeiError(response, 'consumo do cupom');
    const data = unwrap(await response.json()) as Record<string, unknown>;
    const redemption = parseCouponDiscount(data, subtotal);
    if (redemption.customerCpf !== customerCpf) throw new Error('Fidelizei: este cupom pertence a outra cliente');
    redemption.coupon.id ||= normalizedCode;
    redemption.coupon.code = normalizedCode;
    return redemption;
  },
  reverseSale: async (externalSaleId: string) => {
    const response = await fidelizeiFetch(`/sales/${encodeURIComponent(externalSaleId)}/reverse`, { method: 'POST' });
    // 404: o Fidelizei não tem pontos nem cupom registrados para esta venda.
    if (response.status === 404) return { reversed: false, reason: 'NOT_FOUND' };
    if (!response.ok) return fidelizeiError(response, 'estorno da venda');
    return unwrap(await response.json());
  }
};


