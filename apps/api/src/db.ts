import pg from 'pg';

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      statement_timeout: 15_000,
      query_timeout: 20_000
    })
  : undefined;

export type DatabaseClient = { query: (text: string, values?: unknown[]) => Promise<unknown> };

// BEGIN/COMMIT precisam rodar na mesma conexão; pool.query pode usar uma conexão
// diferente a cada chamada e deixar transações abertas ou gravadas pela metade.
export const withTransaction = async <T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> => {
  if (!pool) throw Object.assign(new Error('Banco de dados do PDV indisponível'), { statusCode: 503 });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const initializeDatabase = async () => {
  if (!pool) return;
  await pool.query(`create table if not exists pdv_sales (
    id uuid primary key,
    status text not null,
    data jsonb not null,
    updated_at timestamptz not null default now()
  )`);
  await pool.query("create index if not exists pdv_sales_cash_session_idx on pdv_sales ((data->>'cashSessionId'))");
  await pool.query("create index if not exists pdv_sales_status_idx on pdv_sales (status, updated_at)");
  await pool.query(`create table if not exists integration_credentials (
    provider text primary key,
    access_token text not null,
    refresh_token text,
    expires_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists oauth_states (
    state text primary key,
    provider text not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists bling_products (
    id text primary key,
    sku text not null,
    name text not null,
    price numeric(14,2) not null default 0,
    stock numeric(14,4) not null default 0,
    barcode text,
    synced_at timestamptz not null default now()
  )`);
  await pool.query('create index if not exists bling_products_sku_idx on bling_products (lower(sku))');
  await pool.query('create index if not exists bling_products_barcode_idx on bling_products (barcode)');
  await pool.query('create index if not exists bling_products_name_idx on bling_products using gin (to_tsvector(\'simple\', name))');
  await pool.query(`create table if not exists pdv_cash_sessions (
    id uuid primary key,
    operator_id text not null,
    seller_id text,
    account_id text not null,
    account_name text not null,
    status text not null check (status in ('OPEN','CLOSED')),
    opening_amount numeric(14,2) not null default 0,
    opened_at timestamptz not null default now(),
    closed_at timestamptz,
    closing_summary jsonb
  )`);
  await pool.query('alter table pdv_cash_sessions add column if not exists channel_id text');
  await pool.query('alter table pdv_cash_sessions add column if not exists channel_name text');
  await pool.query('alter table pdv_cash_sessions add column if not exists business_unit_id text');
  await pool.query('alter table pdv_cash_sessions add column if not exists business_unit_name text');
  await pool.query(`create unique index if not exists pdv_cash_sessions_operator_open_idx
    on pdv_cash_sessions (operator_id) where status = 'OPEN'`);
  await pool.query(`create table if not exists pdv_cash_operations (
    id uuid primary key,
    session_id uuid not null references pdv_cash_sessions(id),
    operation_type text not null,
    amount numeric(14,2) not null,
    bling_entry_id text,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`);
  await pool.query('create index if not exists pdv_cash_operations_session_idx on pdv_cash_operations (session_id, created_at)');
  await pool.query(`create table if not exists pdv_cash_closing_versions (
    id uuid primary key, session_id uuid not null references pdv_cash_sessions(id), version integer not null,
    closing_summary jsonb not null, closed_at timestamptz not null, closed_by text,
    unique(session_id, version)
  )`);
  await pool.query(`create table if not exists pdv_cash_reopenings (
    id uuid primary key, session_id uuid not null references pdv_cash_sessions(id),
    closing_version integer not null, justification text not null, reopened_by text not null,
    reopened_at timestamptz not null default now(), previous_summary jsonb not null
  )`);
  await pool.query(`create table if not exists pdv_admin_audit_logs (
    id uuid primary key, actor_id text not null, actor_name text not null, actor_role text not null,
    action text not null, entity_type text not null, entity_id text not null,
    previous_value jsonb, new_value jsonb, ip_address text, terminal text,
    created_at timestamptz not null default now()
  )`);
  await pool.query('create index if not exists pdv_admin_audit_created_idx on pdv_admin_audit_logs (created_at desc)');
  await pool.query('create index if not exists pdv_admin_audit_entity_idx on pdv_admin_audit_logs (entity_type, entity_id, created_at desc)');
  await pool.query('create index if not exists pdv_cash_closings_session_idx on pdv_cash_closing_versions (session_id, version desc)');
  await pool.query(`create or replace function prevent_pdv_audit_mutation() returns trigger language plpgsql as $$
    begin raise exception 'PDV audit history is append-only'; end;
  $$`);
  for (const table of ['pdv_admin_audit_logs','pdv_cash_closing_versions','pdv_cash_reopenings']) {
    const trigger=`${table}_immutable`;
    await pool.query(`drop trigger if exists ${trigger} on ${table}`);
    await pool.query(`create trigger ${trigger} before update or delete on ${table} for each row execute function prevent_pdv_audit_mutation()`);
  }
  await pool.query(`create or replace function audit_pdv_sale_customer() returns trigger language plpgsql as $$
    declare before_customer jsonb; after_customer jsonb;
    begin
      before_customer := case when TG_OP = 'INSERT' then null else jsonb_build_object(
        'name', coalesce(OLD.data #>> '{customer,name}', 'Consumidor Final'),
        'cpf', OLD.data #>> '{customer,cpf}',
        'blingContactId', OLD.data #>> '{customer,bling,id}') end;
      after_customer := jsonb_build_object(
        'name', coalesce(NEW.data #>> '{customer,name}', 'Consumidor Final'),
        'cpf', NEW.data #>> '{customer,cpf}',
        'blingContactId', NEW.data #>> '{customer,bling,id}');
      if TG_OP = 'INSERT' or before_customer is distinct from after_customer then
        insert into pdv_admin_audit_logs
          (id,actor_id,actor_name,actor_role,action,entity_type,entity_id,previous_value,new_value,terminal)
        values (gen_random_uuid(), 'pdv-database', 'PDV (autor da mudança não identificado)', 'SYSTEM',
          case when TG_OP = 'INSERT' then 'CUSTOMER_INITIAL' else 'CUSTOMER_CHANGED' end,
          'sale', NEW.id::text,
          case when TG_OP = 'INSERT' then null else jsonb_build_object('customer',before_customer) end,
          jsonb_build_object('customer',after_customer,'blingOrderNumber',NEW.data->>'blingOrderNumber',
            'saleOperatorId',NEW.data->>'operatorId',
            'reason',case when TG_OP = 'INSERT' then 'Cliente registrado na abertura do pedido' else 'Cliente alterado no PDV; motivo não informado' end),
          'PDV');
      end if;
      return NEW;
    end;
  $$`);
  await pool.query('drop trigger if exists pdv_sale_customer_audit on pdv_sales');
  await pool.query(`create trigger pdv_sale_customer_audit after insert or update of data on pdv_sales
    for each row execute function audit_pdv_sale_customer()`);
  await pool.query(`insert into pdv_cash_closing_versions (id, session_id, version, closing_summary, closed_at, closed_by)
    select gen_random_uuid(), id, 1, closing_summary, coalesce(closed_at, opened_at), operator_id
    from pdv_cash_sessions where status='CLOSED' and closing_summary is not null
    on conflict (session_id, version) do nothing`);
  await pool.query(`create table if not exists bling_webhook_events (
    event_id text primary key,
    event_name text not null,
    company_id text not null,
    event_date timestamptz,
    payload jsonb not null,
    status text not null check (status in ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD')),
    attempts integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error text,
    received_at timestamptz not null default now(),
    processed_at timestamptz
  )`);
  await pool.query(`create index if not exists bling_webhook_events_pending_idx
    on bling_webhook_events (status, next_attempt_at, received_at)
    where status in ('PENDING','PROCESSING','FAILED','DEAD')`);
  await pool.query(`create table if not exists pdv_operator_credentials (
    operator_id text primary key,
    pin_hash text not null,
    role text not null check (role in ('OPERATOR','MANAGER')),
    updated_by text not null,
    updated_at timestamptz not null default now()
  )`);
  await pool.query(`create table if not exists pdv_revoked_tokens (
    jti text primary key,
    expires_at timestamptz not null
  )`);
  await pool.query('delete from pdv_revoked_tokens where expires_at < now()');
  await pool.query('delete from oauth_states where expires_at < now()');
};


