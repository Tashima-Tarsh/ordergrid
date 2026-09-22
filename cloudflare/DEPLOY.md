# OrderGrid Cloudflare-only deployment

OrderGrid's production path is now:

- Cloudflare Worker: public URL, static assets, API routing
- Cloudflare Container: Fastify API plus managed Chromium execution
- Supabase: persistent database
- No Render origin is used by the Worker

## Cloudflare plan

Cloudflare Containers require the Workers Paid plan. The backend uses one `standard-1` instance (4 GiB RAM) in APAC.

## Required Worker secrets

Set these in Cloudflare **Workers & Pages → ordergrid → Settings → Variables and Secrets** as **Secret** values:

- `DATABASE_URL` — the existing production Supabase/Postgres connection string
- `DATA_ENCRYPTION_KEY_BASE64` — the existing OrderGrid encryption key. This must be the same key used by the current production database data.

Optional existing production values can also be copied with the same names: `REDIS_URL`, `GOOGLE_CLIENT_ID`, `ORDERGRID_SIGNUP_CODE`, Shopify/card/EnKash variables.

Do not commit secret values to GitHub.

## Deploy

The Git-connected production build must run:

`npx wrangler deploy`

That command builds `Dockerfile.cloudflare`, pushes the image to Cloudflare's container registry, deploys the Worker, and rolls out the Container.

After deploy, verify:

- `/api/cloudflare/status` → `platform: cloudflare`, `renderDependency: false`
- `/api/health` → application/database health from the Cloudflare Container
- `/version.json` → `cloudflare-container-backend-2026-09-22`

The Worker wakes/keeps the singleton backend Container active every five minutes so the managed retailer worker can continue processing.
