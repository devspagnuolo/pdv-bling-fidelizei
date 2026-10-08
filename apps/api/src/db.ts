import pg from 'pg';

export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
  : undefined;

export const initializeDatabase = async () => {
  if (!pool) return;
  await pool.query(`create table if not exists pdv_sales (
    id uuid primary key,
    status text not null,
    data jsonb not null,
    updated_at timestamptz not null default now()
  )`);
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
  await pool.query('delete from oauth_states where expires_at < now()');
};
