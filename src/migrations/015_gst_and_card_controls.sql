-- GST reporting/invoice snapshots and PCI-safe virtual-card programme controls.

alter table public.issuer_connections
  add column if not exists bank_name text,
  add column if not exists programme_name text,
  add column if not exists card_network text;

alter table public.virtual_cards
  add column if not exists issuer_connection_id uuid references public.issuer_connections(id) on delete set null,
  add column if not exists merchant_scope_type text not null default 'ALL',
  add column if not exists merchant_scope_value text,
  add column if not exists channel_control_status text not null default 'NOT_APPLIED';

alter table public.virtual_cards
  drop constraint if exists virtual_cards_merchant_scope_type_check,
  add constraint virtual_cards_merchant_scope_type_check check (merchant_scope_type in ('ALL','RETAILER')),
  drop constraint if exists virtual_cards_channel_control_status_check,
  add constraint virtual_cards_channel_control_status_check check (channel_control_status in ('NOT_APPLIED','APPLIED','FAILED'));

alter table public.customers
  add column if not exists legal_name text,
  add column if not exists gstin text,
  add column if not exists state_code text;

alter table public.customers
  drop constraint if exists customers_gstin_check,
  add constraint customers_gstin_check check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  drop constraint if exists customers_state_code_check,
  add constraint customers_state_code_check check (state_code is null or state_code ~ '^[0-9]{2}$');

alter table public.batch_items
  add column if not exists hsn_sac text,
  add column if not exists gst_rate numeric(6,3),
  add column if not exists cess_rate numeric(6,3) not null default 0,
  add column if not exists price_includes_gst boolean not null default true;

alter table public.batch_items
  drop constraint if exists batch_items_gst_rate_check,
  add constraint batch_items_gst_rate_check check (gst_rate is null or (gst_rate >= 0 and gst_rate <= 100)),
  drop constraint if exists batch_items_cess_rate_check,
  add constraint batch_items_cess_rate_check check (cess_rate >= 0 and cess_rate <= 100);

create table if not exists public.gst_profiles (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  legal_name text not null,
  trade_name text,
  gstin text not null,
  address_line1 text not null,
  address_line2 text,
  city text not null,
  state text not null,
  state_code text not null,
  postal_code text not null,
  invoice_prefix text not null default 'OG',
  e_invoice_applicable boolean not null default false,
  signatory_name text,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  check (state_code ~ '^[0-9]{2}$'),
  check (postal_code ~ '^[0-9]{6}$')
);
alter table public.gst_profiles enable row level security;

create table if not exists public.gst_invoice_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  financial_year text not null,
  next_number integer not null default 1 check (next_number > 0),
  primary key (tenant_id,financial_year)
);
alter table public.gst_invoice_counters enable row level security;

create table if not exists public.gst_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  checkout_basket_id uuid not null references public.checkout_baskets(id) on delete restrict,
  customer_id uuid references public.customers(id) on delete set null,
  invoice_number text not null,
  invoice_date date not null default current_date,
  financial_year text not null,
  status text not null default 'READY',
  supplier_snapshot jsonb not null,
  buyer_snapshot jsonb not null,
  line_snapshot jsonb not null,
  taxable_minor bigint not null default 0,
  cgst_minor bigint not null default 0,
  sgst_minor bigint not null default 0,
  igst_minor bigint not null default 0,
  cess_minor bigint not null default 0,
  total_minor bigint not null default 0,
  place_of_supply_state_code text not null,
  reverse_charge boolean not null default false,
  irn text,
  signed_qr text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id,checkout_basket_id),
  unique (tenant_id,invoice_number),
  check (status in ('READY','IRN_REQUIRED')),
  check (place_of_supply_state_code ~ '^[0-9]{2}$')
);
create index if not exists gst_invoices_tenant_created_idx on public.gst_invoices(tenant_id,created_at desc);
create index if not exists virtual_cards_scope_idx on public.virtual_cards(tenant_id,merchant_scope_type,merchant_scope_value,status);
alter table public.gst_invoices enable row level security;
