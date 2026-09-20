import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { allowedRetailerUrl, profileKey } from "../agent/lib.mjs";
// @ts-expect-error JavaScript module intentionally has no declaration file.
import { cartUrlFor } from "../agent/cdp.mjs";

test("OrderGrid worker accepts supported HTTPS retailers", () => {
  assert.equal(allowedRetailerUrl("https://www.amazon.in/dp/B000000000"), true);
  assert.equal(allowedRetailerUrl("https://www.flipkart.com/item/p/abc"), true);
  assert.equal(allowedRetailerUrl("https://shop.example/products/widget"), true);
  assert.equal(allowedRetailerUrl("https://merchant.example/item/device"), true);
});

test("OrderGrid worker rejects lookalikes and credential URLs", () => {
  assert.equal(allowedRetailerUrl("https://amazon.in.evil.example/item"), false);
  assert.equal(allowedRetailerUrl("http://amazon.in/item"), false);
  assert.equal(allowedRetailerUrl("https://user:pass@flipkart.com/item"), false);
  assert.equal(allowedRetailerUrl("https://localhost/item"), false);
  assert.equal(allowedRetailerUrl("https://127.0.0.1/item"), false);
});

test("profile keys are stable and do not expose the reference", () => {
  const key = profileKey("customer@example.com");
  assert.equal(key, profileKey("customer@example.com"));
  assert.equal(key.length, 32);
  assert.equal(key.includes("customer"), false);
});


test("bulk worker opens the correct retailer cart for grouped baskets", () => {
  assert.equal(cartUrlFor("amazon-in", "https://www.amazon.in/dp/B000000000"), "https://www.amazon.in/gp/cart/view.html");
  assert.equal(cartUrlFor("flipkart", "https://www.flipkart.com/item/p/abc"), "https://www.flipkart.com/viewcart");
  assert.equal(cartUrlFor("store:shop.example", "https://shop.example/products/widget"), "https://shop.example/cart");
});
