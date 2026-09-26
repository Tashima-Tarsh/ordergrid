import test from "node:test";
import assert from "node:assert/strict";
import { classifyLoginOutcome, decideSessionReady } from "../agent/cdp.mjs";
import { computeOtpCooldown } from "../src/security.js";

test("classifyLoginOutcome correctly classifies login states", () => {
  // 1. OTP screen
  const otp1 = classifyLoginOutcome({ text: "Please enter the verification code sent to your email" });
  assert.equal(otp1.outcome, "OTP_SENT");
  assert.equal(otp1.code, "OTP_SENT");

  const otp2 = classifyLoginOutcome({ text: "Enter code", digitsCount: 6 });
  assert.equal(otp2.outcome, "OTP_CHALLENGE_VISIBLE");
  assert.equal(otp2.code, "OTP_SEND_UNCONFIRMED");

  const otp3 = classifyLoginOutcome({ text: "", hasOtpInput: true });
  assert.equal(otp3.outcome, "OTP_CHALLENGE_VISIBLE");
  assert.equal(otp3.code, "OTP_SEND_UNCONFIRMED");

  // 2. Rate limit
  const rl = classifyLoginOutcome({ text: "You have reached maximum attempts. Please try again later." });
  assert.equal(rl.outcome, "RATE_LIMITED");
  assert.equal(rl.code, "RATE_LIMITED");

  // 3. New user / unregistered
  const nu = classifyLoginOutcome({ text: "Looks like you're new here! Sign up with your email" });
  assert.equal(nu.outcome, "ACCOUNT_NOT_REGISTERED");
  assert.equal(nu.code, "ACCOUNT_NOT_REGISTERED");

  // 4. Unknown / OTP not sent
  const unk = classifyLoginOutcome({ text: "Welcome to Flipkart homepage" });
  assert.equal(unk.outcome, "UNKNOWN");
  assert.equal(unk.code, "OTP_NOT_SENT");
});

test("decideSessionReady enforces evaluation, URL, and account content rules", () => {
  // Null evaluation or evalOk=false -> false
  assert.equal(decideSessionReady({ evalOk: false, url: "https://www.flipkart.com/", hasAccountContent: true }), false);

  // Login / signin URL -> false
  assert.equal(decideSessionReady({ evalOk: true, url: "https://www.flipkart.com/account/login", hasAccountContent: true, isLoginUrl: true }), false);
  assert.equal(decideSessionReady({ evalOk: true, url: "https://www.amazon.in/ap/signin", hasAccountContent: true }), false);

  // Generic cookies alone without account content -> false
  assert.equal(decideSessionReady({ evalOk: true, url: "https://www.flipkart.com/", hasAccountContent: false, cookieNames: ["S", "T", "SN", "at", "rt"] }), false);

  // Valid authenticated account page -> true
  assert.equal(decideSessionReady({ evalOk: true, url: "https://www.flipkart.com/account/orders", hasAccountContent: true, cookieNames: ["SN"] }), true);
});

test("computeOtpCooldown computes correct timestamps for all session result codes", () => {
  const config = { OTP_MIN_INTERVAL_MINUTES: 30, OTP_RATE_LIMIT_COOLDOWN_HOURS: 6 };
  const baseTime = new Date("2026-09-24T00:00:00.000Z");

  // READY clears cooldown
  const readyCooldown = computeOtpCooldown("READY", null, config, baseTime, new Date("2026-09-24T01:00:00.000Z"));
  assert.equal(readyCooldown, null);

  // OTP_SENT sets 30-minute cooldown
  const sentCooldown = computeOtpCooldown("REAUTH_REQUIRED", "OTP_SENT", config, baseTime);
  assert.equal(sentCooldown?.toISOString(), "2026-09-24T00:30:00.000Z");

  // RATE_LIMITED sets 6-hour cooldown
  const rateLimitedCooldown = computeOtpCooldown("REAUTH_REQUIRED", "RATE_LIMITED", config, baseTime);
  assert.equal(rateLimitedCooldown?.toISOString(), "2026-09-24T06:00:00.000Z");

  // OTP_NOT_SENT retains existing cooldown if set
  const existing = new Date("2026-09-24T00:25:00.000Z");
  const notSentCooldown = computeOtpCooldown("REAUTH_REQUIRED", "OTP_NOT_SENT", config, baseTime, existing);
  assert.equal(notSentCooldown?.toISOString(), existing.toISOString());
});
