import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { hashPassword, verifyPassword } from "../src/security.js";

test("production mode rejects startup when ORDERGRID_OWNER_RECOVERY variables are set", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://ordergrid.internal";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/ordergrid";
    process.env.WORKER_API_TOKEN = "a_very_secure_and_long_worker_token_32chars_min";
    process.env.SESSION_SECRET = "a_very_secure_and_long_session_secret_32chars_min";
    process.env.DATA_ENCRYPTION_KEY_BASE64 = "YXV0b2dlbmVyYXRlZF8zMmJ5dGVfa2V5X2Zvcl9wcm9kdWN0aW9uX29yZGVyZ3JpZA==";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@ordergrid.internal";
    process.env.ORDERGRID_OWNER_RECOVERY_USERNAME = "emergency_owner";
    process.env.ORDERGRID_OWNER_RECOVERY_HASH = "scrypt:somehash";

    assert.throws(
      () => loadConfig(),
      (err: any) => {
        return (
          err.name === "ZodError" &&
          err.issues.some((i: any) =>
            i.message.includes("ORDERGRID_OWNER_RECOVERY_* backdoor environment variables are strictly forbidden")
          )
        );
      }
    );
  } finally {
    process.env = originalEnv;
  }
});

test("CLI password reset scrypt hashes verify correctly", async () => {
  const password = "SuperSecretNewPassword123!";
  const hash = await hashPassword(password);

  assert.ok(hash.startsWith("scrypt:"));
  const isValid = await verifyPassword(password, hash);
  assert.equal(isValid, true);

  const isInvalid = await verifyPassword("WrongPassword123!", hash);
  assert.equal(isInvalid, false);
});
