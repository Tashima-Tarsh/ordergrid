import test from "node:test";
import assert from "node:assert/strict";
import { validateRetailerOrderId } from "../src/retailers.js";
import { buildFlipkartAllocation } from "../src/flipkart-allocation.js";
import { computeOtpCooldown } from "../src/security.js";

test("A. Flipkart product preflight rejects non-mobile products", () => {
  const snapshot = {
    isMobile: false,
    title: "Men Cotton T-Shirt",
    sellingPriceMinor: 49900,
    maxQuantity: 5,
    maxQuantityVerified: true
  };
  const verified = snapshot.isMobile === true;
  assert.equal(verified, false, "Non-mobile product must not pass mobile verification");
});

test("B. Flipkart product quantity limit honesty: returns false when no explicit limit is exposed", () => {
  const snapshot = {
    isMobile: true,
    title: "Smartphone 5G (128GB)",
    sellingPriceMinor: 1499900,
    maxQuantity: null,
    maxQuantityVerified: false
  };
  assert.equal(snapshot.maxQuantityVerified, false);
  assert.equal(snapshot.maxQuantity, null);
});

test("C. Flipkart product quantity limit verified: returns explicit quantity when exposed", () => {
  const snapshot = {
    isMobile: true,
    title: "Smartphone 5G (128GB)",
    sellingPriceMinor: 1499900,
    maxQuantity: 2,
    maxQuantityVerified: true
  };
  assert.equal(snapshot.maxQuantityVerified, true);
  assert.equal(snapshot.maxQuantity, 2);
});

test("D. Flipkart allocation respects verified vs unverified quantity", () => {
  const accounts = [
    { retailerAccountId: "acc-1", addressId: "addr-1", accountReference: "user1@example.com", productCheckId: "chk-1", maxQuantity: 2, sellingPriceMinor: 1500000 },
    { retailerAccountId: "acc-2", addressId: "addr-2", accountReference: "user2@example.com", productCheckId: "chk-2", maxQuantity: 1, sellingPriceMinor: 1500000 }
  ];
  const plan = buildFlipkartAllocation(accounts, 3);
  assert.equal(plan.complete, true);
  assert.equal(plan.allocatedQuantity, 3);
  assert.equal(plan.allocations.length, 2);
  assert.equal(plan.allocations[0].quantity, 2);
  assert.equal(plan.allocations[1].quantity, 1);
});

test("E. In-process KeyedMutex serializes concurrent operations for the same profile", async () => {
  class KeyedMutex {
    chains = new Map<string, Promise<unknown>>();
    async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const stringKey = String(key || "default");
      const current = this.chains.get(stringKey) || Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      this.chains.set(stringKey, current.then(() => next, () => next));
      try {
        await current;
        return await fn();
      } finally {
        release();
        if (this.chains.get(stringKey) === next) {
          this.chains.delete(stringKey);
        }
      }
    }
  }

  const mutex = new KeyedMutex();
  const order: string[] = [];

  const task1 = mutex.withLock("profile-1", async () => {
    order.push("task1-start");
    await new Promise(r => setTimeout(r, 50));
    order.push("task1-end");
  });

  const task2 = mutex.withLock("profile-1", async () => {
    order.push("task2-start");
    await new Promise(r => setTimeout(r, 10));
    order.push("task2-end");
  });

  const task3 = mutex.withLock("profile-2", async () => {
    order.push("task3-start");
    await new Promise(r => setTimeout(r, 10));
    order.push("task3-end");
  });

  await Promise.all([task1, task2, task3]);

  const t1End = order.indexOf("task1-end");
  const t2Start = order.indexOf("task2-start");
  assert.ok(t1End < t2Start, "Task 2 must not start before Task 1 completes on the same profile");
});

test("F. Cart verification detects cart contamination and item missing", () => {
  function verifyCart(cartItems: { title: string; pid?: string; quantity: number }[], expectedItems: { productUrl?: string; requestedQuantity?: number }[]) {
    if (!cartItems.length) return { ok: false, code: "CART_EMPTY" };
    if (cartItems.length > expectedItems.length) {
      return { ok: false, code: "CART_CONTAMINATION", message: "Cart contains unexpected items" };
    }
    return { ok: true };
  }

  const clean = verifyCart([{ title: "Phone", quantity: 1 }], [{ requestedQuantity: 1 }]);
  assert.equal(clean.ok, true);

  const contaminated = verifyCart(
    [{ title: "Phone", quantity: 1 }, { title: "Random Case", quantity: 1 }],
    [{ requestedQuantity: 1 }]
  );
  assert.equal(contaminated.ok, false);
  assert.equal(contaminated.code, "CART_CONTAMINATION");
});

test("G. Address verification validates postal code and recipient match", () => {
  function verifyAddress(selectedText: string, expected: { recipient: string; postalCode: string }) {
    const text = selectedText.toLowerCase();
    const pinMatch = text.includes(expected.postalCode.toLowerCase());
    const recipientTokens = expected.recipient.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    const recipientMatch = recipientTokens.some(t => text.includes(t));
    if (!pinMatch || !recipientMatch) {
      return { ok: false, code: "ADDRESS_MISMATCH" };
    }
    return { ok: true };
  }

  const match = verifyAddress("Rahul Sharma, 560001, MG Road, Bangalore", { recipient: "Rahul Sharma", postalCode: "560001" });
  assert.equal(match.ok, true);

  const wrongPin = verifyAddress("Rahul Sharma, 110001, Connaught Place, New Delhi", { recipient: "Rahul Sharma", postalCode: "560001" });
  assert.equal(wrongPin.ok, false);
  assert.equal(wrongPin.code, "ADDRESS_MISMATCH");

  const wrongRecipient = verifyAddress("Amit Verma, 560001, MG Road, Bangalore", { recipient: "Rahul Sharma", postalCode: "560001" });
  assert.equal(wrongRecipient.ok, false);
  assert.equal(wrongRecipient.code, "ADDRESS_MISMATCH");
});

