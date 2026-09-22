-- Stable external identities for Google Sign-In.
create schema if not exists private;

create table if not exists private.user_external_identities (
  provider text not null,
  subject text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  email_at_link text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider, subject),
  unique (provider, user_id),
  constraint user_external_identities_provider_check check (provider in ('google'))
);

create index if not exists user_external_identities_user_idx
  on private.user_external_identities(user_id);

revoke all on table private.user_external_identities from public, anon, authenticated;
grant usage on schema private to ordergrid_app;
grant select,insert,update,delete on table private.user_external_identities to ordergrid_app;
