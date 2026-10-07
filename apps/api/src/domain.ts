export type Product = { id: string; sku: string; name: string; price: number; stock: number };
export type Seller = { id: string; name: string; active: boolean };
export type PaymentMethod = {
  id: string;
  name: string;
  type: string;
  active: boolean;
  isDefault?: boolean;
  source: 'BLING' | 'DEMO';
};
export type Coupon = { id: string; code: string; description: string; discount: number };
export type BlingCustomer = {
  id: string;
  cpf: string;
  name: string;
  email?: string;
  phone?: string;
};
export type FidelizeiCustomer = {
  id: string;
  cpf: string;
  name: string;
  tier: string;
  points: number;
  benefits: string[];
  coupons: Coupon[];
};
export type LookupStatus = 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE';
export type Customer = {
  found: boolean;
  cpf: string;
  name?: string;
  bling?: BlingCustomer;
  fidelizei?: FidelizeiCustomer;
  systems: { bling: LookupStatus; fidelizei: LookupStatus };
};
export type SaleItem = { productId: string; sku: string; name: string; quantity: number; unitPrice: number };
export type Sale = {
  id: string;
  status: 'OPEN' | 'COMPLETED' | 'RECONCILIATION_REQUIRED';
  operatorId: string;
  sellerId: string;
  customer?: Customer;
  items: SaleItem[];
  coupon?: Coupon;
  reservationId?: string;
  paymentMethodId?: string;
  paymentMethodName?: string;
  subtotal: number;
  discount: number;
  total: number;
  blingOrderId?: string;
  fidelizeiTransactionId?: string;
  createdAt: string;
};
export const money = (n: number) => Math.round(n * 100) / 100;
