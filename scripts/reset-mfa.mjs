#!/usr/bin/env node
import readline from "node:readline";
import pg from "pg";

const email = process.argv[2];
if (!email) {
  console.error("Usage: node scripts/reset-mfa.mjs <user-email>");
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Error: DATABASE_URL environment variable is required.");
  process.exit(1);
}

const normalizedEmail = email.trim().toLowerCase();
const pool = new pg.Pool({ connectionString: databaseUrl });

async function askConfirmation(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

try {
  const client = await pool.connect();
  try {
    const userRes = await client.query(
      "select id, tenant_id, email, mfa_enabled from users where lower(email::text) = $1 limit 1",
      [normalizedEmail]
    );

    const user = userRes.rows[0];
    if (!user) {
      console.error(`User with email '${normalizedEmail}' not found.`);
      process.exit(1);
    }

    const confirm = await askConfirmation(`Type the user's email (${normalizedEmail}) again to confirm resetting MFA: `);
    if (confirm.toLowerCase() !== normalizedEmail) {
      console.error("Confirmation email did not match. Aborting MFA reset.");
      process.exit(1);
    }

    await client.query("begin");

    await client.query(
      `update users
       set mfa_enabled = false,
           mfa_secret_ciphertext = null,
           mfa_secret_iv = null,
           mfa_secret_auth_tag = null,
           mfa_enrolled_at = null,
           mfa_last_used_step = null
       where id = $1`,
      [user.id]
    );

    await client.query("delete from user_recovery_codes where user_id = $1", [user.id]);
    await client.query("delete from sessions where user_id = $1", [user.id]);

    await client.query(
      `insert into audit_log (tenant_id, actor_id, action, entity_type, entity_id, metadata)
       values ($1, null, 'user.mfa_reset', 'user', $2, $3)`,
      [user.tenant_id, user.id, JSON.stringify({ actor: "cli", email: normalizedEmail })]
    );

    await client.query("commit");
    console.log(`MFA successfully reset and sessions revoked for '${normalizedEmail}'.`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
} catch (error) {
  console.error("Failed to reset MFA:", error);
  process.exit(1);
} finally {
  await pool.end();
}
