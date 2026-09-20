-- Scalable retailer account pools plus per-account rewards/refund ledgers.
-- Accounts may be explicitly bound to a customer or exist as reusable tenant-level pool accounts.

alter table public.retailer_accounts
  alter column customer_id drop not null;

alter table public.retailer_accounts
  drop constraint if exists retailer_accounts_tenant_id_customer_id_retailer_key;

alter table public.retailer_accounts
  add column if not exists label text,
  add column if not exists active boolean not null default true,
  add column if not exists max_concurrent_orders integer not null default 1,
  add column if not exists last_assigned_at timestamptz,
  add column if not exists created_by uuid references public.users(id) on delete set null;

alter table public.retailer_accounts
  drop constraint if exists retailer_accounts_max_concurrent_orders_check;
alter table public.retailer_accounts
  add constraint retailer_accounts_max_concurrent_orders_check
  check (max_concurrent_orders between 1 and 100);

create unique index if not exists retailer_accounts_bound_customer_retailer_uidx
  on public.retailer_accounts(tenant_id,customer_id,retailer)
  where customer_id is not null;

create index if not exists retailer_accounts_pool_idx
  on public.retailer_accounts(tenant_id,retailer,active,auth_status,credential_status,last_assigned_at)
  where customer_id is null;

create table if not exists public.retailer_reward_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retailer_account_id uuid not null references public.retailer_accounts(id) on delete cascade,
  checkout_basket_id uuid references public.checkout_baskets(id) on delete set null,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  retailer text not null,
  reward_type text not null default 'SUPERCOIN',
  event_type text not null
    check (event_type in ('PENDING','CREDITED','REDEEMED','REVERSED','ADJUSTED')),
  units integer not null,
  idempotency_key text not null,
  retailer_reference text,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create table if not exists public.retailer_refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retailer_account_id uuid not null references public.retailer_accounts(id) on delete cascade,
  checkout_basket_id uuid references public.checkout_baskets(id) on delete set null,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  virtual_card_id uuid references public.virtual_cards(id) on delete set null,
  retailer text not null,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'INR',
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED','INITIATED','PROCESSING','SETTLED','FAILED','CANCELLED')),
  idempotency_key text not null,
  retailer_refund_reference text,
  bank_reference text,
  requested_at timestamptz not null default now(),
  initiated_at timestamptz,
  settled_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create index if not exists retailer_reward_events_account_time_idx
  on public.retailer_reward_events(tenant_id,retailer_account_id,occurred_at desc);
create index if not exists retailer_reward_events_basket_idx
  on public.retailer_reward_events(checkout_basket_id);
create index if not exists retailer_refunds_account_status_idx
  on public.retailer_refunds(tenant_id,retailer_account_id,status,created_at desc);
create index if not exists retailer_refunds_basket_idx
  on public.retailer_refunds(checkout_basket_id);

alter table public.retailer_reward_events enable row level security;
alter table public.retailer_refunds enable row level security;
