-- Flipkart authentication is OTP-first. Persist only the authenticated browser
-- cookie checkpoint, encrypted by the application before it reaches this private table.
create table if not exists private.retailer_session_states (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retailer_account_id uuid not null references public.retailer_accounts(id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,retailer_account_id)
);

create index if not exists retailer_session_states_expiry_idx
  on private.retailer_session_states(expires_at);

-- The production web service runs as a restricted database role. Grant only the
-- private schema visibility and CRUD required for encrypted session checkpoints.
do $
begin
  if exists(select 1 from pg_roles where rolname='ordergrid_app') then
    execute 'grant usage on schema private to ordergrid_app';
    execute 'grant select, insert, update, delete on table private.retailer_session_states to ordergrid_app';
  end if;
end $;

update public.retailer_accounts
set session_target_days=15,
    session_target_expires_at=case
      when session_target_expires_at is null then null
      else least(session_target_expires_at,coalesce(last_authenticated_at,now())+interval '15 days')
    end,
    updated_at=now()
where retailer='flipkart'
  and (
    session_target_days<>15
    or (session_target_expires_at is not null and session_target_expires_at>coalesce(last_authenticated_at,now())+interval '15 days')
  );
