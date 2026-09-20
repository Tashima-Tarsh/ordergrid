# Production operations

Files in this directory require deployment-owner privileges and are intentionally kept outside the normal OrderGrid application migration chain.

## Supabase hardening

Apply `supabase-production-hardening.sql` using the Supabase migration channel or another PostgreSQL owner connection.

It:
- revokes direct `anon` / `authenticated` access to OrderGrid public tables;
- makes `audit_log` append-only for `ordergrid_app`;
- relocates `citext` to the `extensions` schema;
- creates supporting indexes for foreign-key paths.

The production OrderGrid Supabase project has already had this hardening applied.
