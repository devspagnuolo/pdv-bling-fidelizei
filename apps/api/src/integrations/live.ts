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
  const response = await blingRequest(`/contatos?pagina=1&limite=1&numeroDocumento=${encodeURIComponent(document)}`);
  if (!response.ok) throw new Error(`Bling não retornou o cliente (HTTP ${response.status})`);
  const raw = records(await response.json())[0];
  if (!raw) return undefined;
  const id = textValue(raw.id);
  const name = textValue(raw.nome ?? raw.fantasia);
  if (!id || !name) return undefined;
  return { id, cpf: document, name, email: textValue(raw.email), phone: textValue(raw.celular ?? raw.telefone) };
};
let finalConsumerCache: { expires: number; id: string } | undefined;
const findFinalConsumerId = async () => {
  if (finalConsumerCache && finalConsumerCache.expires > Date.now()) return finalConsumerCache.id;
  const response = await blingRequest('/contatos?pagina=1&limite=100&pesquisa=Consumidor%20Final');
  if (!response.ok) throw new Error(`Bling não retornou o Consumidor Final (HTTP ${response.status})`);
  const row = records(await response.json()).find(item => /consumidor final/i.test(textValue(item.nome ?? item.fantasia) ?? ''));
  const id = row ? textValue(row.id) : undefined;
  if (!id) throw new Error('Cadastre ou ative o contato Consumidor Final no Bling');
  finalConsumerCache = { expires: Date.now() + 10 * 60_000, id };
  return id;
};
const createOrder = async (input: { customerId?: string; sellerId: string; salesChannelId?: string; businessUnitId?: string; items: SaleItem[]; discount: number; freight: number; observations?: string; payments: PaymentSplit[]; idempotencyKey: string }) => {
  const customerId = input.customerId ?? await findFinalConsumerId();
  const total = input.items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0) - input.discount + input.freight;
  const itemNotes = input.items.filter(item => item.comment?.trim()).map(item => `${item.sku}: ${item.comment?.trim()}`).join(' | ');
  const orderNotes = [input.observations?.trim(), itemNotes ? `Itens: ${itemNotes}` : undefined].filter(Boolean).join('\n');
  const payload = {
    numeroLoja: input.idempotencyKey,
    contato: { id: Number(customerId) },
    vendedor: { id: Number(input.sellerId) },
    loja: input.salesChannelId ? { id: Number(input.salesChannelId) } : undefined,
    unidadeNegocio: input.businessUnitId ? { id: Number(input.businessUnitId) } : undefined,
    itens: input.items.map(item => ({
      produto: { id: Number(item.productId) },
      codigo: item.sku,
      descricao: item.name,
      quantidade: item.quantity,
      valor: item.unitPrice
    })),
    desconto: input.discount ? { valor: input.discount, unidade: 'REAL' } : undefined,
    transporte: input.freight ? { fretePorConta: 0, frete: input.freight } : undefined,
    observacoes: orderNotes || undefined,
    parcelas: input.payments.map(payment => ({
      dataVencimento: saoPauloDate(),
      valor: payment.amount,
      formaPagamento: { id: Number(payment.paymentMethodId) }
    }))
  };
  const response = await blingRequest('/pedidos/vendas', { method: 'POST', body: JSON.stringify(payload), headers: { 'Idempotency-Key': input.idempotencyKey } });
  const body = await response.json() as { data?: { id?: string | number }; error?: unknown; message?: string; retorno?: unknown };
  if (!response.ok || !body.data?.id) {
    const detail = body.message ?? (typeof body.error === 'string' ? body.error : body.retorno ? JSON.stringify(body.retorno) : '');
    throw new Error(`Bling não criou o pedido (HTTP ${response.status})${detail ? `: ${detail.slice(0, 260)}` : ''}`);
  }
  const id = String(body.data.id);
  let number: string | undefined;
  for (let attempt = 0; attempt < 3 && !number; attempt += 1) {
    if (attempt) await delay(350 * attempt);
    const detailResponse = await blingRequest(`/pedidos/vendas/${encodeURIComponent(id)}`);
    if (!detailResponse.ok) continue;
    const detailBody = await detailResponse.json().catch(() => ({})) as { data?: Record<string, unknown> };
    number = textValue(detailBody.data?.numero);
  }
  return { id, number, status: 'CONFIRMED' as const };
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
const fidelizeiFetch = async (path: string, init: RequestInit = {}) => {
  const { url, key } = fidelizeiConfig();
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
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
    coupons: []
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

export const bling = { products: searchProducts, syncProducts, sellers: fetchSellers, paymentMethods: fetchPayments, salesChannels: fetchSalesChannels, financialAccounts: fetchFinancialAccounts, cashEntries: fetchCashEntries, createCashEntry, findCustomer: findBlingCustomer, createOrder, generateNfce, getFiscalCapability };
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
        programConsent: input.programConsent
      })
    });
    if (!response.ok) return fidelizeiError(response, 'cadastro da cliente');
    return mapFidelizeiCustomer(await response.json(), input.cpf.replace(/\D/g, ''));
  },
  validateAndReserve: async (code: string, orderNumber: string, subtotal: number) => {
    const response = await fidelizeiFetch('/redemptions/consume', {
      method: 'POST',
      body: JSON.stringify({ code: code.trim().toUpperCase(), orderNumber })
    });
    if (!response.ok) return fidelizeiError(response, 'consumo do cupom');
    const data = unwrap(await response.json()) as Record<string, unknown>;
    const reward = data.reward as Record<string, unknown>;
    const minimumOrderCents = numericValue(reward.minimumOrderCents);
    if (Math.round(subtotal * 100) < minimumOrderCents) throw new Error('Fidelizei: pedido abaixo do valor mínimo do cupom');
    const discountType = textValue(reward.discountType);
    const discountValue = numericValue(reward.discountValue);
    const discount = discountType === 'percent'
      ? Math.round(subtotal * discountValue) / 100
      : discountValue / 100;
    const coupon: Coupon = {
      id: code.trim().toUpperCase(),
      code: code.trim().toUpperCase(),
      description: textValue(reward.name) ?? 'Cupom Fidelizei',
      discount: Math.min(subtotal, discount)
    };
    return { coupon, reservationId: `consumed:${coupon.code}`, expiresAt: new Date().toISOString() };
  },
  registerSale: async (input: { externalSaleId: string; orderNumber: string; customerCpf?: string; total: number; occurredAt: string }) => {
    const response = await fidelizeiFetch('/sales', {
      method: 'POST',
      body: JSON.stringify({
        externalSaleId: input.externalSaleId,
        orderNumber: input.orderNumber,
        customerCpf: input.customerCpf?.replace(/\D/g, '') || undefined,
        totalCents: Math.round(input.total * 100),
        occurredAt: input.occurredAt
      })
    });
    if (!response.ok) return fidelizeiError(response, 'registro da venda');
    const data = unwrap(await response.json()) as Record<string, unknown>;
    return { transactionId: textValue(data.id ?? data.externalId) ?? input.externalSaleId, idempotent: data.idempotent === true };
  },
  reverseSale: async (externalSaleId: string) => {
    const response = await fidelizeiFetch(`/sales/${encodeURIComponent(externalSaleId)}/reverse`, { method: 'POST' });
    if (!response.ok) return fidelizeiError(response, 'estorno da venda');
    return unwrap(await response.json());
  }
};
