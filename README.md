# OrderGrid Enterprise Procurement & Automated Checkout Engine

<div align="center">

![OrderGrid Enterprise](https://img.shields.io/badge/System-OrderGrid%20Enterprise-0A84FF?style=for-the-badge&logo=googlechrome&logoColor=white)
![Node Version](https://img.shields.io/badge/Node.js-22.x%20%7C%2024.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-Strict%205.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Database](https://img.shields.io/badge/PostgreSQL-16%2B%20Relational-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Fastify](https://img.shields.io/badge/API-Fastify%205.x-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Status](https://img.shields.io/badge/Status-Pilot%20%2F%20Pre--production-orange?style=for-the-badge)
![Security](https://img.shields.io/badge/Security-Hardened%20%26%20MFA-blue?style=for-the-badge)
![Tests](https://img.shields.io/badge/Tests-Passing-00C853?style=for-the-badge)

**Deterministic Multi-Account Procurement, Isolated Browser Sandboxing, Dynamic Unit Allocation, Single-Use Virtual Card Protection, and Automated GST Invoicing.**

[What is OrderGrid?](#what-ordergrid-does) · [How It Works](#how-ordergrid-works) · [System Architecture](#system-architecture) · [Key Capabilities](#core-capabilities) · [Security & Boundaries](#security-compliance--operational-boundary) · [Operational Runbooks](#operational-runbooks) · [Known Limitations](#known-limitations) · [Configuration & Setup](#configuration--environment-variables)

</div>

---

## What OrderGrid Does

**OrderGrid** is an enterprise-grade commerce procurement and checkout automation engine. It automates high-volume, authorized purchases across Indian and global e-commerce retailers (such as Flipkart, Amazon.in, and custom enterprise merchant storefronts) while strictly maintaining transactional safety, capital control, session integrity, and statutory compliance.

### The Problem It Solves

High-volume procurement teams and e-commerce aggregators face major operational roadblocks when scaling orders across multiple customer profiles:

1. **Session Cross-Contamination**: Managing multiple retailer accounts simultaneously causes cookie collision, session invalidation, and IP cross-linking.
2. **Dynamic Stock & Pincode Fragmentation**: Real-time regional pricing, unassigned default sellers, and heterogeneous quantity limits per account make manual ordering slow and error-prone.
3. **Financial Contamination & Capital Exposure**: Sharing credit cards across accounts triggers merchant risk blocks and creates financial reconciliation nightmares.
4. **OTP & Verification Bottlenecks**: High-frequency login attempts lock retailer accounts due to aggressive OTP rate limits.
5. **Tax & Ledger Invoicing Overhead**: Manual creation of B2B tax invoices with multi-state GST (CGST, SGST, IGST) and HSN codes creates massive administrative friction.

### The OrderGrid Solution

OrderGrid provides a centralized control plane and local execution workers that orchestrate end-to-end procurement:
- **Hermetic Browser Sandboxing**: Dedicated Chrome DevTools Protocol (CDP) browser instances with isolated profiles, storage, and proxy routing per account.
- **Smart Wave Allocation**: Probes retailer accounts in real time to allocate batch quantities based on actual per-account purchasing capacity.
- **Atomic Single-Use Virtual Cards**: Dynamically provisions corporate virtual cards with strict hard funding caps tied directly to a single checkout basket.
- **Automated OTP Rate-Limit Protection**: Enforces exponential cooldown schedules to prevent account suspensions.
- **Automated GST Invoicing & Export**: Instant calculation of intra-state and inter-state tax schedules with downloadable B2B GST invoices and Excel ledgers.

---

## How OrderGrid Works

OrderGrid coordinates procurement through a structured, multi-stage pipeline:

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     1. RECIPIENT & ACCOUNT BINDING                              │
│  Import recipients (CSV/XLSX) ──► Bind regional postal codes ──► Secure retailer authentication  │
└────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   2. BATCH CREATION & ALLOCATION                                │
│  Paste product URL ──► Probe live pincode stock ──► Allocate units across ready accounts (Wave) │
└────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 3. VIRTUAL CARD PROVISIONING & CAP                              │
│  Atomic card claim ──► Programmatic card creation ──► Enforce hard funding ceiling (≤ +10%)     │
└────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   4. ISOLATED BROWSER EXECUTION                                 │
│  Launch dedicated CDP profile ──► Inject cart & address ──► Apply virtual card ──► Place order  │
└────────────────────────────────────────────────┬────────────────────────────────────────────────┘
                                                 │
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  5. CONFIRMATION & STATUTORY LEDGER                             │
│  Capture retailer Order ID ──► Close/cleanup card ──► Generate multi-state GST invoice & report │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Execution Stages

1. **Account Session Preparation**:
   - Operators connect retailer accounts (Flipkart / Amazon) via guided or automated login.
   - Sessions are verified using pure DOM classification heuristics (`classifyLoginOutcome`, `decideSessionReady`) that confirm real account content before marking the session `✓ READY`.
   - Active tokens and cookies are securely encrypted and stored for persistent 15-day reuse.

2. **Wave Allocation & Capacity Probing**:
   - When a bulk order (e.g., 50 units of an electronics item) is entered, OrderGrid analyzes connected accounts.
   - If accounts have individual purchase limits (e.g., max 2 units/account), OrderGrid automatically distributes 25 accounts $\times$ 2 units without account re-use.

3. **Atomic Virtual Card Provisioning**:
   - The system initiates an atomic database lock (`UPDATE virtual_cards SET status='ISSUING'`) ensuring that even under concurrent execution, exactly one virtual card is provisioned per checkout basket.
   - The card is funded up to a strict `CARD_FUNDING_MAX_OVERAGE_PCT` ceiling (default: 10% above estimated price). If the payable amount exceeds this ceiling, the order is halted immediately to protect capital.

4. **Isolated Browser Automation (CDP)**:
   - The native execution worker connects to Chrome via Chrome DevTools Protocol (CDP).
   - Each order executes within its own sandbox directory (`profiles/<account_id>`).
   - The worker navigates to the retailer, validates the exact cart items and price, selects the bound delivery address, inputs virtual card details, and submits the order.

5. **Reconciliation, Card Closure & Tax Invoicing**:
   - Upon completion, OrderGrid captures the verified retailer order ID (e.g. `OD1234567890`).
   - The virtual card is automatically unloaded and marked `CLOSED`. If an issuer lacks programmatic closure endpoints, it safely transitions to `CLEANUP_REQUIRED` with full audit logs.
   - A compliance-grade B2B GST invoice is generated with CGST/SGST/IGST tax splits and HSN codes.

---

## System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              ORDERGRID CONTROL PLANE (API)                             │
│  Fastify 5 REST API · Session Vault · RBAC Engine · PostgreSQL 16 · BullMQ Task Queue  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ WebSocket / Secure REST
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        NATIVE DESKTOP AUTOMATION WORKER (AGENT)                        │
│  Chrome DevTools Protocol (CDP) · Adaptive Concurrency (1-8 profiles) · Token Exporter │
└────────────────────────┬──────────────────────────────────────┬────────────────────────┘
                         │                                      │
                         ▼                                      ▼
     ┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
     │      Flipkart Execution Sandbox      │  │        Amazon Execution Sandbox      │
     │  • Regional Pincode Injection        │  │  • 1-Click Buy Driver                │
     │  • Single-Submit OTP Gatekeeper      │  │  • Multi-Item Cart Builder           │
     │  • Cart Probing & Price Protection   │  │  • Address Selector & Card Driver    │
     └──────────────────────────────────────┘  └──────────────────────────────────────┘
                         │                                      │
                         └──────────────────┬───────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       FINANCIAL & CAPITAL MANAGEMENT ENGINE                            │
│  • EnKash / Custom Bank API Adapters  • Merchant Channel Controls (E-Commerce Only)   │
│  • Hard Funding Overage Ceilings      • Honest Cleanup & Orphan Card Reconciler        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Core Capabilities

### 1. Flipkart & Amazon Multi-Account Allocation
- **Dynamic Pincode Stock Probing**: Injects customer postal codes to query live local inventory and delivery timeframes.
- **Heterogeneous Wave Allocation**: Accommodates varying purchase limits across accounts (e.g., account A allows 1 unit, account B allows 2 units) and computes the optimal distribution.
- **Single-Submit OTP Gatekeeper**: Enforces a single-submission policy on Flipkart login verification to prevent account suspensions from repeated OTP triggers.

### 2. Isolated Browser Virtualization (CDP Engine)
- **Hermetic Chrome Sandboxing**: Every account runs inside its own isolated user profile directory. No shared cookies, cache, or local storage.
- **Adaptive Parallel Execution**: Dynamically scales concurrent checkout instances based on available system RAM and CPU cores.
- **Session Auto-Refresh & Token Capture**: Automatically captures authenticated session tokens, persisting them encrypted in PostgreSQL for up to 15 days.

### 3. Virtual Card Capital & Safety Architecture
- **Strict One-Order, One-Card Rule**: A single virtual card is bound to exactly one basket. Zero card reuse prevents merchant fraud flags.
- **Atomic Issuance Lock**: Partial database unique indexing (`idx_virtual_cards_active_basket`) and atomic state transitions prevent duplicate card creation under concurrency.
- **Hard Funding Ceiling**: Enforces `CARD_FUNDING_MAX_OVERAGE_PCT` (default 10%). Requests exceeding this cap are blocked with `FUNDING_CAP_EXCEEDED` audit logs without clamping.
- **Honest Cleanup & Orphan Reconciliation**: Cards are only marked `CLOSED` when confirmed closed by the bank. Cards failing closure transition to `CLEANUP_REQUIRED` for operator review.

### 4. Non-Blocking Fault Isolation & Operator Queue
- **State Machine Resilience**: A failure or 2FA challenge on one account does not block or fail the rest of the batch.
- **Interactive Action Queue**: Challenge states (`OTP_REQUIRED`, `3DS_VERIFICATION`, `PRICE_REVIEW`) are surfaced cleanly in the operational dashboard.
- **Exponential OTP Cooldowns**: Automatically tracks and displays OTP wait timers (`30 min` for OTP requests, `6 hours` for rate limits).

### 5. Multi-State GST & Regulatory Compliance
- **Dynamic Tax Engine**: Splits intra-state transactions into CGST (9%) + SGST (9%) and inter-state transactions into IGST (18%).
- **B2B Tax Invoices**: Generates standard GST-compliant invoices with HSN/SAC code `8517` for telecommunications and electronics.
- **Audit-Ready Exports**: One-click download of batch transaction ledgers in CSV and Excel (`.xlsx`) formats.

---

## Security, Compliance & Operational Boundary

OrderGrid is engineered around strict compliance, data protection, and ethical automation principles:

> [!IMPORTANT]
> **Operational Boundary**:
> OrderGrid automates legitimate procurement workflows on behalf of authorized account owners. It **does NOT** include stealth scripts, user-agent or fingerprint spoofing, proxy rotation, CAPTCHA bypasses, or OTP interception without user authorization.

- **Zero Raw Card Storage**: Full card PAN and CVV credentials are never stored in the database. Card access uses ephemeral provider tokens.
- **AES-256-GCM Dual-Key Encryption**: All credentials, bank tokens, and browser session cookies are encrypted at rest using AES-256-GCM with dual-key rotation support.
- **Brute-Force & Lockout Protection**: Exponential backoff locks IP/account pairs upon consecutive authentication failures (1s, 2s, 4s, 8s, up to 15m), with constant-time scrypt timing normalization against user enumeration.
- **Multi-Factor Authentication (TOTP)**: RFC 6238-compliant TOTP MFA enforced for privileged roles (`OWNER`, `APPROVER`) with single-use cryptographic recovery codes.
- **Role-Based Access Control (RBAC)**:
  - `OWNER`: Full administrative, workspace, and financial connector configuration.
  - `APPROVER`: Commercial limit approval and batch sign-off.
  - `BUYER`: Batch creation, product probing, and execution monitoring.
  - `AUDITOR`: Read-only compliance, invoice review, and audit inspection.
- **Fail-Closed Security Model**: Demo and showroom servers fail closed (`401 Unauthorized`) when environment credentials are not configured. Backdoors are strictly forbidden in production.

---

## Operational Runbooks

### 1. Unlocking Locked Accounts & IP Addresses
When an operator or automated agent triggers rate limit thresholds or enters incorrect credentials repeatedly, their identifier or IP is throttled in the `login_throttle` table.
```bash
# Unlock specific account identifier or IP
node scripts/unlock-account.mjs user@ordergrid.internal
node scripts/unlock-account.mjs 192.168.1.50
```

### 2. Resetting TOTP Multi-Factor Authentication (MFA)
If an operator loses access to their authenticator device and has exhausted recovery codes, an administrator with database/server access can reset MFA:
```bash
node scripts/reset-mfa.mjs user@ordergrid.internal
```

### 3. Resetting Owner Password via Secure CLI
To avoid insecure environment variable backdoors in production, owner password resets are performed via an authenticated CLI script:
```bash
# Prompts securely for new password, updates scrypt hash, and revokes all active sessions
node scripts/reset-owner-password.mjs owner@ordergrid.internal
```

### 4. Zero-Downtime Dual-Key Encryption Key Rotation
When rotating database encryption keys (`DATA_ENCRYPTION_KEY_BASE64`):
```bash
# Step 1: Set DATA_ENCRYPTION_KEY_PREVIOUS_BASE64 in your environment to the current key
# Step 2: Set DATA_ENCRYPTION_KEY_BASE64 to the newly generated key
# Step 3: Run atomic re-encryption migration script
node scripts/rotate-encryption-key.mjs --old-key "$OLD_KEY" --new-key "$NEW_KEY"

# Step 4: After migration completes, unset DATA_ENCRYPTION_KEY_PREVIOUS_BASE64
```

### 5. Production Deployment & Verification
OrderGrid deployments are strictly pinned to immutable release tags (`vX.Y.Z`) or full 40-character Git commit SHAs. Deploying floating branch names like `main` is prevented.
```bash
# Deploy a verified immutable release
./scripts/deploy.sh v1.0.0
# or with a 40-character SHA
./scripts/deploy.sh 5d082e340e4cf8d80c3c52e85e492ca4ce986423
```

---

## Known Limitations

OrderGrid is currently in **Pilot / Pre-production** status. Operators must be aware of the following operational constraints:

1. **Retailer CAPTCHAs & Anti-Bot Challenges**: OrderGrid strictly adheres to ethical automation and does **not** employ automated CAPTCHA solvers or stealth fingerprint evasions. If a retailer presents an interactive challenge (e.g. Arkose Labs / reCAPTCHA), the worker pauses and surfaces an operator notification for manual completion in headed mode.
2. **Flipkart OTP-First Verification**: Initial Flipkart session creation requires an SMS OTP delivered to the registered phone number. This requires an operator to enter the OTP via the dashboard or headed browser during initial setup.
3. **Issuer Closure Endpoints**: Certain banking APIs do not support synchronous programmatic single-use card termination. If an issuer API lacks a closure endpoint, OrderGrid cleanly marks the card as `CLEANUP_REQUIRED` and records an audit log for financial reconciliation.
4. **Pre-Production Architecture**: OrderGrid is optimized for dedicated single-tenant enterprise deployments. High-concurrency browser automation requires adequate host memory (minimum 2GB RAM per concurrent browser profile).

---

## Configuration & Environment Variables

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | String | `development` | Application environment (`development`, `test`, `production`). |
| `PORT` | Number | `3000` | HTTP server port. |
| `APP_ORIGIN` | String | *Required* | Public application base URL (e.g. `https://ordergrid.example.com`). |
| `DATABASE_URL` | String | *Required* | PostgreSQL connection string. |
| `SESSION_SECRET` | String | *Required (32+ chars)* | Cryptographic secret for signing session cookies. |
| `DATA_ENCRYPTION_KEY_BASE64` | String | *Required (40+ chars)* | Base64-encoded 256-bit AES key for database encryption. |
| `DATA_ENCRYPTION_KEY_PREVIOUS_BASE64` | String | *Optional* | Previous AES key for zero-downtime key rotation. |
| `WORKER_API_TOKEN` | String | *Required in Prod* | Machine-to-machine authentication token for automation workers. |
| `LOGIN_RATE_LIMIT_MAX` | Number | `20` | Maximum login attempts per window before rate-limiting. |
| `MFA_RATE_LIMIT_MAX` | Number | `10` | Maximum MFA verification attempts per window. |
| `MFA_REQUIRED_ROLES` | String | `OWNER,APPROVER` | Comma-separated roles requiring mandatory TOTP MFA. |
| `CARD_FUNDING_MAX_OVERAGE_PCT` | Number | `10` | Maximum percentage allowed above basket price for virtual card funding. |
| `OTP_MIN_INTERVAL_MINUTES` | Number | `30` | Minimum cooldown period between consecutive OTP requests on an account. |
| `OTP_RATE_LIMIT_COOLDOWN_HOURS` | Number | `6` | Cooldown period when a retailer returns rate-limit errors. |
| `DEMO_LOGIN_IDENTIFIER` | String | *Optional* | Dedicated user identifier for demo/showroom login. |
| `DEMO_LOGIN_PASSWORD` | String | *Optional* | Dedicated password for demo/showroom login. |
| `AWS_BEARER_TOKEN_BEDROCK` | String | *Optional* | Amazon Bedrock Nova runtime API key for product extraction. |
| `BEDROCK_REGION` | String | `ap-southeast-2` | AWS region for Bedrock inference. |

---

## Developer & Deployment Quickstart

### 1. Installation & Local Development

```bash
# Clone repository
git clone https://github.com/Tashima-Tarsh/ordergrid.git
cd ordergrid

# Install dependencies
npm install

# Setup environment variables
cp .env.example .env
# Fill in DATABASE_URL, SESSION_SECRET, and DATA_ENCRYPTION_KEY_BASE64

# Run database migrations
npm run db:migrate

# Start local server with hot reloading
npm run dev
```

### 2. Running Verification & Test Suites

OrderGrid includes a comprehensive test suite across unit, integration, and load testing layers:

```bash
# Run all unit tests (security, card safety, MFA, encryption, state machines)
npm test

# Run PostgreSQL integration tests against containerized database
npm run test:integration

# Run concurrency load test (100 parallel requests)
npm run test:load

# Run TypeScript static typecheck and JS syntax validations
npm run typecheck

# Run smoke test contracts
node scripts/smoke-frontend-contract.mjs
node scripts/smoke-automation.mjs
node scripts/smoke-users.mjs
npm run smoke:demo
```

### 3. Running the Native Desktop Automation Worker

The automation worker runs on any machine with Google Chrome installed:

```powershell
# Windows PowerShell
$env:ORDERGRID_URL = "http://localhost:3000"
$env:ORDERGRID_EMAIL = "owner@ordergrid.internal"
$env:ORDERGRID_PASSWORD = "YourSecurePassword"
$env:ORDERGRID_PARALLEL = "4"
$env:ORDERGRID_HEADLESS = "" # Leave blank to view Chrome, set "1" for headless

npm run agent
```

---

<div align="center">

**OrderGrid Enterprise Engine** · Built for Reliability, Transactional Safety, and Scale.

</div>
