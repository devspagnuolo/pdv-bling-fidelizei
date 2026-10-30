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
import { initializeDatabase, pool, withTransaction } from './db.js';
import { money, type Customer, type PaymentSplit, type Sale, type SaleItem } from './domain.js';
import { getWebhookHealth, registerBlingWebhooks } from './webhooks.js';
import { authConfigured, authenticatePin, issueToken, principalFromRequest, verifyToken } from './auth.js';

const app = Fastify({ logger: true });
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    (req as typeof req & { rawBody?: Buffer }).rawBody = body as Buffer;
    done(null, JSON.parse((body as Buffer).toString('utf8')));
  } catch (error) {
    done(error as Error, undefined);
  }
});
const allowedOrigins = new Set([
  process.env.PDV_WEB_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173'
].filter((value): value is string => Boolean(value)));
await app.register(cors, {
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['authorization', 'content-type']
});
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  const protectedRoute = path.startsWith('/sales') || path.startsWith('/customers') ||
    path.startsWith('/cash') || path.startsWith('/operations') ||
    (path.startsWith('/admin') && path !== '/admin/login') ||
    (path === '/catalog/products/sync');
  if (!protectedRoute) return;
  if (!authConfigured()) {
    if (path.startsWith('/operations')) return reply.code(503).send({ message: 'Configure a autenticação do PDV antes de acessar dados operacionais' });
    return;
  }
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  const principal = verifyToken(token);
  if (!principal) return reply.code(401).send({ message: 'Sessão expirada ou acesso não autorizado' });
  (req as typeof req & { auth?: typeof principal }).auth = principal;
});
const requireManager = (req: Parameters<typeof principalFromRequest>[0]) => {
  const principal = principalFromRequest(req);
  if (authConfigured() && principal?.role !== 'MANAGER') {
    throw Object.assign(new Error('Esta operação exige perfil de gerente'), { statusCode: 403 });
  }
  return principal;
};
const requireAdmin = (req: Parameters<typeof principalFromRequest>[0]) => {
  const principal = principalFromRequest(req);
  if (!authConfigured()) throw Object.assign(new Error('Autenticação administrativa não configurada'), { statusCode: 503 });
  if (principal?.role !== 'ADMIN') throw Object.assign(new Error('Esta operação exige perfil de administrador'), { statusCode: 403 });
  return principal;
};
const requireAdminOrManager = (req: Parameters<typeof principalFromRequest>[0]) => {
  const principal = principalFromRequest(req);
  if (!authConfigured()) throw Object.assign(new Error('Autenticação gerencial não configurada'), { statusCode: 503 });
  if (principal?.role !== 'ADMIN' && principal?.role !== 'MANAGER') throw Object.assign(new Error('Esta operação exige perfil gerencial'), { statusCode: 403 });
  return principal;
};
const requireAdminViewer = (req: Parameters<typeof principalFromRequest>[0]) => {
  if (!authConfigured()) throw Object.assign(new Error('Autenticação gerencial não configurada'), { statusCode: 503 });
  const principal=principalFromRequest(req);
  if (!principal) throw Object.assign(new Error('Sessão administrativa inválida'), { statusCode: 401 });
  return principal;
};
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
registerBlingWebhooks(app);
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
app.get('/', async () => ({ ok: true, service: 'pdv-bling-fidelizei-api' }));
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
    encryptionKeyConfigured: Boolean(process.env.CREDENTIALS_ENCRYPTION_KEY),
    webhook: await getWebhookHealth(),
    webhookCompanyConfigured: Boolean(process.env.BLING_COMPANY_ID),
    authenticationConfigured: authConfigured()
  };
});
let integrationStatusCache: { expires: number; value: unknown } | undefined;
let integrationStatusPromise: Promise<unknown> | undefined;
app.get('/auth/status', async () => ({ enabled: authConfigured() }));
app.post('/auth/login', async (req, reply) => {
  if (!authConfigured()) return reply.code(503).send({ message: 'Autenticação do PDV ainda não configurada no servidor' });
  const address = req.ip;
  const current = loginAttempts.get(address);
  if (current && current.resetAt > Date.now() && current.count >= 5) {
    return reply.code(429).send({ message: 'Muitas tentativas. Aguarde cinco minutos' });
  }
  const body = req.body as { operatorId?: string; pin?: string };
  const role = authenticatePin(String(body.pin ?? ''));
  const seller = body.operatorId ? (await bling.sellers()).find(item => item.id === body.operatorId && item.active) : undefined;
  if (!role || !seller) {
    const resetAt = current?.resetAt && current.resetAt > Date.now() ? current.resetAt : Date.now() + 5 * 60_000;
    loginAttempts.set(address, { count: (current?.resetAt && current.resetAt > Date.now() ? current.count : 0) + 1, resetAt });
    return reply.code(401).send({ message: 'Operador ou PIN inválido' });
  }
  loginAttempts.delete(address);
  const principal = { operatorId: seller.id, operatorName: seller.name, role };
  return { token: issueToken(principal), principal };
});
app.post('/admin/login', async (req, reply) => {
  if (!authConfigured()) return reply.code(503).send({ message: 'Autenticação do PDV ainda não configurada no servidor.' });
  const address = req.ip;
  const current = loginAttempts.get(address);
  if (current && current.resetAt > Date.now() && current.count >= 5) return reply.code(429).send({ message: 'Muitas tentativas. Aguarde cinco minutos' });
  const body = req.body as { pin?: string; operatorId?: string };
  const role=authenticatePin(String(body.pin ?? ''));
  if (!role) {
    const resetAt = current?.resetAt && current.resetAt > Date.now() ? current.resetAt : Date.now() + 5 * 60_000;
    loginAttempts.set(address, { count: (current?.resetAt && current.resetAt > Date.now() ? current.count : 0) + 1, resetAt });
    return reply.code(401).send({ message: 'PIN administrativo inválido' });
  }
  if(role!=='ADMIN'&&!body.operatorId)return reply.code(400).send({message:'Selecione seu usuário para registrar as consultas.'});
  const seller=role==='ADMIN'?undefined:(await bling.sellers()).find(item=>item.id===body.operatorId&&item.active);
  if(role!=='ADMIN'&&!seller)return reply.code(401).send({message:'Usuário operacional inválido.'});
  loginAttempts.delete(address);
  const principal = role==='ADMIN'
    ? { operatorId: 'admin', operatorName: process.env.PDV_ADMIN_NAME || 'Administrador', role: 'ADMIN' as const }
    : { operatorId: seller!.id, operatorName: seller!.name, role };
  return { token: issueToken(principal), principal };
});

