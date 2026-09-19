# OrderGrid Bulk Execution Worker

The OrderGrid execution worker is a persistent local companion for operator workstations. After one-time startup and login, bulk runs are started and monitored from the **OrderGrid → Bulk checkout** workspace.

OrderGrid groups approved order lines into one basket per **customer/account + retailer**. For example, 10 customers × 3 Amazon products produces 30 order lines but normally only 10 Amazon baskets.

## What the worker does

For each basket assigned by OrderGrid, the worker:

1. Uses the stable customer/account `reference` plus retailer to select an isolated Chrome profile.
2. Opens every verified product URL for that basket in the same profile.
3. Uses local Chrome DevTools automation to attempt repetitive **Add to Cart / Add to Bag** actions.
4. Opens the retailer cart after all product lines have been prepared.
5. Leaves the visible retailer session open for any login, OTP, CAPTCHA, 3DS, payment authorization, address choice or retailer-specific exception.
6. Keeps the basket in OrderGrid until the genuine retailer order ID is recorded from the Bulk Checkout screen.

The automation port is bound to `127.0.0.1` and exists only on the operator workstation. The worker does not use stealth automation and does not attempt to defeat retailer controls.

## Requirements

- Node.js 22 or newer
- Google Chrome
- A reachable OrderGrid deployment
- An authorized retailer account for each customer/account
- The OrderGrid database migrations applied

## Recipient account mapping

Include a stable, non-secret `reference` column in the recipient CSV/XLSX file. Use an internal customer or account reference, never a retailer username or password.

```csv
reference,recipient,phone,line1,city,state,postal_code
CUST-0001,Example Recipient,9876543210,Example Road,Delhi,Delhi,110001
```

The same reference and retailer reuse the same isolated Chrome profile on later runs.

## Run on Windows

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

You may also set `ORDERGRID_URL` and double-click `agent\run-ordergrid-agent.cmd`.

The worker remains online by default. OrderGrid displays it as **ONLINE** in Bulk Checkout and polls it for newly assigned baskets.

For managed workstations you may provide the OrderGrid operator credentials through environment variables so the worker can start without an interactive login prompt:

```powershell
$env:ORDERGRID_EMAIL = "operator@example.com"
$env:ORDERGRID_PASSWORD = "<operator password>"
$env:ORDERGRID_PARALLEL = "4"
npm run agent
```

Protect those environment values using the workstation's secret-management mechanism. Do not store them in the repository.

Optional controls:

- `ORDERGRID_PARALLEL=1..8` — number of different isolated customer profiles prepared concurrently. Default: 4.
- `ORDERGRID_DAEMON=0` — run one polling cycle and exit instead of remaining online.
- `ORDERGRID_AUTO_CLAIM=1` — allow the worker to claim ready baskets automatically. By default baskets are started explicitly from the OrderGrid web workspace.
- `ORDERGRID_BASKETS=1..25` — auto-claim size when auto-claim is enabled.

## Security boundary

Chrome profile data is stored under `%LOCALAPPDATA%\OrderGrid\profiles` on Windows. Protect the Windows account with device encryption, screen lock and least-privilege access.

OrderGrid does **not** ask the worker to capture or transmit retailer passwords, OTPs, CAPTCHAs, PANs or CVVs. These are entered only into the genuine retailer surface when required. The worker only automates repetitive cart preparation and opens the cart; authentication and final retailer/payment controls remain with the retailer and authorized operator.

A basket is not considered successful merely because Chrome reached a cart or checkout page. OrderGrid marks the basket confirmed only after a genuine retailer-issued order ID is recorded.
