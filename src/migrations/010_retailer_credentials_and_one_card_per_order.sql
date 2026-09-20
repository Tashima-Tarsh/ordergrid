-- Retailer credential vault metadata and one-order/one-card enforcement.
create schema if not exists private;

create table if not exists private.retailer_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retailer_account_id uuid not null references public.retailer_accounts(id) on delete cascade,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (tenant_id, retailer_account_id)
);

alter table public.retailer_accounts
  add column if not exists credential_status text not null default 'MISSING',
  add column if not exists last_credential_update_at timestamptz;

alter table public.retailer_accounts
  drop constraint if exists retailer_accounts_credential_status_check;
alter table public.retailer_accounts
  add constraint retailer_accounts_credential_status_check
  check (credential_status in ('MISSING','STORED','VERIFICATION_REQUIRED','READY'));

alter table public.checkout_baskets
  add column if not exists payment_status text not null default 'PENDING';

alter table public.checkout_baskets
  drop constraint if exists checkout_baskets_payment_status_check;
alter table public.checkout_baskets
  add constraint checkout_baskets_payment_status_check
  check (payment_status in ('PENDING','CARD_ASSIGNED','VERIFICATION_REQUIRED','CONFIRMED','FAILED'));

update public.checkout_baskets
set payment_status=case
  when virtual_card_id is not null then 'CARD_ASSIGNED'
  else 'PENDING'
end
where payment_status='PENDING';

create unique index if not exists virtual_cards_one_basket_uidx
  on public.virtual_cards(checkout_basket_id)
  where checkout_basket_id is not null;

create index if not exists retailer_accounts_credential_status_idx
  on public.retailer_accounts(tenant_id,credential_status,auth_status);

create index if not exists retailer_credentials_tenant_account_idx
  on private.retailer_credentials(tenant_id,retailer_account_id);

revoke all on schema private from public;
revoke all on all tables in schema private from anon, authenticated;
