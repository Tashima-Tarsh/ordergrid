import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allowedHandoff, findChrome, profileKey, profileRoot } from "./lib.mjs";

const baseUrl = (process.env.ORDERGRID_URL || "http://localhost:3000").replace(/\/$/, "");
const rl = createInterface({ input, output });
let cookie = "";

async function ask(label) {
  return (await rl.question(label)).trim();
}

async function readSecret(label) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return ask(label);
  output.write(label);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk) => {
      for (const key of chunk) {
        if (key === "\u0003") return finish(new Error("Cancelled"));
        if (key === "\r" || key === "\n") return finish();
        if (key === "\u007f" || key === "\b") value = value.slice(0, -1);
        else value += key;
      }
    };
    input.on("data", onData);
  });
}

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${body.error || response.statusText} (${response.status})`);
  return { body, response };
}

async function login() {
  const email = await ask("OrderGrid operator email: ");
  let password = await readSecret("OrderGrid operator password: ");
  const { response } = await api("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  password = "";
  const setCookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")];
  const sessionCookie = setCookies.find(Boolean);
  if (!sessionCookie) throw new Error("The server did not return a session cookie.");
  cookie = sessionCookie.split(";")[0];
}

function launchChrome(executable, directory, url) {
  const child = spawn(executable, [
    `--user-data-dir=${directory}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url
  ], { detached: true, stdio: "ignore" });
  child.on("error", (error) => output.write(`Chrome launch failed: ${error.message}\n`));
  child.unref();
}

async function processSession(chrome, session) {
  const label = session.recipient || session.purchase_order_id;
  output.write(`\n${session.retailer || "Retailer"} · ${label} · ₹${(Number(session.amount_minor) / 100).toFixed(2)}\n`);
  const { body } = await api(`/api/operator-queue/${session.id}/open`, { method: "POST", body: "{}" });
  if (!allowedHandoff(body.actionUrl)) throw new Error("OrderGrid returned an untrusted checkout URL.");

  const stableReference = session.account_reference || session.purchase_order_id;
  if (!session.account_reference) {
    output.write("No account reference was supplied; this browser session cannot be matched to the same account later.\n");
  }
  const directory = join(profileRoot(), profileKey(stableReference));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  launchChrome(chrome, directory, body.actionUrl);
  output.write("Chrome opened in an isolated customer profile. Complete retailer sign-in, OTP/CAPTCHA and payment there.\n");

  while (true) {
    const action = (await ask("[c] confirm order  [s] skip  [r] release  [q] quit: ")).toLowerCase();
    if (action === "c") {
      const retailerOrderId = await ask("Retailer order ID: ");
      await api(`/api/operator-queue/${session.id}/confirm`, {
        method: "POST",
        body: JSON.stringify({ retailerOrderId })
      });
      output.write(`Confirmed ${retailerOrderId}.\n`);
      return "continue";
    }
    if (action === "r") {
      await api(`/api/operator-queue/${session.id}/release`, { method: "POST", body: "{}" });
      output.write("Task released to the queue.\n");
      return "continue";
    }
    if (action === "s") return "continue";
    if (action === "q") return "quit";
  }
}

async function main() {
  output.write("\nOrderGrid Operator Companion\n");
  output.write("Retailer passwords, OTPs, CAPTCHAs and card data must be entered only on the genuine retailer page.\n");
  output.write("The companion opens isolated Chrome profiles; it does not automate final payment.\n\n");
  const chrome = findChrome();
  if (!chrome) throw new Error("Google Chrome was not found. Install Chrome and run again.");
  await login();
  const requested = Number(await ask("Tasks to claim (1-25, default 10): ") || "10");
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 25 ? requested : 10;
  await api("/api/operator-queue/claim", { method: "POST", body: JSON.stringify({ limit }) });
  const { body } = await api("/api/operator-queue");
  if (!body.sessions?.length) {
    output.write("No eligible checkout tasks are available.\n");
    return;
  }
  output.write(`Claimed ${body.sessions.length} task(s).\n`);
  for (const session of body.sessions) {
    try {
      if (await processSession(chrome, session) === "quit") break;
    } catch (error) {
      output.write(`Task error: ${error.message}\n`);
    }
  }
}

try {
  await main();
} catch (error) {
  output.write(`\nAgent stopped: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  cookie = "";
  rl.close();
}
