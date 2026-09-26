-- Dealer network hierarchy built on existing tenant isolation.
-- A main dealer is a tenant. Each sub-dealer is a child tenant and therefore
-- automatically receives the full OrderGrid workflow, data isolation and funding scope.

create table if not exists public.dealer_relationships (
  id uuid primary key default gen_random_uuid(),
  parent_tenant_id uuid not null references public.tenants(id) on delete cascade,
  child_tenant_id uuid not null references public.tenants(id) on delete cascade,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUSPENDED')),
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_tenant_id <> child_tenant_id),
  unique (child_tenant_id),
  unique (parent_tenant_id, child_tenant_id)
);

create table if not exists public.dealer_access (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  role user_role not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, tenant_id)
);

alter table public.sessions
  add column if not exists active_tenant_id uuid references public.tenants(id) on delete cascade;

update public.sessions s
set active_tenant_id=u.tenant_id
from public.users u
where u.id=s.user_id and s.active_tenant_id is null;

create unique index if not exists users_global_email_uidx
  on public.users(lower(email::text));

create index if not exists dealer_relationships_parent_idx
  on public.dealer_relationships(parent_tenant_id,status);

create index if not exists dealer_access_user_idx
  on public.dealer_access(user_id,tenant_id);

create index if not exists dealer_access_tenant_idx
  on public.dealer_access(tenant_id,user_id);

create index if not exists sessions_active_tenant_idx
  on public.sessions(active_tenant_id,user_id);

alter table public.dealer_relationships enable row level security;
alter table public.dealer_access enable row level security;

