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
  await pool.query('delete from oauth_states where expires_at < now()');
};
