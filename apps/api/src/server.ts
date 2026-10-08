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
const allowedOrigins = new Set([
  process.env.PDV_WEB_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter((value): value is string => Boolean(value)));
await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin))
});
const sales = new Map<string, Sale>();
const badRequest = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const conflict = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 409 }); };
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

app.get('/health', async (_req, reply) => {
  let database = false;
  let pendingSales = 0;
  try {
    if (pool) {
      await pool.query('select 1');
      database = true;
      const pending = await pool.query(
        `select count(*)::int as count from pdv_sales where status in ('PROCESSING','SYNC_FAILED','RECONCILIATION_REQUIRED')`
      ) as { rows: { count: number }[] };
      pendingSales = pending.rows[0]?.count ?? 0;
    }
  } catch (error) {
    app.log.error({ error }, 'Health check do banco falhou');
  }
  const blingStatus = await getBlingConnectionStatus();
  const ok = database || !pool;
  reply.code(ok ? 200 : 503);
  return {
    ok,
    status: ok && blingStatus.connected ? 'ok' : 'degraded',
    persistence: pool ? 'postgres' : 'memory',
    database,
    bling: blingStatus,
    pendingSales,
    encryptionKeyConfigured: Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY)
  };
});
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
  ) as { rows: any[] };
  return result.rows[0];
};
const cashSessionById = async (id: string) => {
  const database = requireDatabase();
  const result = await database.query(
    `select id, operator_id as "operatorId", seller_id as "sellerId", account_id as "accountId",
      account_name as "accountName", status, opening_amount::float8 as "openingAmount",
      opened_at as "openedAt", closed_at as "closedAt", closing_summary as "closingSummary"
     from pdv_cash_sessions where id = $1 limit 1`,
    [id]
  ) as { rows: any[] };
  return result.rows[0];
};
const cashSessionSnapshot = async (sessionId: string) => {
  const database = requireDatabase();
  const session = await cashSessionById(sessionId);
  if (!session) return badRequest('Sessão de caixa não encontrada');
  const salesResult = await database.query(
    `select data from pdv_sales
     where data->>'cashSessionId' = $1
       and status in ('COMPLETED','RECONCILIATION_REQUIRED') order by updated_at asc`,
    [sessionId]
  ) as { rows: { data: Sale }[] };
  const pendingResult = await database.query(
    `select count(*)::int as count from pdv_sales
     where data->>'cashSessionId' = $1 and status in ('PROCESSING','SYNC_FAILED')`,
    [sessionId]
  ) as { rows: { count: number }[] };
  const operationResult = await database.query(
    `select id, operation_type as type, amount::float8 as amount, bling_entry_id as "blingEntryId",
      data, created_at as "createdAt" from pdv_cash_operations where session_id=$1 order by created_at asc`,
    [sessionId]
  ) as { rows: any[] };
  const paymentTotals = new Map<string, number>();
  let cashSales = 0;
  for (const row of salesResult.rows) for (const payment of row.data.payments ?? []) {
    const name = payment.paymentMethodName || payment.paymentMethodId;
    paymentTotals.set(name, money((paymentTotals.get(name) ?? 0) + payment.amount));
    if (/dinheiro|cash/i.test(name)) cashSales = money(cashSales + payment.amount);
  }
  const withdrawals = money(operationResult.rows.filter(item => item.type === 'WITHDRAWAL').reduce((sum, item) => sum + item.amount, 0));
  const supplies = money(operationResult.rows.filter(item => item.type === 'SUPPLY').reduce((sum, item) => sum + item.amount, 0));
  return {
    session,
    salesRows: salesResult.rows,
    operations: operationResult.rows,
    paymentTotals: [...paymentTotals].map(([name, amount]) => ({ name, amount })),
    expectedCash: money(session.openingAmount + cashSales - withdrawals + supplies),
    pendingSales: pendingResult.rows[0]?.count ?? 0
  };
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
  const operationId = randomUUID();
  const database = requireDatabase();
  await database.query(
    `insert into pdv_cash_sessions (id, operator_id, seller_id, account_id, account_name, status, opening_amount)
     values ($1,$2,$3,$4,$5,'OPEN',$6)`,
    [sessionId, body.operatorId, body.sellerId ?? body.operatorId, account.id, account.name, openingAmount]
  );
  if (openingAmount > 0) {
    await database.query(
      `insert into pdv_cash_operations (id, session_id, operation_type, amount, data)
       values ($1,$2,'OPENING',$3,$4::jsonb)`,
      [operationId, sessionId, openingAmount, JSON.stringify({ account, syncStatus: 'PENDING' })]
    );
    try {
      const entry = await bling.createCashEntry({
        type: 'OPENING', amount: openingAmount, accountId: account.id,
        notes: `Abertura de caixa PDV ${operationId}`, date: todayInSaoPaulo()
      });
      await database.query(
        `update pdv_cash_operations set bling_entry_id=$2,
          data=data || '{"syncStatus":"SYNCED"}'::jsonb where id=$1`,
        [operationId, entry.id ?? null]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha desconhecida';
      await database.query(
        `update pdv_cash_operations set data=data || $2::jsonb where id=$1`,
        [operationId, JSON.stringify({ syncStatus: 'FAILED', lastError: message.slice(0, 500) })]
      );
      app.log.error({ error, operationId, sessionId }, 'Abertura registrada localmente, mas pendente no Bling');
    }
  }
  return { session: await currentCashSession(body.operatorId) };
});
app.post('/cash/entries', async (req) => {
  const body = req.body as { operationId?: string; sessionId?: string; type?: 'WITHDRAWAL' | 'SUPPLY'; amount?: number; notes?: string };
  if (!body.sessionId || !['WITHDRAWAL','SUPPLY'].includes(String(body.type))) return badRequest('Operação de caixa inválida');
  const amount = money(Number(body.amount));
  if (!(amount > 0)) return badRequest('Informe um valor maior que zero');
  const database = requireDatabase();
  const session = await cashSessionById(body.sessionId);
  if (!session || session.status !== 'OPEN') return badRequest('Caixa não está aberto');
  const operationId = body.operationId || randomUUID();
  const existing = await database.query('select id, bling_entry_id as "blingEntryId", data from pdv_cash_operations where id=$1', [operationId]) as { rows: any[] };
  if (existing.rows[0]) return { id: operationId, blingEntryId: existing.rows[0].blingEntryId, idempotent: true, data: existing.rows[0].data };
  const notes = body.notes?.trim() || (body.type === 'WITHDRAWAL' ? 'Sangria do caixa' : 'Suprimento do caixa');
  await database.query(
    `insert into pdv_cash_operations (id, session_id, operation_type, amount, data)
     values ($1,$2,$3,$4,$5::jsonb)`,
    [operationId, body.sessionId, body.type, amount, JSON.stringify({ notes, accountName: session.accountName, syncStatus: 'PENDING' })]
  );
  try {
    const entry = await bling.createCashEntry({
      type: body.type as 'WITHDRAWAL' | 'SUPPLY', amount, accountId: session.accountId,
      notes: `${notes} · PDV ${operationId}`, date: todayInSaoPaulo()
    });
    await database.query(
      `update pdv_cash_operations set bling_entry_id=$2,
        data=data || '{"syncStatus":"SYNCED"}'::jsonb where id=$1`,
      [operationId, entry.id ?? null]
    );
    return { id: operationId, blingEntryId: entry.id, registeredInBling: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha desconhecida';
    await database.query(
      `update pdv_cash_operations set data=data || $2::jsonb where id=$1`,
      [operationId, JSON.stringify({ syncStatus: 'FAILED', lastError: message.slice(0, 500) })]
    );
    throw error;
  }
});
app.get('/cash/day', async (req) => {
  const query = req.query as { date?: string; accountId?: string; sessionId?: string };
  const date = query.date || todayInSaoPaulo();
  const entries = await bling.cashEntries(date, query.accountId);
  if (!query.sessionId) return { date, salesCount: 0, salesTotal: 0, paymentTotals: [], blingEntries: entries, operations: [], expectedCash: 0, pendingSales: 0 };
  const snapshot = await cashSessionSnapshot(query.sessionId);
  return {
    date,
    salesCount: snapshot.salesRows.length,
    salesTotal: money(snapshot.salesRows.reduce((sum, row) => sum + row.data.total, 0)),
    paymentTotals: snapshot.paymentTotals,
    blingEntries: entries,
    operations: snapshot.operations,
    expectedCash: snapshot.expectedCash,
    pendingSales: snapshot.pendingSales,
    canClose: snapshot.pendingSales === 0
  };
});
app.post('/cash/sessions/:id/close', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { countedValues?: { name: string; amount: number }[]; notes?: string };
  const database = requireDatabase();
  const snapshot = await cashSessionSnapshot(id);
  if (snapshot.session.status !== 'OPEN') return badRequest('Caixa já está fechado');
  if (snapshot.pendingSales > 0) return conflict('Existem vendas pendentes de sincronização. Resolva-as antes de fechar o caixa');
  const countedValues = body.countedValues ?? [];
  if (!countedValues.length) return badRequest('Informe os valores conferidos antes de fechar o caixa');
  const expected = new Map(snapshot.paymentTotals.map(item => [item.name, item.amount]));
  const cashName = [...expected.keys()].find(name => /dinheiro|cash/i.test(name)) ?? 'Dinheiro';
  expected.set(cashName, snapshot.expectedCash);
  const counted = new Map(countedValues.map(item => [item.name, money(Number(item.amount) || 0)]));
  const reconciliation = [...new Set([...expected.keys(), ...counted.keys()])].map(name => ({
    name,
    expected: money(expected.get(name) ?? 0),
    counted: money(counted.get(name) ?? 0),
    difference: money((counted.get(name) ?? 0) - (expected.get(name) ?? 0))
  }));
  const date = todayInSaoPaulo();
  const entries = await bling.cashEntries(date, snapshot.session.accountId);
  const summary = {
    closedAfterBlingSync: true,
    date,
    countedValues,
    reconciliation,
    totalDifference: money(reconciliation.reduce((sum, item) => sum + item.difference, 0)),
    expectedCash: snapshot.expectedCash,
    notes: body.notes?.trim() || undefined,
    blingEntries: entries
  };
  await database.query(
    `update pdv_cash_sessions set status='CLOSED', closed_at=now(), closing_summary=$2::jsonb where id=$1 and status='OPEN'`,
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
const canonicalSaleItems = async (requested: SaleItem[]) => {
  if (!requested.length) return badRequest('Adicione ao menos um produto');
  const normalized = requested.map(item => ({
    ...item,
    productId: String(item.productId),
    quantity: Number(item.quantity),
    comment: item.comment?.trim().slice(0, 500) || undefined
  }));
  if (normalized.some(item => !item.productId || !Number.isInteger(item.quantity) || item.quantity <= 0)) {
    return badRequest('Produto ou quantidade inválida');
  }
  const database = requireDatabase();
  const ids = [...new Set(normalized.map(item => item.productId))];
  const result = await database.query(
    `select id, sku, name, price::float8 as price, stock::float8 as stock, barcode
     from bling_products where id = any($1::text[])`,
    [ids]
  ) as { rows: { id: string; sku: string; name: string; price: number; stock: number }[] };
  const catalog = new Map(result.rows.map(item => [item.id, item]));
  for (const item of normalized) {
    if (catalog.has(item.productId)) continue;
    const direct = await bling.products(item.sku || item.productId);
    const found = direct.find(product => product.id === item.productId);
    if (found) catalog.set(found.id, found);
  }
  if (catalog.size !== ids.length) return badRequest('Um ou mais produtos não existem mais no cadastro do Bling');
  return normalized.map(item => {
    const product = catalog.get(item.productId)!;
    return { productId: product.id, sku: product.sku, name: product.name, quantity: item.quantity, unitPrice: money(product.price), comment: item.comment };
  });
};
app.post('/sales', async (req) => {
  const body = req.body as {
    cashSessionId?: string;
    operatorId?: string;
    sellerId: string;
    items: SaleItem[];
    customerCpf?: string;
    manualDiscount?: number;
    freight?: number;
    observations?: string;
    emitFiscal?: boolean;
  };
  if (!body.cashSessionId || !body.operatorId || !body.sellerId || !body.items?.length) {
    return badRequest('Caixa aberto, operador, vendedor e itens são obrigatórios');
  }
  const session = await cashSessionById(body.cashSessionId);
  if (!session || session.status !== 'OPEN') return badRequest('Abra o caixa antes de iniciar a venda');
  if (session.operatorId !== body.operatorId) return badRequest('A venda deve usar o operador responsável pelo caixa aberto');
  const items = await canonicalSaleItems(body.items);
  const lookup = body.customerCpf ? await lookupCustomer(body.customerCpf) : undefined;
  const customer = lookup?.found ? lookup : undefined;
  const manualDiscount = money(Math.max(0, Number(body.manualDiscount) || 0));
  const freight = money(Math.max(0, Number(body.freight) || 0));
  const amounts = calculate(items, manualDiscount, freight);
  const sale: Sale = {
    id: randomUUID(),
    status: 'OPEN',
    cashSessionId: session.id,
    operatorId: body.operatorId,
    sellerId: body.sellerId,
    customer,
    items,
    manualDiscount,
    observations: body.observations?.trim().slice(0, 2000) || undefined,
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
const processingSales = new Set<string>();
const claimSaleForCompletion = async (id: string, fallback: Sale) => {
  if (pool) {
    const result = await pool.query(
      `update pdv_sales set status='PROCESSING',
        data=jsonb_set(data, '{status}', '"PROCESSING"'::jsonb), updated_at=now()
       where id=$1 and status='OPEN' returning data`,
      [id]
    ) as { rows: { data: Sale }[] };
    if (!result.rows[0]) return conflict('Venda já está sendo processada ou foi concluída');
    const claimed = result.rows[0].data;
    sales.set(id, claimed);
    return claimed;
  }
  if (processingSales.has(id) || fallback.status !== 'OPEN') return conflict('Venda já está sendo processada ou foi concluída');
  processingSales.add(id);
  fallback.status = 'PROCESSING';
  return fallback;
};
app.post('/sales/:id/complete', async (req) => {
  const id = (req.params as { id: string }).id;
  const original = await getSale(id);
  const body = req.body as { paymentMethodId?: string; payments?: PaymentSplit[] };
  if (!original || original.status !== 'OPEN') return conflict('Venda já está sendo processada ou foi concluída');
  const session = await cashSessionById(original.cashSessionId);
  if (!session || session.status !== 'OPEN') return badRequest('O caixa desta venda não está mais aberto');

  const requested = Array.isArray(body.payments) && body.payments.length
    ? body.payments
    : body.paymentMethodId
      ? [{ paymentMethodId: body.paymentMethodId, amount: original.total }]
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
  if (Math.abs(paidTotal - original.total) > 0.009) {
    return badRequest(`A soma dos pagamentos (${paidTotal.toFixed(2)}) deve ser igual ao total da venda (${original.total.toFixed(2)})`);
  }
  const sale = await claimSaleForCompletion(id, original);
  const totalReceived = money(payments.reduce((sum, payment) => sum + (payment.receivedAmount ?? payment.amount), 0));
  const totalChange = money(payments.reduce((sum, payment) => sum + (payment.change ?? 0), 0));
  Object.assign(sale, {
    paymentMethodId: payments.length === 1 ? payments[0].paymentMethodId : undefined,
    paymentMethodName: payments.length === 1 ? payments[0].paymentMethodName : 'Pagamento combinado',
    payments,
    amountReceived: totalReceived,
    change: totalChange
  });
  try {
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
    sale.blingOrderId = order.id;
    if (pool) await pool.query(
      `update bling_products product set stock=product.stock-item.quantity
       from jsonb_to_recordset($1::jsonb) as item("productId" text, quantity numeric)
       where product.id=item."productId"`,
      [JSON.stringify(sale.items.map(item => ({ productId: item.productId, quantity: item.quantity })))]
    );
    if (sale.emitFiscal) {
      try {
        await bling.generateNfce(order.id);
        sale.fiscalStatus = 'REQUESTED';
      } catch (error) {
        sale.fiscalStatus = 'FAILED';
        app.log.error({ error, saleId: sale.id, blingOrderId: order.id }, 'Pedido criado, mas a NFC-e não foi gerada no Bling');
      }
    }
    if (!sale.customer?.cpf) {
      sale.status = 'COMPLETED';
    } else {
      try {
        const tx = await fidelizei.registerSale({
          externalSaleId: sale.id,
          orderNumber: order.id,
          customerCpf: sale.customer.cpf,
          total: sale.total,
          occurredAt: new Date().toISOString()
        });
        sale.status = 'COMPLETED';
        sale.fidelizeiTransactionId = tx.transactionId;
      } catch (error) {
        sale.status = 'RECONCILIATION_REQUIRED';
        sale.lastError = error instanceof Error ? error.message.slice(0, 500) : 'Falha no Fidelizei';
        app.log.warn({ error, saleId: sale.id }, 'Venda criada no Bling e pendente no Fidelizei');
      }
    }
    await persist(sale);
    return sale;
  } catch (error) {
    sale.status = 'SYNC_FAILED';
    sale.lastError = error instanceof Error ? error.message.slice(0, 500) : 'Falha desconhecida na sincronização';
    await persist(sale);
    app.log.error({ error, saleId: sale.id }, 'Venda pendente: resultado da criação no Bling precisa de conferência');
    throw Object.assign(new Error('Não foi possível confirmar o pedido no Bling. A venda ficou pendente para conferência, sem nova tentativa automática.'), { statusCode: 502 });
  } finally {
    processingSales.delete(id);
  }
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
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Encerrando o PDV com segurança');
  await app.close();
  await pool?.end();
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
await app.listen({ port: Number(process.env.PORT ?? 3333), host: '0.0.0.0' });
