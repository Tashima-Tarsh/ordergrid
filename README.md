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

## Customer and retailer account identity

Every order is bound to an immutable OrderGrid customer record. OrderGrid does not infer identity from a browser window, recipient name or card number.

The identity chain is:

```text
customer_id
  -> retailer_account_id
  -> isolated browser profile_key
  -> checkout_basket
  -> funding policy / issuer
  -> virtual_card_id (when allocated)
  -> retailer_order_id
```

Recipient imports can include stable customer and retailer-account references:

```csv
reference,recipient,phone,line1,city,state,postal_code,amazon_account
CUST-001,Aarav Sharma,9876543210,12 MG Road,Bengaluru,Karnataka,560001,amazon-account-001
CUST-002,Meera Iyer,9876543211,18 Linking Road,Mumbai,Maharashtra,400052,amazon-account-002
```

Supported optional account columns currently include `amazon_account`, `flipkart_account`, `myntra_account`, `ajio_account`, `tatacliq_account`, `meesho_account`, `nykaa_account` and `jiomart_account`.

These fields are identifiers/labels only. Do not put retailer passwords, OTPs or recovery secrets in recipient files.

### Example: 100 Amazon accounts

For 100 customers with 100 Amazon accounts and 3 Amazon products:

```text
100 customers
x 3 product lines
= 300 order lines
= 100 Amazon baskets
= 100 isolated Amazon browser profiles
```

The execution worker groups by `retailer_account_id`, not by recipient name. Each Amazon account always reuses the same isolated Chrome profile. If Amazon requires login, password, OTP, CAPTCHA or another protected action for one account, only that retailer account/basket enters an authorization-required state; other accounts can continue.

A first-time or expired Amazon session still needs the account owner/operator to complete Amazon's normal authentication. OrderGrid preserves and reuses the resulting browser session but does not bypass retailer security controls.

## Multi-issuer funding router

A tenant can hold multiple issuer connections at once. The data model supports `axis`, `hdfc`, `icici`, `enkash` and `custom` issuer programmes.

Funding policies deterministically select an issuer by retailer, amount range and priority. A basket never asks AI to randomly choose a bank. If only one issuer is connected, it can be used as the deterministic fallback. If multiple issuers are connected and no policy matches, no issuer is silently guessed.

When an eligible active virtual-card record exists, OrderGrid reserves it transactionally to the same `customer_id` and `checkout_basket_id` so two workers cannot allocate one card to different customers.

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
