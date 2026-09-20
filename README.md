# OrderGrid

**A procurement execution system for authorized retailer accounts: product verification, multi-account allocation, persistent browser sessions, bulk checkout, card funding, GST billing, reconciliation and backend automation.**

OrderGrid is built for organizations that need to place many legitimate ecommerce orders through authorized customer/retailer accounts while keeping identity, delivery address, funding, checkout state and retailer confirmation tied together.

Production web app: **https://ordergrid-production.onrender.com**

> OrderGrid automates ordinary browser and workflow steps. It does **not** bypass retailer login controls, OTP, CAPTCHA, 3DS, bank verification, account limits or other protected checks.

---

## What OrderGrid does

The current product combines:

- a multi-tenant Fastify API and PostgreSQL data model;
- persistent retailer-account identities and delivery addresses;
- a native Chrome execution worker with isolated browser profiles;
- bulk procurement and checkout baskets;
- Flipkart mobile price / availability / account-quantity verification;
- multi-account allocation for a requested total quantity;
- backend automation policies and commercial guardrails;
- virtual-card issuer routing and one-order / one-card assignment;
- GST profile, tax calculation, invoice generation and Excel reporting;
- protected human-action handoff for OTP / CAPTCHA / payment verification;
- retailer order-ID confirmation and reconciliation;
- audit events, roles and tenant-scoped records.

The visible workspace currently contains:

**Control Center · Dashboard · Fulfilment · Bulk Orders · Payments · GST & Invoices · Cards & funding · Retailer users**

Autopilot is intentionally **backend-only** in the current frontend. Its policy engine and continuous triggers remain active through the API / worker runtime.

---

## Core execution model

A procurement line is not treated as an anonymous browser click. OrderGrid keeps an explicit identity chain:

```text
tenant
  -> customer
  -> delivery address
  -> retailer account
  -> persistent Chrome profile
  -> product verification
  -> batch item
  -> checkout basket
  -> funding route / virtual card
  -> native worker
  -> retailer order ID
  -> GST / reconciliation records
```

This matters because a quantity limit, authenticated retailer session, delivery address and order confirmation must all belong to the same authorized account.

---

## Flipkart mobile procurement

Flipkart mobile procurement has the most specific retailer logic in the current codebase.

### Account onboarding

OrderGrid can create retailer users individually or import them from CSV/XLSX.

For Flipkart, internal customer references are generated automatically:

```text
ordergrid-flip-000001
ordergrid-flip-000002
ordergrid-flip-000003
...
```

Each retailer account can be bound to:

- customer identity;
- login/mobile/email reference;
- delivery address;
- persistent Chrome profile;
- optional encrypted retailer password;
- maximum concurrent order policy;
- session health / worker state.

Passwords, when intentionally supplied, are encrypted server-side with AES-256-GCM. OTP, CAPTCHA, CVV and 3DS values are not stored.

### Persistent sessions

The native worker keeps one Chrome profile per retailer account.

Session preparation currently has dedicated handling for:

- **Flipkart**
- **Amazon India**

A first login or expired session can still require manual retailer verification. OrderGrid preserves the resulting authenticated browser state for later work.

### Live Flipkart mobile product verification

Before a Flipkart mobile line is accepted into a batch, the native worker can verify:

- product page;
- selling price;
- availability;
- whether the page is a mobile product;
- the account-specific maximum cart quantity.

The batch API rejects:

- stale product checks;
- changed product URLs;
- mismatched retailer accounts;
- submitted prices that no longer match the verified price;
- requested quantities above the verified account limit;
- account/address combinations that do not match the verified account.

### Multi-account allocation

For a total requirement such as:

```text
Required: 40 mobiles
Verified limit: 2 per account
```

OrderGrid can verify accounts in waves and build allocations such as:

```text
Account 01 -> 2
Account 02 -> 2
...
Account 20 -> 2
Total      -> 40
```

The allocator does **not** assume that every account has the same limit. It uses the quantity actually verified for each account and continues until the requested total is covered or verified capacity is exhausted.

Flipkart product checks run through independent saved profiles with bounded parallelism and adaptive slowdown when retailer/security friction is detected.

