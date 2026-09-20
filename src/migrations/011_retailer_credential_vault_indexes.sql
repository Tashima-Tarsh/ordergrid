create index if not exists retailer_credentials_account_idx
  on private.retailer_credentials(retailer_account_id);
create index if not exists retailer_credentials_created_by_idx
  on private.retailer_credentials(created_by)
  where created_by is not null;
