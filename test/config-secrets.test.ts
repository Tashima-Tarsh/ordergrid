import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("production mode rejects default insecure secrets", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://app.example.com";
    process.env.DATABASE_URL = "postgres://user:pass@db:5432/ordergrid";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    process.env.SESSION_SECRET = "ordergrid_session_secret_2026_super_secure_32bytes";
    process.env.DATA_ENCRYPTION_KEY_BASE64 = "YXV0b2dlbmVyYXRlZF8zMmJ5dGVfa2V5X2Zvcg==1234567890abcdef";
    process.env.WORKER_API_TOKEN = "ordergrid_worker_token_secure_min_32_chars_2026";

    assert.throws(() => loadConfig(), /must not use the repository default/);
  } finally {
    process.env = originalEnv;
  }
});

test("production mode rejects short secrets", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://app.example.com";
    process.env.DATABASE_URL = "postgres://user:pass@db:5432/ordergrid";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    process.env.SESSION_SECRET = "short_secret";
    process.env.DATA_ENCRYPTION_KEY_BASE64 = "short_key";
    process.env.WORKER_API_TOKEN = "short_worker_token";

    assert.throws(() => loadConfig());
  } finally {
    process.env = originalEnv;
  }
});

test("production mode accepts strong cryptographic secrets", () => {
  const originalEnv = { ...process.env };
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_ORIGIN = "https://app.example.com";
    process.env.DATABASE_URL = "postgres://user:pass@db:5432/ordergrid";
    process.env.BOOTSTRAP_ADMIN_EMAIL = "admin@example.com";
    process.env.SESSION_SECRET = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6";
    process.env.DATA_ENCRYPTION_KEY_BASE64 = "4d9f1a8c7e2b6a5f0d3c8e1b4a7f2c9e0d3b6a8f1c4e7=";
    process.env.WORKER_API_TOKEN = "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a";

    const config = loadConfig();
    assert.equal(config.NODE_ENV, "production");
    assert.equal(config.OTP_MIN_INTERVAL_MINUTES, 30);
    assert.equal(config.OTP_RATE_LIMIT_COOLDOWN_HOURS, 6);
  } finally {
    process.env = originalEnv;
  }
});
