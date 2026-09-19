import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson, hashPassword, verifyPassword } from "../src/security.js";

test("password hashes verify without storing plaintext", async () => {
  const encoded = await hashPassword("a-long-production-password");
  assert.equal(await verifyPassword("a-long-production-password", encoded), true);
  assert.equal(await verifyPassword("incorrect-password", encoded), false);
  assert.equal(encoded.includes("a-long-production-password"), false);
});

test("provider configuration is authenticated and encrypted", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptJson({ apiKey: "secret", account: "issuer-01" }, key);
  assert.equal(encrypted.ciphertext.includes(Buffer.from("secret")), false);
  assert.deepEqual(decryptJson(encrypted, key), { apiKey: "secret", account: "issuer-01" });
});
