-- Stable external identity bindings for Sign in with Google.
create table if not exists public.auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  subject text not null,
  email_at_link text not null,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  constraint auth_identities_provider_check check (provider in ('google')),
  constraint auth_identities_provider_subject_unique unique (provider,subject),
  constraint auth_identities_user_provider_unique unique (user_id,provider)
);

create index if not exists auth_identities_user_idx
  on public.auth_identities(user_id);

alter table public.auth_identities enable row level security;

revoke all on table public.auth_identities from anon, authenticated;
grant select,insert,update,delete on table public.auth_identities to ordergrid_app;
