-- Managed browser execution can accept a user-supplied retailer OTP without exposing a local browser.
alter table public.execution_worker_commands
  drop constraint if exists execution_worker_commands_command_check;

alter table public.execution_worker_commands
  add constraint execution_worker_commands_command_check
  check (command in ('FOCUS_SESSION','PRODUCT_CHECK','SUBMIT_OTP'));

alter table public.retailer_accounts
  add column if not exists session_challenge_code text;
