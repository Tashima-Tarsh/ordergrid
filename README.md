# OrderGrid Enterprise Procurement & Automated Checkout Engine

<div align="center">

[![OrderGrid Enterprise](https://img.shields.io/badge/System-OrderGrid%20Enterprise-0A84FF?style=for-the-badge&logo=googlechrome&logoColor=white)](https://github.com/Tashima-Tarsh/ordergrid)
[![Node.js](https://img.shields.io/badge/Node.js-22.x%20%7C%2024.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict%205.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%2B%20Relational-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Fastify](https://img.shields.io/badge/API-Fastify%205.x-000000?style=for-the-badge&logo=fastify&logoColor=white)](https://fastify.dev)
[![Docker](https://img.shields.io/badge/Docker-Production%20Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com)
[![Test Suite](https://img.shields.io/badge/Test%20Suite-78%20Passing-00C853?style=for-the-badge)](https://github.com/Tashima-Tarsh/ordergrid)

**Deterministic Multi-Account Procurement, Isolated Browser Sandboxing, Dynamic Wave Allocation, Single-Use Virtual Card Protection, and Automated GST Invoicing.**

[Executive Summary](#executive-summary) · [System Architecture](#system-architecture) · [Workflow Pipeline](#workflow-pipeline) · [Core Capabilities](#core-capabilities) · [Security & Compliance](#security-compliance--operational-boundary) · [Configuration](#configuration--environment-variables) · [Deployment Quickstart](#deployment-quickstart)

</div>

---

## Executive Summary

**OrderGrid** is an enterprise-grade procurement automation and multi-account checkout orchestration platform. Designed specifically for high-volume procurement teams, commercial aggregators, and institutional buyers, OrderGrid safely automates bulk purchases across Indian and global e-commerce retailers (including Flipkart, Amazon.in, and custom enterprise merchant storefronts) while strictly enforcing capital controls, transactional safety, session isolation, and statutory tax compliance.

### Operational Challenges Solved

| Operational Challenge | Traditional Approach Risk | OrderGrid Enterprise Solution |
| :--- | :--- | :--- |
| **Session Collisions** | Shared browser profiles cross-contaminate cookies, invalidating logins and triggering merchant security blocks. | **Hermetic CDP Sandboxing**: Dedicated Chrome DevTools Protocol browser profiles with isolated storage, cookies, and local state per account. |
| **Heterogeneous Account Limits** | Manual ordering fails when accounts have individual purchasing limits (e.g., 1 or 2 units per account). | **Adaptive Wave Allocation**: Real-time probing of per-account limits to compute optimal multi-account distribution without account reuse. |
| **Financial Exposure** | Shared corporate credit cards cause fraud flags, balance leaks, and reconciliation overhead. | **Atomic Single-Use Virtual Cards**: Dynamically provisions single-use cards with hard-capped funding ceilings ($\le +10\%$) bound to a single basket. |
| **OTP & Rate-Limit Lockouts** | Uncoordinated login attempts trigger exponential SMS/Email rate limits and account locks. | **Automated Rate-Limit Protection**: Enforces structured exponential cooldowns (30m OTP retry, 6h rate limit) and native keyboard simulation. |
| **Statutory Tax Invoicing** | Manual calculation of multi-state GST (CGST, SGST, IGST) and HSN schedules creates administrative drag. | **Automated B2B GST Invoicing**: Instant calculation of intra/inter-state tax schedules with exportable invoices and Excel ledgers. |

---

## System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     ORDERGRID CONTROL PLANE (AWS EC2)                                  │
│   Fastify 5 REST API  ·  Session Vault (AES-256-GCM)  ·  RBAC Engine  ·  PostgreSQL 16  ·  Redis 7     │
└───────────────────────────────────────────────────┬────────────────────────────────────────────────────┘
                                                    │
                                                    │ Bidirectional WebSocket / M2M REST
                                                    ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   NATIVE DESKTOP AUTOMATION WORKER (AGENT)                             │
│   Chrome DevTools Protocol (CDP)  ·  Adaptive Concurrency Pool (1-16)  ·  Hardware Input Simulation   │
└───────────────────────────┬────────────────────────────────────────────┬───────────────────────────────┘
                            │                                            │
                            ▼                                            ▼
      ┌──────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
      │         Flipkart Execution Sandbox       │     │          Amazon Execution Sandbox        │
      │   • Regional Postal Code & Stock Probe   │     │   • 1-Click Buy Orchestration            │
      │   • React Controlled Native OTP Entry    │     │   • Multi-Item Cart Builder              │
      │   • Cart Validation & Price Protection   │     │   • Address Selector & Card Driver       │
      └──────────────────────────────────────────┘     └──────────────────────────────────────────┘
                            │                                            │
                            └─────────────────────┬──────────────────────┘
                                                  │
                                                  ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                  FINANCIAL & CAPITAL MANAGEMENT ENGINE                                 │
│   • EnKash / Custom Bank API Adapters         • Hard Funding Overage Ceilings (Default 10%)            │
│   • Merchant Category Controls (E-Commerce)   • Honest State Cleanup & Orphan Reconciliation           │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Workflow Pipeline

```mermaid
flowchart TD
    A["1. Account Import & Binding<br><i>CSV Import, Postal Codes, AES Vault</i>"] --> B["2. Batch Creation & Stock Probing<br><i>Live SKU Stock & Quantity Verification</i>"]
    B --> C["3. Wave Allocation Engine<br><i>Heterogeneous Capacity Distribution</i>"]
    C --> D["4. Atomic Virtual Card Issuing<br><i>One-Order One-Card & Hard Funding Ceiling</i>"]
    D --> E["5. Isolated CDP Browser Execution<br><i>Dedicated Sandbox, Native Keystrokes</i>"]
    E --> F["6. Reconciliation & GST Invoicing<br><i>Capture Retailer Order ID, Generate Tax Invoices</i>"]
```

### Detailed Pipeline Execution Stages

1. **Account Session Vaulting & Verification**:
   - Operators connect retailer accounts (Flipkart / Amazon) via guided or automated login.
   - Sessions are verified using pure DOM classification heuristics (`classifyLoginOutcome`, `decideSessionReady`) that confirm real account content before marking the session `READY`.
   - Active tokens and cookies are securely encrypted and stored for persistent reuse.

2. **Dynamic Wave Allocation & Capacity Probing**:
   - When a bulk purchase (e.g., 50 units of an electronics item) is initiated, OrderGrid probes live inventory and per-account quantity limits.
   - Automatically distributes units across verified accounts (e.g., 25 accounts $\times$ 2 units) without account reuse.

3. **Atomic Virtual Card Provisioning**:
   - An atomic database lock (`UPDATE virtual_cards SET status='ISSUING'`) guarantees that exactly one virtual card is provisioned per checkout basket.
   - The card is funded up to a strict `CARD_FUNDING_MAX_OVERAGE_PCT` ceiling (default: 10% above estimated price). If the payable amount exceeds this ceiling, the order is halted immediately.

4. **Isolated Browser Automation (CDP)**:
   - The native execution worker connects to Chrome via Chrome DevTools Protocol (CDP).
   - Each order executes within its own isolated sandbox directory (`profiles/<account_id>`).
   - The worker navigates to the retailer, validates the exact cart items and price, selects the bound delivery address, inputs virtual card details, and submits the order.

5. **Reconciliation, Card Closure & Tax Invoicing**:
   - Captures the verified retailer order ID (e.g. `OD1234567890`).
   - The virtual card is automatically unloaded and marked `CLOSED`. If an issuer lacks programmatic closure endpoints, it safely transitions to `CLEANUP_REQUIRED` with full audit logs.
   - A compliance-grade B2B GST invoice is generated with CGST/SGST/IGST tax splits and HSN codes.

---

## Core Capabilities

### 1. Flipkart & Amazon Multi-Account Orchestration
- **Dynamic Pincode Stock Probing**: Injects customer postal codes to query live regional inventory and delivery timeframes.
- **Heterogeneous Wave Allocation**: Accommodates varying purchase limits across accounts and computes the optimal distribution.
- **Native Keyboard OTP Engine**: Simulates hardware-level keystrokes for React-controlled OTP boxes, ensuring 100% login reliability across hundreds of accounts.

### 2. Isolated Browser Virtualization (CDP Engine)
- **Hermetic Chrome Sandboxing**: Every account runs inside its own isolated user profile directory. No shared cookies, cache, or local storage.
- **Adaptive Parallel Execution**: Dynamically scales concurrent checkout instances based on available system RAM and CPU cores.
- **Session Auto-Refresh & Token Capture**: Automatically captures authenticated session tokens, persisting them encrypted in PostgreSQL.

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
- **AES-256-GCM Encryption**: All credentials and sensitive tokens are encrypted at rest using AES-256-GCM authenticated encryption.
- **Role-Based Access Control (RBAC)**:
  - `OWNER`: Full administrative, workspace, and financial connector configuration.
  - `APPROVER`: Commercial limit approval and batch sign-off.
  - `BUYER`: Batch creation, product probing, and execution monitoring.
  - `AUDITOR`: Read-only compliance, invoice review, and audit inspection.
- **Fail-Closed Security Model**: Demo and showroom servers fail closed (`401 Unauthorized`) when environment credentials are not configured.

---

## Configuration & Environment Variables

| Variable | Type | Default | Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | String | `production` | Application environment (`development`, `test`, `production`). |
| `PORT` | Number | `3000` | HTTP server port. |
| `APP_ORIGIN` | String | *Required* | Public application base URL (e.g. `http://3.106.181.196:3000`). |
| `DATABASE_URL` | String | *Required* | PostgreSQL connection string (`postgresql://user:pass@host:5432/db`). |
| `REDIS_URL` | String | *Required* | Redis connection string (`redis://host:6379`). |
| `SESSION_SECRET` | String | *Required (32+ chars)* | Cryptographic secret for signing session cookies. |
| `DATA_ENCRYPTION_KEY_BASE64` | String | *Required (40+ chars)* | Base64-encoded 256-bit AES key for database encryption. |
| `WORKER_API_TOKEN` | String | *Required in Prod* | Machine-to-machine authentication token for automation workers. |
| `CARD_FUNDING_MAX_OVERAGE_PCT` | Number | `10` | Maximum percentage allowed above basket price for virtual card funding. |
| `OTP_MIN_INTERVAL_MINUTES` | Number | `30` | Minimum cooldown period between consecutive OTP requests on an account. |
| `OTP_RATE_LIMIT_COOLDOWN_HOURS` | Number | `6` | Cooldown period when a retailer returns rate-limit errors. |
| `BEDROCK_REGION` | String | `ap-south-1` | AWS region for Amazon Bedrock AI product inference. |

---

## Deployment Quickstart

### 1. Docker Compose Production Deployment (AWS EC2)

```bash
# Clone the repository on the target server
git clone https://github.com/Tashima-Tarsh/ordergrid.git /opt/ordergrid
cd /opt/ordergrid

# Configure environment variables
cp .env.example .env
# Edit .env with your PostgreSQL, Redis, and secret keys

# Build and start services (Web API, PostgreSQL, Redis)
docker compose up -d --build

# Verify container health
curl -s http://localhost:3000/api/health
```

### 2. Running Verification & Test Suites

OrderGrid includes 78 unit, integration, and security tests:

```bash
# Run the complete test suite (78 tests)
npm test

# Run TypeScript static typecheck
npm run typecheck

# Run frontend & automation smoke tests
node scripts/smoke-frontend-contract.mjs
node scripts/smoke-automation.mjs
node scripts/smoke-users.mjs
```

### 3. Running the Native Desktop Automation Worker

The desktop automation worker connects securely to the OrderGrid control plane:

```powershell
# Windows PowerShell
$env:ORDERGRID_URL = "http://3.106.181.196:3000"
$env:ORDERGRID_EMAIL = "owner@ordergrid.internal"
$env:ORDERGRID_PASSWORD = "YourSecurePassword"
$env:ORDERGRID_PARALLEL = "4"
$env:ORDERGRID_HEADLESS = "" # Leave blank to view Chrome, set "1" for headless

node agent/index.mjs
```

---

<div align="center">

**OrderGrid Enterprise Engine** · Built for Reliability, Transactional Safety, and Scale.

</div>