app.get('/integrations/status', async (req) => {
  const refresh = (req.query as { refresh?: string }).refresh === '1';
  if (!refresh && integrationStatusCache && integrationStatusCache.expires > Date.now()) return integrationStatusCache.value;
  if (!integrationStatusPromise) {
    integrationStatusPromise = (async () => {
      const value = {
        bling: await getBlingConnectionStatus(),
        fidelizaPlus: await getFidelizeiConnectionStatus(),
        fiscal: await bling.getFiscalCapability()
      };
      integrationStatusCache = { expires: Date.now() + 60_000, value };
      return value;
    })().finally(() => { integrationStatusPromise = undefined; });
  }
  return integrationStatusPromise;
});
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
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
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
app.post('/catalog/products/sync', async (req) => { requireManager(req); return { synced: await bling.syncProducts() }; });
app.get('/catalog/products', async (req) => {
  const query = (req.query as { query?: string }).query ?? '';
  return bling.products(query);
});
app.get('/catalog/sellers', async () => bling.sellers());
app.get('/catalog/payment-methods', async () => bling.paymentMethods());
app.get('/catalog/financial-categories', async () => bling.financialCategories());
const todayInSaoPaulo = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const requireDatabase = () => {
  if (!pool) throw Object.assign(new Error('Banco de dados do PDV indisponível para operações de caixa'), { statusCode: 503 });
  return pool;
};
const currentCashSession = async (operatorId: string) => {
  const database = requireDatabase();
  const result = await database.query(
    `select id, operator_id as "operatorId", seller_id as "sellerId", account_id as "accountId",
      account_name as "accountName", channel_id as "channelId", channel_name as "channelName",
      business_unit_id as "businessUnitId", business_unit_name as "businessUnitName",
      status, opening_amount::float8 as "openingAmount",
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
      account_name as "accountName", channel_id as "channelId", channel_name as "channelName",
      business_unit_id as "businessUnitId", business_unit_name as "businessUnitName",
      status, opening_amount::float8 as "openingAmount",
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

const writeAdminAudit = async (req: any, action: string, entityType: string, entityId: string, previousValue?: unknown, newValue?: unknown) => {
  const database = requireDatabase();
  const principal = principalFromRequest(req);
  await database.query(`insert into pdv_admin_audit_logs
    (id,actor_id,actor_name,actor_role,action,entity_type,entity_id,previous_value,new_value,ip_address,terminal)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)`, [
    randomUUID(), principal?.operatorId ?? 'legacy-session', principal?.operatorName ?? 'Operador do PDV', principal?.role ?? 'OPERATOR',
    action, entityType, entityId, previousValue === undefined ? null : JSON.stringify(previousValue),
    newValue === undefined ? null : JSON.stringify(newValue), req.ip ?? null,
    String(req.headers?.['x-pdv-terminal'] ?? req.headers?.['user-agent'] ?? '').slice(0, 300) || null
  ]);
};

const adminSaleFilters = (req: any, query: Record<string, string | undefined>, values: unknown[], where: string[], alias = 'data') => {
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.from) where.push(`(${alias}->>'createdAt')::timestamptz >= ${add(`${query.from}T00:00:00-03:00`)}::timestamptz`);
  if (query.to) where.push(`(${alias}->>'createdAt')::timestamptz < (${add(`${query.to}T00:00:00-03:00`)}::timestamptz + interval '1 day')`);
  if (query.number?.trim()) where.push(`coalesce(${alias}->>'blingOrderNumber','') ilike ${add(`%${query.number.trim()}%`)}`);
  if (query.customer?.trim()) where.push(`(coalesce(${alias}#>>'{customer,name}','') ilike ${add(`%${query.customer.trim()}%`)} or coalesce(${alias}#>>'{customer,cpf}','') ilike ${add(`%${query.customer.trim()}%`)})`);
  if (query.operator?.trim()) where.push(`coalesce(${alias}->>'operatorId','') ilike ${add(`%${query.operator.trim()}%`)}`);
  if (query.paymentMethod?.trim()) where.push(`exists(select 1 from jsonb_array_elements(coalesce(${alias}->'payments','[]'::jsonb)) p where coalesce(p->>'paymentMethodName',p->>'paymentMethodId','') ilike ${add(`%${query.paymentMethod.trim()}%`)})`);
  if (query.status && query.status !== 'ALL') where.push(`${alias}->>'status'=${add(query.status)}`);
  const principal = principalFromRequest(req);
  if (principal?.role === 'OPERATOR') where.push(`${alias}->>'operatorId'=${add(principal.operatorId)}`);
  return add;
};

// Área administrativa independente do terminal: consultas paginadas, relatórios,
// reconciliação financeira e operações de caixa com trilha de auditoria.
app.get('/admin/dashboard', async (req) => {
  const principal = requireAdminViewer(req);
  const database = requireDatabase();
  const query = req.query as { from?: string; to?: string };
  const today = todayInSaoPaulo();
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = query.from || monthStart;
  const to = query.to || today;
  const values: unknown[] = [`${from}T00:00:00-03:00`, `${to}T00:00:00-03:00`];
  const ownFilter = principal?.role === 'OPERATOR' ? ` and data->>'operatorId'=$3` : '';
  if (ownFilter) values.push(principal!.operatorId);
  const result = await database.query(`select data from pdv_sales where status in ('COMPLETED','RECONCILIATION_REQUIRED')
    and (data->>'createdAt')::timestamptz >= $1::timestamptz and (data->>'createdAt')::timestamptz < ($2::timestamptz + interval '1 day')${ownFilter}
    order by (data->>'createdAt')::timestamptz`, values) as { rows: { data: Sale }[] };
  const salesInRange = result.rows.map(row => row.data);
  const daySales = salesInRange.filter(sale => sale.createdAt.slice(0, 10) === today);
  const monthSales = salesInRange.filter(sale => sale.createdAt.slice(0, 7) === today.slice(0, 7));
  const group = (map: Map<string, number>, key: string, amount: number) => map.set(key, money((map.get(key) ?? 0) + amount));
  const salesByDay = new Map<string, number>(), methods = new Map<string, number>(), products = new Map<string, number>(), operators = new Map<string, { count: number; total: number }>();
  const clients = new Set<string>();
  for (const sale of salesInRange) {
    group(salesByDay, sale.createdAt.slice(0, 10), sale.total);
    clients.add(sale.customer?.cpf || sale.customer?.name || 'Consumidor Final');
    const operator = operators.get(sale.operatorId) ?? { count: 0, total: 0 };
    operator.count++; operator.total = money(operator.total + sale.total); operators.set(sale.operatorId, operator);
    for (const payment of sale.payments ?? []) group(methods, payment.paymentMethodName || payment.paymentMethodId, payment.amount);
    for (const item of sale.items) group(products, item.name, item.quantity);
  }
  const lastCash = await database.query(`select max(opened_at) as "lastOpen",max(closed_at) as "lastClose" from pdv_cash_sessions ${principal?.role==='OPERATOR'?'where operator_id=$1':''}`,
    principal?.role==='OPERATOR'?[principal.operatorId]:[]) as { rows: any[] };
  const openSessions = await database.query(`select id from pdv_cash_sessions where status='OPEN'${principal?.role === 'OPERATOR' ? ' and operator_id=$1' : ''}`,
    principal?.role === 'OPERATOR' ? [principal.operatorId] : []) as { rows: { id: string }[] };
  let currentCashBalance = 0;
  for (const session of openSessions.rows) currentCashBalance = money(currentCashBalance + (await cashSessionSnapshot(session.id)).expectedCash);
  let sellerNames: Record<string,string> = {};
  try { sellerNames = Object.fromEntries((await bling.sellers()).map(seller => [seller.id, seller.name])); } catch { /* relatórios seguem disponíveis sem o Bling */ }
  return {
    period: { from, to },
    kpis: { salesToday: money(daySales.reduce((n, sale) => n + sale.total, 0)), salesMonth: money(monthSales.reduce((n, sale) => n + sale.total, 0)),
      orders: salesInRange.length, averageTicket: salesInRange.length ? money(salesInRange.reduce((n, sale) => n + sale.total, 0) / salesInRange.length) : 0,
      customers: clients.size, currentCashBalance, activeCashSessions: openSessions.rows.length },
    charts: { salesByDay: [...salesByDay].map(([date,total]) => ({date,total})), payments: [...methods].map(([name,total]) => ({name,total})),
      products: [...products].map(([name,quantity]) => ({name,quantity})).sort((a,b)=>b.quantity-a.quantity).slice(0,10),
      operators: [...operators].map(([id,value]) => ({id,name:sellerNames[id]??id,...value})).sort((a,b)=>b.total-a.total).slice(0,10) },
    lastCashOpen: lastCash.rows[0]?.lastOpen,
    lastCashClose: lastCash.rows[0]?.lastClose
  };
});

app.get('/admin/sales', async (req) => {
  requireAdminViewer(req);
  const database = requireDatabase();
  const query = req.query as Record<string,string|undefined>;
  const values: unknown[] = [];
  const filters: string[] = [`status in ('COMPLETED','RECONCILIATION_REQUIRED','SYNC_FAILED','PROCESSING','CANCELLED','DELETED','OPEN')`];
  const add = adminSaleFilters(req, query, values, filters);
  const page = Math.max(1, Number(query.page)||1), pageSize = Math.max(10, Math.min(100, Number(query.pageSize)||25));
  const orderBy: Record<string,string> = { date:`(data->>'createdAt')::timestamptz`, number:`coalesce(data->>'blingOrderNumber','')`, customer:`coalesce(data#>>'{customer,name}','')`, total:`(data->>'total')::numeric`, status:`data->>'status'` };
  const sort = orderBy[query.sort||'date'] || orderBy.date, direction = query.direction === 'asc' ? 'asc' : 'desc';
  const where = `where ${filters.join(' and ')}`;
  const summary = await database.query(`select count(*)::int count,coalesce(sum((data->>'total')::numeric),0)::float8 total,coalesce(sum((data->>'discount')::numeric),0)::float8 discount from pdv_sales ${where}`,values) as { rows:any[] };
  values.push(pageSize, (page-1)*pageSize);
  const rows = await database.query(`select data from pdv_sales ${where} order by ${sort} ${direction} nulls last limit $${values.length-1} offset $${values.length}`,values) as { rows:{data:Sale}[] };
  return { orders: rows.rows.map(row=>row.data), page, pageSize, totalRows: summary.rows[0]?.count??0, summary: summary.rows[0] };
});

app.get('/admin/sales/:id', async (req) => {
  const principal = requireAdminViewer(req);
  const sale = await getSale((req.params as {id:string}).id);
  if (!sale) return badRequest('Pedido não encontrado');
  if (principal?.role==='OPERATOR'&&sale.operatorId!==principal.operatorId) throw Object.assign(new Error('Sem permissão para consultar este pedido'),{statusCode:403});
  return sale;
});

app.post('/admin/sales/:id/cancel', async (req) => {
  requireAdmin(req);
  const id = (req.params as {id:string}).id, sale = await getSale(id);
  if (!sale) return badRequest('Pedido não encontrado');
  if (sale.status==='CANCELLED') return sale;
  if (sale.status==='DELETED') return badRequest('Pedido excluído não pode ser cancelado');
  if (!sale.blingOrderId) return badRequest('Pedido sem vínculo com o Bling');
  const before = { status:sale.status, total:sale.total, payments:sale.payments };
  const result = sale.status==='OPEN' ? await bling.cancelDraftOrder(sale.blingOrderId) : await bling.cancelOrder(sale.blingOrderId);
  let loyaltyWarning: string|undefined;
  if (sale.fidelizeiTransactionId) try { await fidelizei.reverseSale(sale.id); } catch (error) { loyaltyWarning=error instanceof Error?error.message.slice(0,400):'Estorno Fidelizei pendente'; }
  if (pool&&['COMPLETED','RECONCILIATION_REQUIRED'].includes(sale.status)) await pool.query(`update bling_products product set stock=product.stock+item.quantity from jsonb_to_recordset($1::jsonb) as item("productId" text,quantity numeric) where product.id=item."productId"`,[JSON.stringify(sale.items.map(item=>({productId:item.productId,quantity:item.quantity})))]);
  sale.status='CANCELLED'; sale.cancelledAt=new Date().toISOString(); Object.assign(sale,{cancellationKind:'CANCELLED',lastError:loyaltyWarning});
  await persist(sale); await writeAdminAudit(req,'CANCEL','sale',sale.id,before,{status:sale.status,total:sale.total,operatorId:sale.operatorId});
  return {...sale,cancelledInBling:true,loyaltyWarning,blingWarnings:result.warnings};
});

app.get('/admin/finance', async (req) => {
  const principal=requireAdminViewer(req), database=requireDatabase();
  const query=req.query as {from?:string;to?:string}; const today=todayInSaoPaulo();
  const from=query.from||`${today.slice(0,7)}-01`,to=query.to||today;
  const values:unknown[]=[`${from}T00:00:00-03:00`,`${to}T00:00:00-03:00`];
  const own=principal?.role==='OPERATOR'?' and s.data->>\'operatorId\'=$3':''; if(own)values.push(principal!.operatorId);
  const result=await database.query(`select coalesce(p->>'paymentMethodName',p->>'paymentMethodId','Outros') name,count(*)::int transactions,coalesce(sum((p->>'amount')::numeric),0)::float8 total from pdv_sales s cross join lateral jsonb_array_elements(coalesce(s.data->'payments','[]'::jsonb)) p where s.status in ('COMPLETED','RECONCILIATION_REQUIRED') and (s.data->>'createdAt')::timestamptz >= $1::timestamptz and (s.data->>'createdAt')::timestamptz < ($2::timestamptz+interval '1 day')${own} group by 1 order by total desc`,values) as {rows:any[]};
  const total=result.rows.reduce((sum,row)=>sum+Number(row.total),0);
  return {period:{from,to},total:money(total),methods:result.rows.map(row=>({...row,total:money(Number(row.total)),average:row.transactions?money(Number(row.total)/row.transactions):0,share:total?Number((Number(row.total)/total*100).toFixed(2)):0}))};
});

app.get('/admin/cash/sessions', async (req) => {
  const principal=requireAdminViewer(req),database=requireDatabase(); const query=req.query as Record<string,string|undefined>;
  const values:unknown[]=[],filters:string[]=[]; const add=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(query.from)filters.push(`(c.opened_at at time zone 'America/Sao_Paulo')::date>=${add(query.from)}::date`);
  if(query.to)filters.push(`(c.opened_at at time zone 'America/Sao_Paulo')::date<=${add(query.to)}::date`);
  if(query.status&&query.status!=='ALL')filters.push(`c.status=${add(query.status)}`);
  if(query.search?.trim())filters.push(`c.operator_id ilike ${add(`%${query.search.trim()}%`)}`);
  if(principal?.role==='OPERATOR')filters.push(`c.operator_id=${add(principal.operatorId)}`);
  const page=Math.max(1,Number(query.page)||1),pageSize=Math.max(10,Math.min(100,Number(query.pageSize)||25));
  const where=filters.length?`where ${filters.join(' and ')}`:'';
  const count=await database.query(`select count(*)::int count from pdv_cash_sessions c ${where}`,values) as {rows:any[]};
  values.push(pageSize,(page-1)*pageSize);
  const result=await database.query(`select c.id,c.operator_id "operatorId",c.status,c.opening_amount::float8 "openingAmount",c.opened_at "openedAt",c.closed_at "closedAt",c.closing_summary "closingSummary",coalesce(v.version,0)::int "closingVersion",coalesce(s.count,0)::int "salesCount",coalesce(s.total,0)::float8 "salesTotal" from pdv_cash_sessions c left join lateral(select max(version) version from pdv_cash_closing_versions where session_id=c.id) v on true left join lateral(select count(*) count,coalesce(sum((data->>'total')::numeric),0) total from pdv_sales where data->>'cashSessionId'=c.id::text and status in ('COMPLETED','RECONCILIATION_REQUIRED')) s on true ${where} order by c.opened_at desc limit $${values.length-1} offset $${values.length}`,values) as {rows:any[]};
  return {sessions:result.rows,page,pageSize,totalRows:count.rows[0]?.count??0};
});

app.get('/admin/cash/sessions/:id', async (req) => {
  const principal=requireAdminViewer(req),id=(req.params as {id:string}).id,snapshot=await cashSessionSnapshot(id);
  if(principal?.role==='OPERATOR'&&snapshot.session.operatorId!==principal.operatorId)throw Object.assign(new Error('Sem permissão para consultar este caixa'),{statusCode:403});
  const database=requireDatabase();
  const versions=await database.query(`select version,closing_summary "closingSummary",closed_at "closedAt",closed_by "closedBy" from pdv_cash_closing_versions where session_id=$1 order by version`,[id]) as {rows:any[]};
  const reopenings=await database.query(`select id,closing_version "closingVersion",justification,reopened_by "reopenedBy",reopened_at "reopenedAt" from pdv_cash_reopenings where session_id=$1 order by reopened_at`,[id]) as {rows:any[]};
  const sales=snapshot.salesRows.map((row:any)=>row.data);
  return {...snapshot,sales,versions:versions.rows,reopenings:reopenings.rows};
});

app.post('/admin/cash/sessions/open', async (req) => {
  const principal=requireAdmin(req),body=req.body as {operatorId?:string;accountId?:string;channelId?:string;businessUnitId?:string;openingAmount?:number};
  if(!body.operatorId||!body.accountId||!body.channelId)return badRequest('Informe operador, conta e loja');
  if(await currentCashSession(body.operatorId))return conflict('Este operador já possui um caixa aberto');
  const [accounts,channels,sellers]=await Promise.all([bling.financialAccounts(),bling.salesChannels(),bling.sellers()]);
  const account=accounts.find(item=>item.id===body.accountId&&item.active),channel=channels.find(item=>item.id===body.channelId&&item.active),seller=sellers.find(item=>item.id===body.operatorId&&item.active);
  if(!account||!channel||!seller)return badRequest('Operador, conta ou loja inválidos/inativos no Bling');
  const businessUnitId=body.businessUnitId??channel.businessUnitId;
  if(channel.id!=='DEFAULT'&&!businessUnitId)return badRequest('A loja não possui unidade de negócio vinculada');
  const id=randomUUID(),amount=money(Math.max(0,Number(body.openingAmount)||0));
  await withTransaction(async client=>{await client.query(`insert into pdv_cash_sessions(id,operator_id,seller_id,account_id,account_name,channel_id,channel_name,business_unit_id,business_unit_name,status,opening_amount) values($1,$2,$2,$3,$4,$5,$6,$7,$8,'OPEN',$9)`,[id,seller.id,account.id,account.name,channel.id,channel.name,businessUnitId??null,channel.businessUnitName??null,amount]);
    await client.query(`insert into pdv_cash_operations(id,session_id,operation_type,amount,data) values($1,$2,'OPENING',$3,$4::jsonb)`,[randomUUID(),id,amount,JSON.stringify({controlOnly:true,syncStatus:'NOT_REQUIRED',source:'ADMIN'})]);});
  const session=await cashSessionById(id);await writeAdminAudit(req,'OPEN','cash_session',id,null,{session,openedBy:principal?.operatorName});return {session};
});

app.post('/admin/cash/sessions/:id/movements', async (req) => {
  const principal=requireAdmin(req),id=(req.params as {id:string}).id,body=req.body as {type?:'WITHDRAWAL'|'SUPPLY';amount?:number;notes?:string};
  if(!['WITHDRAWAL','SUPPLY'].includes(String(body.type)))return badRequest('Selecione sangria ou suprimento');
  const notes=body.notes?.trim();if(!notes||notes.length<4)return badRequest('Informe uma justificativa para a movimentação');
  const amount=money(Number(body.amount));if(!(amount>0))return badRequest('Informe um valor maior que zero');
  const database=requireDatabase(),session=await cashSessionById(id);if(!session||session.status!=='OPEN')return conflict('A movimentação exige um caixa aberto');
  const operationId=randomUUID();await database.query(`insert into pdv_cash_operations(id,session_id,operation_type,amount,data) values($1,$2,$3,$4,$5::jsonb)`,[operationId,id,body.type,amount,JSON.stringify({notes,source:'ADMIN',syncStatus:'PENDING'})]);
  await writeAdminAudit(req,body.type==='WITHDRAWAL'?'SANGRIA':'SUPRIMENTO','cash_movement',operationId,null,{sessionId:id,amount,notes});
  try{const entry=await bling.createCashEntry({type:body.type as 'WITHDRAWAL'|'SUPPLY',amount,accountId:session.accountId,notes:`${notes} · PDV ${operationId}`,date:todayInSaoPaulo()});await database.query(`update pdv_cash_operations set bling_entry_id=$2,data=data||'{"syncStatus":"SYNCED"}'::jsonb where id=$1`,[operationId,entry.id??null]);return {id:operationId,blingEntryId:entry.id,registeredInBling:true};}
  catch(error){const message=error instanceof Error?error.message:'Falha desconhecida';await database.query(`update pdv_cash_operations set data=data||$2::jsonb where id=$1`,[operationId,JSON.stringify({syncStatus:'FAILED',lastError:message.slice(0,500)})]);await writeAdminAudit(req,'MOVEMENT_SYNC_FAILED','cash_movement',operationId,{syncStatus:'PENDING'},{syncStatus:'FAILED',error:message.slice(0,500)});throw error;}
});

app.post('/admin/cash/sessions/:id/reopen', async (req) => {
  const principal=requireAdmin(req),id=(req.params as {id:string}).id,body=req.body as {justification?:string};
  const justification=body.justification?.trim();if(!justification||justification.length<8)return badRequest('Justificativa obrigatória (mínimo de 8 caracteres)');
  const database=requireDatabase(),session=await cashSessionById(id);if(!session)return badRequest('Caixa não encontrado');if(session.status!=='CLOSED')return conflict('Somente caixa fechado pode ser reaberto');
  if(await currentCashSession(session.operatorId))return conflict('O operador já possui outro caixa aberto');
  const version=await database.query('select coalesce(max(version),1)::int version from pdv_cash_closing_versions where session_id=$1',[id]) as {rows:any[]};
  const closingVersion=version.rows[0]?.version??1;
  await withTransaction(async client=>{
    await client.query(`insert into pdv_cash_reopenings(id,session_id,closing_version,justification,reopened_by,previous_summary) values($1,$2,$3,$4,$5,$6::jsonb)`,[randomUUID(),id,closingVersion,justification,principal?.operatorName??principal?.operatorId,JSON.stringify(session.closingSummary??{})]);
    const reopened=await client.query(`update pdv_cash_sessions set status='OPEN',closed_at=null,closing_summary=null where id=$1 and status='CLOSED' returning id`,[id]) as {rows:unknown[]};
    if(!reopened.rows[0])return conflict('Caixa foi alterado por outro usuário');
    await client.query(`insert into pdv_cash_operations(id,session_id,operation_type,amount,data) values($1,$2,'REOPENING',0,$3::jsonb)`,[randomUUID(),id,JSON.stringify({controlOnly:true,source:'ADMIN',justification,actor:principal?.operatorName})]);
  });
  const updated=await cashSessionById(id);await writeAdminAudit(req,'REOPEN','cash_session',id,{status:'CLOSED',closingSummary:session.closingSummary},{status:'OPEN',justification,closingVersion});return {session:updated,closingVersion};
});

app.post('/admin/cash/sessions/:id/close', async (req) => {
  const principal=requireAdminOrManager(req),id=(req.params as {id:string}).id,body=req.body as {countedValues?:{name:string;amount:number}[];notes?:string};
  const snapshot=await cashSessionSnapshot(id);if(snapshot.session.status!=='OPEN')return conflict('Caixa não está aberto');
  if(principal?.role==='OPERATOR'&&snapshot.session.operatorId!==principal.operatorId)throw Object.assign(new Error('Sem permissão para fechar este caixa'),{statusCode:403});
  const expected=new Map(snapshot.paymentTotals.map(item=>[item.name,item.amount]));const cashName=[...expected.keys()].find(name=>/dinheiro|cash/i.test(name))??'Dinheiro';expected.set(cashName,snapshot.expectedCash);
  const countedValues=body.countedValues?.length?body.countedValues:[...expected].map(([name,amount])=>({name,amount}));
  const counted=new Map(countedValues.map(item=>[item.name,money(Number(item.amount)||0)]));
  const reconciliation=[...new Set([...expected.keys(),...counted.keys()])].map(name=>({name,expected:money(expected.get(name)??0),counted:money(counted.get(name)??0),difference:money((counted.get(name)??0)-(expected.get(name)??0))}));
  const summary={closedAt:new Date().toISOString(),countedValues,reconciliation,totalDifference:money(reconciliation.reduce((sum,item)=>sum+item.difference,0)),expectedCash:snapshot.expectedCash,notes:body.notes?.trim()||undefined,closedBy:principal?.operatorName};
  const version=await withTransaction(async client=>{
    const update=await client.query(`update pdv_cash_sessions set status='CLOSED',closed_at=now(),closing_summary=$2::jsonb where id=$1 and status='OPEN' returning closed_at`,[id,JSON.stringify(summary)]) as {rows:any[]};if(!update.rows[0])return conflict('Caixa foi alterado por outro usuário');
    const versionResult=await client.query('select coalesce(max(version),0)::int version from pdv_cash_closing_versions where session_id=$1',[id]) as {rows:any[]};const version=(versionResult.rows[0]?.version??0)+1;
    await client.query(`insert into pdv_cash_closing_versions(id,session_id,version,closing_summary,closed_at,closed_by) values($1,$2,$3,$4::jsonb,$5,$6)`,[randomUUID(),id,version,JSON.stringify(summary),update.rows[0].closed_at,principal?.operatorName??principal?.operatorId]);
    await client.query(`insert into pdv_cash_operations(id,session_id,operation_type,amount,data) values($1,$2,'CLOSING',0,$3::jsonb)`,[randomUUID(),id,JSON.stringify({controlOnly:true,source:'ADMIN',version,summary})]);
    return version;
  });
  await writeAdminAudit(req,'CLOSE','cash_session',id,{status:'OPEN'},{status:'CLOSED',version,summary});return {closed:true,version,summary};
});

app.get('/admin/audit', async (req) => {
  const principal=requireAdminViewer(req),database=requireDatabase(),query=req.query as {from?:string;to?:string;action?:string;page?:string;pageSize?:string};
  const values:unknown[]=[],filters:string[]=[];const add=(value:unknown)=>{values.push(value);return `$${values.length}`;};
  if(query.from)filters.push(`created_at>=${add(`${query.from}T00:00:00-03:00`)}::timestamptz`);if(query.to)filters.push(`created_at<(${add(`${query.to}T00:00:00-03:00`)}::timestamptz+interval '1 day')`);if(query.action&&query.action!=='ALL')filters.push(`action=${add(query.action)}`);if(principal?.role==='OPERATOR')filters.push(`actor_id=${add(principal.operatorId)}`);
  const page=Math.max(1,Number(query.page)||1),pageSize=Math.max(10,Math.min(100,Number(query.pageSize)||25)),where=filters.length?`where ${filters.join(' and ')}`:'';
  const count=await database.query(`select count(*)::int count from pdv_admin_audit_logs ${where}`,values) as {rows:any[]};values.push(pageSize,(page-1)*pageSize);
  const result=await database.query(`select id,actor_id "actorId",actor_name "actorName",actor_role "actorRole",action,entity_type "entityType",entity_id "entityId",previous_value "previousValue",new_value "newValue",ip_address "ipAddress",terminal,created_at "createdAt" from pdv_admin_audit_logs ${where} order by created_at desc limit $${values.length-1} offset $${values.length}`,values) as {rows:any[]};
  return {events:result.rows,page,pageSize,totalRows:count.rows[0]?.count??0};
});

app.get('/admin/audit/order-customers', async (req) => {
  requireAdminOrManager(req);
  const database = requireDatabase();
  const query = req.query as { from?: string; to?: string; number?: string; page?: string };
  const values: unknown[] = [];
  const filters = ["a.entity_type = 'sale'", "a.action in ('CUSTOMER_INITIAL','CUSTOMER_CHANGED','BLING_CONTACT_BASELINE','BLING_CONTACT_MISMATCH','BLING_CONTACT_CHANGED')"];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.from) filters.push(`(s.data->>'createdAt')::timestamptz >= (${add(query.from)}::date::timestamp at time zone 'America/Sao_Paulo')`);
  if (query.to) filters.push(`(s.data->>'createdAt')::timestamptz < ((${add(query.to)}::date + 1)::timestamp at time zone 'America/Sao_Paulo')`);
  if (query.number?.trim()) filters.push(`s.data->>'blingOrderNumber' = ${add(query.number.trim())}`);
  const where = `where ${filters.join(' and ')}`;
  const page = Math.max(1, Number(query.page) || 1), pageSize = 25;
  const count = await database.query(`select count(*)::int count from pdv_admin_audit_logs a left join pdv_sales s on s.id::text=a.entity_id ${where}`, values) as { rows: { count: number }[] };
  values.push(pageSize, (page - 1) * pageSize);
  const result = await database.query(`select a.id,a.action,a.previous_value "previousValue",a.new_value "newValue",a.actor_name "observer",a.created_at "createdAt",s.data->>'blingOrderNumber' "orderNumber",s.data->>'status' "saleStatus"
    from pdv_admin_audit_logs a left join pdv_sales s on s.id::text=a.entity_id ${where}
    order by a.created_at desc limit $${values.length - 1} offset $${values.length}`, values) as { rows: unknown[] };
  return { events: result.rows, page, pageSize, totalRows: count.rows[0]?.count ?? 0 };
});

app.post('/admin/audit/order-customers/check', async (req) => {
  requireAdminOrManager(req);
  const database = requireDatabase();
  const body = (req.body ?? {}) as { from?: string; to?: string; page?: number; number?: string };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(body.to ?? '') || body.from! > body.to!) return badRequest('Informe um período válido para conferir os pedidos');
  const page = Math.max(1, Number(body.page) || 1);
  const values: unknown[] = [body.from, body.to];
  const numberFilter = body.number?.trim() ? `and data->>'blingOrderNumber' = $3` : '';
  if (numberFilter) values.push(body.number!.trim());
  values.push(20, (page - 1) * 20);
  const rows = await database.query(`select data from pdv_sales where (data->>'createdAt')::timestamptz >= ($1::date::timestamp at time zone 'America/Sao_Paulo') and (data->>'createdAt')::timestamptz < (($2::date + 1)::timestamp at time zone 'America/Sao_Paulo') ${numberFilter} and data->>'blingOrderId' is not null
    order by data->>'createdAt' desc limit $${values.length - 1} offset $${values.length}`, values) as { rows: { data: Sale }[] };
  let mismatches = 0, recorded = 0;
  const errors: { orderNumber?: string; message: string }[] = [];
  for (const { data: sale } of rows.rows) {
    try {
      const current = await bling.getOrderContact(sale.blingOrderId!);
      const expected = { id: sale.customer?.bling?.id, name: sale.customer?.name ?? 'Consumidor Final', cpf: sale.customer?.cpf };
      const mismatch = expected.id ? current.id !== expected.id : expected.cpf
        ? current.cpf !== expected.cpf
        : current.name.trim().toLocaleLowerCase('pt-BR') !== 'consumidor final' || Boolean(current.cpf);
      if (mismatch) mismatches++;
      const previous = await database.query(`select new_value "newValue" from pdv_admin_audit_logs where entity_type='sale' and entity_id=$1 and action in ('BLING_CONTACT_BASELINE','BLING_CONTACT_MISMATCH','BLING_CONTACT_CHANGED') order by created_at desc limit 1`, [sale.id]) as { rows: { newValue?: { bling?: typeof current } }[] };
      const prior = previous.rows[0]?.newValue?.bling;
      const changed = prior && (prior.id !== current.id || prior.name !== current.name || prior.cpf !== current.cpf);
      if (!prior || changed) {
        const action = changed ? 'BLING_CONTACT_CHANGED' : mismatch ? 'BLING_CONTACT_MISMATCH' : 'BLING_CONTACT_BASELINE';
        await writeAdminAudit(req, action, 'sale', sale.id,
          prior ? { bling: prior } : { pdv: expected },
          { bling: current, pdv: expected, blingOrderNumber: sale.blingOrderNumber,
            reason: changed ? 'Mudança no contato do Bling detectada entre duas conferências; autor e momento exato não disponíveis nesta integração' : mismatch ? 'Divergência entre o cliente salvo no PDV e o contato atual do Bling; momento da alteração desconhecido' : 'Primeira conferência do contato atual no Bling' });
        recorded++;
      }
    } catch (error) {
      errors.push({ orderNumber: sale.blingOrderNumber, message: error instanceof Error ? error.message : 'Falha ao consultar pedido no Bling' });
    }
  }
  return { checked: rows.rows.length, mismatches, recorded, errors, page, hasMore: rows.rows.length === 20 };
});

