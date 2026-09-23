#!/usr/bin/env node
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";

function parseArgs() {
  const args = process.argv.slice(2);
  let oldKey = process.env.DATA_ENCRYPTION_KEY_PREVIOUS_BASE64;
  let newKey = process.env.DATA_ENCRYPTION_KEY_BASE64;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--old-key" && args[i + 1]) {
      oldKey = args[++i];
    } else if (args[i] === "--new-key" && args[i + 1]) {
      newKey = args[++i];
    }
  }

  return { oldKey, newKey };
}

function validateKey(keyB64, label) {
  if (!keyB64) {
    throw new Error(`Missing ${label}. Provide via CLI flag (--old-key / --new-key) or env var.`);
  }
  const buf = Buffer.from(keyB64, "base64");
  if (buf.length !== 32) {
    throw new Error(`${label} must decode to exactly 32 bytes (got ${buf.length}).`);
  }
  return keyB64;
}

function encryptJson(value, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function decryptJson(parts, keyB64) {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), parts.iv);
  d.setAuthTag(parts.authTag);
  return JSON.parse(Buffer.concat([d.update(parts.ciphertext), d.final()]).toString("utf8"));
}

const { oldKey: rawOld, newKey: rawNew } = parseArgs();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required.");
  process.exit(1);
}

try {
  const oldKey = validateKey(rawOld, "Old encryption key");
  const newKey = validateKey(rawNew, "New encryption key");

  if (oldKey === newKey) {
    console.error("Error: Old key and new key cannot be identical.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  const report = {};

  try {
    await client.query("begin");

    // 1. issuer_connections
    const issuerTable = await client.query(
      "select exists (select 1 from information_schema.tables where table_name='issuer_connections') as exists"
    );
    if (issuerTable.rows[0]?.exists) {
      const rows = await client.query(
        "select id, ciphertext, iv, auth_tag from issuer_connections where ciphertext is not null"
      );
      let count = 0;
      for (const r of rows.rows) {
        if (!r.ciphertext || !r.iv || !r.auth_tag) continue;
        const decrypted = decryptJson({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, oldKey);
        const reEnc = encryptJson(decrypted, newKey);
        await client.query(
          "update issuer_connections set ciphertext=$1, iv=$2, auth_tag=$3, updated_at=now() where id=$4 and iv=$5",
          [reEnc.ciphertext, reEnc.iv, reEnc.authTag, r.id, r.iv]
        );
        count++;
      }
      report["issuer_connections"] = count;
    }

    // 2. private.retailer_credentials
    const credTable = await client.query(
      "select exists (select 1 from information_schema.tables where table_schema='private' and table_name='retailer_credentials') as exists"
    );
    if (credTable.rows[0]?.exists) {
      const rows = await client.query(
        "select tenant_id, retailer_account_id, ciphertext, iv, auth_tag from private.retailer_credentials where ciphertext is not null"
      );
      let count = 0;
      for (const r of rows.rows) {
        if (!r.ciphertext || !r.iv || !r.auth_tag) continue;
        const decrypted = decryptJson({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, oldKey);
        const reEnc = encryptJson(decrypted, newKey);
        await client.query(
          "update private.retailer_credentials set ciphertext=$1, iv=$2, auth_tag=$3, updated_at=now() where tenant_id=$4 and retailer_account_id=$5 and iv=$6",
          [reEnc.ciphertext, reEnc.iv, reEnc.authTag, r.tenant_id, r.retailer_account_id, r.iv]
        );
        count++;
      }
      report["private.retailer_credentials"] = count;
    }

    // 3. private.retailer_session_states
    const sessTable = await client.query(
      "select exists (select 1 from information_schema.tables where table_schema='private' and table_name='retailer_session_states') as exists"
    );
    if (sessTable.rows[0]?.exists) {
      const rows = await client.query(
        "select tenant_id, retailer_account_id, ciphertext, iv, auth_tag from private.retailer_session_states where ciphertext is not null"
      );
      let count = 0;
      for (const r of rows.rows) {
        if (!r.ciphertext || !r.iv || !r.auth_tag) continue;
        const decrypted = decryptJson({ ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, oldKey);
        const reEnc = encryptJson(decrypted, newKey);
        await client.query(
          "update private.retailer_session_states set ciphertext=$1, iv=$2, auth_tag=$3, updated_at=now() where tenant_id=$4 and retailer_account_id=$5 and iv=$6",
          [reEnc.ciphertext, reEnc.iv, reEnc.authTag, r.tenant_id, r.retailer_account_id, r.iv]
        );
        count++;
      }
      report["private.retailer_session_states"] = count;
    }

    // 4. users (MFA secrets)
    const userCols = await client.query(
      "select exists (select 1 from information_schema.columns where table_name='users' and column_name='mfa_secret_ciphertext') as exists"
    );
    if (userCols.rows[0]?.exists) {
      const rows = await client.query(
        "select id, tenant_id, mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_auth_tag from users where mfa_secret_ciphertext is not null"
      );
      let count = 0;
      for (const r of rows.rows) {
        if (!r.mfa_secret_ciphertext || !r.mfa_secret_iv || !r.mfa_secret_auth_tag) continue;
        const decrypted = decryptJson({ ciphertext: r.mfa_secret_ciphertext, iv: r.mfa_secret_iv, authTag: r.mfa_secret_auth_tag }, oldKey);
        const reEnc = encryptJson(decrypted, newKey);
        await client.query(
          "update users set mfa_secret_ciphertext=$1, mfa_secret_iv=$2, mfa_secret_auth_tag=$3 where id=$4 and mfa_secret_iv=$5",
          [reEnc.ciphertext, reEnc.iv, reEnc.authTag, r.id, r.mfa_secret_iv]
        );
        count++;
      }
      report["users_mfa"] = count;
    }

    // Audit log
    await client.query(
      "insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata) values ($1, null, 'security.encryption_key_rotated', 'system', null, $2)",
      ["00000000-0000-0000-0000-000000000000", JSON.stringify({ actor: "cli", report, rotatedAt: new Date().toISOString() })]
    );

    await client.query("commit");

    console.log("Encryption key rotation completed successfully!");
    console.log("Summary of re-encrypted records:");
    for (const [table, count] of Object.entries(report)) {
      console.log(`  - ${table}: ${count} record(s)`);
    }
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
} catch (error) {
  console.error("Encryption key rotation failed:", error.message || error);
  process.exit(1);
}
