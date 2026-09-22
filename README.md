# OrderGrid Enterprise Procurement Engine

<div align="center">

![OrderGrid Architecture](https://img.shields.io/badge/System-OrderGrid%20Enterprise-0A84FF?style=for-the-badge&logo=googlechrome&logoColor=white)
![Node Version](https://img.shields.io/badge/Node.js-22.x%20%7C%2024.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Database](https://img.shields.io/badge/PostgreSQL-16%2B-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Fastify](https://img.shields.io/badge/API-Fastify%205.x-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Status](https://img.shields.io/badge/Production-Complete%20%26%20Verified-00C853?style=for-the-badge)

**Deterministic Multi-Account Procurement, Live Product Verification, Isolated Session Orchestration, Virtual Card Funding, and Compliance-Grade Invoicing.**

[Live Production Console](https://ordergrid-production.up.railway.app) · [Architecture Blueprint](#architecture--system-design) · [Flipkart Allocation](#flipkart-mobile-allocation-engine) · [Security Model](#security-compliance--ethical-automation) · [Operations](#deployment--operations)

</div>

---

## Executive Overview

**OrderGrid** is an enterprise-grade ecommerce procurement and fulfilment execution platform built for high-volume, authorized multi-account operations. It solves the critical bottleneck of orchestrating large-scale purchases across disparate customer accounts while maintaining strict transactional integrity, isolated financial boundaries, identity binding, and statutory compliance.

### The Problem It Solves

Large procurement operations often fail due to:
1. **Account Session Collision**: Managing dozens of retailer profiles concurrently without session leakage, fingerprint degradation, or IP contamination.
2. **Dynamic Stock & Pincode Fragmentation**: Real-time regional pricing, unassigned default sellers, and heterogeneous quantity limits across accounts.
3. **Financial Contamination & Limit Breaches**: Reusing parent credit cards across multiple orders, triggering merchant anti-fraud blocks.
4. **Fragile Exception Handling**: Retailer OTPs, 3DS authentication, or stock depletion crashing entire batch operations.
5. **Tax & Regulatory Gaps**: Disconnected invoice reconciliation, missing multi-state GST schedules, and manual ledger entries.

### The Solution: OrderGrid Core Innovations

- **Isolated Browser Virtualization**: Each retailer profile operates in a dedicated, hermetically isolated Chrome DevTools Protocol (CDP) sandbox with persistent session cookies and hardware tokens.
- **Deterministic Multi-Account Allocator**: Distributes batch unit requirements across verified accounts based on real-time live capacity probing rather than naive fixed assumptions.
- **Single-Use Virtual Card Engine**: Programmatically provisions, limits, and binds a unique virtual card to exactly one order.
- **Zero-Loss Exception State Machine**: Automatically pauses challenged transactions (`REQUIRES_ACTION`, `OTP_REQUIRED`, `3DS_VERIFICATION`) into operator queues while remaining healthy orders execute concurrently.
- **Automated GST & Ledger Generation**: Computes intra-state (CGST/SGST) and inter-state (IGST) schedules with automated B2B invoice generation and Excel reporting.

---

## Architecture & System Design

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             ORDERGRID CONTROL PLANE                              │
├──────────────────────────┬───────────────────────────┬───────────────────────────┤
│    Fastify REST API      │   PostgreSQL 16 Engine    │     BullMQ / Redis        │
│  (Auth, RBAC, Sessions)  │ (Multi-Tenant Relational) │   (Distributed Queues)    │
└────────────┬─────────────┴─────────────┬─────────────┴─────────────┬─────────────┘
             │                           │                           │
             ▼                           ▼                           ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         NATIVE DESKTOP AUTOMATION WORKER                         │
├──────────────────────────────────────────────────────────────────────────────────┤
│  • Adaptive Parallelism (1-8 concurrent profile workers)                         │
│  • Chrome DevTools Protocol (CDP) WebSocket Engine                               │
│  • Session Reconciler & Instant Token Exporter                                   │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 ▼                                               ▼
┌──────────────────────────────────┐           ┌──────────────────────────────────┐
│    Flipkart Retailer Profile     │           │     Amazon / Custom Retailer     │
│   • Profile Key Sandbox          │           │   • Profile Key Sandbox          │
│   • Pincode Resolution           │           │   • 1-Click Buy Driver           │
│   • Live Cart Probing            │           │   • Address Verification         │
│   • Single-Use Virtual Card      │           │   • Single-Use Virtual Card      │
└──────────────────────────────────┘           └──────────────────────────────────┘
```

### Identity & Entity Chain

A procurement item is never treated as an anonymous HTTP request. OrderGrid maintains an unbroken, cryptographically auditable chain of custody:

$$\text{Tenant} \longrightarrow \text{Customer} \longrightarrow \text{Delivery Address} \longrightarrow \text{Retailer Account} \longrightarrow \text{Isolated Browser Profile} \longrightarrow \text{Product Check} \longrightarrow \text{Virtual Card} \longrightarrow \text{Retailer Order ID} \longrightarrow \text{GST Invoice}$$

---

## Core Capabilities

### 1. Flipkart Mobile Allocation Engine

OrderGrid includes specialized engine heuristics designed specifically for high-demand consumer electronics and mobile procurement.

- **Dynamic Pincode Resolution**: Injects the account's bound regional postal code to reveal live regional pricing, stock status, and serviceable delivery timelines.
- **Multi-Account Wave Allocator**: Iterates across session-ready accounts, verifies real unit capacity per profile, and computes optimal batch distribution.
- **Operator Price Confirmation Fallback**: If a listing displays alternate seller selections or pending geolocation, operators can confirm the verified market price directly within the wizard, immediately locking the account verification.

---

### 2. Isolated Browser Profile Orchestration

- **Hermetic Chrome Sandboxing**: Every account identity runs inside its own isolated `profiles/<account_id>` directory.
- **Adaptive Parallel Execution**: Manages multiple concurrent browser processes without exceeding system RAM or CPU thresholds.
- **Clean Browser Lifecycle**: Immediately closes automation windows upon successful OTP verification or checkout completion, releasing memory back to the host machine.
- **Token Capture & 15-Day Session Persistence**: Automatically dumps session cookies, storage state, and tokens back to PostgreSQL, keeping accounts session-ready across restarts.

---

### 3. Virtual Card Funding & Commercial Safety

- **One-Order / One-Card Model**: Generates unique virtual card tokens with exact spending limits and expiration windows.
- **No Card Reuse**: Eliminates merchant cross-account correlation by ensuring no two accounts ever share the same payment instrument.
- **Commercial Price Gates**: Verifies final payable amounts at the retailer's terminal step against the approved batch total before triggering the order submission.

---

### 4. Resilient State Machine & Human Action Handoff

```text
PENDING ──► ACCOUNT_ALLOCATED ──► SESSION_READY ──► PRICE_VERIFIED ──► CARD_ASSIGNED
                                                                            │
      ┌─────────────────────────────────────────────────────────────────────┘
      ▼
READY_TO_EXECUTE ──► CHECKOUT_OPENED ──► PAYMENT_SUBMITTED ──► CONFIRMED
      │
      ├─► [CHALLENGE DETECTED: OTP / CAPTCHA / 3DS] ──► REQUIRES_ACTION (Operator Queue)
      └─► [OUT OF STOCK] ──► STOCK_WATCH (Auto-Polling Engine)
```

- **Non-Blocking Fault Isolation**: A single account failure or verification request pauses only the affected order, allowing the remainder of the 50+ order batch to proceed without interruption.
- **Interactive Human Action Queue**: Surfaces OTP, CAPTCHA, and 3DS requirements in a dedicated operational cockpit.

---

### 5. Multi-State GST & Invoice Automation

- **Automated Tax Engine**: Dynamically calculates CGST (9%), SGST (9%), IGST (18%), and custom cess schedules based on supplier vs recipient states.
- **Instant Tax Invoices**: Generates enterprise-grade PDF/print invoices with HSN/SAC codes (`8517` for telecommunications/mobiles).
- **Excel Ledger Export**: Full batch export including retailer order numbers, payment references, tax breakdowns, and customer bindings.

---

## Security, Compliance & Ethical Automation

OrderGrid is engineered around strict compliance and ethical automation principles:

> [!IMPORTANT]
> **Strict Operational Boundary**:
> OrderGrid automates standard, legitimate browser workflows for authorized user accounts. It **does NOT** bypass retailer login controls, crack CAPTCHAs, intercept OTPs without operator consent, or bypass bank 3DS/PIN security.

- **Cryptographic Secret Protection**: Stored passwords (when intentionally provided) are encrypted at rest with **AES-256-GCM**.
- **No Raw Card Storage**: Full PAN and CVV credentials are never stored in the database. Virtual card tokens are retrieved via ephemeral provider APIs.
- **Role-Based Access Control (RBAC)**:
  - `OWNER`: Full administrative, tenant, and financial configuration.
  - `APPROVER`: Commercial limit approval and batch execution sign-off.
  - `BUYER`: Order creation, product check execution, and session management.
  - `AUDITOR`: Read-only compliance and invoice inspection.
- **Immutable Audit Trail**: All state transitions, manual price overrides, card assignments, and order placements are permanently logged to the `audit_logs` ledger.

---

## Production Verification & Test Suite

The codebase enforces strict test-driven safety contracts across every layer:

```bash
# Run full unit and integration test suite
npm test

# Run frontend UI and DOM element contract verification
node scripts/smoke-frontend-contract.mjs

# Run backend automation policy engine verification
node scripts/smoke-automation.mjs

# Run multi-tenant user authentication verification
node scripts/smoke-users.mjs

# Validate static types and JavaScript modules
npm run typecheck
```

### Verified Test Matrix

| Test Suite | Pass Count | Status |
| :--- | :---: | :---: |
| **Unit & Integration (`test/*.test.ts`)** | `27 / 27` | `PASS` |
| **Frontend Contract (`smoke-frontend-contract.mjs`)** | `100%` | `PASS` |
| **Automation Engine (`smoke-automation.mjs`)** | `100%` | `PASS` |
| **Multi-Tenant Security (`smoke-users.mjs`)** | `100%` | `PASS` |
| **TypeScript & JS Syntax Checks** | `100%` | `PASS` |

---

## Deployment & Operations

### 1. Cloud Server Deployment (Railway / Docker)

The central OrderGrid server runs on any standard Node.js/Docker hosting provider.

```bash
# Environment Variables (.env)
NODE_ENV=production
PORT=3000
DATABASE_URL="postgresql://user:password@host:5432/ordergrid"
SESSION_SECRET="your-64-char-cryptographic-session-secret"
WORKER_API_TOKEN="your-secure-machine-to-machine-worker-token"
APP_ORIGIN="https://ordergrid-production.up.railway.app"
```

```bash
# Build and migrate
npm run build
npm run db:migrate
npm start
```

---

### 2. Native Desktop Automation Worker Setup

The native execution worker runs on an authorized workstation with Google Chrome installed.

```powershell
# Windows PowerShell Execution
$env:ORDERGRID_URL = "https://ordergrid-production.up.railway.app"
$env:ORDERGRID_EMAIL = "admin@ordergrid.com"
$env:ORDERGRID_PASSWORD = "YourSecurePassword"
$env:ORDERGRID_HEADLESS = ""  # Set to "1" for headless execution

# Launch Desktop Worker
npm run agent
```

#### Worker Configuration Flags

| Variable | Default | Description |
| :--- | :---: | :--- |
| `ORDERGRID_PARALLEL` | `4` | Number of concurrent checkout browser sandboxes. |
| `ORDERGRID_PRODUCT_CHECK_PARALLEL` | `4` | Max parallel product verification probes. |
| `ORDERGRID_SESSION_CLAIM` | `1` | Automatically claims and prepares unassigned retailer accounts. |
| `ORDERGRID_HEADLESS` | `""` | Runs Chrome headlessly or visibly for operator observation. |

---

## User Workflow Quickstart

### Step 1: Connect Retailer Account
1. Open **Retailer Accounts** in the OrderGrid sidebar.
2. Click **Connect** next to an account (e.g. `Flipkart`).
3. The secure browser will launch, navigate to the authentication portal, and await your mobile OTP.
4. Enter the OTP — OrderGrid captures the session token, marks the account `✓ READY`, and immediately closes the window.

### Step 2: Create a Procurement Batch
1. Click **New Batch** in the header.
2. Paste the **Flipkart product URL** (e.g., iPhone 16 / S24 Ultra).
3. **Single Order**: Select your connected account under *Single-account check*, confirm unit price, and proceed.
4. **Bulk Multi-Account**: Set total required units (e.g. `20`) and click **Allocate across ready accounts**.
5. Proceed through **Recipients** (auto-bound addresses) → **Commercial Approval** → **Submit & Execute**.

---

<div align="center">

**OrderGrid Enterprise Engine** · Built for Reliability, Compliance, and Scale.

</div>