app.get('/admin/catalog', async () => { const [sellers,paymentMethods,configuration]=await Promise.all([bling.sellers(),bling.paymentMethods(),Promise.all([bling.financialAccounts(),bling.salesChannels()])]);return {sellers,paymentMethods,accounts:configuration[0],channels:configuration[1]}; });

app.get('/cash/accounts', async () => bling.financialAccounts());
app.get('/cash/configuration', async () => {
  const [accounts, channels] = await Promise.all([bling.financialAccounts(), bling.salesChannels()]);
  return { accounts, channels };
});
app.get('/cash/sessions', async (req) => {
  requireManager(req);
  const query = req.query as { from?: string; to?: string; status?: string; search?: string; limit?: string };
  const database = requireDatabase();
  const values: unknown[] = [];
  const filters: string[] = [];
  const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (query.from) filters.push(`(session.opened_at at time zone 'America/Sao_Paulo')::date >= ${add(query.from)}::date`);
  if (query.to) filters.push(`(session.opened_at at time zone 'America/Sao_Paulo')::date <= ${add(query.to)}::date`);
  if (query.status && ['OPEN', 'CLOSED'].includes(query.status)) filters.push(`session.status = ${add(query.status)}`);
  if (query.search?.trim()) {
    const term = add(`%${query.search.trim()}%`);
    filters.push(`(session.operator_id ilike ${term} or coalesce(session.channel_name,'') ilike ${term} or session.account_name ilike ${term})`);
  }
  const limit = Math.max(1, Math.min(300, Number(query.limit) || 100));
  values.push(limit);
  const result = await database.query(
    `select session.id, session.operator_id as "operatorId", session.seller_id as "sellerId",
      session.account_id as "accountId", session.account_name as "accountName",
      session.channel_id as "channelId", session.channel_name as "channelName",
      session.business_unit_id as "businessUnitId", session.business_unit_name as "businessUnitName",
      session.status, session.opening_amount::float8 as "openingAmount", session.opened_at as "openedAt",
      session.closed_at as "closedAt", session.closing_summary as "closingSummary",
      coalesce(stats.sales_count,0)::int as "salesCount", coalesce(stats.sales_total,0)::float8 as "salesTotal"
     from pdv_cash_sessions session
     left join lateral (
       select count(*) as sales_count, coalesce(sum((sale.data->>'total')::numeric),0) as sales_total
       from pdv_sales sale where sale.data->>'cashSessionId'=session.id::text
         and sale.status in ('COMPLETED','RECONCILIATION_REQUIRED')
     ) stats on true
     ${filters.length ? `where ${filters.join(' and ')}` : ''}
     order by session.opened_at desc limit $${values.length}`,
    values
  ) as { rows: any[] };
  return { sessions: result.rows, count: result.rows.length };
});
app.get('/cash/sessions/current', async (req) => {
  const operatorId = principalFromRequest(req)?.operatorId ?? String((req.query as { operatorId?: string }).operatorId ?? '');
  if (!operatorId) return badRequest('Informe o operador do caixa');
  return { session: await currentCashSession(operatorId) ?? null };
});
app.post('/cash/sessions/open', async (req) => {
  const body = req.body as { operatorId?: string; sellerId?: string; accountId?: string; channelId?: string; businessUnitId?: string; openingAmount?: number };
  const operatorId = principalFromRequest(req)?.operatorId ?? body.operatorId;
  if (!operatorId || !body.accountId || !body.channelId) return badRequest('Operador, loja e conta financeira do Bling são obrigatórios');
  if (await currentCashSession(operatorId)) return badRequest('Este operador já possui um caixa aberto');
  const accounts = await bling.financialAccounts();
  const account = accounts.find(item => item.id === body.accountId);
  if (!account) return badRequest('Conta financeira não encontrada ou inativa no Bling');
  const channels = await bling.salesChannels();
  const channel = channels.find(item => item.id === body.channelId);
  if (!channel) return badRequest('Loja/canal de venda não encontrado ou inativo no Bling');
  const useDefaultRouting = channel.id === 'DEFAULT';
  const businessUnitId = body.businessUnitId ?? channel.businessUnitId;
  if (!useDefaultRouting && !businessUnitId) return badRequest('A loja selecionada não possui unidade de negócio vinculada no Bling');
  const businessUnitName = useDefaultRouting ? 'Configuração padrão' : channel.businessUnitName ?? 'Unidade do Bling';
  const openingAmount = money(Math.max(0, Number(body.openingAmount) || 0));
  const sessionId = randomUUID();
  const operationId = randomUUID();
  await withTransaction(async client => {
    await client.query(
      `insert into pdv_cash_sessions (id, operator_id, seller_id, account_id, account_name, channel_id, channel_name,
         business_unit_id, business_unit_name, status, opening_amount)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN',$10)`,
      [sessionId, operatorId, body.sellerId ?? operatorId, account.id, account.name, channel.id, channel.name,
        businessUnitId, businessUnitName, openingAmount]
    );
    await client.query(
      `insert into pdv_cash_operations (id, session_id, operation_type, amount, data)
       values ($1,$2,'OPENING',$3,$4::jsonb)`,
      [operationId, sessionId, openingAmount, JSON.stringify({ account, syncStatus: 'NOT_REQUIRED', controlOnly: true })]
    );
  });
  return { session: await currentCashSession(operatorId), openingSyncStatus: 'NOT_REQUIRED', controlOnly: true };
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
    canClose: true
  };
});
app.get('/cash/control', async (req) => {
  requireManager(req);
  const query = req.query as { sessionId?: string };
  if (!query.sessionId) return badRequest('Informe a sessão de caixa');
  const snapshot = await cashSessionSnapshot(query.sessionId);
  const sales = snapshot.salesRows.map((row: { data: Sale }) => ({
    id: row.data.id,
    orderId: row.data.blingOrderId,
    orderNumber: row.data.blingOrderNumber,
    createdAt: row.data.createdAt,
    total: row.data.total,
    subtotal: row.data.subtotal,
    discount: row.data.discount ?? 0,
    customerName: row.data.customer?.name ?? 'Consumidor Final',
    status: row.data.status,
    payments: row.data.payments ?? []
  }));
  return {
    session: snapshot.session,
    sales,
    salesCount: sales.length,
    salesTotal: money(sales.reduce((sum: number, sale: { total: number }) => sum + sale.total, 0)),
    discountsTotal: money(sales.reduce((sum: number, sale: { discount?: number }) => sum + (sale.discount ?? 0), 0)),
    paymentTotals: snapshot.paymentTotals,
    operations: snapshot.operations,
    expectedCash: snapshot.expectedCash,
    pendingSales: snapshot.pendingSales
  };
});
app.post('/cash/sessions/:id/reopen', async (req) => {
  requireManager(req);
  const id = (req.params as { id: string }).id;
  const database = requireDatabase();
  const session = await cashSessionById(id);
  if (!session) return badRequest('Caixa não encontrado');
  if (session.status === 'OPEN') return { reopened: true, session, idempotent: true };
  if (await currentCashSession(session.operatorId)) return badRequest('O operador já possui outro caixa aberto');
  await withTransaction(async client => {
    const reopened = await client.query(`update pdv_cash_sessions set status='OPEN', closed_at=null, closing_summary=null where id=$1 and status='CLOSED' returning id`, [id]) as { rows: unknown[] };
    if (!reopened.rows[0]) return conflict('Caixa foi alterado por outro usuário');
    await client.query(
      `insert into pdv_cash_operations (id, session_id, operation_type, amount, data)
       values ($1,$2,'REOPENING',0,$3::jsonb)`,
      [randomUUID(), id, JSON.stringify({ syncStatus: 'NOT_REQUIRED', controlOnly: true })]
    );
  });
  await writeAdminAudit(req, 'REOPEN', 'cash_session', id, { status: 'CLOSED', closingSummary: session.closingSummary }, { status: 'OPEN', source: 'PDV' });
  return { reopened: true, session: await cashSessionById(id) };
});
app.delete('/cash/sessions/:id', async (req, reply) => {
  requireManager(req);
  const id = (req.params as { id: string }).id;
  const database = requireDatabase();
  const session = await cashSessionById(id);
  if (!session) return reply.code(404).send({ message: 'Caixa não encontrado' });
  const [salesResult, movementResult] = await Promise.all([
    database.query(`select count(*)::int as count from pdv_sales where data->>'cashSessionId'=$1 and status not in ('CANCELLED','DELETED')`, [id]) as Promise<{ rows: { count: number }[] }>,
    database.query(`select count(*)::int as count from pdv_cash_operations where session_id=$1 and operation_type in ('WITHDRAWAL','SUPPLY')`, [id]) as Promise<{ rows: { count: number }[] }>
  ]);
  if ((salesResult.rows[0]?.count ?? 0) > 0 || (movementResult.rows[0]?.count ?? 0) > 0) {
    return reply.code(409).send({ message: 'Este caixa possui vendas, sangrias ou suprimentos. Exclua apenas aberturas de teste sem movimento.' });
  }
  await withTransaction(async client => {
    await client.query('delete from pdv_cash_operations where session_id=$1', [id]);
    await client.query('delete from pdv_cash_sessions where id=$1', [id]);
  });
  await writeAdminAudit(req, 'DELETE', 'cash_session', id, { session }, null);
  return { deleted: true, sessionId: id };
});
app.post('/cash/sessions/:id/close', async (req) => {
  const id = (req.params as { id: string }).id;
  const body = req.body as { countedValues?: { name: string; amount: number }[]; notes?: string };
  const database = requireDatabase();
  const snapshot = await cashSessionSnapshot(id);
  if (snapshot.session.status !== 'OPEN') return badRequest('Caixa já está fechado');
  const expected = new Map(snapshot.paymentTotals.map(item => [item.name, item.amount]));
  const cashName = [...expected.keys()].find(name => /dinheiro|cash/i.test(name)) ?? 'Dinheiro';
  expected.set(cashName, snapshot.expectedCash);
  const countedValues = body.countedValues?.length
    ? body.countedValues
    : [...expected].map(([name, amount]) => ({ name, amount }));
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
    pendingSalesAtClosing: snapshot.pendingSales,
    notes: body.notes?.trim() || undefined,
    blingEntries: entries
  };
  await withTransaction(async client => {
    const closed = await client.query(
      `update pdv_cash_sessions set status='CLOSED', closed_at=now(), closing_summary=$2::jsonb where id=$1 and status='OPEN' returning closed_at`,
      [id, JSON.stringify(summary)]
    ) as { rows: { closed_at: Date }[] };
    if (!closed.rows[0]) return conflict('Caixa foi alterado por outro usuário');
    const versionResult = await client.query('select coalesce(max(version),0)::int version from pdv_cash_closing_versions where session_id=$1', [id]) as { rows: { version: number }[] };
    const version = (versionResult.rows[0]?.version ?? 0) + 1;
    await client.query(
      `insert into pdv_cash_closing_versions (id, session_id, version, closing_summary, closed_at, closed_by) values ($1,$2,$3,$4::jsonb,$5,$6)`,
      [randomUUID(), id, version, JSON.stringify(summary), closed.rows[0].closed_at, principalFromRequest(req)?.operatorName ?? snapshot.session.operatorId]
    );
    await client.query(
      `insert into pdv_cash_operations (id, session_id, operation_type, amount, data)
       values ($1,$2,'CLOSING',0,$3::jsonb)`,
      [randomUUID(), id, JSON.stringify({ syncStatus: 'NOT_REQUIRED', summary })]
    );
  });
  await writeAdminAudit(req, 'CLOSE', 'cash_session', id, { status: 'OPEN' }, { status: 'CLOSED', summary, source: 'PDV' });
  return { closed: true, sessionId: id, summary };
});

