import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { bling, fidelizei, getFidelizeiConnectionStatus } from './integrations/live.js';
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
const calculate = (items: SaleItem[], discount = 0, freight = 0) => {
  const subtotal = money(items.reduce((n, i) => n + i.quantity * i.unitPrice, 0));
  const safeDiscount = money(Math.min(subtotal, Math.max(0, discount)));
  const safeFreight = money(Math.max(0, freight));
  return { subtotal, discount: safeDiscount, freight: safeFreight, total: money(Math.max(0, subtotal - safeDiscount + safeFreight)) };
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
void bling.syncProducts().catch(error => app.log.error(error, 'Falha na sincronização inicial do catálogo Bling'));
setInterval(() => void bling.syncProducts().catch(error => app.log.error(error, 'Falha na sincronização periódica do catálogo Bling')), 15 * 60_000).unref();
const persist = async (sale: Sale) => {
  sales.set(sale.id, sale);
  if (pool) await pool.query(
    `insert into pdv_sales (id, status, data) values ($1, $2, $3::jsonb)
     on conflict (id) do update set status = excluded.status, data = excluded.data, updated_at = now()`,
    [sale.id, sale.status, JSON.stringify(sale)]
  );
};
const getSale = async (id: string) => {
  const cached = sales.get(id);
  if (cached) return cached;
  if (!pool) return undefined;
  const result = await pool.query('select data from pdv_sales where id = $1', [id]) as { rows: { data: Sale }[] };
  const sale = result.rows[0]?.data;
  if (sale) sales.set(sale.id, sale);
  return sale;
};
const reconcileFidelizeiSale = async (sale: Sale) => {
  if (sale.status !== 'RECONCILIATION_REQUIRED' || !sale.blingOrderId) return;
  try {
    const tx = await fidelizei.registerSale({
      externalSaleId: sale.id,
      orderNumber: sale.blingOrderId,
      customerCpf: sale.customer?.cpf,
      total: sale.total,
      occurredAt: sale.createdAt
    });
    Object.assign(sale, { status: 'COMPLETED', fidelizeiTransactionId: tx.transactionId });
    await persist(sale);
    app.log.info({ saleId: sale.id }, 'Venda reconciliada com o Fidelizei');
  } catch (error) {
    app.log.warn({ error, saleId: sale.id }, 'Fidelizei indisponível; venda continuará pendente');
  }
};
const reconcilePendingSales = async () => {
  if (!pool) return;
  const result = await pool.query(
    `select data from pdv_sales where status = 'RECONCILIATION_REQUIRED' order by updated_at asc limit 50`
  ) as { rows: { data: Sale }[] };
  for (const row of result.rows) await reconcileFidelizeiSale(row.data);
};
setInterval(() => void reconcilePendingSales().catch(error => app.log.error(error, 'Falha na rotina de reconciliação Fidelizei')), 60_000).unref();
void reconcilePendingSales().catch(error => app.log.error(error, 'Falha na reconciliação inicial Fidelizei'));

app.get('/health', async () => ({ ok: true, persistence: pool ? 'postgres' : 'memory' }));
app.get('/integrations/status', async () => ({
  bling: await getBlingConnectionStatus(),
  fidelizaPlus: await getFidelizeiConnectionStatus(),
  fiscal: await bling.getFiscalCapability()
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
app.post('/catalog/products/sync', async () => ({ synced: await bling.syncProducts() }));
app.get('/catalog/products', async (req) => {
  const query = (req.query as { query?: string }).query ?? '';
  return bling.products(query);
});
app.get('/catalog/sellers', async () => bling.sellers());
app.get('/catalog/payment-methods', async () => bling.paymentMethods());
app.get('/customers/:cpf', async (req) => lookupCustomer((req.params as { cpf: string }).cpf));
app.post('/customers/fidelizei', async (req) => {
  const body = req.body as { name: string; cpf: string; phone?: string; email?: string; programConsent: boolean };
  if (!body.name || !body.cpf || body.programConsent !== true) return badRequest('Nome, CPF e consentimento explícito são obrigatórios para adesão');
  if (!body.phone) return badRequest('Celular é obrigatório para adesão ao Fidelizei');
  return fidelizei.upsertCustomer(body);
});
app.post('/sales', async (req) => {
  const body = req.body as {
    operatorId?: string;
    sellerId: string;
    items: SaleItem[];
    customerCpf?: string;
    manualDiscount?: number;
    freight?: number;
    observations?: string;
    emitFiscal?: boolean;
  };
  if (!body.sellerId || !body.items?.length) {
    return badRequest('Vendedor e itens são obrigatórios');
  }
  const lookup = body.customerCpf ? await lookupCustomer(body.customerCpf) : undefined;
  const customer = lookup?.found ? lookup : undefined;
  const manualDiscount = money(Math.max(0, Number(body.manualDiscount) || 0));
  const freight = money(Math.max(0, Number(body.freight) || 0));
  const amounts = calculate(body.items, manualDiscount, freight);
  const sale: Sale = {
    id: randomUUID(),
    status: 'OPEN',
    operatorId: body.operatorId || body.sellerId,
    sellerId: body.sellerId,
    customer,
    items: body.items,
    manualDiscount,
    observations: body.observations?.trim() || undefined,
    emitFiscal: body.emitFiscal !== false,
    fiscalStatus: body.emitFiscal === false ? 'NOT_REQUESTED' : undefined,
    ...amounts,
    createdAt: new Date().toISOString()
  };
  await persist(sale);
  return sale;
});
app.post('/sales/:id/coupon', async (req) => {
  const sale = await getSale((req.params as { id: string }).id);
  const { code } = req.body as { code: string };
  const fidelizeiCustomer = sale?.customer?.fidelizei;
  if (!sale || !fidelizeiCustomer) return badRequest('Cliente não cadastrado no Fidelizei');
  const reservation = await fidelizei.validateAndReserve(code, sale.id, sale.subtotal);
  Object.assign(sale, {
    coupon: reservation.coupon,
    reservationId: reservation.reservationId,
    ...calculate(sale.items, (sale.manualDiscount ?? 0) + reservation.coupon.discount, sale.freight ?? 0)
  });
  await persist(sale);
  return sale;
});
app.post('/sales/:id/complete', async (req) => {
  const sale = await getSale((req.params as { id: string }).id);
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
    freight: sale.freight ?? 0,
    observations: sale.observations,
    paymentMethodId: paymentMethod.id,
    idempotencyKey: sale.id
  });
  if (sale.emitFiscal) {
    try {
      await bling.generateNfce(order.id);
      sale.fiscalStatus = 'REQUESTED';
    } catch (error) {
      sale.fiscalStatus = 'FAILED';
      app.log.error({ error, saleId: sale.id, blingOrderId: order.id }, 'Pedido criado, mas a NFC-e não foi gerada no Bling');
    }
  }
  try {
    const tx = await fidelizei.registerSale({
      externalSaleId: sale.id,
      orderNumber: order.id,
      customerCpf: sale.customer?.cpf,
      total: sale.total,
      occurredAt: new Date().toISOString()
    });
    Object.assign(sale, {
      status: 'COMPLETED',
      blingOrderId: order.id,
      fidelizeiTransactionId: tx.transactionId
    });
  } catch {
    Object.assign(sale, { status: 'RECONCILIATION_REQUIRED', blingOrderId: order.id });
  }
  await persist(sale);
  return sale;
});
app.post('/sales/:id/reverse-fidelizei', async (req) => {
  const sale = await getSale((req.params as { id: string }).id);
  if (!sale?.fidelizeiTransactionId) return badRequest('Venda sem transação Fidelizei para estorno');
  return fidelizei.reverseSale(sale.id);
});
app.post('/webhooks/:provider', async (req) => ({
  accepted: true,
  provider: (req.params as { provider: string }).provider,
  idempotency: req.headers['x-event-id'] ?? randomUUID()
}));
await app.listen({ port: Number(process.env.PORT ?? 3333), host: '0.0.0.0' });