---

## Fulfilment and Bulk Orders

### Fulfilment

Fulfilment is the procurement creation surface.

It provides:

- active-batch summary;
- product / recipient / ready / attention / confirmed counts;
- approved value;
- recent batches;
- order summary;
- one primary **New procurement** action;
- procurement cart and checkout continuation.

The detailed execution state remains in backend batch / basket records rather than a large visible pipeline.

### Bulk Orders

Bulk Orders is the operational checkout queue.

It shows:

- customer orders;
- product-line count;
- ready / running orders;
- retailer-confirmed orders;
- per-order value and status;
- stock watch;
- session-resume actions;
- requeue actions;
- exception handling.

The human-action queue is mounted independently and surfaces only orders that require operator involvement.

---

## Native execution worker

The native worker is the browser execution layer.

Requirements:

- Node.js 22+
- Google Chrome
- reachable OrderGrid server
- authorized retailer accounts
- applied database migrations

Start it from the repository:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
$env:ORDERGRID_EMAIL = "worker@example.com"
$env:ORDERGRID_PASSWORD = "<worker-password>"
$env:ORDERGRID_WORKER_TOKEN = "<machine-token>"
npm run agent
```

Useful controls:

```text
ORDERGRID_PARALLEL=1..8
ORDERGRID_PRODUCT_CHECK_PARALLEL=1..8
ORDERGRID_BASKETS=1..25
ORDERGRID_DAEMON=0
```

Default checkout parallelism is 4 customer profiles. Flipkart product checks default to 4-way adaptive parallel execution.

Persistent browser profiles are stored locally on the authorized workstation. Protect that workstation with device encryption, OS account separation, screen lock and least-privilege access.

See [agent/README.md](agent/README.md).

---

## Protected verification boundary

OrderGrid deliberately stops or pauses when a retailer or issuer requires a protected action.

Examples:

- retailer login;
- OTP;
- CAPTCHA;
- bank OTP / 3DS;
- CVV entry;
- payment-method confirmation.

The worker does not solve or bypass those controls.

When a protected step is detected, the affected basket can move to a human-action state while other eligible baskets continue.

---

## Backend automation

The automation engine remains active even though the Autopilot page has been removed from the frontend.

Current policy controls include:

- automation enabled / paused state;
- manual vs continuous run mode;
- maximum active orders;
- automatic virtual-card assignment;
- automatic ordinary checkout continuation;
- maximum price increase;
- maximum order value;
- maximum batch variance;
- failure-pause threshold;
- price-breach action.

In continuous mode, eligible work can be claimed when an approved batch becomes checkout-ready. The maximum-active setting is enforced as a total active concurrency ceiling, not simply as a per-call claim count.

Protected verification still overrides automation.

---

## Cards & funding

OrderGrid separates funding policy from retailer execution.

### Funding router

A tenant can hold multiple issuer connections and route a checkout basket deterministically by policy.

Supported issuer profiles in the current code include:

- HDFC Bank
- Axis Bank
- ICICI Bank
- SBI
- YES BANK
- Kotak Mahindra Bank
- IndusInd Bank
- IDFC FIRST Bank
- Bank of Baroda
- EnKash
- custom bank / issuer API

A provider appearing in the UI does **not** mean production credentials are already connected.

### Virtual cards

The card layer supports:

- issuer connection testing;
- virtual-card creation;
- card-control configuration when the issuer exposes it;
- balance loading;
- one-order / one-card reservation;
- masked card metadata;
- provider account/card IDs.

OrderGrid does not generate fake PANs or store CVV.

A production bank integration requires the organization's own approved API programme, credentials, KYC/compliance onboarding and issuer limits.

### Current adapters

The repository includes:

- an EnKash production-style adapter;
- a generic bank JSON API adapter configurable for approved bank contracts.

The public production deployment must still be tested with the actual issuer credentials before real card issuance can be claimed as proven.

---

## GST & Invoices

GST & Invoices is a first-class workspace.

It supports:

- supplier GST profile;
- GSTIN validation;
- supplier / buyer state codes;
- HSN/SAC and GST rate on procurement lines;
- CGST + SGST calculation for intra-state supply;
- IGST calculation for inter-state supply;
- cess;
- tax-inclusive pricing;
- invoice numbering by financial year;
- invoice register;
- printable / PDF-ready invoice HTML;
- GST Excel export;
- IRN + signed-QR attachment state.

If a GST profile is configured as e-Invoice applicable, an invoice remains **IRN REQUIRED** until an IRN / signed QR result is attached.

The repository does **not** currently contain a fully activated government IRP connector. A production e-Invoice deployment should connect an authorized IRP/GSP API rather than rely on manual IRN entry.

OrderGrid also does not silently invent HSN/SAC or tax rates.

---

## Retailer scope

### Implemented with dedicated session / reconciliation logic

- Flipkart
- Amazon India

### Dedicated live product-limit verification

- Flipkart mobile product-detail URLs

### URL registry

The server recognizes additional retailer domains such as Myntra, AJIO, Tata CLiQ, Meesho, Nykaa and JioMart, and can validate generic public-store HTTPS URLs.

Do not interpret URL recognition as proof that every retailer has a production-tested checkout adapter. DOM-driven retailer automation can change when the retailer changes its website and must be verified against live authorized accounts before commercial rollout.

---

## Architecture

```text
Browser workspace
      |
      v
