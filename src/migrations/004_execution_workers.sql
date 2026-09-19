create table if not exists execution_workers (
  id text not null,
  tenant_id uuid not null references tenants(id),
  user_id uuid not null references users(id),
  hostname text,
  mode text not null default 'BULK',
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id,id)
);
create index if not exists execution_workers_tenant_seen_idx on execution_workers(tenant_id,last_seen desc);
alter table execution_workers enable row level security;
