import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptJson, decryptWithKeys, encryptJson } from "../src/security.js";

test("decryptWithKeys supports primary and previous encryption keys", () => {
  const key1 = randomBytes(32).toString("base64");
  const key2 = randomBytes(32).toString("base64");
  const key3 = randomBytes(32).toString("base64");

  const payload = { account: "test-user-123", secretToken: "my-secret-value-xyz" };

  // Encrypted under key1 (old key)
  const encryptedUnderKey1 = encryptJson(payload, key1);

  // Encrypted under key2 (new key)
  const encryptedUnderKey2 = encryptJson(payload, key2);

  // Decrypting key2 payload with [key2, key1] -> succeeds (primary key)
  const decPrimary = decryptWithKeys(encryptedUnderKey2, [key2, key1]);
  assert.deepEqual(decPrimary, payload);

  // Decrypting key1 payload with [key2, key1] -> succeeds (previous key fallback)
  const decFallback = decryptWithKeys(encryptedUnderKey1, [key2, key1]);
  assert.deepEqual(decFallback, payload);

  // Decrypting with wrong key3 -> throws
  assert.throws(() => decryptWithKeys(encryptedUnderKey1, [key2, key3]));

  // decryptJson with array parameter also works
  const decJsonArray = decryptJson(encryptedUnderKey1, [key2, key1]);
  assert.deepEqual(decJsonArray, payload);
});

test("atomic re-encryption round-trip maintains identical plaintext JSON", () => {
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");

  const originalData = {
    apiKey: "enkash_live_sec_9921",
    secret: "shhh_super_secret",
    timestamp: Date.now()
  };

  const oldEncrypted = encryptJson(originalData, oldKey);

  // Rotate: decrypt with old, encrypt with new
  const decrypted = decryptJson(oldEncrypted, oldKey);
  const newEncrypted = encryptJson(decrypted, newKey);

  // Old key can no longer decrypt new ciphertext
  assert.throws(() => decryptJson(newEncrypted, oldKey));

  // New key successfully decrypts to original data
  const finalDecrypted = decryptJson(newEncrypted, newKey);
  assert.deepEqual(finalDecrypted, originalData);
});
