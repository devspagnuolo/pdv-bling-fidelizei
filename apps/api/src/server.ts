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
import { money, type Customer, type PaymentSplit, type Sale, type SaleItem } from './domain.js';

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
const todayInSaoPaulo = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const requireDatabase = () => {
  if (!pool) throw Object.assign(new Error('Banco de dados do PDV indisponível para operações de caixa'), { statusCode: 503 });
  return pool;
};
const currentCashSession = async (operatorId: string) => {
  const database = requireDatabase();
  const result = await database.query(
    `select id, operator_id as "operatorId", seller_id as "sellerId", account_id as "accountId",
      account_name as "accountName", status, opening_amount::float8 as "openingAmount",
      opened_at as "openedAt", closed_at as "closedAt", closing_summary as "closingSummary"
     from pdv_cash_sessions where operator_id = $1 and status = 'OPEN' order by opened_at desc limit 1`,
    [operatorId]
  );
  return result.rows[0];
};

app.get('/cash/accounts', async () => bling.financialAccounts());
app.get('/cash/sessions/current', async (req) => {
  const operatorId = String((req.query as { operatorId?: string }).operatorId ?? '');
  if (!operatorId) return badRequest('Informe o operador do caixa');
  return { session: await currentCashSession(operatorId) ?? null };
});
app.post('/cash/sessions/open', async (req) => {
  const body = req.body as { operatorId?: string; sellerId?: string; accountId?: string; openingAmount?: number };
  if (!body.operatorId || !body.accountId) return badRequest('Operador e conta financeira do Bling são obrigatórios');
  if (await currentCashSession(body.operatorId)) return badRequest('Este operador já possui um caixa aberto');
  const accounts = await bling.financialAccounts();
  const account = accounts.find(item => item.id === body.accountId);
  if (!account) return badRequest('Conta financeira não encontrada ou inativa no Bling');
  const openingAmount = money(Math.max(0, Number(body.openingAmount) || 0));
  const sessionId = randomUUID();
  let blingEntryId: string | undefined;
  if (openingAmount > 0) {
    const entry = await bling.createCashEntry({
      type: 'OPENING', amount: openingAmount, accountId: account.id,
      notes: `Abertura de caixa PDV ${sessionId}`, date: todayInSaoPaulo()
    });
    blingEntryId = entry.id;
  }
  const database = requireDatabase();
  await database.query(
    `insert into pdv_cash_sessions (id, operator_id, seller_id, account_id, account_name, status, opening_amount)
     values ($1,$2,$3,$4,$5,'OPEN',$6)`,
    [sessionId, body.operatorId, body.sellerId ?? body.operatorId, account.id, account.name, openingAmount]
  );
  if (openingAmount > 0) await database.query(
    `insert into pdv_cash_operations (id, session_id, operation_type, amount, bling_entry_id, data)
     values ($1,$2,'OPENING',$3,$4,$5::jsonb)`,
    [randomUUID(), sessionId, openingAmount, blingEntryId ?? null, JSON.stringify({ account })]
  );
  return { session: await currentCashSession(body.operatorId) };
});
app.post('/cash/entries', async (req) => {
  const body = req.body as { sessionId?: string; type?: 'WITHDRAWAL' | 'SUPPLY'; amount?: number; notes?: string };
  if (!body.sessionId || !['WITHDRAWAL','SUPPLY'].includes(String(body.type))) return badRequest('Operação de caixa inválida');
  const amount = money(Number(body.amount));
  if (!(amount > 0)) return badRequest('Informe um valor maior que zero');
  const database = requireDatabase();
  const result = await database.query(
    `select id, account_id as "accountId", account_name as "accountName" from pdv_cash_sessions where id=$1 and status='OPEN'`,
    [body.sessionId]
  );
  const session = result.rows[0];
  if (!session) return badRequest('Caixa não está aberto');
  const operationId = randomUUID();
  const notes = body.notes?.trim() || (body.type === 'WITHDRAWAL' ? 'Sangria do caixa' : 'Suprimento do caixa');
  const entry = await bling.createCashEntry({
    type: body.type as 'WITHDRAWAL' | 'SUPPLY', amount, accountId: session.accountId,
    notes: `${notes} · PDV ${operationId}`, date: todayInSaoPaulo()
  });
  await database.query(
    `insert into pdv_cash_operations (id, session_id, operation_type, amount, bling_entry_id, data)
     values ($1,$2,$3,$4,$5,$6::jsonb)`,
    [operationId, body.sessionId, body.type, amount, entry.id ?? null, JSON.stringify({ notes, accountName: session.accountName })]
  );
  return { id: operationId, blingEntryId: entry.id, registeredInBling: true };
});
app.get('/cash/day', async (req) => {
  const query = req.query as { date?: string; accountId?: string; sessionId?: string };
  const date = query.date || todayInSaoPaulo();
  const entries = await bling.cashEntries(date, query.accountId);
  let salesRows: { data: Sale }[] = [];
  let operations: unknown[] = [];
  if (pool) {
    const salesResult = await pool.query(
      `select data from pdv_sales where status in ('COMPLETED','RECONCILIATION_REQUIRED')
       and (data->>'createdAt')::timestamptz >= $1::timestamptz
       and (data->>'createdAt')::timestamptz < ($1::timestamptz + interval '1 day')`,
      [`${date}T00:00:00-03:00`]
    ) as { rows: { data: Sale }[] };
    salesRows = salesResult.rows;
    if (query.sessionId) {
      const operationResult = await pool.query(
        `select id, operation_type as type, amount::float8 as amount, bling_entry_id as "blingEntryId", data, created_at as "createdAt"
         from pdv_cash_operations where session_id=$1 order by created_at asc`, [query.sessionId]
      );
      operations = operationResult.rows;
    }
  }
  const paymentTotals = new Map<string, number>();
  for (const row of salesRows) for (const payment of row.data.payments ?? []) {
    const name = payment.paymentMethodName || payment.paymentMethodId;
    paymentTotals.set(name, money((paymentTotals.get(name) ?? 0) + payment.amount));
  }
  return {
    date,
    salesCount: salesRows.length,
    salesTotal: money(salesRows.reduce((sum, row) => sum + row.data.total, 0)),
    paymentTotals: [...paymentTotals].map(([name, amount]) => ({ name, amount })),
    blingEntries: entries,
    operations
  };
});
app.post('/cash/sessions/:id/close', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { countedValues?: { name: string; amount: number }[]; notes?: string };
  const database = requireDatabase();
  const result = await database.query(
    `select id, operator_id as "operatorId", account_id as "accountId" from pdv_cash_sessions where id=$1 and status='OPEN'`, [id]
  );
  const session = result.rows[0];
  if (!session) return badRequest('Caixa já está fechado ou não existe');
  const date = todayInSaoPaulo();
  const entries = await bling.cashEntries(date, session.accountId);
  const summary = {
    closedAfterBlingSync: true,
    date,
    countedValues: (body.countedValues ?? []).map(item => ({ name: item.name, amount: money(Number(item.amount) || 0) })),
    notes: body.notes?.trim() || undefined,
    blingEntries: entries
  };
  await database.query(
    `update pdv_cash_sessions set status='CLOSED', closed_at=now(), closing_summary=$2::jsonb where id=$1`,
    [id, JSON.stringify(summary)]
  );
  return { closed: true, sessionId: id, summary };
});

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
    emitFiscal: body.emitFiscal === true,
    fiscalStatus: body.emitFiscal === true ? undefined : 'NOT_REQUESTED',
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
  const body = req.body as { paymentMethodId?: string; payments?: PaymentSplit[] };
  if (!sale || sale.status !== 'OPEN') return badRequest('Venda indisponível para conclusão');

  const requested = Array.isArray(body.payments) && body.payments.length
    ? body.payments
    : body.paymentMethodId
      ? [{ paymentMethodId: body.paymentMethodId, amount: sale.total }]
      : [];
  if (!requested.length) return badRequest('Adicione ao menos uma forma de pagamento');

  const availableMethods = await bling.paymentMethods();
  const payments = requested.map(input => {
    const method = availableMethods.find(item => item.id === input.paymentMethodId && item.active);
    if (!method) return badRequest('Uma forma de pagamento não foi encontrada ou está inativa no Bling');
    const amount = money(Number(input.amount));
    if (!(amount > 0)) return badRequest('Informe um valor válido para cada forma de pagamento');
    const isCash = /dinheiro|cash/i.test(`${method.name} ${method.type}`);
    const receivedAmount = input.receivedAmount === undefined ? undefined : money(Number(input.receivedAmount));
    if (isCash && receivedAmount !== undefined && receivedAmount < amount) {
      return badRequest('O valor recebido em dinheiro não pode ser menor que a parte paga em dinheiro');
    }
    return {
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      amount,
      receivedAmount,
      change: isCash && receivedAmount !== undefined ? money(Math.max(0, receivedAmount - amount)) : 0
    };
  });
  const paidTotal = money(payments.reduce((sum, payment) => sum + payment.amount, 0));
  if (Math.abs(paidTotal - sale.total) > 0.009) {
    return badRequest(`A soma dos pagamentos (${paidTotal.toFixed(2)}) deve ser igual ao total da venda (${sale.total.toFixed(2)})`);
  }

  const totalReceived = money(payments.reduce((sum, payment) => sum + (payment.receivedAmount ?? payment.amount), 0));
  const totalChange = money(payments.reduce((sum, payment) => sum + (payment.change ?? 0), 0));
  Object.assign(sale, {
    paymentMethodId: payments.length === 1 ? payments[0].paymentMethodId : undefined,
    paymentMethodName: payments.length === 1 ? payments[0].paymentMethodName : 'Pagamento combinado',
    payments,
    amountReceived: totalReceived,
    change: totalChange
  });
  const order = await bling.createOrder({
    customerId: sale.customer?.bling?.id,
    sellerId: sale.sellerId,
    items: sale.items,
    discount: sale.discount,
    freight: sale.freight ?? 0,
    observations: sale.observations,
    payments,
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
app.get('/sales/recent', async (req) => {
  const rawLimit = Number((req.query as { limit?: string }).limit ?? 10);
  const limit = Math.max(1, Math.min(30, Number.isFinite(rawLimit) ? rawLimit : 10));
  if (pool) {
    const result = await pool.query(
      `select data from pdv_sales where status in ('COMPLETED','RECONCILIATION_REQUIRED') order by updated_at desc limit $1`,
      [limit]
    ) as { rows: { data: Sale }[] };
    return result.rows.map(row => row.data);
  }
  return [...sales.values()]
    .filter(item => item.status !== 'OPEN')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
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
