import test from "node:test";
import assert from "node:assert/strict";

test("Flipkart OTP text detection matches legitimate verification prompts", () => {
  const isOtpText = (text: string) => /(please enter the verification code|please enter the otp|enter otp|verification code we've sent|resend otp in|enter 6-digit|enter the 6-digit)/i.test(text);

  assert.equal(isOtpText("Please enter the verification code sent to your email"), true);
  assert.equal(isOtpText("Enter the 6-digit OTP sent to 9876543210"), true);
  assert.equal(isOtpText("Resend OTP in 25 seconds"), true);
  assert.equal(isOtpText("Welcome to Flipkart, please log in"), false);
});

test("Flipkart rate limit detection matches throttle messages", () => {
  const isRateLimited = (text: string) => /(try again later|too many attempts|something went wrong|unable to send|maximum attempts reached)/i.test(text);

  assert.equal(isRateLimited("You have reached maximum attempts. Please try again later."), true);
  assert.equal(isRateLimited("Too many attempts. Try after 2 hours."), true);
  assert.equal(isRateLimited("Something went wrong while sending OTP"), true);
  assert.equal(isRateLimited("Enter your password"), false);
});

test("Flipkart new user detection identifies unregistered accounts", () => {
  const isNewUser = (text: string) => /looks like you're new here|sign up with your/i.test(text);

  assert.equal(isNewUser("Looks like you're new here! Sign up with your email to continue"), true);
  assert.equal(isNewUser("Sign up with your mobile number"), true);
  assert.equal(isNewUser("Please enter the OTP"), false);
});

