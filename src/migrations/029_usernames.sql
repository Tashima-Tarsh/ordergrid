-- Optional human-friendly username login for OrderGrid users.
alter table public.users
  add column if not exists username citext;

create unique index if not exists users_username_uidx
  on public.users(username)
  where username is not null;
