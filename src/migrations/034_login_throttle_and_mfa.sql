-- Login throttling, account lockouts, and TOTP Multi-Factor Authentication (MFA)
create table if not exists public.login_throttle (
  identifier_hash text primary key,
  failures int not null default 0,
  locked_until timestamptz,
  lock_count int not null default 0,
  last_failure_at timestamptz
);

alter table public.users
  add column if not exists mfa_secret_ciphertext bytea,
  add column if not exists mfa_secret_iv bytea,
  add column if not exists mfa_secret_auth_tag bytea,
  add column if not exists mfa_enabled boolean not null default false,
  add column if not exists mfa_enrolled_at timestamptz,
  add column if not exists mfa_last_used_step bigint;

create table if not exists public.user_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_recovery_codes_user_idx
  on public.user_recovery_codes(user_id);

alter table public.login_throttle enable row level security;
alter table public.user_recovery_codes enable row level security;

grant select, insert, update, delete on table public.login_throttle to ordergrid_app;
grant select, insert, update, delete on table public.user_recovery_codes to ordergrid_app;
