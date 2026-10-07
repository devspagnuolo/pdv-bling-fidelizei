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

  const activeMethods = collected.filter(method => method.active);
  if (!activeMethods.length) throw new Error('Nenhuma forma de pagamento ativa foi encontrada no Bling');
  paymentMethodCache = { expiresAt: Date.now() + PAYMENT_METHOD_CACHE_MS, data: activeMethods };
  return activeMethods;
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
  products: async () => products,
  sellers: async () => sellers,
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
export const fidelizei = {
  findCustomer: async (cpf: string) => cpf.replace(/\D/g, '') === fidelizeiCustomer.cpf ? fidelizeiCustomer : undefined,
  validateAndReserve: async (code: string, customerId: string, subtotal: number) => {
    const coupon = fidelizeiCustomer.coupons.find(c => c.code === code.toUpperCase());
    if (!coupon || customerId !== fidelizeiCustomer.id || subtotal < coupon.discount) {
      throw new Error('Cupom inválido para esta compra');
    }
    return {
      coupon,
      reservationId: `reserve-${coupon.id}-${Date.now()}`,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    };
  },
  consumeReservation: async (reservationId: string, saleId: string) => ({
    transactionId: `fid-tx-${saleId}`,
    reservationId
  }),
  releaseReservation: async (_reservationId: string) => undefined
};
