alter table order_batches
  add column if not exists payment_route text not null default 'Corporate virtual card';

do $$ begin
  alter table order_batches
    add constraint order_batches_payment_route_check
    check (payment_route in ('Corporate virtual card','Cash on Delivery'));
exception when duplicate_object then null;
end $$;

create table if not exists checkout_baskets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  batch_id uuid not null references order_batches(id) on delete cascade,
  address_id uuid not null references addresses(id),
  account_reference text,
  retailer text not null,
  status text not null default 'READY'
    check (status in ('READY','CLAIMED','OPENED','REQUIRES_ACTION','CONFIRMED','FAILED')),
  claimed_by uuid references users(id),
  retailer_order_id text,
  failure_code text,
  failure_message text,
  expires_at timestamptz,
  opened_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id,address_id,retailer)
);

alter table purchase_orders
  add column if not exists checkout_basket_id uuid references checkout_baskets(id);

create index if not exists checkout_baskets_tenant_status_idx
  on checkout_baskets(tenant_id,status,expires_at);
create index if not exists purchase_orders_basket_idx
  on purchase_orders(checkout_basket_id);

alter table checkout_baskets enable row level security;
