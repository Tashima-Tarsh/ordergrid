import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { allowedHandoff, profileKey } from "../agent/lib.mjs";

test("operator companion accepts supported HTTPS retailers", () => {
  assert.equal(allowedHandoff("https://www.amazon.in/dp/B000000000"), true);
  assert.equal(allowedHandoff("https://www.flipkart.com/item/p/abc"), true);
  assert.equal(allowedHandoff("https://shop.example/products/widget"), true);
});

test("operator companion rejects lookalikes and credential URLs", () => {
  assert.equal(allowedHandoff("https://amazon.in.evil.example/item"), false);
  assert.equal(allowedHandoff("http://amazon.in/item"), false);
  assert.equal(allowedHandoff("https://user:pass@flipkart.com/item"), false);
});

test("profile keys are stable and do not expose the reference", () => {
  const key = profileKey("customer@example.com");
  assert.equal(key, profileKey("customer@example.com"));
  assert.equal(key.length, 32);
  assert.equal(key.includes("customer"), false);
});
