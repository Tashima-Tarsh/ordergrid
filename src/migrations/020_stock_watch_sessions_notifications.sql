-- Persistent retailer session readiness, stock-watch auto-buy, and in-app notifications.

alter table public.checkout_baskets
  drop constraint if exists checkout_baskets_status_check;
alter table public.checkout_baskets
  add constraint checkout_baskets_status_check
  check (status in ('READY','CLAIMED','OPENED','WAITING_STOCK','REQUIRES_ACTION','CONFIRMED','FAILED'));

alter table public.checkout_baskets
  add column if not exists stock_watch_enabled boolean not null default false,
  add column if not exists stock_watch_auto_order boolean not null default false,
  add column if not exists stock_watch_max_amount_minor bigint,
  add column if not exists stock_watch_interval_minutes integer not null default 15,
  add column if not exists stock_watch_started_at timestamptz,
  add column if not exists stock_watch_expires_at timestamptz,
  add column if not exists stock_last_checked_at timestamptz,
  add column if not exists stock_next_check_at timestamptz,
  add column if not exists stock_available_at timestamptz,
  add column if not exists stock_last_message text;

alter table public.checkout_baskets drop constraint if exists checkout_baskets_stock_watch_amount_check;
alter table public.checkout_baskets add constraint checkout_baskets_stock_watch_amount_check
  check (stock_watch_max_amount_minor is null or stock_watch_max_amount_minor > 0);
alter table public.checkout_baskets drop constraint if exists checkout_baskets_stock_watch_interval_check;
alter table public.checkout_baskets add constraint checkout_baskets_stock_watch_interval_check
  check (stock_watch_interval_minutes between 1 and 1440);

create index if not exists checkout_baskets_stock_watch_idx
  on public.checkout_baskets(tenant_id,execution_worker_id,stock_next_check_at)
  where status='WAITING_STOCK' and stock_watch_enabled;

alter table public.retailer_accounts
  add column if not exists session_status text not null default 'UNKNOWN',
  add column if not exists session_checked_at timestamptz,
  add column if not exists session_target_expires_at timestamptz,
  add column if not exists session_target_days integer not null default 20,
  add column if not exists session_check_requested_at timestamptz,
  add column if not exists session_check_claimed_at timestamptz,
  add column if not exists session_worker_id text;

alter table public.retailer_accounts drop constraint if exists retailer_accounts_session_status_check;
alter table public.retailer_accounts add constraint retailer_accounts_session_status_check
  check (session_status in ('UNKNOWN','VERIFYING','READY','REAUTH_REQUIRED','ERROR'));
alter table public.retailer_accounts drop constraint if exists retailer_accounts_session_target_days_check;
alter table public.retailer_accounts add constraint retailer_accounts_session_target_days_check
  check (session_target_days between 1 and 90);

create index if not exists retailer_accounts_session_check_idx
  on public.retailer_accounts(tenant_id,session_check_requested_at,session_check_claimed_at)
  where active and session_check_requested_at is not null;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  checkout_basket_id uuid references public.checkout_baskets(id) on delete cascade,
  type text not null check (type in (
    'STOCK_WATCH_STARTED','BACK_IN_STOCK','ORDER_CONFIRMED','HUMAN_ACTION_REQUIRED',
    'SESSION_READY','SESSION_REAUTH_REQUIRED','STOCK_WATCH_EXPIRED'
  )),
  title text not null,
  message text not null,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique(tenant_id,idempotency_key)
);

create index if not exists notifications_user_unread_idx
  on public.notifications(tenant_id,user_id,created_at desc)
  where read_at is null;

alter table public.notifications enable row level security;

grant select,insert,update,delete on table public.notifications to ordergrid_app;
