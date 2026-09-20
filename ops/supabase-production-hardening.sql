-- Production hardening: direct Data API lockdown, append-only audit permissions,
-- extension hygiene, and foreign-key indexes for delete/update paths.

revoke all privileges on all tables in schema public from anon, authenticated;
revoke all privileges on all sequences in schema public from anon, authenticated;

-- The application may read and append audit records but may not mutate history.
revoke update, delete, truncate on table public.audit_log from ordergrid_app;
grant select, insert on table public.audit_log to ordergrid_app;

create schema if not exists extensions;
do $$
begin
  if exists(select 1 from pg_extension where extname='citext')
     and (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='citext')='public'
  then
    alter extension citext set schema extensions;
  end if;
end $$;

create index if not exists idx_address_books_created_by on public.address_books(created_by);
create index if not exists idx_address_books_tenant_id on public.address_books(tenant_id);
create index if not exists idx_addresses_customer_id on public.addresses(customer_id);
create index if not exists idx_audit_log_actor_id on public.audit_log(actor_id);
create index if not exists idx_batch_items_address_id on public.batch_items(address_id);
create index if not exists idx_checkout_baskets_address_id on public.checkout_baskets(address_id);
create index if not exists idx_checkout_baskets_claimed_by on public.checkout_baskets(claimed_by);
create index if not exists idx_checkout_baskets_customer_id on public.checkout_baskets(customer_id);
create index if not exists idx_checkout_baskets_issuer_connection_id on public.checkout_baskets(issuer_connection_id);
create index if not exists idx_checkout_baskets_retailer_account_id on public.checkout_baskets(retailer_account_id);
create index if not exists idx_checkout_baskets_virtual_card_id on public.checkout_baskets(virtual_card_id);
create index if not exists idx_dealer_access_created_by on public.dealer_access(created_by);
create index if not exists idx_dealer_relationships_created_by on public.dealer_relationships(created_by);
create index if not exists idx_execution_worker_commands_basket on public.execution_worker_commands(checkout_basket_id);
create index if not exists idx_execution_worker_commands_requested_by on public.execution_worker_commands(requested_by);
create index if not exists idx_execution_workers_user_id on public.execution_workers(user_id);
create index if not exists idx_funding_policies_issuer_connection_id on public.funding_policies(issuer_connection_id);
create index if not exists idx_gst_invoices_checkout_basket_id on public.gst_invoices(checkout_basket_id);
create index if not exists idx_gst_invoices_created_by on public.gst_invoices(created_by);
create index if not exists idx_gst_invoices_customer_id on public.gst_invoices(customer_id);
create index if not exists idx_gst_profiles_updated_by on public.gst_profiles(updated_by);
create index if not exists idx_issuer_connections_connected_by on public.issuer_connections(connected_by);
create index if not exists idx_notifications_checkout_basket_id on public.notifications(checkout_basket_id);
create index if not exists idx_notifications_user_id on public.notifications(user_id);
create index if not exists idx_order_batches_approved_by on public.order_batches(approved_by);
create index if not exists idx_order_batches_created_by on public.order_batches(created_by);
create index if not exists idx_purchase_orders_batch_item_id on public.purchase_orders(batch_item_id);
create index if not exists idx_retailer_accounts_created_by on public.retailer_accounts(created_by);
create index if not exists idx_retailer_order_observations_basket on public.retailer_order_observations(checkout_basket_id);
create index if not exists idx_retailer_order_observations_account on public.retailer_order_observations(retailer_account_id);
create index if not exists idx_retailer_refunds_created_by on public.retailer_refunds(created_by);
create index if not exists idx_retailer_refunds_purchase_order_id on public.retailer_refunds(purchase_order_id);
create index if not exists idx_retailer_refunds_account on public.retailer_refunds(retailer_account_id);
create index if not exists idx_retailer_refunds_card on public.retailer_refunds(virtual_card_id);
create index if not exists idx_retailer_reward_events_created_by on public.retailer_reward_events(created_by);
create index if not exists idx_retailer_reward_events_purchase_order_id on public.retailer_reward_events(purchase_order_id);
create index if not exists idx_retailer_reward_events_account on public.retailer_reward_events(retailer_account_id);
create index if not exists idx_sessions_user_id on public.sessions(user_id);
create index if not exists idx_virtual_cards_created_by on public.virtual_cards(created_by);
create index if not exists idx_virtual_cards_customer_id on public.virtual_cards(customer_id);
create index if not exists idx_virtual_cards_issuer_connection_id on public.virtual_cards(issuer_connection_id);
