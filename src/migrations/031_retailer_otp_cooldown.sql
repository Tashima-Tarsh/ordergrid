-- Retailer account OTP request tracking and rate-limit cooldown.
alter table public.retailer_accounts
  add column if not exists otp_last_requested_at timestamptz,
  add column if not exists otp_cooldown_until timestamptz,
  add column if not exists session_check_verify_only boolean not null default false;

create index if not exists retailer_accounts_otp_cooldown_idx
  on public.retailer_accounts(tenant_id, retailer, otp_cooldown_until);

grant select, update on table public.retailer_accounts to ordergrid_app;
