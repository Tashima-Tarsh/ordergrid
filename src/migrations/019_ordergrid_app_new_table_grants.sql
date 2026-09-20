-- Server-role grants for tables introduced after the initial app-role bootstrap.
-- OrderGrid connects directly as ordergrid_app; browser access remains blocked by RLS.

grant select,insert,update,delete on table
  public.gst_profiles,
  public.gst_invoice_counters,
  public.gst_invoices,
  public.retailer_reward_events,
  public.retailer_refunds,
  public.retailer_order_observations,
  public.execution_worker_commands
to ordergrid_app;
