-- Human action commands and retailer reconciliation observations.

alter table public.retailer_accounts
  add column if not exists reward_balance_observed integer,
  add column if not exists reward_balance_observed_at timestamptz,
  add column if not exists reward_tier text;

alter table public.checkout_baskets
  add column if not exists reconciliation_status text not null default 'PENDING',
  add column if not exists reconciliation_last_at timestamptz,
  add column if not exists reconciliation_next_at timestamptz,
  add column if not exists reconciliation_error text;

alter table public.checkout_baskets
  drop constraint if exists checkout_baskets_reconciliation_status_check;
alter table public.checkout_baskets
  add constraint checkout_baskets_reconciliation_status_check
  check (reconciliation_status in ('PENDING','RUNNING','OBSERVED','ERROR'));

create index if not exists checkout_baskets_reconciliation_idx
  on public.checkout_baskets(tenant_id,status,reconciliation_next_at)
  where status='CONFIRMED';

create table if not exists public.execution_worker_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  worker_id text not null,
  checkout_basket_id uuid references public.checkout_baskets(id) on delete cascade,
  command text not null check (command in ('FOCUS_SESSION')),
  status text not null default 'PENDING'
    check (status in ('PENDING','PROCESSING','COMPLETED','FAILED')),
  payload jsonb not null default '{}'::jsonb,
  requested_by uuid references public.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  processing_at timestamptz,
  completed_at timestamptz,
  error text
);

create index if not exists execution_worker_commands_claim_idx
  on public.execution_worker_commands(tenant_id,worker_id,status,requested_at);

alter table public.execution_worker_commands enable row level security;


create table if not exists public.retailer_order_observations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retailer_account_id uuid not null references public.retailer_accounts(id) on delete cascade,
  checkout_basket_id uuid references public.checkout_baskets(id) on delete cascade,
  retailer text not null,
  retailer_order_id text not null,
  order_status text,
  refund_status text,
  refund_amount_minor bigint,
  reward_units integer,
  source_url text,
  excerpt text,
  observed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,retailer_account_id,retailer_order_id),
  check (refund_amount_minor is null or refund_amount_minor > 0)
);

create index if not exists retailer_order_observations_account_idx
  on public.retailer_order_observations(tenant_id,retailer_account_id,observed_at desc);

alter table public.retailer_order_observations enable row level security;
