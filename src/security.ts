import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCb);

export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export async function hashPassword(password: string) { const salt=randomBytes(16); const key=await scrypt(password,salt,64) as Buffer; return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`; }
export async function verifyPassword(password:string, encoded:string) { const [,s,k]=encoded.split(":"); if(!s||!k)return false; const actual=await scrypt(password,Buffer.from(s,"base64"),64) as Buffer; return timingSafeEqual(actual,Buffer.from(k,"base64")); }
export function encryptJson(value: object, keyB64: string) { const key=Buffer.from(keyB64,"base64"); if(key.length!==32) throw new Error("Encryption key must be 32 bytes"); const iv=randomBytes(12); const cipher=createCipheriv("aes-256-gcm",key,iv); const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]); return {ciphertext,iv,authTag:cipher.getAuthTag()}; }
export function decryptJson(parts:{ciphertext:Buffer;iv:Buffer;authTag:Buffer}, keyB64:string) { const d=createDecipheriv("aes-256-gcm",Buffer.from(keyB64,"base64"),parts.iv); d.setAuthTag(parts.authTag); return JSON.parse(Buffer.concat([d.update(parts.ciphertext),d.final()]).toString("utf8")); }
