create table if not exists issuer_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references tenants(id) on delete cascade,
  provider text not null check (provider in ('enkash')),
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  status text not null default 'CONNECTED' check (status in ('CONNECTED','ERROR','DISCONNECTED')),
  connected_by uuid references users(id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists issuer_connections_tenant_idx on issuer_connections(tenant_id);
alter table issuer_connections enable row level security;
