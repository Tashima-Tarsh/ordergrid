alter table checkout_baskets
  add column if not exists execution_worker_id text;
create index if not exists checkout_baskets_worker_idx
  on checkout_baskets(tenant_id,execution_worker_id,status);
