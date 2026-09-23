import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";

test("rate-limit error response format and Retry-After header", async () => {
  const app = Fastify();

  await app.register(rateLimit, {
    max: 2,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: "Rate limit exceeded. Please try again later.",
      retryAfterSeconds: Math.ceil(context.ttl / 1000)
    })
  });

  app.setErrorHandler((error: any, req, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : error instanceof z.ZodError
        ? 400
        : 500;

    if (statusCode < 500) {
      if (typeof error.errorResponseBuilder === "function" || error.error === "rate_limited" || statusCode === 429) {
        if (typeof error.retryAfterSeconds === "number") {
          reply.header("Retry-After", error.retryAfterSeconds.toString());
        }
        return reply.code(429).send({
          error: "rate_limited",
          message: error.message || "Rate limit exceeded. Please try again later.",
          ...(typeof error.retryAfterSeconds === "number" ? { retryAfterSeconds: error.retryAfterSeconds } : {})
        });
      }
      return reply.code(statusCode).send({
        error: error.code || error.error || "client_error",
        message: error.message || "Bad Request"
      });
    }

    return reply.code(500).send({
      error: "internal_error",
      requestId: req.id,
      message: "An internal server error occurred"
    });
  });

  app.get("/test", async () => ({ ok: true }));

  // 1st request -> 200
  const res1 = await app.inject({ method: "GET", url: "/test" });
  assert.equal(res1.statusCode, 200);

  // 2nd request -> 200
  const res2 = await app.inject({ method: "GET", url: "/test" });
  assert.equal(res2.statusCode, 200);

  // 3rd request -> 429
  const res3 = await app.inject({ method: "GET", url: "/test" });
  assert.equal(res3.statusCode, 429);
  const body3 = JSON.parse(res3.body);
  assert.equal(body3.error, "rate_limited");
  assert.ok(typeof body3.retryAfterSeconds === "number" && body3.retryAfterSeconds > 0);
  assert.ok(res3.headers["retry-after"]);
});

test("errorHandler preserves 400 validation errors and 500 internal errors", async () => {
  const app = Fastify();

  app.setErrorHandler((error: any, req, reply) => {
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : error instanceof z.ZodError
        ? 400
        : 500;

    if (statusCode < 500) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          error: "invalid_request",
          issues: error.issues,
          message: error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")
        });
      }
      return reply.code(statusCode).send({
        error: error.code || error.error || "client_error",
        message: error.message || "Bad Request"
      });
    }

    return reply.code(500).send({
      error: "internal_error",
      requestId: req.id,
      message: "An internal server error occurred"
    });
  });

  const schema = z.object({ email: z.string().email() });

  app.post("/validate", async (req) => {
    const parsed = schema.parse(req.body);
    return { email: parsed.email };
  });

  app.get("/explode", async () => {
    throw new Error("Database connection lost");
  });

  // Invalid payload -> 400 invalid_request
  const badRes = await app.inject({
    method: "POST",
    url: "/validate",
    payload: { email: "not-an-email" }
  });
  assert.equal(badRes.statusCode, 400);
  const badBody = JSON.parse(badRes.body);
  assert.equal(badBody.error, "invalid_request");

  // Server error -> 500 internal_error
  const errRes = await app.inject({
    method: "GET",
    url: "/explode"
  });
  assert.equal(errRes.statusCode, 500);
  const errBody = JSON.parse(errRes.body);
  assert.equal(errBody.error, "internal_error");
  assert.equal(errBody.message, "An internal server error occurred");
});
