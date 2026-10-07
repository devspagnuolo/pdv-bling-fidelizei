import type { Customer, Product, SaleItem, Seller } from '../domain.js';

const products: Product[] = [
  { id: 'bling-prod-1', sku: 'VEST-001', name: 'Vestido Midi', price: 199.9, stock: 8 },
  { id: 'bling-prod-2', sku: 'CALC-002', name: 'Calça Alfaiataria', price: 149.9, stock: 12 },
  { id: 'bling-prod-3', sku: 'BOLS-003', name: 'Bolsa Couro', price: 279.9, stock: 3 }
];
const sellers: Seller[] = [{ id: 'bling-seller-1', name: 'Juliana Souza', active: true }, { id: 'bling-seller-2', name: 'Marcos Lima', active: true }];
const customer: Customer = { id: 'fid-customer-1', cpf: '12345678909', name: 'Maria da Silva', tier: 'Ouro', points: 1240, benefits: ['Frete grátis', '5% em acessórios'], coupons: [{ id: 'fid-coupon-1', code: 'OURO50', description: 'R$ 50 de desconto', discount: 50 }] };

export const bling = {
  products: async () => products, sellers: async () => sellers,
  createOrder: async (input: { customerId?: string; sellerId: string; items: SaleItem[]; discount: number; paymentMethod: string; idempotencyKey: string }) => ({ id: `bling-order-${input.idempotencyKey}`, status: 'CONFIRMED' as const })
};
export const fidelizei = {
  findCustomer: async (cpf: string) => cpf.replace(/\D/g, '') === customer.cpf ? customer : undefined,
  validateAndReserve: async (code: string, customerId: string, subtotal: number) => {
    const coupon = customer.coupons.find(c => c.code === code.toUpperCase());
    if (!coupon || customerId !== customer.id || subtotal < coupon.discount) throw new Error('Cupom inválido para esta compra');
    return { coupon, reservationId: `reserve-${coupon.id}-${Date.now()}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  },
  consumeReservation: async (reservationId: string, saleId: string) => ({ transactionId: `fid-tx-${saleId}`, reservationId }),
  releaseReservation: async (_reservationId: string) => undefined
};
