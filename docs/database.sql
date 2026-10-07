-- PostgreSQL: modelo inicial (UUID, timestamps e ids externos são obrigatórios)
create table sales (
  id uuid primary key, status text not null, operator_id text not null, seller_id text not null,
  customer_id text, bling_order_id text unique, fidelizei_transaction_id text,
  coupon_id text, subtotal numeric(12,2) not null, discount numeric(12,2) not null,
  total numeric(12,2) not null, payment_method text not null, fiscal_status text not null default 'PENDING',
  created_at timestamptz not null default now(), completed_at timestamptz
);
create table sale_items (
  id uuid primary key, sale_id uuid not null references sales(id), product_id text not null,
  sku text not null, description text not null, quantity numeric(12,3) not null,
  unit_price numeric(12,2) not null, line_total numeric(12,2) not null
);
create table integration_events (
  id uuid primary key, provider text not null, event_type text not null, idempotency_key text not null unique,
  payload jsonb not null, status text not null, attempts int not null default 0, created_at timestamptz not null default now()
);
create table coupon_reservations (
  id uuid primary key, sale_id uuid not null references sales(id), coupon_id text not null,
  external_reservation_id text unique, status text not null, expires_at timestamptz not null
);
