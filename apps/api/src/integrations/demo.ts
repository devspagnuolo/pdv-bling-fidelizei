import type {
  BlingCustomer,
  FidelizeiCustomer,
  PaymentMethod,
  Product,
  SaleItem,
  Seller
} from '../domain.js';
import { getBlingAccessToken } from './credentials.js';

const products: Product[] = [
  { id: 'bling-prod-1', sku: 'VEST-001', name: 'Vestido Midi', price: 199.9, stock: 8 },
  { id: 'bling-prod-2', sku: 'CALC-002', name: 'Calça Alfaiataria', price: 149.9, stock: 12 },
  { id: 'bling-prod-3', sku: 'BOLS-003', name: 'Bolsa Couro', price: 279.9, stock: 3 }
];
const sellers: Seller[] = [
  { id: 'bling-seller-1', name: 'Juliana Souza', active: true },
  { id: 'bling-seller-2', name: 'Marcos Lima', active: true }
];
const demoPaymentMethods: PaymentMethod[] = [
  { id: 'demo-pix', name: 'Pix', type: 'PIX', active: true, isDefault: true, source: 'DEMO' },
  { id: 'demo-credit', name: 'Cartão de crédito', type: 'CREDIT_CARD', active: true, source: 'DEMO' },
  { id: 'demo-debit', name: 'Cartão de débito', type: 'DEBIT_CARD', active: true, source: 'DEMO' },
  { id: 'demo-cash', name: 'Dinheiro', type: 'CASH', active: true, source: 'DEMO' }
];
const demoBlingCustomers: BlingCustomer[] = [
  {
    id: 'bling-customer-1',
    cpf: '12345678909',
    name: 'Maria da Silva',
    email: 'maria@exemplo.com',
    phone: '11999990000'
  },
  {
    id: 'bling-customer-2',
    cpf: '52998224725',
    name: 'Carlos Almeida',
    email: 'carlos@exemplo.com',
    phone: '11988880000'
  }
];
const fidelizeiCustomer: FidelizeiCustomer = {
  id: 'fid-customer-1',
  cpf: '12345678909',
  name: 'Maria da Silva',
  tier: 'Ouro',
  points: 1240,
  benefits: ['Frete grátis', '5% em acessórios'],
  coupons: [{ id: 'fid-coupon-1', code: 'OURO50', description: 'R$ 50 de desconto', discount: 50 }]
};

const BLING_API_URL = 'https://api.bling.com.br/Api/v3';
const PAYMENT_METHOD_CACHE_MS = 5 * 60_000;
let paymentMethodCache: { expiresAt: number; data: PaymentMethod[] } | undefined;
let productCache = new Map<string, { expiresAt: number; data: Product[] }>();

