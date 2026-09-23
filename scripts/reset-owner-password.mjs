#!/usr/bin/env node
import readline from "node:readline";
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scrypt = promisify(scryptCb);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function promptInput(promptText, hideInput = false) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required.");
  process.exit(1);
}

let identifier = process.argv[2];
let newPassword = process.argv[3];

if (!identifier) {
  identifier = await promptInput("Enter Owner email or username: ");
}
if (!identifier) {
  console.error("Error: Owner email or username is required.");
  process.exit(1);
}

if (!newPassword) {
  newPassword = await promptInput("Enter new password (min 14 characters): ");
}

if (!newPassword || newPassword.length < 14) {
  console.error("Error: Password must be at least 14 characters.");
  process.exit(1);
}

const normalized = identifier.trim().toLowerCase();
const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  const client = await pool.connect();
  try {
    const userRes = await client.query(
      "select id, tenant_id, email, username, role from users where active and (lower(email::text) = $1 or lower(coalesce(username::text, '')) = $1) limit 1",
      [normalized]
    );
    const user = userRes.rows[0];
    if (!user) {
      console.error(`Error: User '${normalized}' not found.`);
      process.exit(1);
    }
    if (user.role !== "OWNER") {
      console.warn(`Warning: User '${normalized}' has role '${user.role}' (not OWNER).`);
    }

    const passwordHash = await hashPassword(newPassword);

    await client.query("begin");

    await client.query(
      "update users set password_hash = $1 where id = $2",
      [passwordHash, user.id]
    );

    await client.query("delete from sessions where user_id = $1", [user.id]);

    await client.query(
      "insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata) values ($1, null, 'user.password_reset', 'user', $2, $3)",
      [user.tenant_id, user.id, JSON.stringify({ actor: "cli", identifier: normalized, role: user.role })]
    );

    await client.query("commit");
    console.log(`Password reset successful for '${user.email}'. All active sessions revoked.`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
} catch (error) {
  console.error("Failed to reset password:", error);
  process.exit(1);
} finally {
  await pool.end();
}
