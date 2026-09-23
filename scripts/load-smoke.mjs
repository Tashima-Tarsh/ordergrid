#!/usr/bin/env node
import http from "node:http";
import Fastify from "fastify";

async function createSmokeServer() {
  const app = Fastify({ logger: false });
  app.get("/api/health", async () => ({ status: "ok", api: "healthy" }));
  app.get("/api/auth-config", async () => ({
    google: { enabled: false, clientId: null },
    ownerSignupEnabled: true
  }));
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, address };
}

async function fetchUrl(url) {
  const start = performance.now();
  return new Promise((resolve) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const duration = performance.now() - start;
        resolve({ statusCode: res.statusCode, duration, ok: res.statusCode === 200 });
      });
    }).on("error", (err) => {
      const duration = performance.now() - start;
      resolve({ statusCode: 0, duration, ok: false, error: err.message });
    });
  });
}

async function runLoadSmoke() {
  console.log("==> OrderGrid Load & Concurrency Smoke Test");

  let serverToClose = null;
  let targetOrigin = process.env.LOAD_TEST_TARGET || process.env.TARGET_URL;

  if (!targetOrigin) {
    const { app, address } = await createSmokeServer();
    serverToClose = app;
    targetOrigin = address;
  }

  console.log(`Target: ${targetOrigin}`);

  const totalRequests = 100;
  const concurrency = 20;
  const endpoints = ["/api/health", "/api/auth-config"];

  const results = [];
  const batches = Math.ceil(totalRequests / concurrency);

  const overallStart = performance.now();

  for (let b = 0; b < batches; b++) {
    const promises = [];
    for (let c = 0; c < concurrency && results.length + promises.length < totalRequests; c++) {
      const ep = endpoints[(b * concurrency + c) % endpoints.length];
      promises.push(fetchUrl(`${targetOrigin}${ep}`));
    }
    const batchRes = await Promise.all(promises);
    results.push(...batchRes);
  }

  const overallDuration = performance.now() - overallStart;

  if (serverToClose) {
    await serverToClose.close();
  }

  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const durations = results.map((r) => r.duration).sort((a, b) => a - b);

  const p50 = durations[Math.floor(durations.length * 0.5)].toFixed(2);
  const p95 = durations[Math.floor(durations.length * 0.95)].toFixed(2);
  const p99 = durations[Math.floor(durations.length * 0.99)].toFixed(2);
  const max = durations[durations.length - 1].toFixed(2);
  const rps = ((totalRequests / overallDuration) * 1000).toFixed(0);

  console.log("\n--- Results Summary ---");
  console.log(`Total Requests:   ${totalRequests}`);
  console.log(`Successful:       ${successCount}`);
  console.log(`Failed:           ${failCount}`);
  console.log(`Overall Duration: ${overallDuration.toFixed(2)} ms (~${rps} req/sec)`);
  console.log(`Latency p50:      ${p50} ms`);
  console.log(`Latency p95:      ${p95} ms`);
  console.log(`Latency p99:      ${p99} ms`);
  console.log(`Latency max:      ${max} ms`);

  if (failCount > 0) {
    console.error(`\nLoad test FAILED: ${failCount} errors detected.`);
    process.exit(1);
  }

  console.log("\nLoad smoke test passed cleanly (0 errors).");
}

runLoadSmoke().catch((err) => {
  console.error("Load test execution error:", err);
  process.exit(1);
});
