create table if not exists checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  purchase_order_id uuid not null references purchase_orders(id),
  claimed_by uuid not null references users(id),
  status text not null default 'CLAIMED' check (status in ('CLAIMED','OPENED','CONFIRMED','RELEASED','EXPIRED')),
  retailer_host text not null,
  opened_at timestamptz,
  confirmed_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_order_id)
);
create index if not exists checkout_sessions_tenant_status_idx on checkout_sessions(tenant_id,status,expires_at);
alter table checkout_sessions enable row level security;
