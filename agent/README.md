# OrderGrid Operator Companion

The companion is a visible, human-authorized checkout runner for Windows operator workstations. It claims approved OrderGrid tasks, opens each retailer link in a separate Chrome profile and returns the genuine retailer order ID to OrderGrid after the operator completes checkout.

## Requirements

- Node.js 22 or newer
- Google Chrome
- A reachable OrderGrid deployment
- An authorized retailer account for each recipient

## Recipient account mapping

Add a stable, non-secret `reference` column to the recipient CSV/XLSX file. Use an internal customer or account reference, never a retailer username or password. The companion hashes this reference to select the same isolated Chrome profile on later runs.

```csv
reference,recipient,phone,line1,city,state,postal_code
CUST-0001,Example Recipient,9876543210,Example Road,Delhi,Delhi,110001
```

## Run on Windows

```powershell
$env:ORDERGRID_URL = "https://your-ordergrid.example"
npm run agent
```

You may also set `ORDERGRID_URL` and double-click `agent\run-ordergrid-agent.cmd`.

The companion asks for the OrderGrid operator login at runtime. It keeps the portal session only in memory. For every task it:

1. Claims a leased checkout task.
2. Chooses the Chrome profile derived from the recipient account reference.
3. Opens the verified retailer product URL in a visible Chrome window.
4. Waits while the operator signs in and completes OTP, CAPTCHA and payment on the retailer page.
5. Asks for the genuine retailer order ID and sends it to OrderGrid.

Chrome profile data is stored under `%LOCALAPPDATA%\OrderGrid\profiles`. Protect the Windows account with device encryption, screen lock and least-privilege access. Close or remove profiles according to your customer retention policy.

The companion never asks for or stores retailer passwords, OTPs, CAPTCHAs, PANs or CVVs. It does not use remote debugging, automate the retailer DOM or bypass retailer controls. Run multiple companion instances on separate operator workstations to process independent claimed tasks concurrently.
