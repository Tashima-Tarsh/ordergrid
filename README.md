# OrderGrid

**Bulk procurement orchestration for multi-product customer baskets, controlled browser execution and retailer-confirmed outcomes.**

OrderGrid turns multiple product links plus a recipient spreadsheet into a controlled bulk procurement run. Instead of exposing every customer-product pair as a separate manual checkout, it creates order lines and groups them into the minimum practical checkout unit: one **customer/account + retailer basket**.

Example: **10 customers × 3 Amazon products = 30 order lines, normally 10 Amazon checkout baskets — not 30 manual checkout tasks.**

> OrderGrid does not bypass retailer authentication, OTP, CAPTCHA, 3DS or payment controls. It does not mark an order successful until a genuine retailer order ID is recorded.

## Bulk workflow

1. Add one or more product URLs, estimated prices and quantities per recipient.
2. Import recipient records from CSV or Excel.
3. Validate required columns, phone numbers and six-digit Indian PIN codes.
4. Approve the batch once.
5. Create idempotent purchase-order lines for every recipient × product combination.
6. Group actionable lines by **recipient/account + retailer** into checkout baskets.
7. Claim multiple baskets from **OrderGrid → Bulk checkout**.
8. A persistent OrderGrid workstation worker prepares baskets concurrently in isolated Chrome profiles.
9. The worker attempts repetitive Add to Cart / Add to Bag actions for every item in the basket and opens the retailer cart.
10. If the retailer requires login, OTP, CAPTCHA, 3DS, address confirmation or payment authorization, only that basket pauses for operator action.
11. Record the genuine retailer-issued order ID in OrderGrid.
12. OrderGrid confirms all lines in that basket and exports the consolidated report.

The legacy single-order assisted checkout remains available as a fallback for exception recovery.

## Example

A batch contains:

- 10 recipients
- 3 products for each recipient
- all products from Amazon India

OrderGrid creates:

- **30 order lines**
- **10 customer/retailer baskets**
- up to the configured number of baskets prepared concurrently

If one customer's three products are split between Amazon and Flipkart, OrderGrid creates two baskets for that customer because retailer carts and accounts are separate.

## Supported retailer validation

OrderGrid validates HTTPS product links and recognizes:

- Amazon India
- Flipkart
- Myntra
- AJIO
- Tata CLiQ
- Meesho
- Nykaa
- JioMart
- Shopify-style `/products/` URLs

Retailer availability, account state, price, payment authorization, COD eligibility, OTP, CAPTCHA and other retailer controls remain authoritative at the retailer.

## OrderGrid execution model

| Stage | OrderGrid responsibility | Human/retailer responsibility |
| --- | --- | --- |
| Products | Validate URLs, quantity and estimated value | Confirm requested products |
| Recipients | Import and validate delivery records | Supply authorized customer data |
| Approval | Calculate the estimate and record one batch approval | Approve the procurement and limits |
| Basket creation | Group order lines by customer/account + retailer | None |
| Allocation | Prevent duplicate work and lease baskets to workers | Keep the authorized worker online |
| Cart preparation | Open isolated profile, attempt repetitive add-to-cart actions, open cart | Handle retailer-specific exceptions |
| Authentication | Surface the challenged basket | Enter password/OTP/CAPTCHA only on genuine retailer surface |
| Payment | Preserve approved payment route and basket state | Complete retailer/issuer authorization when required |
| Confirmation | Store retailer order ID and confirm every line in the basket | Supply the genuine retailer order ID |
| Reporting | Reconcile confirmed and exception states | Resolve remaining retailer/payment exceptions |

## Recipient file

Required columns:

```csv
reference,recipient,phone,line1,city,state,postal_code
CUST-0001,Example Recipient,9876543210,Example Road,Delhi,Delhi,110001
```

`reference` is strongly recommended. It should be a stable internal customer/account identifier, never a retailer password or credential. The OrderGrid execution worker uses it with the retailer identity to reuse the correct isolated Chrome profile.

## Implemented capabilities

