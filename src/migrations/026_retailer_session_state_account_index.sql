-- Cover the retailer_account_id foreign key for session-state cleanup and account lookups.
create index if not exists retailer_session_states_account_idx
  on private.retailer_session_states(retailer_account_id);
