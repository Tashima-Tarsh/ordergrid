-- Explicit customer identity, retailer-account isolation and deterministic funding routing.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  external_reference text not null,
  display_name text,
  phone text,
  email citext,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, external_reference)
);

create table if not exists retailer_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  retailer text not null,
  account_reference text not null,
  profile_key text not null default gen_random_uuid()::text,
  auth_status text not null default 'AUTH_REQUIRED'
    check (auth_status in ('AUTH_REQUIRED','READY','CHALLENGE','LOCKED','DISABLED')),
  last_authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id, customer_id, retailer),
  unique(tenant_id, retailer, account_reference),
  unique(tenant_id, profile_key)
);

create table if not exists funding_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  retailer text,
  issuer_provider text not null check (issuer_provider in ('axis','hdfc','icici','enkash','custom')),
  issuer_connection_id uuid references issuer_connections(id) on delete set null,
  min_amount_minor bigint not null default 0 check (min_amount_minor >= 0),
  max_amount_minor bigint check (max_amount_minor is null or max_amount_minor >= min_amount_minor),
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table issuer_connections drop constraint if exists issuer_connections_provider_check;
alter table issuer_connections add constraint issuer_connections_provider_check
  check (provider in ('axis','hdfc','icici','enkash','custom'));
alter table issuer_connections drop constraint if exists issuer_connections_tenant_id_key;
create unique index if not exists issuer_connections_tenant_provider_uidx
  on issuer_connections(tenant_id,provider);

alter table addresses add column if not exists customer_id uuid references customers(id);
alter table checkout_baskets add column if not exists customer_id uuid references customers(id);
alter table checkout_baskets add column if not exists retailer_account_id uuid references retailer_accounts(id);
alter table checkout_baskets add column if not exists issuer_connection_id uuid references issuer_connections(id);
alter table checkout_baskets add column if not exists virtual_card_id uuid references virtual_cards(id);
alter table virtual_cards add column if not exists customer_id uuid references customers(id);
alter table virtual_cards add column if not exists checkout_basket_id uuid references checkout_baskets(id);

-- Backfill customers from existing recipient records. Stable CSV reference wins;
-- otherwise the address id becomes a deterministic legacy reference.
insert into customers(tenant_id, external_reference, display_name, phone)
select distinct on (ab.tenant_id, coalesce(nullif(a.reference,''),'ADDR-'||a.id::text))
  ab.tenant_id,
  coalesce(nullif(a.reference,''),'ADDR-'||a.id::text),
  a.recipient,
  a.phone
from addresses a
join address_books ab on ab.id=a.address_book_id
on conflict(tenant_id, external_reference) do update
set display_name=excluded.display_name, phone=excluded.phone, updated_at=now();

update addresses a
set customer_id=c.id
from address_books ab, customers c
where ab.id=a.address_book_id
  and c.tenant_id=ab.tenant_id
  and c.external_reference=coalesce(nullif(a.reference,''),'ADDR-'||a.id::text)
  and a.customer_id is null;

-- Existing baskets get an explicit customer and an isolated retailer account.
update checkout_baskets cb
set customer_id=a.customer_id
from addresses a
where a.id=cb.address_id and cb.customer_id is null;

insert into retailer_accounts(tenant_id,customer_id,retailer,account_reference)
select distinct cb.tenant_id,cb.customer_id,cb.retailer,
       coalesce(nullif(cb.account_reference,''),c.external_reference)
from checkout_baskets cb
join customers c on c.id=cb.customer_id
where cb.customer_id is not null
on conflict(tenant_id,customer_id,retailer) do nothing;

update checkout_baskets cb
set retailer_account_id=ra.id,
    account_reference=ra.account_reference
from retailer_accounts ra
where ra.tenant_id=cb.tenant_id
  and ra.customer_id=cb.customer_id
  and ra.retailer=cb.retailer
  and cb.retailer_account_id is null;

create index if not exists customers_tenant_reference_idx on customers(tenant_id,external_reference);
create index if not exists retailer_accounts_tenant_retailer_idx on retailer_accounts(tenant_id,retailer,auth_status);
create index if not exists retailer_accounts_customer_idx on retailer_accounts(customer_id,retailer);
create index if not exists funding_policies_route_idx on funding_policies(tenant_id,retailer,active,priority);
create index if not exists checkout_baskets_customer_idx on checkout_baskets(tenant_id,customer_id,retailer);
create index if not exists virtual_cards_customer_idx on virtual_cards(tenant_id,customer_id);

alter table customers enable row level security;
alter table retailer_accounts enable row level security;
alter table funding_policies enable row level security;
