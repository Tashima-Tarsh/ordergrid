-- Allow native worker product inspection commands and persist their verified result.
alter table public.execution_worker_commands
  drop constraint if exists execution_worker_commands_command_check;

alter table public.execution_worker_commands
  add constraint execution_worker_commands_command_check
  check (command in ('FOCUS_SESSION','PRODUCT_CHECK'));

alter table public.execution_worker_commands
  add column if not exists result jsonb;