const valueAsText = (value: unknown) => {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return valueAsText(record.descricao ?? record.nome ?? record.id);
  }
  return undefined;
};
const isActive = (value: unknown) => {
  if (value === undefined || value === null) return true;
  if (value === true || value === 1) return true;
  return ['A', 'ATIVO', 'ACTIVE', '1', 'TRUE'].includes(String(value).toUpperCase());
};
const normalizePaymentMethod = (raw: Record<string, unknown>): PaymentMethod | undefined => {
  const id = valueAsText(raw.id);
  const name = valueAsText(raw.descricao ?? raw.nome);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    type: valueAsText(raw.tipoPagamento ?? raw.tipo ?? raw.categoria) ?? 'OTHER',
    active: isActive(raw.situacao ?? raw.ativo),
    isDefault: raw.padrao === true || raw.padrao === 1,
    source: 'BLING'
  };
};
const fetchPaymentMethods = async (): Promise<PaymentMethod[]> => {
  const accessToken = await getBlingAccessToken();
  if (!accessToken) return demoPaymentMethods;
  if (paymentMethodCache && paymentMethodCache.expiresAt > Date.now()) return paymentMethodCache.data;

  const collected: PaymentMethod[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetch(`${BLING_API_URL}/formas-pagamentos?pagina=${page}&limite=100`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Bling não retornou as formas de pagamento (HTTP ${response.status})`);
    const payload = await response.json() as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    collected.push(...rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map(normalizePaymentMethod)
      .filter((method): method is PaymentMethod => Boolean(method)));
    if (rows.length < 100) break;
  }

  const activeMethods = collected.filter(method => method.active && !/fornecedor|supplier|compra|contas a pagar/i.test(`${method.name} ${method.type}`));
  if (!activeMethods.length) throw new Error('Nenhuma forma de pagamento ativa foi encontrada no Bling');
  paymentMethodCache = { expiresAt: Date.now() + PAYMENT_METHOD_CACHE_MS, data: activeMethods };
  return activeMethods;
};
const asNumber = (value: unknown, fallback = 0) => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
};
const normalizeProduct = (raw: Record<string, unknown>): Product | undefined => {
  const id = valueAsText(raw.id);
  const name = valueAsText(raw.nome);
  if (!id || !name) return undefined;
  return {
    id,
    sku: valueAsText(raw.codigo) ?? id,
    name,
    price: asNumber(raw.preco ?? raw.precoVenda),
    stock: asNumber(raw.estoqueAtual ?? raw.estoque ?? (raw.saldo as Record<string, unknown> | undefined)?.saldoVirtualTotal),
    barcode: valueAsText(raw.gtin ?? raw.gtinPrincipal)
  };
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const fetchProducts = async (query = ''): Promise<Product[]> => {
  const normalizedQuery = query.trim();
  const accessToken = await getBlingAccessToken();
  if (!accessToken) {
    const term = normalizedQuery.toLowerCase();
    return term ? products.filter(product => `${product.name} ${product.sku} ${product.barcode ?? ''}`.toLowerCase().includes(term)) : products;
  }
  const cached = productCache.get(normalizedQuery);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const isBarcode = /^\d{8,14}$/.test(normalizedQuery);
  const isExactCode = Boolean(normalizedQuery) && /^[A-Za-z0-9._/-]+$/.test(normalizedQuery) && !isBarcode;
  const result: Product[] = [];

  // Para SKU/código, a API do Bling não garante a localização pela pesquisa textual.
  // Portanto, percorremos o catálogo até a correspondência exata, com cadência segura.
  for (let page = 1; page <= (isExactCode ? 250 : isBarcode ? 10 : 1); page += 1) {
    const url = new URL(`${BLING_API_URL}/produtos`);
    url.searchParams.set('pagina', String(page));
    url.searchParams.set('limite', '100');
    if (normalizedQuery && !isExactCode) {
      if (isBarcode) url.searchParams.append('gtins[]', normalizedQuery);
      else url.searchParams.set('pesquisa', normalizedQuery);
    }

    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'enable-jwt': '1' } });
      if (response.status !== 429) break;
      await delay(1100 * (attempt + 1));
    }
    if (!response || !response.ok) throw new Error(`Bling não retornou os produtos (HTTP ${response?.status ?? 0})`);

    const payload = await response.json() as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const pageProducts = rows
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
      .map(normalizeProduct)
      .filter((product): product is Product => Boolean(product));
    const found = isExactCode
      ? pageProducts.filter(product => [product.id, product.sku, product.barcode].some(value => value?.toLowerCase() === normalizedQuery.toLowerCase()))
      : pageProducts;
    result.push(...found);
    if (found.length || rows.length < 100 || isBarcode) break;
    await delay(650);
  }
  productCache.set(normalizedQuery, { expiresAt: Date.now() + 60_000, data: result });
  return result;
};

const findBlingCustomer = async (cpf: string): Promise<BlingCustomer | undefined> => {
  const normalizedCpf = cpf.replace(/\D/g, '');
  const accessToken = await getBlingAccessToken();
  if (!accessToken) return demoBlingCustomers.find(customer => customer.cpf === normalizedCpf);

  const url = new URL(`${BLING_API_URL}/contatos`);
  url.searchParams.set('pagina', '1');
  url.searchParams.set('limite', '1');
  url.searchParams.set('numeroDocumento', normalizedCpf);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Bling não retornou o cliente (HTTP ${response.status})`);

  const payload = await response.json() as { data?: unknown };
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const raw = rows.find((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
  if (!raw) return undefined;

  const id = valueAsText(raw.id);
  const name = valueAsText(raw.nome ?? raw.fantasia);
  const document = valueAsText(raw.numeroDocumento)?.replace(/\D/g, '');
  if (!id || !name || document !== normalizedCpf) return undefined;
  return {
    id,
    cpf: document,
    name,
    email: valueAsText(raw.email),
    phone: valueAsText(raw.celular ?? raw.telefone)
  };
};

export const bling = {
  products: fetchProducts,
  sellers: async () => {
    const accessToken = await getBlingAccessToken();
    if (!accessToken) return sellers;
    const response = await fetch(`${BLING_API_URL}/vendedores?pagina=1&limite=100`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Bling não retornou os vendedores (HTTP ${response.status})`);
    const payload = await response.json() as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const result = rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object').map(row => ({ id: valueAsText(row.id) ?? '', name: valueAsText(row.nome ?? row.name) ?? '', active: isActive(row.situacao ?? row.ativo) })).filter(v => v.id && v.name && v.active);
    return result.length ? result : sellers;
  },
  paymentMethods: fetchPaymentMethods,
  findCustomer: findBlingCustomer,
  createOrder: async (input: {
    customerId?: string;
    sellerId: string;
    items: SaleItem[];
    discount: number;
    paymentMethodId: string;
    idempotencyKey: string;
  }) => ({ id: `bling-order-${input.idempotencyKey}`, status: 'CONFIRMED' as const })
};
export const getFidelizeiConnectionStatus = async () => {
  const baseUrl = (process.env.FIDELIZI_API_URL ?? process.env.FIDELIZEI_API_URL ?? process.env.FIDELIZAPLUS_API_URL ?? 'https://integracao.fidelizii.com.br/api/v3').replace(/\/$/, '');
  const appToken = process.env.FIDELIZI_APP_TOKEN ?? process.env.FIDELIZEI_APP_TOKEN ?? process.env.FIDELIZAPLUS_APP_TOKEN;
  const accessToken = process.env.FIDELIZI_ACCESS_TOKEN ?? process.env.FIDELIZEI_ACCESS_TOKEN ?? process.env.FIDELIZAPLUS_ACCESS_TOKEN;
  const bearerToken = process.env.FIDELIZEI_API_KEY ?? process.env.FIDELIZI_API_KEY ?? process.env.FIDELIZAPLUS_API_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (appToken && accessToken) {
    headers['app-token'] = appToken;
    headers['access-token'] = accessToken;
  } else if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
    headers['x-api-key'] = bearerToken;
    headers['api-key'] = bearerToken;
  } else {
    return { configured: false, connected: false, mode: 'demo' as const };
  }

  try {
    const endpoint = appToken && accessToken ? `${baseUrl}/estabelecimentos` : `${baseUrl}/ready`;
    const response = await fetch(endpoint, { headers });
    return { configured: true, connected: response.ok, mode: appToken ? 'fidelizi-tokens' as const : 'api-token' as const, statusCode: response.status };
  } catch {
    return { configured: true, connected: false, mode: appToken ? 'fidelizi-tokens' as const : 'api-token' as const };
  }
};

export const fidelizei = {
  findCustomer: async (cpf: string) => cpf.replace(/\D/g, '') === fidelizeiCustomer.cpf ? fidelizeiCustomer : undefined,
  previewCoupon: async (code: string, _orderNumber: string, subtotal: number, customerCpf: string) => {
    const coupon = fidelizeiCustomer.coupons.find(c => c.code === code.toUpperCase());
    if (!coupon || customerCpf !== fidelizeiCustomer.cpf || subtotal < coupon.discount) {
      throw new Error('Cupom inválido para esta compra');
    }
    return {
      coupon,
      customerCpf,
      status: 'ready_for_use',
      expectedReward: { discountType: 'fixed' as const, discountValue: coupon.discount * 100, minimumOrderCents: 0 }
    };
  },
  consumeCoupon: async (code: string, orderNumber: string, subtotal: number, customerCpf: string, _expectedReward: { discountType: 'percent' | 'fixed'; discountValue: number; minimumOrderCents: number }) => {
    const preview = await fidelizei.previewCoupon(code, orderNumber, subtotal, customerCpf);
    return preview;
  },
  consumeReservation: async (reservationId: string, saleId: string) => ({
    transactionId: `fid-tx-${saleId}`,
    reservationId
  }),
  releaseReservation: async (_reservationId: string) => undefined
};
