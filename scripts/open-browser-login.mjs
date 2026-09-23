import { spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { findChrome, profileKey, profileRoot } from "../agent/lib.mjs";
import { exportRetailerSessionState } from "../agent/cdp.mjs";

const rl = createInterface({ input, output });

async function main() {
  const accountRef = process.argv[2] || (await rl.question("Enter Flipkart email or mobile number: ")).trim();
  if (!accountRef) {
    console.error("Account email or mobile is required.");
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error("Chrome / Edge browser was not found.");
    process.exit(1);
  }

  const directory = join(profileRoot(), profileKey(accountRef));
  console.log(`\nOpening dedicated browser window for ${accountRef}...`);
  console.log(`Profile directory: ${directory}`);

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
  console.log("  FLIPKART LOGIN BROWSER OPENED ON YOUR SCREEN");
  console.log("=======================================================");
  console.log("1. Go to the newly opened browser window.");
  console.log(`2. Enter ${accountRef}, click Continue / Request OTP.`);
  console.log("3. Enter your OTP and complete sign-in.");
  console.log("=======================================================\n");

  await rl.question("Press [ENTER] here once you are logged in to sync session with OrderGrid: ");

  console.log("\nExporting session cookies and verifying authentication...");
  try {
    const sessionState = await exportRetailerSessionState({ chrome, directory, retailer: "flipkart" });
    const cookieCount = sessionState?.cookies?.length || 0;
    console.log(`Successfully captured ${cookieCount} session cookie(s)!`);
    console.log("Session is preserved and ready for OrderGrid batch checkouts.");
  } catch (error) {
    console.error("Session sync notice:", error.message);
  }

  rl.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
