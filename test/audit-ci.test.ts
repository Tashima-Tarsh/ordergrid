import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { classifyAuditResult } from "../scripts/audit-ci.mjs";

test("CI audit distinguishes clean, vulnerable and registry outage results", () => {
  assert.equal(classifyAuditResult({ status: 0, stdout: "{}", stderr: "" }), "clean");
  assert.equal(classifyAuditResult({
    status: 1,
    stdout: JSON.stringify({ metadata: { vulnerabilities: { high: 1 } } }),
    stderr: ""
  }), "vulnerable");
  assert.equal(classifyAuditResult({
    status: 1,
    stdout: JSON.stringify({ error: "Service unavailable" }),
    stderr: "503 Service Unavailable"
  }), "service-error");
});

test("CI audit does not hide unknown command failures", () => {
  assert.equal(classifyAuditResult({ status: 1, stdout: "", stderr: "unexpected failure" }), "failed");
});
