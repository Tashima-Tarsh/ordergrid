import test from "node:test";
import assert from "node:assert/strict";
import { buildDemoApp } from "../src/demo-server.js";

test("demo server fails closed when credentials are not configured", async () => {
  const app = await buildDemoApp({ identifier: "", password: "" });

  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: {
      email: "demo@example.com",
      password: "somepassword123"
    }
  });

  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "invalid_credentials");
  await app.close();
});

test("demo server rejects wrong password", async () => {
  const app = await buildDemoApp({
    identifier: "owner@ordergrid.internal",
    password: "CorrectSecretPassword123!"
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: {
      identifier: "owner@ordergrid.internal",
      password: "WrongPassword"
    }
  });

  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "invalid_credentials");
  await app.close();
});

test("demo server rejects correct password with wrong identifier", async () => {
  const app = await buildDemoApp({
    identifier: "owner@ordergrid.internal",
    password: "CorrectSecretPassword123!"
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: {
      identifier: "intruder@ordergrid.internal",
      password: "CorrectSecretPassword123!"
    }
  });

  assert.equal(res.statusCode, 401);
  const body = JSON.parse(res.body);
  assert.equal(body.error, "invalid_credentials");
  await app.close();
});

test("demo server accepts valid credentials and establishes session", async () => {
  const app = await buildDemoApp({
    identifier: "owner@ordergrid.internal",
    password: "CorrectSecretPassword123!"
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: {
      identifier: "owner@ordergrid.internal",
      password: "CorrectSecretPassword123!"
    }
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.user.role, "OWNER");
  assert.ok(body.workspace.id);

  const cookies = res.cookies;
  const sessionCookie = cookies.find(c => c.name === "demo_session" || c.name === "session");
  assert.ok(sessionCookie, "Expected session cookie to be set");
  await app.close();
});