app.get('/operations/pending', async (req) => {
  const database = requireDatabase();
  const [salesResult, cashResult, webhookResult] = await Promise.all([
    database.query(
      `select id, status, data->>'blingOrderId' as "blingOrderId", data->>'lastError' as "lastError",
        coalesce((data->>'reconciliationAttempts')::int,0) as attempts, updated_at as "updatedAt"
       from pdv_sales where status in ('PROCESSING','SYNC_FAILED','RECONCILIATION_REQUIRED')
       order by updated_at asc limit 100`
    ) as Promise<{ rows: any[] }>,
    database.query(
      `select id, operation_type as type, amount::float8 as amount, data->>'syncStatus' as status,
        data->>'lastError' as "lastError", created_at as "createdAt"
       from pdv_cash_operations where data->>'syncStatus' in ('PENDING','FAILED')
       order by created_at asc limit 100`
    ) as Promise<{ rows: any[] }>,
    database.query(
      `select event_id as "eventId", event_name as event, status, attempts, last_error as "lastError",
        received_at as "receivedAt" from bling_webhook_events
       where status in ('PENDING','PROCESSING','FAILED','DEAD')
       order by received_at asc limit 100`
    ) as Promise<{ rows: any[] }>
  ]);
  return {
    counts: { sales: salesResult.rows.length, cash: cashResult.rows.length, webhooks: webhookResult.rows.length },
    sales: salesResult.rows,
    cash: cashResult.rows,
    webhooks: webhookResult.rows
  };
});

