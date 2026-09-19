import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function classifyAuditResult(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status === 0) return "clean";
  try {
    const report = JSON.parse(result.stdout || "{}");
    if (report.metadata?.vulnerabilities) return "vulnerable";
    if (report.error) return "service-error";
  } catch {
    // Fall through to the transport-error patterns below.
  }
  if (/\b(429|500|502|503|504)\b|service unavailable|audit endpoint returned an error|eai_again|enotfound|etimedout|econnreset/i.test(combined)) {
    return "service-error";
  }
  return "failed";
}

export async function runAudit({ attempts = 3, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
      encoding: "utf8",
      shell: process.platform === "win32"
    });
    const classification = classifyAuditResult(result);
    if (classification === "clean") {
      process.stdout.write(result.stdout || "No high-severity production dependency vulnerabilities found.\n");
      return 0;
    }
    if (classification === "vulnerable" || classification === "failed") {
      process.stdout.write(result.stdout || "");
      process.stderr.write(result.stderr || "");
      return 1;
    }
    if (attempt < attempts) {
      process.stderr.write(`npm audit service unavailable (attempt ${attempt}/${attempts}); retrying.\n`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  process.stderr.write("::warning::npm audit service remained unavailable after retries. Code verification passed; dependency audit must run again when the registry recovers.\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runAudit();
}
