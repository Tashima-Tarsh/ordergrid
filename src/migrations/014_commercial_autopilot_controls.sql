alter table public.automation_policies
  add column if not exists max_price_increase_percent numeric(6,2) not null default 5.00,
  add column if not exists max_order_value_minor bigint not null default 0,
  add column if not exists max_batch_variance_percent numeric(6,2) not null default 3.00,
  add column if not exists price_breach_action text not null default 'PAUSE_ORDER',
  add column if not exists run_mode text not null default 'MANUAL',
  add column if not exists inherit_parent_policy boolean not null default true,
  add column if not exists allow_child_policy_relaxation boolean not null default false;

alter table public.automation_policies
  drop constraint if exists automation_policies_price_increase_check,
  add constraint automation_policies_price_increase_check check (max_price_increase_percent between 0 and 100),
  drop constraint if exists automation_policies_order_value_check,
  add constraint automation_policies_order_value_check check (max_order_value_minor >= 0),
  drop constraint if exists automation_policies_batch_variance_check,
  add constraint automation_policies_batch_variance_check check (max_batch_variance_percent between 0 and 100),
  drop constraint if exists automation_policies_price_breach_action_check,
  add constraint automation_policies_price_breach_action_check check (price_breach_action in ('PAUSE_ORDER','PAUSE_BATCH')),
  drop constraint if exists automation_policies_run_mode_check,
  add constraint automation_policies_run_mode_check check (run_mode in ('MANUAL','CONTINUOUS'));

alter table public.checkout_baskets
  add column if not exists observed_amount_minor bigint,
  add column if not exists commercial_status text not null default 'PENDING',
  add column if not exists commercial_variance_percent numeric(8,3),
  add column if not exists commercial_checked_at timestamptz;

alter table public.checkout_baskets
  drop constraint if exists checkout_baskets_observed_amount_check,
  add constraint checkout_baskets_observed_amount_check check (observed_amount_minor is null or observed_amount_minor >= 0),
  drop constraint if exists checkout_baskets_commercial_status_check,
  add constraint checkout_baskets_commercial_status_check check (commercial_status in ('PENDING','APPROVED','REVIEW_REQUIRED'));

create index if not exists checkout_baskets_commercial_status_idx
  on public.checkout_baskets(tenant_id,commercial_status,status);

create index if not exists automation_policies_run_mode_idx
  on public.automation_policies(run_mode,automation_enabled);
