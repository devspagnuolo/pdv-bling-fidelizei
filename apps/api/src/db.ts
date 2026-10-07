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
  await pool.query('delete from oauth_states where expires_at < now()');
};