- Multi-product fulfilment batch wizard
- CSV and XLSX recipient import
- Bulk order-line creation
- Customer/account + retailer basket grouping
- Persistent payment-route recording
- Bulk basket claiming in groups of 1–25
- Concurrency-safe claiming with PostgreSQL row locks
- 20-minute basket leases with automatic expiry recovery
- Persistent OrderGrid execution-worker heartbeat
- Up to 8 parallel isolated customer profiles per workstation
- Local visible Chrome DevTools automation for repetitive cart preparation
- Strict HTTPS and lookalike-domain protection
- Stable per-customer/per-retailer Chrome profiles
- Genuine retailer order-ID validation
- Idempotent purchase-order creation
- Multi-tenant PostgreSQL data model
- Owner, approver, buyer and auditor roles
- Scrypt password hashing and server-side session cookies
- Rate limiting, security headers and sensitive-log redaction
- BullMQ/Valkey background processing
- Immutable audit events
- Downloadable order and exception CSV report
- Transactional, versioned database migrations
- Render Blueprint for API, worker, PostgreSQL and Valkey
- CI type-checking, JavaScript syntax checks, tests, build and dependency audit

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
    |                     worker heartbeat
    |                     audit
    |
BullMQ / Valkey
    |
background order worker

Operator workstation
    |
OrderGrid execution worker
    |
isolated Chrome profile per customer + retailer
    |
verified retailer product pages -> retailer cart
    |
human only when retailer requires authentication/payment challenge
```

The API and PostgreSQL state are the source of truth. Browser state is never treated as proof of purchase.

## Repository structure

```text
public/                  OrderGrid web workspace
public/bulk.js           Bulk basket control surface
agent/                   Persistent workstation execution worker
agent/cdp.mjs            Local visible Chrome cart-preparation automation
src/server.ts            API, authentication and bulk workflow endpoints
src/baskets.ts           Basket grouping and order-line attachment
src/worker.ts            Pricing/order background worker
src/assisted-checkout.ts Retailer URL and order-ID validation
src/providers.ts         Retailer and card-provider contracts
src/migrations/          PostgreSQL migrations
test/                    Security, retailer and worker tests
render.yaml              Production infrastructure blueprint
```

## Local setup

Requirements:

- Node.js 22 or newer
- PostgreSQL
- Valkey or Redis for background jobs
- Google Chrome on each execution workstation

```bash
npm ci
cp .env.example .env
npm run build
npm run db:migrate
npm start
```

Run the server-side background worker separately:

```bash
npm run worker
```

For development:

```bash
npm run dev
```

Start the persistent workstation execution worker:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

Then use **OrderGrid → Bulk checkout** to see the worker online and start baskets. See [agent/README.md](agent/README.md).

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

The repository contains a card-issuer interface and funding UI, but live virtual-card issuance remains disabled until an approved issuer or programme manager is integrated. OrderGrid should receive only provider tokens and masked metadata; raw PAN and CVV data must remain in issuer-hosted fields.

The selected payment route is now persisted with the batch. COD eligibility is still decided by the retailer for the product, account and delivery PIN code.

## Retailer automation boundary

The local OrderGrid execution worker automates repetitive cart preparation in a visible Chrome session. This is deliberately different from bypass automation:

- no CAPTCHA solving
- no OTP interception
- no password capture
- no stealth or fingerprint-evasion logic
- no hidden confirmation of an order
- no success state without a retailer-issued order ID

Retailer DOMs can change. If the worker cannot safely find an Add to Cart control, the item remains visible for operator review instead of guessing or clicking a destructive/final-purchase control.

For truly unattended final ordering, integrate an approved retailer ordering API or other authorized provider interface.

## Production readiness

A live deployment still requires:

- PostgreSQL and Valkey provisioned
- all database migrations applied
- strong deployment secrets
- TLS and correct application origin
- the persistent OrderGrid worker installed on authorized operator workstations
- authorized retailer accounts and customer consent
- an approved issuer for live virtual cards, if card issuance is required
- operational testing of each retailer's current cart UI
- security, privacy, retention and incident-response review

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run audit:ci
```

## License

OrderGrid is dual-licensed under your choice of:

- [MIT License](LICENSE-MIT)
- [Apache License 2.0](LICENSE-APACHE)

SPDX expression: `MIT OR Apache-2.0`.