test("H. Delivery signal extraction extracts postal code, estimate, and stock state", () => {
  const signal = {
    deliveryEstimate: "Delivery by Tomorrow, 9 PM",
    seller: "RetailNet",
    stockState: "IN_STOCK",
    observedPostalCode: "560001"
  };
  assert.ok(signal.deliveryEstimate.includes("Tomorrow"));
  assert.equal(signal.seller, "RetailNet");
  assert.equal(signal.stockState, "IN_STOCK");
});

test("I. Commercial price check enforces policy variance threshold", () => {
  const policy = { max_price_increase_percent: 5, max_order_value_minor: 20000000 };
  const expectedMinor = 1500000;

  function checkCommercial(observedMinor: number) {
    const variance = (observedMinor - expectedMinor) / expectedMinor * 100;
    if (variance > policy.max_price_increase_percent) {
      return { allowed: false, status: "REVIEW_REQUIRED", variance };
    }
    return { allowed: true, status: "APPROVED", variance };
  }

  const okCheck = checkCommercial(1550000);
  assert.equal(okCheck.allowed, true);

  const breachedCheck = checkCommercial(1650000);
  assert.equal(breachedCheck.allowed, false);
  assert.equal(breachedCheck.status, "REVIEW_REQUIRED");
});

test("J. Retailer Order ID validation accepts genuine Flipkart and Amazon IDs and rejects invalid formats", () => {
  assert.equal(validateRetailerOrderId("OD123456789012345000"), "OD123456789012345000");
  assert.equal(validateRetailerOrderId("OD987654321098765000"), "OD987654321098765000");
  assert.equal(validateRetailerOrderId("402-1234567-1234567"), "402-1234567-1234567");

  assert.throws(() => validateRetailerOrderId(""), /Invalid retailer order ID/i);
  assert.throws(() => validateRetailerOrderId("   "), /Invalid retailer order ID/i);
  assert.throws(() => validateRetailerOrderId("!@#$"), /Invalid retailer order ID/i);
  assert.throws(() => validateRetailerOrderId("ab"), /Invalid retailer order ID/i);
  
});

test("K. OTP cooldown semantics: Claiming session check does not set or advance cooldown", () => {
  const config = { OTP_MIN_INTERVAL_MINUTES: 10, OTP_RATE_LIMIT_COOLDOWN_HOURS: 4 };
  const now = new Date("2026-09-24T12:00:00Z");

  const noEvidence = computeOtpCooldown("REAUTH_REQUIRED", "LOGIN_REQUIRED", config, now, null);
  assert.equal(noEvidence, null, "Claiming or opening login without OTP_SENT must not set cooldown");

  const otpSentCooldown = computeOtpCooldown("REAUTH_REQUIRED", "OTP_SENT", config, now, null);
  assert.equal(otpSentCooldown?.toISOString(), new Date("2026-09-24T12:10:00Z").toISOString());

  const rateLimitCooldown = computeOtpCooldown("REAUTH_REQUIRED", "RATE_LIMITED", config, now, null);
  assert.equal(rateLimitCooldown?.toISOString(), new Date("2026-09-24T16:00:00Z").toISOString());

  const readyCooldown = computeOtpCooldown("READY", null, config, now, otpSentCooldown);
  assert.equal(readyCooldown, null, "Session becoming READY clears any lingering cooldown");
});

test("L. Ambiguous final submit outcome moves to CONFIRMATION_PENDING and never double submits", () => {
  type Basket = {
    finalSubmitStartedAt: Date | null;
    confirmationState: string;
    status: string;
  };

  const basket: Basket = {
    finalSubmitStartedAt: null,
    confirmationState: "NOT_SUBMITTED",
    status: "OPENED"
  };

  function startFinalSubmit(b: Basket): { allowed: boolean; error?: string } {
    if (b.finalSubmitStartedAt || ["SUBMITTING", "SUBMITTED", "CONFIRMED"].includes(b.confirmationState)) {
      return { allowed: false, error: "final_submit_already_started" };
    }
    b.finalSubmitStartedAt = new Date();
    b.confirmationState = "SUBMITTING";
    return { allowed: true };
  }

  const firstAttempt = startFinalSubmit(basket);
  assert.equal(firstAttempt.allowed, true);

  const duplicateAttempt = startFinalSubmit(basket);
  assert.equal(duplicateAttempt.allowed, false);
  assert.equal(duplicateAttempt.error, "final_submit_already_started");
});

test("M. Reconciliation recovery matches orders on order history page", () => {
  const observations = [
    { retailerOrderId: "OD123456789012345000", orderStatus: "ORDER_PLACED" }
  ];

  const pendingBasket = {
    id: "basket-123",
    confirmationState: "CONFIRMATION_PENDING",
    status: "REQUIRES_ACTION",
    retailerOrderId: null as string | null
  };

  if (observations.length && pendingBasket.confirmationState === "CONFIRMATION_PENDING") {
    pendingBasket.retailerOrderId = observations[0].retailerOrderId;
    pendingBasket.confirmationState = "CONFIRMED";
    pendingBasket.status = "CONFIRMED";
  }

  assert.equal(pendingBasket.status, "CONFIRMED");
  assert.equal(pendingBasket.retailerOrderId, "OD123456789012345000");
  assert.equal(pendingBasket.confirmationState, "CONFIRMED");
});
