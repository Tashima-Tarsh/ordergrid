import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { findChrome, profileKey, profileRoot } from "../agent/lib.mjs";
import { exportRetailerSessionState } from "../agent/cdp.mjs";

const rl = createInterface({ input, output });

async function main() {
  const serverUrl = (process.env.ORDERGRID_URL || "http://3.106.181.196:3000").replace(/\/$/, "");
  const adminEmail = process.env.ORDERGRID_EMAIL || "amyhod3@gmail.com";
  const adminPassword = process.env.ORDERGRID_PASSWORD || "OrderGridAdmin2026!7xK9";

  console.log("=======================================================");
  console.log("       ORDERGRID FLIPKART ACCOUNT CONNECTOR");
  console.log("=======================================================");
  console.log(`OrderGrid Server: ${serverUrl}\n`);

  let accountRef = process.argv[2];
  if (!accountRef) {
    const inputRef = (await rl.question("Enter Flipkart email or mobile number [default: niku906099@gmail.com]: ")).trim();
    accountRef = inputRef || "niku906099@gmail.com";
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error("Chrome / Edge browser was not found on your system.");
    process.exit(1);
  }

  const directory = join(profileRoot(), profileKey(accountRef));
  console.log(`\nLaunching dedicated browser profile for ${accountRef}...`);

  const args = [
    `--user-data-dir=${directory}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "https://www.flipkart.com/account/login?ret=/"
  ];

  const browser = spawn(chrome, args, { detached: true, stdio: "ignore" });
  browser.unref();

  console.log("\n=======================================================");
  console.log("  >>> FLIPKART BROWSER WINDOW OPENED <<<");
  console.log("=======================================================");
  console.log("1. Look at the Chrome window that just opened.");
  console.log(`2. Enter ${accountRef} on Flipkart, click Request OTP / Continue.`);
  console.log("3. Enter your OTP and complete sign-in.");
  console.log("=======================================================\n");

  await rl.question("Press [ENTER] here as soon as you have signed into Flipkart... ");

  console.log("\nCapturing session cookies from browser...");
  try {
    const sessionState = await exportRetailerSessionState({ chrome, directory, retailer: "flipkart" });
    const cookieCount = sessionState?.cookies?.length || 0;
    console.log(`Captured ${cookieCount} session cookie(s).`);

    console.log("Syncing authenticated session with OrderGrid cloud server...");
    const loginRes = await fetch(`${serverUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    const cookieHeader = loginRes.headers.get("set-cookie")?.split(";")[0];
    if (!cookieHeader) throw new Error("Could not log in to OrderGrid server.");

    const accountsRes = await fetch(`${serverUrl}/api/retailer-accounts?retailer=flipkart&limit=100`, {
      headers: { "Cookie": cookieHeader }
    });
    const { accounts = [] } = await accountsRes.json();
    let target = accounts.find(a => a.account_reference.toLowerCase() === accountRef.toLowerCase());

    if (!target) {
      console.log(`Adding ${accountRef} to OrderGrid pool...`);
      const createRes = await fetch(`${serverUrl}/api/retailer-accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": cookieHeader },
        body: JSON.stringify({
          retailer: "flipkart",
          accountReference: accountRef,
          maxConcurrentOrders: 1,
          active: true
        })
      });
      target = await createRes.json();
    }

    if (target?.id) {
      console.log(`Triggering verification for account ${target.id}...`);
      await fetch(`${serverUrl}/api/retailer-accounts/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Cookie": cookieHeader },
        body: JSON.stringify({
          accountIds: [target.id],
          retailer: "flipkart",
          targetDays: 15,
          verifyOnly: true
        })
      });
    }

    console.log("\n=======================================================");
    console.log("  SUCCESS: Flipkart Session Synced with OrderGrid!");
    console.log(`  Account: ${accountRef}`);
    console.log("  Dashboard: " + serverUrl);
    console.log("=======================================================\n");
  } catch (error) {
    console.error("Session sync notice:", error.message);
  }

  rl.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
