-- Account-level health score and cooldown for pool fairness and failure recovery.
-- health_score: 0-100 (starts 100, decremented on checkout failure, restored on success)
-- cooldown_until: auto-set after a checkout failure to prevent immediate re-assignment

alter table public.retailer_accounts
  add column if not exists health_score smallint not null default 100
    check (health_score between 0 and 100),
  add column if not exists cooldown_until timestamptz;

-- Drop and recreate the pool index to include cooldown in the eligibility scan
drop index if exists public.retailer_accounts_pool_idx;

create index if not exists retailer_accounts_pool_idx
  on public.retailer_accounts(tenant_id, retailer, active, auth_status, credential_status, cooldown_until, last_assigned_at)
  where customer_id is null;

-- Additional index for session-ready + not cooling down (used by allocation plan query)
create index if not exists retailer_accounts_session_ready_idx
  on public.retailer_accounts(tenant_id, retailer, session_status, cooldown_until, last_assigned_at)
  where active = true and auth_status not in ('LOCKED','DISABLED');

grant select, update on table public.retailer_accounts to ordergrid_app;
