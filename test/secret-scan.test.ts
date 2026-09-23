import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

test("repository tracked files contain no hardcoded production secrets or personal emails", () => {
  const tracked = execSync("git ls-files", { encoding: "utf8" })
    .split("\n")
    .map(f => f.trim())
    .filter(Boolean);

  const blocklist = [
    "amyhod3@gmail.com",
    "niku906099@gmail.com",
    "nitish906099kumar",
    "OrderGrid2026SecurePostgres!",
    "OrderGrid2026SecureAdmin!"
  ];

  const allowedExceptions = new Set([
    "src/config.ts",
    "test/secret-scan.test.ts",
    "test/config-secrets.test.ts"
  ]);

  const violations: { file: string; secret: string }[] = [];

  for (const file of tracked) {
    if (allowedExceptions.has(file.replace(/\\/g, "/"))) continue;
    try {
      const content = readFileSync(file, "utf8");
      for (const secret of blocklist) {
        if (content.includes(secret)) {
          violations.push({ file, secret });
        }
      }
    } catch {
      // Ignore binary files or unreadable items
    }
  }

  assert.equal(
    violations.length,
    0,
    `Found hardcoded secrets or personal emails in tracked files:\n` +
      violations.map(v => `  - ${v.file}: contains blocked term "${v.secret}"`).join("\n")
  );
});
