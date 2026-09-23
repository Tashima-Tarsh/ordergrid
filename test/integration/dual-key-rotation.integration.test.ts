import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationApp, createMockDb } from "./helpers.js";
import { encryptJson, generateTotpSecret, hashPassword } from "../../src/security.js";

test("Integration: Dual-Key Encryption & Rotation Access", async () => {
  const { db, store } = createMockDb();
  const previousKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
  const currentKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  const { secretBase32 } = generateTotpSecret();
  // Encrypt MFA secret under previous key
  const encOld = encryptJson({ secret: secretBase32 }, previousKey);

  const passwordHash = await hashPassword("OwnerPassword12345!");
  const user = {
    id: "rotated-user-3333-3333-3333-3333",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    email: "rotated@ordergrid.internal",
    username: "rotated",
    role: "OWNER",
    active: true,
    password_hash: passwordHash,
    mfa_enabled: true,
    mfa_secret_ciphertext: encOld.ciphertext,
    mfa_secret_iv: encOld.iv,
    mfa_secret_auth_tag: encOld.authTag,
    mfa_last_used_step: null
  };
  store.users.set(user.id, user);

  // App configured with currentKey and previousKey
  const app = await createIntegrationApp(db, {
    DATA_ENCRYPTION_KEY_BASE64: currentKey,
    DATA_ENCRYPTION_KEY_PREVIOUS_BASE64: previousKey
  });

  // 1. Login with password -> returns MFA token
  const login1 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "OwnerPassword12345!" }
  });
  assert.equal(login1.statusCode, 200);
  const login1Body = JSON.parse(login1.body);
  assert.equal(login1Body.mfaRequired, true);

  // 2. Verify MFA: app decrypts secret using previous key fallback seamlessly
  import("../../src/security.js").then(async ({ generateTotp }) => {
    const totp = generateTotp(secretBase32);
    const mfaRes = await app.inject({
      method: "POST",
      url: "/api/login/mfa",
      payload: { mfaToken: login1Body.mfaToken, code: totp }
    });
    assert.equal(mfaRes.statusCode, 200);
    assert.equal(JSON.parse(mfaRes.body).user.id, user.id);
  });
});
