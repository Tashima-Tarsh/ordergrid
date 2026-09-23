import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationApp, createMockDb } from "./helpers.js";
import { generateTotp, hashPassword, tokenHash } from "../../src/security.js";

test("Integration: Full Login Throttle & Lockout Lifecycle", async () => {
  const { db, store } = createMockDb();
  const passwordHash = await hashPassword("ValidPassword12345!");
  const user = {
    id: "user-1111-1111-1111-1111",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    email: "operator@ordergrid.internal",
    username: "operator",
    role: "BUYER",
    active: true,
    password_hash: passwordHash,
    mfa_enabled: false
  };
  store.users.set(user.id, user);

  const app = await createIntegrationApp(db);

  // 1-4: Failed attempts
  for (let i = 1; i <= 4; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { identifier: user.email, password: "WrongPassword!" }
    });
    assert.equal(res.statusCode, 401);
  }

  // 5th failed attempt -> locks account
  const res5 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "WrongPassword!" }
  });
  assert.equal(res5.statusCode, 401);

  // 6th attempt (even with CORRECT password) -> blocked by 429 lockout BEFORE checking password
  const res6 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "ValidPassword12345!" }
  });
  assert.equal(res6.statusCode, 429);
  const body6 = JSON.parse(res6.body);
  assert.equal(body6.error, "too_many_attempts");
  assert.ok(res6.headers["retry-after"]);

  // Unlock account (simulate scripts/unlock-account.mjs)
  const idHash = tokenHash(user.email.toLowerCase());
  store.login_throttle.delete(idHash);

  // Now valid login succeeds
  const resSuccess = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "ValidPassword12345!" }
  });
  assert.equal(resSuccess.statusCode, 200);
  const successBody = JSON.parse(resSuccess.body);
  assert.equal(successBody.user.id, user.id);
});

test("Integration: TOTP MFA Lifecycle and Recovery Codes", async () => {
  const { db, store } = createMockDb();
  const passwordHash = await hashPassword("OwnerPassword12345!");
  const user = {
    id: "owner-2222-2222-2222-2222",
    tenant_id: "00000000-0000-0000-0000-000000000001",
    email: "owner@ordergrid.internal",
    username: "owner",
    role: "OWNER",
    active: true,
    password_hash: passwordHash,
    mfa_enabled: false
  };
  store.users.set(user.id, user);

  const app = await createIntegrationApp(db);

  // Step 1: Initial login (MFA not yet enabled)
  const login1 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "OwnerPassword12345!" }
  });
  assert.equal(login1.statusCode, 200);
  const sessionToken = login1.cookies.find(c => c.name === "session")?.value;
  assert.ok(sessionToken);
  const authHeaders = { cookie: `session=${sessionToken}` };

  // Step 2: Attempt to access protected dashboard -> blocked by 403 mfa_enrollment_required
  const dash1 = await app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: authHeaders
  });
  assert.equal(dash1.statusCode, 403);
  assert.equal(JSON.parse(dash1.body).error, "mfa_enrollment_required");

  // Step 3: Start MFA enrollment
  const enrollStart = await app.inject({
    method: "POST",
    url: "/api/mfa/enroll/start",
    headers: authHeaders
  });
  assert.equal(enrollStart.statusCode, 200);
  const { secret, enrollmentToken } = JSON.parse(enrollStart.body);
  assert.ok(secret && enrollmentToken);

  // Step 4: Verify MFA enrollment with valid TOTP
  const totpCode = generateTotp(secret);
  const enrollVerify = await app.inject({
    method: "POST",
    url: "/api/mfa/enroll/verify",
    headers: authHeaders,
    payload: { enrollmentToken, code: totpCode }
  });
  assert.equal(enrollVerify.statusCode, 200);
  const { recoveryCodes } = JSON.parse(enrollVerify.body);
  assert.equal(recoveryCodes.length, 10);

  // Step 5: Dashboard access now succeeds
  const dash2 = await app.inject({
    method: "GET",
    url: "/api/dashboard",
    headers: authHeaders
  });
  assert.equal(dash2.statusCode, 200);

  // Step 6: Next login requires MFA
  const login2 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "OwnerPassword12345!" }
  });
  assert.equal(login2.statusCode, 200);
  const login2Body = JSON.parse(login2.body);
  assert.equal(login2Body.mfaRequired, true);
  assert.ok(login2Body.mfaToken);

  // Step 7: Complete login using a single-use recovery code
  const chosenRecoveryCode = recoveryCodes[0];
  const mfaLogin = await app.inject({
    method: "POST",
    url: "/api/login/mfa",
    payload: { mfaToken: login2Body.mfaToken, code: chosenRecoveryCode }
  });
  assert.equal(mfaLogin.statusCode, 200);
  const mfaLoginBody = JSON.parse(mfaLogin.body);
  assert.equal(mfaLoginBody.user.id, user.id);
  assert.equal(mfaLoginBody.user.recoveryCodeUsed, true);

  // Step 8: Reusing the same recovery code is rejected
  const login3 = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { identifier: user.email, password: "OwnerPassword12345!" }
  });
  const login3Body = JSON.parse(login3.body);

  const mfaReuse = await app.inject({
    method: "POST",
    url: "/api/login/mfa",
    payload: { mfaToken: login3Body.mfaToken, code: chosenRecoveryCode }
  });
  assert.equal(mfaReuse.statusCode, 401);
});