Fastify API
      |
      +-------------------- PostgreSQL
      |                       |
      |                       +-- tenants / users / sessions
      |                       +-- customers / addresses
      |                       +-- retailer accounts
      |                       +-- batches / batch items
      |                       +-- checkout baskets
      |                       +-- cards / issuer connections
      |                       +-- GST invoices
      |                       +-- notifications / audit
      |
      +---- optional BullMQ / Redis-compatible queue
      |                       |
      |                       v
      |                 server batch worker
      |
      v
Native OrderGrid workers
      |
persistent Chrome profiles
      |
retailer product/cart/checkout
      |
protected human verification when required
      |
retailer-issued order ID
      |
reconciliation / GST / reports
```

---

## Security model

Implemented controls include:

- host-only HTTP-only session cookies;
- Secure cookies in production;
- SameSite=Strict;
- 12-hour server-side sessions;
- scrypt password hashing;
- login rate limiting;
- global API rate limiting;
- Helmet security headers and CSP;
- request-ID logging;
- dedicated machine-token requirement on native worker execution routes;
- sensitive request-log redaction;
- AES-256-GCM secret encryption;
- HTTPS-only retailer URL validation;
- retailer lookalike-domain rejection;
- tenant IDs on operational records and API queries;
- role checks on sensitive management operations;
- private retailer-credential table;
- browser-profile isolation;
- one-order / one-card allocation;
- idempotent purchase-order creation;
- protected-verification boundaries.

Supabase public tables have RLS enabled without browser policies. The intended access path is the server-side Postgres role; direct browser Data API reads are denied by RLS.

### Security hardening still recommended before high-value rollout

The current audit identified several items that should be completed before calling a deployment hardened enterprise production:

1. tighten role authorization on every mutating endpoint, especially batch/import and worker lifecycle endpoints;
2. introduce a dedicated worker credential/token model rather than relying only on an ordinary authenticated user session plus worker ID;
3. make audit-log immutability a database permission guarantee (the application role currently has broader table privileges than strictly required);
4. revoke unnecessary Data API grants from `anon` / `authenticated` as defense-in-depth, even though RLS currently denies rows;
5. move the `citext` extension out of the public schema when practical;
6. add / review covering indexes for high-volume foreign-key paths based on real query traffic;
7. run a third-party security review before processing material payment volume.

---

## Production deployment requirements

The codebase is deployable, but production quality depends on the surrounding infrastructure.

### Web service

Use a paid always-on service for a commercial deployment.

The current public OrderGrid service has been useful for validation, but a free compute instance should not be treated as the final commercial hosting tier.

Configure:

```text
NODE_ENV=production
APP_ORIGIN=https://your-domain.example
DATABASE_URL=...
SESSION_SECRET=...
DATA_ENCRYPTION_KEY_BASE64=...
BOOTSTRAP_ADMIN_EMAIL=...
BOOTSTRAP_ADMIN_PASSWORD=...
```

### Database

Apply every migration in order:

```bash
npm run build
npm run db:migrate
```

The current migration set includes the Flipkart product-check and retailer-account-pinning schema.

### Queue worker

`REDIS_URL` is optional.

If `REDIS_URL` is not configured, eligible batch preparation can run through the direct server path.

If `REDIS_URL` **is configured**, run a separate server-side queue worker:

```bash
npm run worker
```

Do not configure Redis/BullMQ in production without an active worker service.

### Native worker

The native workstation worker is separate from the web / queue worker:

```bash
npm run agent
```

At least one online native worker is required for real retailer session work.

---

## Production-readiness status

The repository currently has CI coverage for:

- TypeScript type checking;
- JavaScript syntax checks;
- unit tests;
- build;
- frontend contract tests;
- end-to-end showroom checkout smoke;
- user-workspace contract smoke;
- backend automation policy enforcement;
- production dependency audit.

A green CI run means the code contracts passed. It does **not** by itself prove:

- a real Flipkart account can complete checkout today;
- a specific retailer DOM has not changed;
- a bank has approved and activated its API programme;
- a real virtual card can be issued with the current deployment credentials;
- an IRP/GSP e-Invoice integration is active;
- payment / retailer limits permit a requested commercial volume.

Those require live authorized external accounts and credentials.

---

## Recommended commercial go-live gate

Before selling a deployment as fully production-ready, complete this pilot:

1. move the web service off free compute;
2. configure a health check and production alerting;
3. decide whether Redis/BullMQ is required and deploy a queue worker if it is;
4. run all database migrations and Supabase advisors;
5. harden the role / worker authentication items listed above;
6. onboard one real retailer account;
7. complete OTP/manual sign-in;
8. verify a real product price and account quantity limit;
9. place one low-value real order end to end;
10. verify retailer order ID and reconciliation;
11. test the approved bank/card integration if card payments are part of scope;
12. generate and review a GST invoice;
13. test backup / restore and incident rollback;
14. then scale account count gradually.

Only after that pilot should a specific retailer + payment combination be described as live-proven.

---

## Repository structure

```text
public/                       web workspace
public/dashboard.js           procurement overview
public/fulfilment.js          fulfilment workspace
public/bulk.js                bulk checkout queue
public/human-actions.js       protected verification queue
public/funding.js             cards / issuer controls
public/gst.js                 GST billing workspace
public/navigation.js          workspace routing
agent/                        native Chrome execution worker
agent/cdp.mjs                 browser / retailer execution engine
src/server.ts                 Fastify API and orchestration
src/worker.ts                 optional BullMQ batch worker
src/baskets.ts                checkout basket grouping
src/flipkart-allocation.ts    verified multi-account allocation
src/retailers.ts              retailer URL validation
src/card-issuer.ts            issuer abstraction / EnKash adapter
src/bank-card-issuer.ts       generic approved-bank API adapter
src/gst.ts                    GST calculation primitives
src/gst-reporting.ts          GST invoice / Excel reporting
src/migrations/               versioned PostgreSQL migrations
test/                         unit and security tests
scripts/                      CI / smoke contracts
render.yaml                   deployment blueprint
```

---

## Local setup

```bash
npm ci
cp .env.example .env
npm run build
npm run db:migrate
npm start
```

Optional queue worker:

```bash
npm run worker
```

Native retailer worker:

```bash
npm run agent
```

---

## Verification

Run the same core checks used by CI:

```bash
npm run typecheck
npm test
npm run build
npm run smoke:frontend
npm run smoke:demo
npm run smoke:users
node scripts/smoke-automation.mjs
npm run audit:ci
```

---

## License

Dual licensed under **MIT OR Apache-2.0**.

See [LICENSE](LICENSE), [LICENSE-MIT](LICENSE-MIT), [LICENSE-APACHE](LICENSE-APACHE) and [NOTICE](NOTICE).
