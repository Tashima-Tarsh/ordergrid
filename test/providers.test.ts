import test from "node:test";
import assert from "node:assert/strict";
import { ControlledRetailerProvider, ShopifyProvider } from "../src/providers.js";

test("retailer detection does not accept lookalike Amazon hosts", () => {
  const amazon = new ControlledRetailerProvider(/(^|\.)amazon\.in$/);
  assert.equal(amazon.supports("https://www.amazon.in/dp/ABC"), true);
  assert.equal(amazon.supports("https://amazon.in.attacker.example/item"), false);
});

test("Shopify provider accepts product paths and rejects malformed URLs", () => {
  const shopify = new ShopifyProvider();
  assert.equal(shopify.supports("https://merchant.example/products/device"), true);
  assert.equal(shopify.supports("not-a-url"), false);
});
