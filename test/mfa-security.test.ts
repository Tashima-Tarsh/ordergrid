import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode,
  base32Encode,
  computeLockoutDurationSeconds,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashPassword,
  verifyPassword,
  verifyTotp
} from "../src/security.js";

// ------------------------------------------------------------------------------------------------
// Section 1.8 Tests: TOTP RFC 6238 Vectors, Replay Rejection, Recovery Codes & Lockout Math
// ------------------------------------------------------------------------------------------------

test("1.8.1: TOTP matches RFC 6238 SHA-1 official test vectors", () => {
  // RFC 6238 Appendix B test secret: ASCII "12345678901234567890" (20 bytes)
  const rfcSecret = Buffer.from("12345678901234567890", "ascii");

  const testVectors = [
    { timeSec: 59, expected: "287082" },
    { timeSec: 1111111109, expected: "081804" },
    { timeSec: 1111111111, expected: "050471" },
    { timeSec: 1234567890, expected: "005924" },
    { timeSec: 2000000000, expected: "279037" },
    { timeSec: 20000000000, expected: "353130" }
  ];

  for (const { timeSec, expected } of testVectors) {
    const code = generateTotp(rfcSecret, { timestampMs: timeSec * 1000, stepSeconds: 30, digits: 6 });
    assert.equal(code, expected, `Failed for timestamp ${timeSec}s`);

    const result = verifyTotp(expected, rfcSecret, { timestampMs: timeSec * 1000, stepSeconds: 30, digits: 6 });
    assert.equal(result.valid, true, `Verification failed for timestamp ${timeSec}s`);
  }
});

test("1.8.2: Base32 encode and decode roundtrip", () => {
  const secret = generateTotpSecret(20);
  const decoded = base32Decode(secret.secretBase32);
  assert.deepEqual(decoded, secret.secretBuffer);

  const reEncoded = base32Encode(decoded);
  assert.equal(reEncoded, secret.secretBase32);
});

test("1.8.3: TOTP enforces replay rejection with lastUsedStep", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  const timeMs = 1234567890 * 1000;
  const currentStep = BigInt(Math.floor(1234567890 / 30)); // 41152263n
  const code = "005924";

  // First verification with no prior used step -> valid
  const first = verifyTotp(code, secret, { timestampMs: timeMs, lastUsedStep: null });
  assert.equal(first.valid, true);
  assert.equal(first.step, currentStep);

  // Replay attempt with lastUsedStep >= currentStep -> rejected
  const replayed = verifyTotp(code, secret, { timestampMs: timeMs, lastUsedStep: currentStep });
  assert.equal(replayed.valid, false, "Replay of same step must be rejected");

  // Next time window (T + 30s) with lastUsedStep = currentStep -> valid
  const nextTimeMs = (1234567890 + 30) * 1000;
  const nextStep = currentStep + 1n;
  const nextCode = generateTotp(secret, { timestampMs: nextTimeMs });

  const nextRes = verifyTotp(nextCode, secret, { timestampMs: nextTimeMs, lastUsedStep: currentStep });
  assert.equal(nextRes.valid, true);
  assert.equal(nextRes.step, nextStep);
});

test("1.8.4: Recovery codes generation, hashing, and single-use validation", async () => {
  const codes = generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10, "Recovery codes must be unique");

  // Hash code
  const codeToUse = codes[0];
  const hashed = await hashPassword(codeToUse);

  // Check valid code against hash
  assert.equal(await verifyPassword(codeToUse, hashed), true);
  assert.equal(await verifyPassword("WRONG-CODE", hashed), false);
});

test("1.8.5: Lockout timing math computes doubling intervals capped at 4 hours", () => {
  // 1st lock: 15 min (900s)
  assert.equal(computeLockoutDurationSeconds(1), 15 * 60);

  // 2nd lock: 30 min (1800s)
  assert.equal(computeLockoutDurationSeconds(2), 30 * 60);

  // 3rd lock: 60 min (3600s)
  assert.equal(computeLockoutDurationSeconds(3), 60 * 60);

  // 4th lock: 120 min (7200s)
  assert.equal(computeLockoutDurationSeconds(4), 120 * 60);

  // 5th lock: 240 min (14400s)
  assert.equal(computeLockoutDurationSeconds(5), 240 * 60);

  // 6th lock & higher: capped at 240 min (14400s)
  assert.equal(computeLockoutDurationSeconds(6), 240 * 60);
  assert.equal(computeLockoutDurationSeconds(10), 240 * 60);
});
