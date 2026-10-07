import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { bling, fidelizei } from './integrations/demo.js';
import {
  consumeBlingOAuthState,
  createBlingOAuthState,
  exchangeBlingAuthorizationCode,
  getBlingConnectionStatus
} from './integrations/credentials.js';
import { initializeDatabase, pool } from './db.js';
import { money, type Customer, type Sale, type SaleItem } from './domain.js';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const sales = new Map<string, Sale>();
const badRequest = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const calculate = (items: SaleItem[], discount = 0) => {
  const subtotal = money(items.reduce((n, i) => n + i.quantity * i.unitPrice, 0));
  return { subtotal, discount, total: money(Math.max(0, subtotal - discount)) };
};
const lookupCustomer = async (cpf: string): Promise<Customer> => {
  const normalizedCpf = cpf.replace(/\D/g, '');
  if (normalizedCpf.length !== 11) return badRequest('Informe um CPF válido com 11 dígitos');

  const [blingResult, fidelizeiResult] = await Promise.allSettled([
    bling.findCustomer(normalizedCpf),
    fidelizei.findCustomer(normalizedCpf)
  ]);
  const blingCustomer = blingResult.status === 'fulfilled' ? blingResult.value : undefined;
  const fidelizeiCustomer = fidelizeiResult.status === 'fulfilled' ? fidelizeiResult.value : undefined;
  return {
    found: Boolean(blingCustomer || fidelizeiCustomer),
    cpf: normalizedCpf,
    name: blingCustomer?.name ?? fidelizeiCustomer?.name,
    bling: blingCustomer,
    fidelizei: fidelizeiCustomer,
    systems: {
      bling: blingResult.status === 'rejected' ? 'UNAVAILABLE' : blingCustomer ? 'FOUND' : 'NOT_FOUND',
      fidelizei: fidelizeiResult.status === 'rejected' ? 'UNAVAILABLE' : fidelizeiCustomer ? 'FOUND' : 'NOT_FOUND'
    }
  };
};

await initializeDatabase();
const persist = async (sale: Sale) => {
  sales.set(sale.id, sale);
  if (pool) await pool.query(
    `insert into pdv_sales (id, status, data) values ($1, $2, $3::jsonb)
     on conflict (id) do update set status = excluded.status, data = excluded.data, updated_at = now()`,
    [sale.id, sale.status, JSON.stringify(sale)]
  );
};

app.get('/health', async () => ({ ok: true, persistence: pool ? 'postgres' : 'memory' }));
app.get('/integrations/status', async () => ({
  bling: await getBlingConnectionStatus(),
  fidelizaPlus: {
    configured: Boolean(process.env.FIDELIZAPLUS_API_URL && process.env.FIDELIZAPLUS_API_TOKEN),
    connected: Boolean(process.env.FIDELIZAPLUS_API_URL && process.env.FIDELIZAPLUS_API_TOKEN),
    mode: process.env.FIDELIZAPLUS_API_TOKEN ? 'api-token' : 'demo'
  }
}));
app.get('/integrations/bling/connect', async (_req, reply) => {
  const clientId = process.env.BLING_CLIENT_ID;
  const redirectUri = process.env.BLING_REDIRECT_URI;
  if (!clientId || !process.env.BLING_CLIENT_SECRET || !redirectUri) {
    throw Object.assign(new Error('Aplicativo Bling ainda não configurado no servidor'), { statusCode: 503 });
  }
  const state = await createBlingOAuthState();
  const authorizeUrl = new URL('https://www.bling.com.br/Api/v3/oauth/authorize');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('state', state);
  return reply.redirect(authorizeUrl.toString());
});
app.get('/integrations/bling/callback', async (req, reply) => {
  const query = req.query as { code?: string; state?: string; error?: string };
  if (query.error) return badRequest(`Autorização Bling recusada: ${query.error}`);
  if (!query.code || !query.state) return badRequest('Retorno OAuth do Bling incompleto');
  if (!await consumeBlingOAuthState(query.state)) return badRequest('Estado OAuth inválido ou expirado');
  await exchangeBlingAuthorizationCode(query.code);
  const webUrl = process.env.PDV_WEB_URL ?? 'https://pdv-bling-fidelizei-web.onrender.com';
  return reply.redirect(`${webUrl}?integration=bling-connected`);
});
app.get('/catalog/products', async () => bling.products());
app.get('/catalog/sellers', async () => bling.sellers());
app.get('/catalog/payment-methods', async () => bling.paymentMethods());
app.get('/customers/:cpf', async (req) => lookupCustomer((req.params as { cpf: string }).cpf));
app.post('/sales', async (req) => {
  const body = req.body as { operatorId: string; sellerId: string; items: SaleItem[]; customerCpf?: string };
  if (!body.operatorId || !body.sellerId || !body.items?.length) {
    return badRequest('Operador, vendedor e itens são obrigatórios');
  }
  const lookup = body.customerCpf ? await lookupCustomer(body.customerCpf) : undefined;
  const customer = lookup?.found ? lookup : undefined;
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
  const fidelizeiCustomer = sale?.customer?.fidelizei;
  if (!sale || !fidelizeiCustomer) return badRequest('Cliente não cadastrado no Fidelizei');
  const reservation = await fidelizei.validateAndReserve(code, fidelizeiCustomer.id, sale.subtotal);
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
    customerId: sale.customer?.bling?.id,
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
