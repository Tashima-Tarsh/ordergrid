-- Virtual cards issuing safety and lifecycle states.
alter table public.virtual_cards
  drop constraint if exists virtual_cards_status_check;

alter table public.virtual_cards
  add constraint virtual_cards_status_check
  check (status in (
    'PENDING_ISSUE',
    'ISSUING',
    'ACTIVE',
    'CONTROL_FAILED',
    'LOAD_FAILED',
    'CLOSED',
    'DISABLED',
    'CANCELLED',
    'ISSUE_UNCERTAIN',
    'CLEANUP_REQUIRED'
  ));

alter table public.virtual_cards
  add column if not exists issuing_started_at timestamptz;

-- Replace full unique index with partial unique index ignoring CLOSED and CANCELLED cards
drop index if exists public.virtual_cards_one_basket_uidx;

create unique index if not exists virtual_cards_one_basket_uidx
  on public.virtual_cards(checkout_basket_id)
  where checkout_basket_id is not null and status not in ('CLOSED','CANCELLED');

grant select, insert, update on table public.virtual_cards to ordergrid_app;
