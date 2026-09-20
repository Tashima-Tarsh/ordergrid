# OrderGrid Native Bulk Ordering Worker

The OrderGrid worker is the execution layer behind **OrderGrid → Bulk ordering**. Start it once on an authorized workstation; after that, approved baskets are started, monitored, retried and reconciled from the OrderGrid web workspace.

## Normal flow

1. OrderGrid receives products and recipients.
2. It creates one basket per customer/account + retailer.
3. An approver starts the bulk run in OrderGrid.
4. A live worker is assigned baskets by worker ID.
5. The worker reuses the isolated Chrome profile for that customer + retailer.
6. It adds all basket items and drives the checkout flow.
7. If the retailer can complete without a new challenge, the worker continues automatically.
8. If the retailer requires password, OTP, CAPTCHA, 3DS or another protected action, that basket is marked **AUTHORIZATION REQUIRED** in OrderGrid while the secure browser session remains open.
9. After the protected step is completed, the worker resumes the same checkout automatically.
10. The basket is marked **CONFIRMED** only after the worker detects a genuine retailer-issued order ID.

There is no normal "retailer handoff" workflow and no manual order-ID entry in the OrderGrid UI.

## Requirements

- Node.js 22+
- Google Chrome
- Reachable OrderGrid deployment
- Authorized retailer accounts
- All OrderGrid database migrations applied

## Recipient/account isolation

Include a stable non-secret `reference` in the recipient file:

```csv
reference,recipient,phone,line1,city,state,postal_code
CUST-0001,Example Recipient,9876543210,Example Road,Delhi,Delhi,110001
```

OrderGrid combines this reference with the retailer identity to select a persistent isolated browser profile.

## Start the worker

For a normal Windows workstation, sign in to OrderGrid, open **Retailer users**, click **Install / start worker**, download `ordergrid-worker.ps1`, and run it once. The installer:

- verifies Node.js and Chrome;
- signs in to OrderGrid with the authorized worker user;
- obtains the machine token through the authenticated bootstrap endpoint;
- protects the local password/token with Windows user encryption;
- installs the worker under `%LOCALAPPDATA%\OrderGrid`;
- starts it immediately;
- registers it to start automatically when that Windows user signs in.

Queued Flipkart session checks are picked up automatically when the worker comes online.

For source/developer operation:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

For managed workstations:

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
$env:ORDERGRID_EMAIL = "worker@example.com"
$env:ORDERGRID_PASSWORD = "<worker-password>"
$env:ORDERGRID_WORKER_TOKEN = "<machine-token>"
$env:ORDERGRID_PARALLEL = "4"
npm run agent
```

The worker requires both an authorized OrderGrid user session and the deployment machine token (`ORDERGRID_WORKER_TOKEN`). It stays online by default and heartbeats into OrderGrid. The Bulk ordering page shows the live worker count.

Optional:

- `ORDERGRID_PARALLEL=1..8`
- `ORDERGRID_BASKETS=1..25`
- `ORDERGRID_DAEMON=0` to run one cycle and exit

## Security boundary

The worker does not defeat or solve retailer security controls. It does not intercept OTPs, solve CAPTCHAs, bypass 3DS, capture passwords or mark an order successful without a retailer order ID.

Browser profiles live under `%LOCALAPPDATA%\OrderGrid\profiles` on Windows. Protect operator workstations with device encryption, screen lock and least-privilege access.

For card payments, OrderGrid does not store full PAN/CVV. Automatic use of an issuer-created card requires an approved PCI/tokenized payment integration or a retailer-saved payment method. If a retailer requests raw card entry and no approved secure payment integration is configured, the basket is surfaced as a payment challenge rather than exposing card credentials to OrderGrid.
