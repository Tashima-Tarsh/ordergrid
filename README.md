# OrderGrid

OrderGrid is a controlled bulk-procurement platform for converting product links, quantities and delivery addresses into approved, traceable purchase orders. It separates retailer connectivity, regulated card issuance, approvals and order execution so failures never masquerade as successful orders.

## Production boundary

- Amazon India and Flipkart require approved business/partner connectivity. OrderGrid does not bypass CAPTCHA, OTP, rate limits or retailer terms.
- Shopify ordering requires store-specific Storefront API access and merchant checkout support.
- Virtual cards are issued only through a regulated issuer/program manager. PAN, CVV and full card data are never stored in OrderGrid.
- If an API cannot complete checkout, the order becomes `REQUIRES_ACTION` and is resolved by an authorised operator.

## Included

- Multi-tenant PostgreSQL schema and immutable audit log
- Owner/approver/buyer/auditor role model
- Secure server-side sessions, rate limiting and security headers
- Bulk batch ingestion API with idempotent queued processing
- Separate pricing and checkout workers with graceful shutdown
- Provider contracts for Shopify, Amazon India, Flipkart and card issuers
- Approval gate before payment or checkout
- Render Blueprint for web, worker, PostgreSQL 17 and durable Valkey queue
- Production operations dashboard

## Launch

1. Copy `.env.example` to `.env` and set every required value.
2. Generate the encryption key with `openssl rand -base64 32`.
3. Run `npm install`, `npm run build`, `npm run db:migrate`, then `npm start` and `npm run worker`.
4. Complete onboarding with an Indian issuer/program manager and approved retailer accounts before enabling live checkout.

Never commit `.env`, card credentials or retailer secrets.
