-- Flipkart checkout hardening: durable final submission, state machine, delivery signals and audit timeline
alter table public.checkout_baskets
  add column if not exists final_submit_started_at timestamptz,
  add column if not exists final_submit_attempt_id uuid,
  add column if not exists confirmation_state text not null default 'NONE',
  add column if not exists checkout_stage text not null default 'CREATED',
  add column if not exists cart_verified_at timestamptz,
  add column if not exists address_verified_at timestamptz,
  add column if not exists delivery_estimate text,
  add column if not exists delivery_seller text,
  add column if not exists delivery_stock_state text,
  add column if not exists observed_payable_minor bigint,
  add column if not exists timeline jsonb not null default '[]'::jsonb;

create index if not exists checkout_baskets_final_submit_idx
  on public.checkout_baskets(tenant_id, final_submit_started_at);

grant select, update on table public.checkout_baskets to ordergrid_app;
