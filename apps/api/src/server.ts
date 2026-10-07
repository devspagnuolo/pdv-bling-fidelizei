import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { bling, fidelizei } from './integrations/demo.js';
import { money, type Sale, type SaleItem } from './domain.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const sales = new Map<string, Sale>();
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL }) : undefined;
const badRequest = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const calculate = (items: SaleItem[], discount = 0) => {
  const subtotal = money(items.reduce((n, i) => n + i.quantity * i.unitPrice, 0));
  return { subtotal, discount, total: money(Math.max(0, subtotal - discount)) };
};

if (pool) {
  await pool.query(`create table if not exists pdv_sales (
    id uuid primary key, status text not null, data jsonb not null, updated_at timestamptz not null default now()
  )`);
}
const persist = async (sale: Sale) => {
  sales.set(sale.id, sale);
  if (pool) await pool.query(
    `insert into pdv_sales (id, status, data) values ($1, $2, $3::jsonb)
     on conflict (id) do update set status = excluded.status, data = excluded.data, updated_at = now()`,
    [sale.id, sale.status, JSON.stringify(sale)]
  );
};

app.get('/health', async () => ({ ok: true, persistence: pool ? 'postgres' : 'memory' }));
app.get('/catalog/products', async () => bling.products());
app.get('/catalog/sellers', async () => bling.sellers());
app.get('/catalog/payment-methods', async () => bling.paymentMethods());
app.get('/customers/:cpf', async (req) => fidelizei.findCustomer((req.params as { cpf: string }).cpf));
app.post('/sales', async (req) => {
  const body = req.body as { operatorId: string; sellerId: string; items: SaleItem[]; customerCpf?: string };
  if (!body.operatorId || !body.sellerId || !body.items?.length) return badRequest('Operador, vendedor e itens são obrigatórios');
  const customer = body.customerCpf ? await fidelizei.findCustomer(body.customerCpf) : undefined;
  const amounts = calculate(body.items);
  const sale: Sale = {
    id: randomUUID(),
    status: 'OPEN',
    operatorId: body.operatorId,
    sellerId: body.sellerId,
    customer,
    items: body.items,
    ...amounts,
    createdAt: new Date().toISOString()
  };
  await persist(sale);
  return sale;
});
app.post('/sales/:id/coupon', async (req) => {
  const sale = sales.get((req.params as { id: string }).id);
  const { code } = req.body as { code: string };
  if (!sale || !sale.customer) return badRequest('Venda ou cliente não encontrado');
  const reservation = await fidelizei.validateAndReserve(code, sale.customer.id, sale.subtotal);
  Object.assign(sale, {
    coupon: reservation.coupon,
    reservationId: reservation.reservationId,
    ...calculate(sale.items, reservation.coupon.discount)
  });
  await persist(sale);
  return sale;
});
app.post('/sales/:id/complete', async (req) => {
  const sale = sales.get((req.params as { id: string }).id);
  const { paymentMethodId } = req.body as { paymentMethodId: string };
  if (!sale || sale.status !== 'OPEN') return badRequest('Venda indisponível para conclusão');
  if (!paymentMethodId) return badRequest('Selecione uma forma de pagamento');

  const paymentMethod = (await bling.paymentMethods()).find(method => method.id === paymentMethodId && method.active);
  if (!paymentMethod) return badRequest('Forma de pagamento não encontrada ou inativa no Bling');

  Object.assign(sale, { paymentMethodId: paymentMethod.id, paymentMethodName: paymentMethod.name });
  const order = await bling.createOrder({
    customerId: sale.customer?.id,
    sellerId: sale.sellerId,
    items: sale.items,
    discount: sale.discount,
    paymentMethodId: paymentMethod.id,
    idempotencyKey: sale.id
  });
  try {
    const tx = sale.reservationId ? await fidelizei.consumeReservation(sale.reservationId, sale.id) : undefined;
    Object.assign(sale, {
      status: 'COMPLETED',
      blingOrderId: order.id,
      fidelizeiTransactionId: tx?.transactionId
    });
  } catch {
    Object.assign(sale, { status: 'RECONCILIATION_REQUIRED', blingOrderId: order.id });
  }
  await persist(sale);
  return sale;
});
app.post('/webhooks/:provider', async (req) => ({
  accepted: true,
  provider: (req.params as { provider: string }).provider,
  idempotency: req.headers['x-event-id'] ?? randomUUID()
}));
await app.listen({ port: Number(process.env.PORT ?? 3333), host: '0.0.0.0' });
