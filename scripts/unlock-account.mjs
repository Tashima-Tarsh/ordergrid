#!/usr/bin/env node
import { createHash } from "node:crypto";
import pg from "pg";

const identifier = process.argv[2];
if (!identifier) {
  console.error("Usage: node scripts/unlock-account.mjs <identifier|email|username>");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required.");
  process.exit(1);
}

const tokenHash = (val) => createHash("sha256").update(val).digest("hex");
const normalized = identifier.trim().toLowerCase();
const identifierHash = tokenHash(normalized);

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const client = await pool.connect();
  try {
    const res = await client.query(
      "delete from login_throttle where identifier_hash = $1 returning *",
      [identifierHash]
    );

    const userRes = await client.query(
      "select id, tenant_id, email from users where lower(email::text) = $1 or lower(coalesce(username::text, '')) = $1 limit 1",
      [normalized]
    );

    const user = userRes.rows[0];
    const tenantId = user?.tenant_id || "00000000-0000-0000-0000-000000000000";

    await client.query(
      "insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata) values ($1, null, 'user.unlocked', 'user', $2, $3)",
      [tenantId, user?.id || null, JSON.stringify({ actor: "cli", identifier: normalized })]
    );

    if (res.rowCount > 0) {
      console.log(`Account lock cleared for '${normalized}'. (Reset ${res.rowCount} throttle entry)`);
    } else {
      console.log(`No active lock found for '${normalized}'. Throttle record is clear.`);
    }
  } finally {
    client.release();
  }
} catch (error) {
  console.error("Failed to unlock account:", error);
  process.exit(1);
} finally {
  await pool.end();
}
