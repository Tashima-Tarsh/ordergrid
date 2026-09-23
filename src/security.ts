import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [, s, k] = encoded.split(":");
  if (!s || !k) return false;
  const actual = (await scrypt(password, Buffer.from(s, "base64"), 64)) as Buffer;
  const expected = Buffer.from(k, "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Dummy password verification for unknown identifiers to prevent timing-based user enumeration
const DUMMY_SCRYPT_SALT = Buffer.from("dummySaltForOrderGridUserEnumerationProtection==", "base64").subarray(0, 16);
let cachedDummyExpected: Buffer | null = null;
export async function dummyVerifyPassword(password: string): Promise<boolean> {
  if (!cachedDummyExpected) {
    cachedDummyExpected = (await scrypt("DummyPasswordForTimingNormalization123!", DUMMY_SCRYPT_SALT, 64)) as Buffer;
  }
  const actual = (await scrypt(password, DUMMY_SCRYPT_SALT, 64)) as Buffer;
  return actual.length === cachedDummyExpected.length && timingSafeEqual(actual, cachedDummyExpected) && false;
}

export function encryptJson(value: object, keyB64: string) {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptJson(parts: { ciphertext: Buffer; iv: Buffer; authTag: Buffer }, keyB64: string) {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), parts.iv);
  d.setAuthTag(parts.authTag);
  return JSON.parse(Buffer.concat([d.update(parts.ciphertext), d.final()]).toString("utf8"));
}

export function computeOtpCooldown(
  status: "READY" | "REAUTH_REQUIRED" | "ERROR",
  code: string | null | undefined,
  config: { OTP_MIN_INTERVAL_MINUTES: number; OTP_RATE_LIMIT_COOLDOWN_HOURS: number },
  now: Date = new Date(),
  currentCooldown: Date | null = null
): Date | null {
  if (status === "READY") return null;
  if (code === "RATE_LIMITED") {
    return new Date(now.getTime() + config.OTP_RATE_LIMIT_COOLDOWN_HOURS * 3600 * 1000);
  }
  if (code === "OTP_SENT") {
    return new Date(now.getTime() + config.OTP_MIN_INTERVAL_MINUTES * 60 * 1000);
  }
  return currentCooldown;
}

// ------------------------------------------------------------------------------------------------
// Section 1: Lockout Timing Math & TOTP MFA (RFC 6238 / RFC 4226)
// ------------------------------------------------------------------------------------------------

/**
 * Computes lockout duration in seconds.
 * 1st lock: 15 min (900s). Each further lock doubles (30m, 60m, 120m, 240m max), capped at 4 hours.
 */
export function computeLockoutDurationSeconds(lockCount: number): number {
  const count = Math.max(1, Math.floor(lockCount));
  const baseMinutes = 15;
  const multiplier = Math.pow(2, count - 1);
  const minutes = Math.min(240, baseMinutes * multiplier);
  return minutes * 60;
}

// Base32 Alphabet RFC 4648
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | (buffer[i] ?? 0);
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i]!;
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(numBytes = 20): { secretBase32: string; secretBuffer: Buffer } {
  const secretBuffer = randomBytes(numBytes);
  const secretBase32 = base32Encode(secretBuffer);
  return { secretBase32, secretBuffer };
}

export function generateTotp(
  secret: string | Buffer,
  options?: { timestampMs?: number; stepSeconds?: number; digits?: number }
): string {
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const stepSeconds = options?.stepSeconds ?? 30;
  const digits = options?.digits ?? 6;
  const timestampMs = options?.timestampMs ?? Date.now();
  const step = Math.floor(timestampMs / 1000 / stepSeconds);

  return generateHotp(key, step, digits);
}

export function generateHotp(key: Buffer, counter: number | bigint, digits = 6): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = createHmac("sha1", key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const b0 = hmac[offset] ?? 0;
  const b1 = hmac[offset + 1] ?? 0;
  const b2 = hmac[offset + 2] ?? 0;
  const b3 = hmac[offset + 3] ?? 0;

  const codeInt =
    ((b0 & 0x7f) << 24) |
    (b1 << 16) |
    (b2 << 8) |
    b3;

  const mod = 10 ** digits;
  const code = (codeInt % mod).toString().padStart(digits, "0");
  return code;
}

export function verifyTotp(
  code: string,
  secret: string | Buffer,
  options?: {
    timestampMs?: number;
    stepSeconds?: number;
    digits?: number;
    window?: number;
    lastUsedStep?: number | bigint | null;
  }
): { valid: boolean; step: bigint } {
  const normalizedCode = code.replace(/\s+/g, "");
  if (!/^\d{6,8}$/.test(normalizedCode)) {
    return { valid: false, step: 0n };
  }

  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const stepSeconds = options?.stepSeconds ?? 30;
  const digits = options?.digits ?? 6;
  const timestampMs = options?.timestampMs ?? Date.now();
  const window = options?.window ?? 1;
  const lastUsedStep = options?.lastUsedStep != null ? BigInt(options.lastUsedStep) : null;

  const currentStep = BigInt(Math.floor(timestampMs / 1000 / stepSeconds));
  const codeBuf = Buffer.from(normalizedCode);

  for (let w = -window; w <= window; w++) {
    const stepToCheck = currentStep + BigInt(w);
    if (stepToCheck < 0n) continue;

    // Replay protection: Reject if step has already been used
    if (lastUsedStep != null && stepToCheck <= lastUsedStep) {
      continue;
    }

    const expectedCode = generateHotp(key, stepToCheck, digits);
    const expectedBuf = Buffer.from(expectedCode);

    if (codeBuf.length === expectedBuf.length && timingSafeEqual(codeBuf, expectedBuf)) {
      return { valid: true, step: stepToCheck };
    }
  }

  return { valid: false, step: 0n };
}

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const part1 = randomBytes(3).toString("hex").toUpperCase();
    const part2 = randomBytes(3).toString("hex").toUpperCase();
    codes.push(`${part1}-${part2}`);
  }
  return codes;
}

export function createSignedMfaToken(payload: object, secret: string): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json).toString("base64url");
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifySignedMfaToken<T = any>(token: string, secret: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const data = parts[0]!;
  const sig = parts[1]!;
  const expectedSig = createHmac("sha256", secret).update(data).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (parsed.expiresAt && Number(parsed.expiresAt) < Date.now()) {
      return null;
    }
    return parsed as T;
  } catch {
    return null;
  }
}
