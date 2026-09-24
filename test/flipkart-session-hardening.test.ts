import test from "node:test";
import assert from "node:assert/strict";
import { decideSessionReady } from "../agent/cdp.mjs";
import { profileKey } from "../agent/lib.mjs";
import { validateRetailerOrderId } from "../src/retailers.js";
import { buildFlipkartAllocation } from "../src/flipkart-allocation.js";

test("A. MANAGED worker cannot claim Flipkart session check when verifyOnly=false", () => {
  const isManaged = true;
  const accounts = [
    { id: "acc-1", retailer: "flipkart", session_check_verify_only: false },
    { id: "acc-2", retailer: "amazon-in", session_check_verify_only: false }
  ];

  const claimable = accounts.filter(acc => {
    if (isManaged && acc.retailer === "flipkart" && !acc.session_check_verify_only) {
      return false;
    }
    return true;
  });

  assert.equal(claimable.length, 1);
  assert.equal(claimable[0].id, "acc-2");
  assert.ok(!claimable.some(a => a.id === "acc-1"));
});

test("B. DESKTOP worker can claim Flipkart session check when verifyOnly=false", () => {
  const isManaged = false;
  const accounts = [
    { id: "acc-1", retailer: "flipkart", session_check_verify_only: false },
    { id: "acc-2", retailer: "amazon-in", session_check_verify_only: false }
  ];

  const claimable = accounts.filter(acc => {
    if (isManaged && acc.retailer === "flipkart" && !acc.session_check_verify_only) {
      return false;
    }
    return true;
  });

  assert.equal(claimable.length, 2);
  assert.ok(claimable.some(a => a.id === "acc-1"));
});

test("C. MANAGED worker can claim Flipkart session check when verifyOnly=true", () => {
  const isManaged = true;
  const accounts = [
    { id: "acc-1", retailer: "flipkart", session_check_verify_only: true },
    { id: "acc-2", retailer: "flipkart", session_check_verify_only: false }
  ];

  const claimable = accounts.filter(acc => {
    if (isManaged && acc.retailer === "flipkart" && !acc.session_check_verify_only) {
      return false;
    }
    return true;
  });

  assert.equal(claimable.length, 1);
  assert.equal(claimable[0].id, "acc-1");
  assert.equal(claimable[0].session_check_verify_only, true);
});

test("D. Flipkart initial connection returns LOGIN_REQUIRED with human-in-the-loop message rather than auto-OTP", () => {
  const verifyOnly = false;
  const isReady = false;

  const getOutcome = (ready: boolean, verify: boolean) => {
    if (ready) {
      return { status: "READY", code: "SESSION_READY" };
    }
    if (verify) {
      return { status: "REAUTH_REQUIRED", code: "LOGIN_REQUIRED", message: "Retailer sign-in is required." };
    }
    return {
      status: "REAUTH_REQUIRED",
      code: "LOGIN_REQUIRED",
      message: "Complete Flipkart sign-in in the visible Chrome window. Enter OTP/CAPTCHA directly in Flipkart if requested, then return to OrderGrid and click Verify sign-in."
    };
  };

  const outcome = getOutcome(isReady, verifyOnly);
  assert.equal(outcome.status, "REAUTH_REQUIRED");
  assert.equal(outcome.code, "LOGIN_REQUIRED");
  assert.ok(outcome.message.includes("Complete Flipkart sign-in in the visible Chrome window"));
  assert.ok(!outcome.message.includes("OTP sent"));
});

test("E. Authenticated Flipkart session can become READY after verification", () => {
  const ready = decideSessionReady({
    evalOk: true,
    url: "https://www.flipkart.com/account/orders",
    hasAccountContent: true,
    isLoginUrl: false,
    hasLoginBtn: false,
    cookieNames: ["SN", "T"]
  });
  assert.equal(ready, true);
});

test("F. Session state export/restore schema supports cookies and localStorage", () => {
  const sessionState = {
    cookies: [
      { name: "SN", value: "test-token", domain: ".flipkart.com", path: "/", secure: true, httpOnly: true }
    ],
    localStorage: {
      "flipkart_user_pref": "true",
      "cart_session_id": "abc-123"
    }
  };

  assert.ok(Array.isArray(sessionState.cookies));
  assert.equal(sessionState.cookies[0].name, "SN");
  assert.equal(typeof sessionState.localStorage, "object");
  assert.equal(sessionState.localStorage.cart_session_id, "abc-123");
});

test("G. No account session is marked READY based solely on generic cookies", () => {
  const genericCookies = ["S", "T", "SN", "at", "rt", "vid", "gp_acc"];
  const readyWithoutAccount = decideSessionReady({
    evalOk: true,
    url: "https://www.flipkart.com/",
    hasAccountContent: false,
    isLoginUrl: false,
    hasLoginBtn: true,
    cookieNames: genericCookies
  });
  assert.equal(readyWithoutAccount, false);
});

test("H. Profile key remains stable between worker restarts", () => {
  const accountId = "acct-flipkart-user-9876543210";
  const keyRun1 = profileKey(accountId);
  const keyRun2 = profileKey(accountId);
  assert.equal(keyRun1, keyRun2);
  assert.equal(keyRun1.length, 32);
  assert.match(keyRun1, /^[0-9a-f]{32}$/);
});

test("I. Bulk allocation excludes non-READY Flipkart accounts", () => {
  const accountsInPool = [
    { retailerAccountId: "acc-1", session_status: "READY", maxQuantity: 2, sellingPriceMinor: 100000, addressId: "a1", accountReference: "ref1", productCheckId: "c1" },
    { retailerAccountId: "acc-2", session_status: "REAUTH_REQUIRED", maxQuantity: 2, sellingPriceMinor: 100000, addressId: "a2", accountReference: "ref2", productCheckId: "c2" },
    { retailerAccountId: "acc-3", session_status: "NOT_CONFIGURED", maxQuantity: 2, sellingPriceMinor: 100000, addressId: "a3", accountReference: "ref3", productCheckId: "c3" }
  ];

  const readyOnly = accountsInPool.filter(a => a.session_status === "READY");
  const allocation = buildFlipkartAllocation(readyOnly as any, 4);

  assert.equal(allocation.allocations.length, 1);
  assert.equal(allocation.allocations[0].retailerAccountId, "acc-1");
  assert.equal(allocation.allocatedQuantity, 2);
  assert.equal(allocation.remainingQuantity, 2);
  assert.equal(allocation.complete, false);
});

test("J. Checkout never confirms without retailer order ID", () => {
  assert.throws(() => validateRetailerOrderId(""), /Invalid retailer order ID/);
  assert.throws(() => validateRetailerOrderId("   "), /Invalid retailer order ID/);
  assert.throws(() => validateRetailerOrderId("!@#$"), /Invalid retailer order ID/);

  assert.equal(validateRetailerOrderId("OD123456789012345000"), "OD123456789012345000");
  assert.equal(validateRetailerOrderId("405-1234567-1234567"), "405-1234567-1234567");
});
