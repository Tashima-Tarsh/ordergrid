# OrderGrid

**Bulk ordering from one control plane: products, recipients, execution workers, real virtual cards, retailer confirmation and reporting.**

OrderGrid turns a multi-product requirement plus a recipient file into grouped customer/retailer baskets and executes them through persistent OrderGrid workers.

Example: **10 customers × 3 Amazon products = 30 order lines → 10 Amazon baskets**, not 30 manual checkout tasks.

## Product model

The normal workflow is:

**Upload → Validate → Approve once → Group baskets → Place bulk orders → Resolve only protected challenges → Auto-confirm from retailer order ID → Report**

There is no retailer-handoff workspace and no manual order-ID confirmation step.

A retailer can still require protected actions such as password, OTP, CAPTCHA or 3DS. OrderGrid does not bypass those controls. When one occurs, only that basket enters **AUTHORIZATION REQUIRED** while the worker preserves the secure browser session; after the protected step is completed, the worker resumes automatically.

## Bulk execution

OrderGrid:

- accepts multiple product URLs in one batch;
- imports CSV/XLSX recipients;
- creates recipient × product order lines;
- groups lines by customer/account + retailer;
- leases baskets to live execution workers;
- reuses isolated Chrome profiles per customer + retailer;
- attempts repetitive add-to-cart and checkout progression;
- selects matching saved delivery context where possible;
- supports COD selection where exposed by the retailer;
- detects login, OTP, CAPTCHA, 3DS and payment-method challenges;
- detects retailer confirmation pages and extracts the genuine order ID;
- confirms every order line in the basket from that retailer ID;
- retries failed/challenged baskets from the OrderGrid UI;
- exports reconciliation reports.

## Real virtual cards

The old browser-side test-card generator has been removed.

OrderGrid now has a server-side virtual-card issuer interface and an EnKash production adapter. When a production issuer is configured, **Cards & funding → Create & load virtual cards** calls the issuer to create real virtual prepaid cards and then allocates funds to them.

OrderGrid stores:

- its internal card record ID;
- provider name;
- provider card/account IDs;
- masked card metadata when the issuer returns it;
- loaded balance;
- status and merchant-control label.

OrderGrid does **not** invent PANs, store CVVs or claim a card exists when the issuer call failed.

Real issuance still requires the organization's own issuer onboarding, KYC/compliance approval, programme limits and production credentials.

### EnKash configuration

Set:

```env
CARD_PROVIDER=enkash
ENKASH_BASE_URL=<production API base supplied by EnKash>
ENKASH_TOKEN_URL=<production OAuth token URL supplied by EnKash>
ENKASH_PARTNER_ID=
ENKASH_BASIC_AUTH=
ENKASH_USERNAME=
ENKASH_PASSWORD=
ENKASH_CLIENT_ID=
ENKASH_COMPANY_ID=
ENKASH_CARD_ACCOUNT_ID=
```

Do not commit these values.

## Payment boundary

Creating and loading a real virtual card does not by itself make raw card credentials safe to expose to application code.

For automatic card entry during retailer checkout, use an approved PCI/tokenized issuer flow or an authorized retailer-saved payment method. If a retailer requests raw card entry and no approved secure integration is available, OrderGrid reports a payment challenge rather than retrieving/storing PAN or CVV.

COD can be executed automatically when the retailer exposes it and the basket is eligible.

## Worker

Start one or more authorized workstation workers:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

Workers heartbeat into the server and are assigned baskets independently of whichever user clicked **Place bulk orders**.

See [agent/README.md](agent/README.md).

## Architecture

```text
OrderGrid web workspace
        |
        v
Fastify API ---------------- PostgreSQL
    |                          |
    |                     batches
    |                     order lines
    |                     checkout baskets
    |                     virtual-card metadata
    |                     worker assignments
    |                     audit
    |
BullMQ / Valkey
    |
batch preparation
        |
        v
OrderGrid execution workers
        |
isolated customer + retailer Chrome profiles
        |
cart → checkout → protected challenge when required → confirmation
        |
retailer order ID → OrderGrid reconciliation
```

## Security controls

- HTTPS-only retailer URL validation
- lookalike-domain rejection
- tenant isolation
- owner / approver / buyer / auditor roles
- server-side sessions
- scrypt password hashing
- rate limiting and security headers
- sensitive-log redaction
- idempotent purchase-order creation
- worker-specific basket assignment
- isolated browser profiles
- no CAPTCHA/OTP/3DS bypass
- no browser-generated fake order IDs
- no browser-generated fake cards
- no full PAN/CVV storage
- immutable audit events

## Repository structure

```text
public/                 OrderGrid workspace
public/bulk.js          Native bulk ordering control
public/funding.js       Real issuer-backed card controls
agent/                  Persistent execution worker
agent/cdp.mjs           Visible Chrome checkout engine
src/server.ts           API and workflow state
src/retailers.ts        Retailer URL validation
src/card-issuer.ts      Real issuer adapter
src/baskets.ts          Basket grouping
src/worker.ts           Server-side batch preparation
src/migrations/         Versioned PostgreSQL migrations
test/                   Automated verification
render.yaml             Deployment blueprint
```

## Local / production setup

```bash
npm ci
cp .env.example .env
npm run build
npm run db:migrate
npm start
```

Run the queue worker separately:

```bash
npm run worker
```

Run the workstation execution worker:

```bash
npm run agent
```

## Required base configuration

- `DATABASE_URL`
- `REDIS_URL`
- `APP_ORIGIN`
- `SESSION_SECRET`
- `DATA_ENCRYPTION_KEY_BASE64`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run audit:ci
```

## License

MIT OR Apache-2.0.
