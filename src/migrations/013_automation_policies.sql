create table if not exists public.automation_policies (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  automation_enabled boolean not null default true,
  auto_assign_virtual_card boolean not null default true,
  auto_continue_checkout boolean not null default true,
  max_active_orders integer not null default 8 check (max_active_orders between 1 and 50),
  failure_pause_percent numeric(5,2) not null default 5.00 check (failure_pause_percent between 0 and 100),
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.automation_policies enable row level security;
revoke all on public.automation_policies from anon, authenticated;

create index if not exists automation_policies_updated_by_idx
  on public.automation_policies(updated_by)
  where updated_by is not null;
