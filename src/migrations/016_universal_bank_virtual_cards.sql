-- Universal bank virtual-card adapters.
alter table public.issuer_connections
  add column if not exists bank_code text,
  add column if not exists integration_mode text not null default 'ISSUER_PROGRAMME',
  add column if not exists capabilities jsonb not null default '{}'::jsonb;

alter table public.issuer_connections drop constraint if exists issuer_connections_provider_check;
alter table public.issuer_connections add constraint issuer_connections_provider_check
  check (provider in ('enkash','hdfc','axis','icici','sbi','yes','kotak','indusind','idfc','bob','custom'));

alter table public.issuer_connections drop constraint if exists issuer_connections_integration_mode_check;
alter table public.issuer_connections add constraint issuer_connections_integration_mode_check
  check (integration_mode in ('ISSUER_PROGRAMME','PARENT_CARD_API','CUSTOM_BANK_API'));

alter table public.virtual_cards drop constraint if exists virtual_cards_channel_control_status_check;
alter table public.virtual_cards add constraint virtual_cards_channel_control_status_check
  check (channel_control_status in ('NOT_APPLIED','APPLIED','NOT_SUPPORTED','FAILED'));

create index if not exists issuer_connections_bank_code_idx
  on public.issuer_connections(tenant_id,bank_code,status);

alter table public.funding_policies drop constraint if exists funding_policies_issuer_provider_check;
alter table public.funding_policies add constraint funding_policies_issuer_provider_check
  check (issuer_provider in ('axis','hdfc','icici','sbi','yes','kotak','indusind','idfc','bob','enkash','custom'));
