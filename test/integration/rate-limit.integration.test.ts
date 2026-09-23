import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationApp, createMockDb } from "./helpers.js";

test("Integration: Signup Route Rate Limiting (5 requests OK, 6th rate-limited)", async () => {
  const { db } = createMockDb();
  const app = await createIntegrationApp(db);

  for (let i = 1; i <= 5; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/api/signup",
      payload: {
        email: `owner_${i}@ordergrid.internal`,
        password: "ValidPassword12345!",
        setupCode: "valid_signup_code_123"
      }
    });
    assert.equal(res.statusCode, 200);
  }

  // 6th request -> Rate limited (429)
  const res6 = await app.inject({
    method: "POST",
    url: "/api/signup",
    payload: {
      email: "owner_6@ordergrid.internal",
      password: "ValidPassword12345!",
      setupCode: "valid_signup_code_123"
    }
  });

  assert.equal(res6.statusCode, 429);
  const body6 = JSON.parse(res6.body);
  assert.equal(body6.error, "rate_limited");
  assert.ok(typeof body6.retryAfterSeconds === "number" && body6.retryAfterSeconds > 0);
  assert.ok(res6.headers["retry-after"]);
});
