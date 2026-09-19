# OrderGrid

**Bulk procurement control for product links, recipient files and human-authorized retailer checkout.**

OrderGrid turns one product link, an estimated unit price, a quantity and a recipient spreadsheet into a controlled queue of traceable purchase tasks. It is designed for operations teams that must coordinate high-volume purchasing while keeping retailer login, OTP, CAPTCHA and final confirmation under human control.

> OrderGrid is not an Amazon or Flipkart bypass. It does not defeat CAPTCHA, intercept OTPs, conceal automation or mark an order successful before a retailer issues a genuine order ID.

## What the product does

1. Accepts a product or SKU URL, estimated unit price and quantity per recipient.
2. Imports recipient records from CSV or Excel.
3. Validates required columns, phone numbers and six-digit Indian PIN codes.
4. Creates an estimated batch total and sends the batch through approval.
5. Produces idempotent purchase tasks so the same item is not submitted twice.
6. Allocates eligible tasks to operators in controlled groups of 5–25.
7. Opens the genuine retailer page for customer-controlled authentication.
8. Lets the operator record the retailer-issued order ID after checkout.
9. Expires abandoned claims and returns unfinished work to the queue.
10. Exports a consolidated completion and exception report.

## Supported retailer handoff

OrderGrid validates HTTPS product links and recognizes:

- Amazon India
- Flipkart
- Myntra
- AJIO
- Tata CLiQ
- Meesho
- Nykaa
- JioMart
- Shopify-style product URLs

These are **assisted handoffs**, not private retailer APIs. Retailer availability, price, account authentication, payment authorization, COD eligibility, CAPTCHA and OTP remain controlled by the retailer.

## Operator workflow

| Stage | OrderGrid responsibility | Human/retailer responsibility |
| --- | --- | --- |
| Product | Validate URL, quantity and estimated value | Confirm the requested product |
| Recipients | Import and validate delivery records | Supply authorized customer data |
| Approval | Calculate batch estimate and record approval | Approve price and payment limits |
| Allocation | Prevent duplicates and lease tasks to operators | Work only assigned tasks |
| Checkout | Open the validated retailer URL | Sign in and enter OTP/CAPTCHA on the retailer page |
| Confirmation | Store the genuine retailer order ID | Confirm the retailer accepted the order |
| Reporting | Reconcile confirmed and exception states | Resolve retailer/payment exceptions |

For personal retailer accounts, use a separately isolated browser profile or managed browser context per account. Ordinary tabs share cookies and are not account-isolated.

## Implemented capabilities

- Multi-tenant PostgreSQL data model
- Owner, approver, buyer and auditor roles
- Scrypt password hashing and server-side session cookies
- Rate limiting, security headers and sensitive-log redaction
- CSV and XLSX address-book import
- Transactional batch creation and approval
- BullMQ/Valkey background job queue
- Idempotent purchase-order creation
- Concurrency-safe operator claiming with PostgreSQL row locks
- 20-minute checkout-session leases, release and expiry recovery
- Windows operator companion with stable per-customer isolated Chrome profiles
- Strict HTTPS and lookalike-domain protection
- Genuine retailer order-ID validation
- Immutable audit events
- Downloadable order and exception CSV report
- Versioned transactional database migrations
- Responsive operator portal with a guided four-stage batch wizard
- Render Blueprint for the API, worker, PostgreSQL and Valkey services
- Automated type-checking, tests, build and dependency audit

## Architecture

```text
Operator portal
      |
Fastify API ───────── PostgreSQL
      |                   |
      |              batches, orders,
      |              sessions, audit
      |
BullMQ queue ─────── Valkey
      |
Background worker
      |
Retailer handoff / approved provider adapters
```

The API is the source of truth. Browser state is not treated as proof that an order was placed. A purchase becomes confirmed only after an authorized operator records the retailer-generated order ID.

## Repository structure

```text
public/                  Operator portal
agent/                   Windows operator companion
src/server.ts            API, authentication and workflow endpoints
src/worker.ts            Pricing and ordering worker
src/assisted-checkout.ts Retailer URL and order-ID validation
src/providers.ts         Retailer and card-provider contracts
src/migrations/          PostgreSQL migrations
test/                    Security and retailer-validation tests
render.yaml              Production infrastructure blueprint
```

## Local setup

Requirements:

- Node.js 22 or newer
- PostgreSQL
- Valkey or Redis for background jobs

```bash
npm ci
cp .env.example .env
npm run db:migrate
npm run build
npm start
```

Run the worker separately:

```bash
npm run worker
```

For development:

```bash
npm run dev
```

Run the Windows operator companion against a reachable deployment:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

Include a stable, non-secret `reference` column in the recipient file so the companion reuses the correct isolated Chrome profile. See [`agent/README.md`](agent/README.md).

## Required environment configuration

Use `.env.example` as the source of required variables. At minimum configure:

- `DATABASE_URL`
- `REDIS_URL`
- `APP_ORIGIN`
- `SESSION_SECRET`
- `DATA_ENCRYPTION_KEY_BASE64`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

Generate a 32-byte encryption key:

```bash
openssl rand -base64 32
```

Never commit environment files, customer credentials, OTPs, card numbers, CVVs, retailer cookies or provider secrets.

## Card and payment boundary

The repository contains a card-issuer interface and funding UI, but live card issuance is disabled until an approved issuer or programme manager is integrated. OrderGrid must receive only provider tokens and masked metadata; raw PAN and CVV data must remain in issuer-hosted fields.

COD is recorded as a requested payment route. Final COD availability is decided by the retailer for the product, account and delivery PIN code.

## Production readiness

The application contains production-oriented controls, but a live deployment still requires:

- Provisioned PostgreSQL and Valkey services
- Database migrations
- Strong deployment secrets
- TLS and a configured application origin
- An approved card issuer for real virtual cards
- Approved retailer APIs for unattended ordering
- Managed isolated browser profiles for personal-account assisted checkout
- Security, privacy, consent and operational review for customer data

Without an approved retailer ordering API, final checkout remains human-assisted.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

## License

OrderGrid is dual-licensed under your choice of:

- [MIT License](LICENSE-MIT)
- [Apache License 2.0](LICENSE-APACHE)

SPDX expression: `MIT OR Apache-2.0`. You may use the project under either license.
