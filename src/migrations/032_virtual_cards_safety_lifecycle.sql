-- Virtual cards safety lifecycle: support PENDING_ISSUE, CONTROL_FAILED, LOAD_FAILED, CLOSED statuses.
alter table public.virtual_cards
  drop constraint if exists virtual_cards_status_check;

alter table public.virtual_cards
  add constraint virtual_cards_status_check
  check (status in ('PENDING_ISSUE','ACTIVE','CONTROL_FAILED','LOAD_FAILED','CLOSED','DISABLED','CANCELLED'));

grant select, insert, update on table public.virtual_cards to ordergrid_app;
