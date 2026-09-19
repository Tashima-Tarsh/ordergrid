create table if not exists virtual_cards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  provider text not null,
  provider_card_id text not null,
  provider_account_id text,
  label text,
  masked_number text,
  status text not null default 'ACTIVE',
  balance_minor bigint not null default 0,
  currency char(3) not null default 'INR',
  merchant_control text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider,provider_card_id)
);
create index if not exists virtual_cards_tenant_created_idx on virtual_cards(tenant_id,created_at desc);
alter table virtual_cards enable row level security;