app.get('/customers/:cpf', async (req) => lookupCustomer((req.params as { cpf: string }).cpf));
app.post('/customers/bling', async (req) => {
  const body = req.body as { name?: string; cpf?: string; phone?: string; email?: string; address?: { postalCode?: string; street?: string; number?: string; complement?: string; neighborhood?: string; city?: string; state?: string } };
  const cpf = body.cpf?.replace(/\D/g, '') ?? '';
  if (!body.name?.trim() || cpf.length !== 11) return badRequest('Nome e CPF válido são obrigatórios para cadastrar no Bling');
  if (body.email && !/^\S+@\S+\.\S+$/.test(body.email.trim())) return badRequest('Informe um e-mail válido ou deixe o campo vazio');
  const address = body.address;
  const postalCode = address?.postalCode?.replace(/\D/g, '') ?? '';
  const state = address?.state?.trim() ?? '';
  if (postalCode.length !== 8 || !address?.street?.trim() || !address.number?.trim() || !address.neighborhood?.trim() || !address.city?.trim() || !/^[A-Za-z]{2}$/.test(state)) {
    return badRequest('Endereço completo obrigatório: CEP válido, logradouro, número, bairro, município e UF');
  }
  return bling.createCustomer({
    name: body.name.trim().slice(0, 120), cpf, phone: body.phone?.trim(), email: body.email?.trim(),
    address: { postalCode, street: address.street.trim().slice(0, 150), number: address.number.trim().slice(0, 20), complement: address.complement?.trim().slice(0, 100), neighborhood: address.neighborhood.trim().slice(0, 100), city: address.city.trim().slice(0, 100), state: state.toUpperCase() }
  });
});
app.post('/customers/fidelizei', async (req) => {
  const body = req.body as { name: string; cpf: string; phone?: string; email?: string; programConsent: boolean };
  if (!body.name || !body.cpf || body.programConsent !== true) return badRequest('Nome, CPF e consentimento explícito são obrigatórios para adesão');
  if (!body.phone) return badRequest('Celular é obrigatório para adesão ao Fidelizei');
  if (!body.email || !/^\S+@\S+\.\S+$/.test(body.email.trim())) return badRequest('E-mail válido é obrigatório para enviar o acesso provisório do Fidelizei');
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
const blingOrderInput = (sale: Sale, session: any, payments: PaymentSplit[] = sale.payments ?? []) => ({
  customerId: sale.customer?.bling?.id,
  sellerId: sale.sellerId,
  categoryId: sale.categoryId,
  items: sale.items,
  discount: sale.discount,
  freight: sale.freight ?? 0,
  observations: sale.observations,
  salesChannelId: session.channelId === 'DEFAULT' ? undefined : session.channelId,
  businessUnitId: session.channelId === 'DEFAULT' ? undefined : session.businessUnitId,
  payments,
  idempotencyKey: sale.id,
  statusId: sale.blingDraftStatusId
});
const assertBlingOrderCustomer = async (sale: Sale) => {
  if (!sale.blingOrderId) return;
  const linked = await bling.getOrderContact(sale.blingOrderId);
  const expectedId = sale.customer?.bling?.id;
  const intact = expectedId
    ? linked.id === expectedId
    : linked.name.trim().toLocaleLowerCase('pt-BR') === 'consumidor final' && !linked.cpf;
  if (!intact) return conflict('O cliente do pedido no Bling diverge do PDV. A operação foi bloqueada para não substituir o contato; confira a auditoria no Admin');
};
app.post('/sales', async (req) => {
  const body = req.body as {
    cashSessionId?: string;
    operatorId?: string;
    sellerId: string;
    categoryId?: string;
    items: SaleItem[];
    customerCpf?: string;
    manualDiscount?: number;
    freight?: number;
    observations?: string;
    emitFiscal?: boolean;
    payments?: PaymentSplit[];
    draftStep?: Sale['draftStep'];
  };
  const operatorId = principalFromRequest(req)?.operatorId ?? body.operatorId;
  if (!body.cashSessionId || !operatorId || !body.sellerId || !body.items?.length) {
    return badRequest('Caixa aberto, operador, vendedor e itens são obrigatórios');
  }
  const session = await cashSessionById(body.cashSessionId);
  if (!session || session.status !== 'OPEN') return badRequest('Abra o caixa antes de iniciar a venda');
  if (session.operatorId !== operatorId) return badRequest('A venda deve usar o operador responsável pelo caixa aberto');
  const items = await canonicalSaleItems(body.items);
  const lookup = body.customerCpf ? await lookupCustomer(body.customerCpf) : undefined;
  if (body.customerCpf && (!lookup?.found || !lookup.bling?.id)) return conflict('Cliente não confirmado no Bling. O pedido não foi criado para evitar vínculo incorreto');
  const customer = lookup?.found ? lookup : undefined;
  const manualDiscount = money(Math.max(0, Number(body.manualDiscount) || 0));
  const freight = money(Math.max(0, Number(body.freight) || 0));
  const categories = await bling.financialCategories();
  const category = categories.find(item => item.id === body.categoryId)
    ?? categories.find(item => item.isDefault)
    ?? categories.find(item => /vendas? de mercadorias/i.test(item.name));
  if (!category) return badRequest('A categoria financeira Vendas de mercadorias não foi encontrada no Bling');
  const amounts = calculate(items, manualDiscount, freight);
  const sale: Sale = {
    id: randomUUID(),
    status: 'OPEN',
    cashSessionId: session.id,
    operatorId,
    sellerId: body.sellerId,
    categoryId: category.id,
    categoryName: category.name,
    customer,
    items,
    manualDiscount,
    observations: body.observations?.trim().slice(0, 2000) || undefined,
    emitFiscal: body.emitFiscal === true,
    payments: Array.isArray(body.payments) ? body.payments.map(payment => ({
      paymentMethodId: String(payment.paymentMethodId ?? ''),
      paymentMethodName: payment.paymentMethodName,
      amount: money(Math.max(0, Number(payment.amount) || 0)),
      receivedAmount: payment.receivedAmount === undefined ? undefined : money(Math.max(0, Number(payment.receivedAmount) || 0))
    })).filter(payment => payment.paymentMethodId) : [],
    draftStep: ['product', 'customer', 'payment'].includes(body.draftStep ?? '') ? body.draftStep : 'product',
    draftSyncStatus: 'SYNCED',
    fiscalStatus: body.emitFiscal === true ? undefined : 'NOT_REQUESTED',
    ...amounts,
    createdAt: new Date().toISOString()
  };
  sale.blingDraftStatusId = await bling.findInServiceStatusId();
  const order = await bling.createOrder(blingOrderInput(sale, session, []));
  const createdContact = await bling.getOrderContact(order.id);
  if (sale.customer?.bling?.id && createdContact.id !== sale.customer.bling.id) {
    throw new Error('Bling criou o pedido com um contato diferente do cliente confirmado; a venda não será vinculada no PDV');
  }
  sale.blingOrderId = order.id;
  sale.blingOrderNumber = order.number;
  await persist(sale);
  return sale;
});
app.put('/sales/:id', async (req) => {
  const sale = await getSale((req.params as { id: string }).id);
  if (!sale) return badRequest('Venda em atendimento não encontrada');
  if (sale.status !== 'OPEN') return conflict('Somente vendas em atendimento podem ser atualizadas');
  const body = req.body as { sellerId?: string; categoryId?: string; items?: SaleItem[]; customerCpf?: string; customerSaleId?: string; manualDiscount?: number; freight?: number; observations?: string; emitFiscal?: boolean; payments?: PaymentSplit[]; draftStep?: Sale['draftStep'] };
  if (!body.items?.length) return badRequest('Adicione ao menos um produto');
  const session = await cashSessionById(sale.cashSessionId);
  if (!session || session.status !== 'OPEN') return badRequest('O caixa desta venda não está mais aberto');
  await assertBlingOrderCustomer(sale);
  const items = await canonicalSaleItems(body.items);
  const requestedCpf = body.customerCpf?.replace(/\D/g, '');
  let updatedCustomer = sale.customer;
  if (requestedCpf) {
    if (sale.customer?.cpf && sale.customer.cpf !== requestedCpf) return conflict('A troca de cliente de um pedido já identificado foi bloqueada. Confira o pedido antes de fazer uma correção administrativa');
    // Um cliente só entra num pedido sem identificação se foi consultado/cadastrado com
    // esta mesma venda em tela. Evita que um cadastro feito numa venda caia em outra.
    if (!sale.customer?.cpf && body.customerSaleId !== sale.id) return conflict('O cliente informado foi consultado em outra venda e não foi vinculado a este pedido. Consulte o CPF novamente nesta venda');
    const lookup = await lookupCustomer(requestedCpf);
    if (!lookup.found || !lookup.bling?.id || lookup.bling.cpf !== requestedCpf) return conflict('Cliente não confirmado no Bling. O cliente anterior foi preservado');
    updatedCustomer = lookup;
  }
  const categories = await bling.financialCategories();
  const category = categories.find(item => item.id === body.categoryId) ?? categories.find(item => item.id === sale.categoryId);
  if (!category) return badRequest('A categoria financeira da venda não foi encontrada no Bling');
  const manualDiscount = money(Math.max(0, Number(body.manualDiscount) || 0));
  const freight = money(Math.max(0, Number(body.freight) || 0));
  Object.assign(sale, {
    sellerId: body.sellerId || sale.sellerId,
    categoryId: category.id,
    categoryName: category.name,
    customer: updatedCustomer,
    items,
    manualDiscount,
    observations: body.observations?.trim().slice(0, 2000) || undefined,
    emitFiscal: body.emitFiscal === true,
    payments: Array.isArray(body.payments) ? body.payments.map(payment => ({
      paymentMethodId: String(payment.paymentMethodId ?? ''),
      paymentMethodName: payment.paymentMethodName,
      amount: money(Math.max(0, Number(payment.amount) || 0)),
      receivedAmount: payment.receivedAmount === undefined ? undefined : money(Math.max(0, Number(payment.receivedAmount) || 0))
    })).filter(payment => payment.paymentMethodId) : sale.payments ?? [],
    draftStep: ['product', 'customer', 'payment'].includes(body.draftStep ?? '') ? body.draftStep : sale.draftStep ?? 'product',
    ...calculate(items, manualDiscount + (sale.coupon?.discount ?? 0), freight)
  });
  sale.freight = freight;
  sale.blingDraftStatusId ??= await bling.findInServiceStatusId();
  // O rascunho local é a fonte de verdade da tela. Assim, uma rejeição temporária
  // do Bling nunca mistura nem apaga o estado de outro pedido durante a troca.
  await persist(sale);
  try {
    const order = sale.blingOrderId
      ? await bling.updateOrder(sale.blingOrderId, blingOrderInput(sale, session, []))
      : await bling.createOrder(blingOrderInput(sale, session, []));
    const savedContact = await bling.getOrderContact(order.id);
    if (sale.customer?.bling?.id && savedContact.id !== sale.customer.bling.id) {
      throw new Error('Bling retornou um contato diferente do cliente confirmado para este pedido');
    }
    sale.blingOrderId = order.id;
    sale.blingOrderNumber = order.number ?? sale.blingOrderNumber;
    sale.draftSyncStatus = 'SYNCED';
    sale.draftSyncError = undefined;
  } catch (error) {
    sale.draftSyncStatus = 'PENDING';
    sale.draftSyncError = error instanceof Error ? error.message.slice(0, 700) : 'Falha ao atualizar o rascunho no Bling';
    app.log.warn({ error, saleId: sale.id, blingOrderId: sale.blingOrderId }, 'Rascunho salvo no PDV e pendente de atualização no Bling');
  }
  await persist(sale);
  return sale;
});
app.get('/sales/open', async (req) => {
  const cashSessionId = String((req.query as { cashSessionId?: string }).cashSessionId ?? '');
  if (pool) {
    const result = await pool.query(`select data from pdv_sales where status='OPEN' and ($1='' or data->>'cashSessionId'=$1) order by updated_at desc limit 50`, [cashSessionId]) as { rows: { data: Sale }[] };
    return result.rows.map(row => row.data);
  }
  return [...sales.values()].filter(item => item.status === 'OPEN' && (!cashSessionId || item.cashSessionId === cashSessionId));
});
app.get('/sales/:id', async (req) => {
  const sale = await getSale((req.params as { id: string }).id);
  if (!sale) throw Object.assign(new Error('Venda não encontrada'), { statusCode: 404 });
  return sale;
});
const couponApplications = new Map<string, { code: string; promise: Promise<Sale> }>();
app.post('/sales/:id/coupon', async (req) => {
  let sale = await getSale((req.params as { id: string }).id);
  const rawCode = (req.body as { code?: string } | undefined)?.code;
  const code = String(rawCode ?? '').trim().toUpperCase();
  if (!code) return badRequest('Informe o código do cupom Fidelizei');
  const fidelizeiCustomer = sale?.customer?.fidelizei;
  if (!sale || !fidelizeiCustomer) return badRequest('Cliente não cadastrado no Fidelizei');
  if (sale.status !== 'OPEN') return conflict('Este pedido não está aberto para aplicar cupom');
  if (sale.coupon) {
    if (sale.coupon.code.trim().toUpperCase() === code) return sale;
    return conflict('Este pedido já possui um cupom aplicado');
  }
  const pending = couponApplications.get(sale.id);
  if (pending) {
    if (pending.code !== code) return conflict('Já existe uma validação de cupom em andamento para este pedido');
    return pending.promise;
  }

  const promise = (async () => {
    const databaseClient = pool ? await pool.connect() : undefined;
    let lockAcquired = false;
    try {
      if (databaseClient) {
        await databaseClient.query('select pg_advisory_lock(hashtext($1))', [sale.id]);
        lockAcquired = true;
        const refreshed = await databaseClient.query('select data from pdv_sales where id = $1', [sale.id]) as { rows: { data: Sale }[] };
        if (refreshed.rows[0]) {
          sale = refreshed.rows[0].data;
          sales.set(sale.id, sale);
        }
      }

      if (sale.coupon) {
        if (sale.coupon.code.trim().toUpperCase() === code) return sale;
        return conflict('Este pedido já possui um cupom aplicado');
      }
      if (sale.status !== 'OPEN' || !sale.customer?.fidelizei) return conflict('Este pedido não está aberto ou não possui cliente Fidelizei vinculado');

            const session = await cashSessionById(sale.cashSessionId);
      if (!session || session.status !== 'OPEN' || !sale.blingOrderId) return conflict('O pedido precisa estar aberto e salvo no Bling antes de aplicar o cupom');
      await assertBlingOrderCustomer(sale);
      const customerCpf = sale.customer.fidelizei.cpf;
      const preview = await fidelizei.previewCoupon(code, sale.id, sale.subtotal, customerCpf);
      const discountedSale: Sale = {
        ...sale,
        coupon: preview.coupon,
        ...calculate(sale.items, (sale.manualDiscount ?? 0) + preview.coupon.discount, sale.freight ?? 0)
      };
      // O Bling precisa confirmar o desconto antes que o Fidelizei marque o código como usado.
      await bling.updateOrder(sale.blingOrderId, blingOrderInput(discountedSale, session, []));

      let redemption;
      try {
        redemption = await fidelizei.consumeCoupon(code, sale.id, sale.subtotal, customerCpf, preview.expectedReward);
      } catch (error) {
        // Uma resposta perdida pode ocorrer depois do consumo. A prévia identifica
        // o uso pelo mesmo pedido e a confirmação seguinte é idempotente.
        try {
          const current = await fidelizei.previewCoupon(code, sale.id, sale.subtotal, customerCpf);
          if (current.status === 'used') {
            redemption = await fidelizei.consumeCoupon(code, sale.id, sale.subtotal, customerCpf, preview.expectedReward);
          }
        } catch {
          // A consulta também pode falhar; a venda fica disponível para reconciliação.
        }
        if (!redemption) {
          try {
            await bling.updateOrder(sale.blingOrderId, { ...blingOrderInput(sale, session, []), clearDiscount: true });
            sale.draftSyncStatus = 'SYNCED';
            sale.draftSyncError = undefined;
          } catch (rollbackError) {
            sale.draftSyncStatus = 'PENDING';
            sale.draftSyncError = rollbackError instanceof Error ? rollbackError.message.slice(0, 700) : 'Falha ao restaurar o pedido no Bling';
            await persist(sale);
          }
          throw error;
        }
      }
      Object.assign(sale, {
        coupon: redemption.coupon,
        reservationId: `consumed:${code}`,
        ...calculate(sale.items, (sale.manualDiscount ?? 0) + redemption.coupon.discount, sale.freight ?? 0)
      });
      sale.draftSyncStatus = 'SYNCED';
      sale.draftSyncError = undefined;
      await persist(sale);
      if (Math.abs(redemption.coupon.discount - preview.coupon.discount) > 0.009) {
        // Defesa para versões antigas da API que não aplicam a comparação da regra.
        try {
          await bling.updateOrder(sale.blingOrderId, blingOrderInput(sale, session, []));
        } catch (error) {
          sale.draftSyncStatus = 'PENDING';
          sale.draftSyncError = error instanceof Error ? error.message.slice(0, 700) : 'Falha ao atualizar o rascunho no Bling';
          await persist(sale);
        }
      }
      return sale;
    } finally {
      if (databaseClient) {
        if (lockAcquired) await databaseClient.query('select pg_advisory_unlock(hashtext($1))', [sale.id]).catch(() => undefined);
        databaseClient.release();
      }
    }
  })();
  couponApplications.set(sale.id, { code, promise });
  try {
    return await promise;
  } finally {
    if (couponApplications.get(sale.id)?.promise === promise) couponApplications.delete(sale.id);
  }
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
  if (!original) return conflict('Venda não encontrada');
  if (original.status === 'SYNC_FAILED') {
    if (/Bling não criou o pedido \(HTTP 4\d\d\)/.test(original.lastError ?? '')) {
      original.status = 'OPEN';
      await persist(original);
    } else {
      return conflict(`Venda pendente para conferência: ${original.lastError ?? 'resultado do Bling não confirmado'}`);
    }
  }
  if (original.status !== 'OPEN') return conflict('Venda já está sendo processada ou foi concluída');
  const session = await cashSessionById(original.cashSessionId);
  if (!session || session.status !== 'OPEN') return badRequest('O caixa desta venda não está mais aberto');
  await assertBlingOrderCustomer(original);

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
    const order = sale.blingOrderId
      ? await bling.updateOrder(sale.blingOrderId, blingOrderInput(sale, session, payments))
      : await bling.createOrder(blingOrderInput(sale, session, payments));
    sale.blingOrderId = order.id;
    sale.blingOrderNumber = order.number;
    await persist(sale);
    let fulfillmentError: string | undefined;
    try {
      sale.blingFulfillment = await bling.finalizeOrder(order.id);
    } catch (error) {
      fulfillmentError = error instanceof Error ? error.message.slice(0, 500) : 'Falha ao lançar contas, estoque ou marcar o pedido como atendido';
      app.log.error({ error, saleId: sale.id, blingOrderId: order.id }, 'Pedido criado, mas a finalização automática do Bling exige conferência');
    }
    if (pool) await pool.query(
      `update bling_products product set stock=product.stock-item.quantity
       from jsonb_to_recordset($1::jsonb) as item("productId" text, quantity numeric)
       where product.id=item."productId"`,
      [JSON.stringify(sale.items.map(item => ({ productId: item.productId, quantity: item.quantity })))]
    );
    if (sale.emitFiscal) {
      try {
        const fiscal = await bling.generateNfce(order.id);
        sale.fiscalStatus = 'REQUESTED';
        sale.fiscalDocumentUrl = fiscal.documentUrl;
      } catch (error) {
        sale.fiscalStatus = 'FAILED';
        app.log.error({ error, saleId: sale.id, blingOrderId: order.id }, 'Pedido criado, mas a NFC-e não foi gerada no Bling');
      }
    }
    // O Fidelizei credita os pontos ao processar o pedido do Bling. O PDV somente
    // consulta a cliente e valida/consome cupons, evitando pontuação duplicada.
    sale.status = 'COMPLETED';
    if (fulfillmentError) {
      sale.status = 'RECONCILIATION_REQUIRED';
      sale.lastError = [sale.lastError, fulfillmentError].filter(Boolean).join(' · ').slice(0, 500);
    }
    await persist(sale);
    return sale;
  } catch (error) {
    sale.status = sale.blingOrderId ? 'OPEN' : 'SYNC_FAILED';
    sale.lastError = error instanceof Error ? error.message.slice(0, 500) : 'Falha desconhecida na sincronização';
    await persist(sale);
    app.log.error({ err: error, saleId: sale.id }, 'Venda pendente: resultado da criação no Bling precisa de conferência');
    throw Object.assign(new Error(`Não foi possível confirmar o pedido no Bling. Motivo: ${sale.lastError}`), { statusCode: 502 });
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
app.get('/sales/orders', async (req) => {
  const query = req.query as { limit?: string; from?: string; to?: string; search?: string; status?: string; scope?: 'all' | 'active' | 'deleted' | 'cancelled' };
  const normalizeLegacyStatus = (item: Sale) => item.status === 'CANCELLED' && !(item as Sale & { cancellationKind?: string }).cancellationKind
    ? Object.assign({}, item, { status: 'DELETED' as const, deletionKind: 'LEGACY_DELETE' })
    : item;
  const rawLimit = Number(query.limit ?? 100);
  const limit = Math.max(1, Math.min(200, Number.isFinite(rawLimit) ? rawLimit : 100));
  if (pool) {
    const values: unknown[] = [];
    const filters: string[] = [];
    const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
    if (query.from) filters.push(`(data->>'createdAt')::timestamptz >= ${add(`${query.from}T00:00:00-03:00`)}::timestamptz`);
    if (query.to) filters.push(`(data->>'createdAt')::timestamptz < (${add(`${query.to}T00:00:00-03:00`)}::timestamptz + interval '1 day')`);
    if (query.status) filters.push(`status = ${add(query.status)}`);
    if (query.scope === 'active') filters.push(`status not in ('CANCELLED','DELETED')`);
    if (query.scope === 'deleted') filters.push(`(status = 'DELETED' or (status='CANCELLED' and coalesce(data->>'cancellationKind','')=''))`);
    if (query.scope === 'cancelled') filters.push(`status = 'CANCELLED' and data->>'cancellationKind'='CANCELLED'`);
    if (query.search?.trim()) {
      const term = add(`%${query.search.trim()}%`);
      filters.push(`(coalesce(data->>'blingOrderNumber','') ilike ${term}
        or coalesce(data->>'blingOrderId','') ilike ${term}
        or coalesce(data#>>'{customer,name}','') ilike ${term}
        or coalesce(data#>>'{customer,cpf}','') ilike ${term}
        or coalesce(data#>>'{customer,email}','') ilike ${term})`);
    }
    const where = filters.length ? `where ${filters.join(' and ')}` : '';
    values.push(limit);
    const result = await pool.query(
      `select data from pdv_sales ${where} order by (data->>'createdAt')::timestamptz desc limit $${values.length}`,
      values
    ) as { rows: { data: Sale }[] };
    const orders = result.rows.map(row => normalizeLegacyStatus(row.data));
    const active = orders.filter(item => !['CANCELLED','DELETED'].includes(item.status));
    return {
      orders,
      summary: {
        count: active.length,
        total: money(active.reduce((sum, item) => sum + item.total, 0)),
        cancelled: orders.filter(item => item.status === 'CANCELLED').length,
        deleted: orders.filter(item => item.status === 'DELETED').length
      }
    };
  }
  const orders = [...sales.values()].map(normalizeLegacyStatus)
    .filter(item => !query.from || item.createdAt.slice(0, 10) >= query.from)
    .filter(item => !query.to || item.createdAt.slice(0, 10) <= query.to)
    .filter(item => !query.status || item.status === query.status)
    .filter(item => !query.scope || query.scope === 'all'
      || (query.scope === 'active' && !['CANCELLED','DELETED'].includes(item.status))
      || (query.scope === 'deleted' && item.status === 'DELETED')
      || (query.scope === 'cancelled' && item.status === 'CANCELLED'))
    .filter(item => !query.search || JSON.stringify(item).toLowerCase().includes(query.search.toLowerCase()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  const active = orders.filter(item => !['CANCELLED','DELETED'].includes(item.status));
  return { orders, summary: { count: active.length, total: money(active.reduce((sum, item) => sum + item.total, 0)), cancelled: orders.filter(item => item.status === 'CANCELLED').length, deleted: orders.filter(item => item.status === 'DELETED').length } };
});
const deleteSale = async (req: any) => {
  const id = (req.params as { id: string }).id;
  const sale = await getSale(id);
  if (!sale) return badRequest('Pedido não encontrado no PDV');
  if (sale.status === 'DELETED') return { ...sale, idempotent: true };
  if (sale.status === 'CANCELLED') return badRequest('Pedido cancelado não pode ser excluído por este fluxo');
  const deletion = sale.blingOrderId
    ? sale.status === 'OPEN' ? await bling.deleteDraftOrder(sale.blingOrderId) : await bling.deleteOrder(sale.blingOrderId)
    : { deleted: false, warnings: [] as string[] };
  let loyaltyWarning: string | undefined;
  if (sale.fidelizeiTransactionId) {
    try { await fidelizei.reverseSale(sale.id); }
    catch (error) { loyaltyWarning = error instanceof Error ? error.message.slice(0, 400) : 'Estorno Fidelizei pendente'; }
  }
  if (pool && ['COMPLETED', 'RECONCILIATION_REQUIRED'].includes(sale.status)) {
    await pool.query(
      `update bling_products product set stock=product.stock+item.quantity
       from jsonb_to_recordset($1::jsonb) as item("productId" text, quantity numeric)
       where product.id=item."productId"`,
      [JSON.stringify(sale.items.map(item => ({ productId: item.productId, quantity: item.quantity })))]
    );
  }
  sale.status = 'DELETED';
  Object.assign(sale, { deletedAt: new Date().toISOString(), deletionKind: 'DELETED' });
  sale.lastError = [loyaltyWarning, ...(deletion.warnings ?? [])].filter(Boolean).join(' · ') || undefined;
  await persist(sale);
  return { ...sale, deletedInBling: Boolean(sale.blingOrderId), loyaltyWarning, blingWarnings: deletion.warnings };
};
app.delete('/sales/:id', deleteSale);
// Alguns navegadores, proxies e redes corporativas bloqueiam DELETE. A ação POST
// preserva a mesma semântica e torna a exclusão operacional no caixa.
app.post('/sales/:id/delete', deleteSale);
app.post('/sales/:id/cancel', async (req) => {
  const id = (req.params as { id: string }).id;
  const sale = await getSale(id);
  if (!sale) return badRequest('Pedido não encontrado no PDV');
  if (sale.status === 'CANCELLED') return { ...sale, idempotent: true };
  if (sale.status === 'DELETED') return badRequest('Pedido excluído não pode ser cancelado');
  if (!sale.blingOrderId) return badRequest('Pedido ainda não foi criado no Bling');
  const cancellation = sale.status === 'OPEN' ? await bling.cancelDraftOrder(sale.blingOrderId) : await bling.cancelOrder(sale.blingOrderId);
  let loyaltyWarning: string | undefined;
  if (sale.fidelizeiTransactionId) {
    try { await fidelizei.reverseSale(sale.id); }
    catch (error) { loyaltyWarning = error instanceof Error ? error.message.slice(0, 400) : 'Estorno Fidelizei pendente'; }
  }
  if (pool && ['COMPLETED', 'RECONCILIATION_REQUIRED'].includes(sale.status)) {
    await pool.query(
      `update bling_products product set stock=product.stock+item.quantity
       from jsonb_to_recordset($1::jsonb) as item("productId" text, quantity numeric)
       where product.id=item."productId"`,
      [JSON.stringify(sale.items.map(item => ({ productId: item.productId, quantity: item.quantity })))]
    );
  }
  sale.status = 'CANCELLED';
  sale.cancelledAt = new Date().toISOString();
  Object.assign(sale, { cancellationKind: 'CANCELLED', lastError: [loyaltyWarning, ...(cancellation.warnings ?? [])].filter(Boolean).join(' · ') || undefined });
  await persist(sale);
  return { ...sale, cancelledInBling: true, loyaltyWarning, blingWarnings: cancellation.warnings };
});
app.post('/sales/:id/reverse-fidelizei', async (req) => {
  requireManager(req);
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


