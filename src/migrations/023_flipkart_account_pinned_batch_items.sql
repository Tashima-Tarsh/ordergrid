-- Pin verified Flipkart allocations to the retailer account that produced the quantity check.
alter table public.batch_items
  add column if not exists retailer_account_id uuid references public.retailer_accounts(id);

create index if not exists batch_items_retailer_account_idx
  on public.batch_items(retailer_account_id)
  where retailer_account_id is not null;
