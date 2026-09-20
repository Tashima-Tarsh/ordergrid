-- PCI-safe identity for the existing funding card/programme.
-- Stores identification metadata only; never full PAN, CVV, PIN or OTP.

alter table public.issuer_connections
  add column if not exists funding_cardholder_name text,
  add column if not exists funding_card_last4 text,
  add column if not exists funding_card_expiry_month smallint,
  add column if not exists funding_card_expiry_year smallint;

alter table public.issuer_connections
  drop constraint if exists issuer_connections_funding_card_last4_check,
  add constraint issuer_connections_funding_card_last4_check
    check (funding_card_last4 is null or funding_card_last4 ~ '^[0-9]{4}$'),
  drop constraint if exists issuer_connections_funding_card_expiry_month_check,
  add constraint issuer_connections_funding_card_expiry_month_check
    check (funding_card_expiry_month is null or funding_card_expiry_month between 1 and 12),
  drop constraint if exists issuer_connections_funding_card_expiry_year_check,
  add constraint issuer_connections_funding_card_expiry_year_check
    check (funding_card_expiry_year is null or funding_card_expiry_year between 2024 and 2100);
