import Fastify, { FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  computeLockoutDurationSeconds,
  createSignedMfaToken,
  decryptJson,
  dummyVerifyPassword,
  encryptJson,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  tokenHash,
  verifyPassword,
  verifySignedMfaToken,
  verifyTotp
} from "../../src/security.js";

export interface MockDbStore {
  tenants: Map<string, any>;
  users: Map<string, any>;
  sessions: Map<string, any>;
  login_throttle: Map<string, any>;
  user_recovery_codes: Map<string, any>;
  audit_logs: any[];
  checkout_baskets: Map<string, any>;
  virtual_cards: Map<string, any>;
  retailer_accounts: Map<string, any>;
}

export function createMockDb(): { db: any; store: MockDbStore } {
  const store: MockDbStore = {
    tenants: new Map(),
    users: new Map(),
    sessions: new Map(),
    login_throttle: new Map(),
    user_recovery_codes: new Map(),
    audit_logs: [],
    checkout_baskets: new Map(),
    virtual_cards: new Map(),
    retailer_accounts: new Map()
  };

  const defaultTenant = { id: "00000000-0000-0000-0000-000000000001", name: "OrderGrid Test" };
  store.tenants.set(defaultTenant.id, defaultTenant);

  const db: any = {
    query: async (text: string, params: any[] = []) => {
      const sql = text.trim().toLowerCase().replace(/\s+/g, " ");

      // login_throttle select
      if (sql.includes("from login_throttle where identifier_hash")) {
        const idHash = params[0];
        const row = store.login_throttle.get(idHash);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }

      // login_throttle delete
      if (sql.includes("delete from login_throttle where identifier_hash")) {
        const idHash = params[0];
        const existed = store.login_throttle.delete(idHash);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }

      // login_throttle insert/update
      if (sql.includes("insert into login_throttle")) {
        const idHash = params[0];
        if (params.length === 3) {
          // values ($1, 0, $2, $3, now()) -> params: [idHash, lockedUntil, lockCount]
          if (params[1] instanceof Date || typeof params[1] === "string") {
            store.login_throttle.set(idHash, {
              identifier_hash: idHash,
              failures: 0,
              locked_until: new Date(params[1]),
              lock_count: params[2],
              last_failure_at: new Date()
            });
          } else {
            // values ($1, $2, null, $3, now()) -> params: [idHash, failures, lockCount]
            store.login_throttle.set(idHash, {
              identifier_hash: idHash,
              failures: params[1],
              locked_until: null,
              lock_count: params[2],
              last_failure_at: new Date()
            });
          }
        }
        return { rows: [], rowCount: 1 };
      }

      // users lookup by email or username
      if (sql.includes("from users") && sql.includes("lower(email::text)=lower($1)")) {
        const id = String(params[0]).toLowerCase();
        for (const u of store.users.values()) {
          if (u.active && (u.email.toLowerCase() === id || (u.username && u.username.toLowerCase() === id))) {
            return { rows: [{ ...u }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // users lookup by id and tenant_id
      if (sql.includes("from users where id=$1 and tenant_id=$2")) {
        const u = store.users.get(params[0]);
        if (u && u.tenant_id === params[1] && u.active) {
          return { rows: [{ ...u }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      // update users mfa_last_used_step
      if (sql.includes("update users set mfa_last_used_step=$1 where id=$2")) {
        const u = store.users.get(params[1]);
        if (u) u.mfa_last_used_step = params[0];
        return { rows: [], rowCount: 1 };
      }

      // update users mfa enrollment
      if (sql.includes("update users set mfa_secret_ciphertext=$1")) {
        const u = store.users.get(params[4]);
        if (u) {
          u.mfa_secret_ciphertext = params[0];
          u.mfa_secret_iv = params[1];
          u.mfa_secret_auth_tag = params[2];
          u.mfa_enabled = true;
          u.mfa_enrolled_at = new Date();
          u.mfa_last_used_step = params[3];
        }
        return { rows: [], rowCount: 1 };
      }

      // update users mfa disable
      if (sql.includes("update users set mfa_enabled=false")) {
        const u = store.users.get(params[0]);
        if (u) {
          u.mfa_enabled = false;
          u.mfa_secret_ciphertext = null;
          u.mfa_secret_iv = null;
          u.mfa_secret_auth_tag = null;
          u.mfa_enrolled_at = null;
          u.mfa_last_used_step = null;
        }
        return { rows: [], rowCount: 1 };
      }

      // user_recovery_codes select
      if (sql.includes("from user_recovery_codes where user_id=$1 and code_hash=$2")) {
        for (const code of store.user_recovery_codes.values()) {
          if (code.user_id === params[0] && code.code_hash === params[1] && !code.used_at) {
            return { rows: [{ ...code }], rowCount: 1 };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // user_recovery_codes update used_at
      if (sql.includes("update user_recovery_codes set used_at=now() where id=$1")) {
        const c = store.user_recovery_codes.get(params[0]);
        if (c) c.used_at = new Date();
        return { rows: [], rowCount: 1 };
      }

      // user_recovery_codes insert
      if (sql.includes("insert into user_recovery_codes")) {
        const id = randomUUID();
        store.user_recovery_codes.set(id, {
          id,
          user_id: params[0],
          code_hash: params[1],
          used_at: null,
          created_at: new Date()
        });
        return { rows: [], rowCount: 1 };
      }

      // user_recovery_codes delete
      if (sql.includes("delete from user_recovery_codes where user_id=$1")) {
        for (const [k, v] of store.user_recovery_codes.entries()) {
          if (v.user_id === params[0]) store.user_recovery_codes.delete(k);
        }
        return { rows: [], rowCount: 1 };
      }

      // sessions lookup
      if (sql.includes("from sessions s join users u on u.id=s.user_id where s.id_hash=$1")) {
        const sess = store.sessions.get(params[0]);
        if (sess && new Date(sess.expires_at).getTime() > Date.now()) {
          const u = store.users.get(sess.user_id);
          if (u && u.active) {
            return {
              rows: [{
                id: u.id,
                home_tenant_id: u.tenant_id,
                tenant_id: u.tenant_id,
                role: u.role,
                mfa_enabled: Boolean(u.mfa_enabled)
              }],
              rowCount: 1
            };
          }
        }
        return { rows: [], rowCount: 0 };
      }

      // sessions insert
      if (sql.includes("insert into sessions")) {
        const idHash = params[0];
        store.sessions.set(idHash, {
          id_hash: idHash,
          user_id: params[1],
          active_tenant_id: params[2],
          expires_at: new Date(Date.now() + 12 * 3600 * 1000)
        });
        return { rows: [], rowCount: 1 };
      }

      // tenants lookup
      if (sql.includes("select id,name from tenants where id=$1")) {
        const t = store.tenants.get(params[0]);
        return { rows: t ? [t] : [], rowCount: t ? 1 : 0 };
      }

      // audit_log insert
      if (sql.includes("insert into audit_log")) {
        store.audit_logs.push({
          tenant_id: params[0],
          actor_id: params[1],
          action: params[2],
          entity_type: params[3],
          entity_id: params[4],
          metadata: params[5],
          created_at: new Date()
        });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      const client = {
        query: db.query,
        release: () => {}
      };
      return client;
    }
  };

  return { db, store };
}

export async function createIntegrationApp(db: any, customConfig?: any): Promise<FastifyInstance> {
  const sessionSecret = "test-session-secret-32-bytes-minimum-key!";
  const dataEncryptionKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  const previousEncryptionKey = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

  const config = {
    SESSION_SECRET: sessionSecret,
    DATA_ENCRYPTION_KEY_BASE64: dataEncryptionKey,
    DATA_ENCRYPTION_KEY_PREVIOUS_BASE64: previousEncryptionKey,
    LOGIN_RATE_LIMIT_MAX: 5,
    MFA_RATE_LIMIT_MAX: 5,
    MFA_REQUIRED_ROLES: "OWNER,APPROVER",
    ORDERGRID_SIGNUP_CODE: "valid_signup_code_123",
    ...customConfig
  };

  const encryptionKeys = [config.DATA_ENCRYPTION_KEY_BASE64, config.DATA_ENCRYPTION_KEY_PREVIOUS_BASE64].filter(Boolean) as string[];
  const mfaRequiredRoles = new Set(config.MFA_REQUIRED_ROLES.split(",").map((r: string) => r.trim().toUpperCase()).filter(Boolean));
  const isMfaRequired = (role: string) => mfaRequiredRoles.has(role.toUpperCase());

  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "rate_limited",
      message: "Rate limit exceeded. Please try again later.",
      retryAfterSeconds: Math.ceil(context.ttl / 1000)
    })
  });

  async function recordLoginFailure(dbClient: any, identifierHash: string, userId?: string, tenantId?: string) {
    const current = await dbClient.query("select failures, lock_count from login_throttle where identifier_hash=$1", [identifierHash]);
    const failures = (current.rows[0]?.failures || 0) + 1;
    let lockCount = current.rows[0]?.lock_count || 0;
    let lockedUntil: Date | null = null;

    if (failures >= 5) {
      lockCount += 1;
      const lockDuration = computeLockoutDurationSeconds(lockCount);
      lockedUntil = new Date(Date.now() + lockDuration * 1000);
      await dbClient.query(
        `insert into login_throttle (identifier_hash, failures, locked_until, lock_count, last_failure_at)
         values ($1, 0, $2, $3, now())`,
        [identifierHash, lockedUntil, lockCount]
      );
    } else {
      await dbClient.query(
        `insert into login_throttle (identifier_hash, failures, locked_until, lock_count, last_failure_at)
         values ($1, $2, null, $3, now())`,
        [identifierHash, failures, lockCount]
      );
    }
  }

  app.addHook("preHandler", async (req, reply) => {
    const path = String(req.url || "").split("?", 1)[0] ?? "";
    if (
      !path.startsWith("/api/") ||
      path === "/api/health" ||
      path === "/api/login" ||
      path === "/api/login/mfa" ||
      path === "/api/signup"
    ) {
      return;
    }
    const raw = req.cookies.session;
    if (!raw) return reply.code(401).send({ error: "unauthorized" });
    const { rows } = await db.query(
      `select u.id,u.tenant_id home_tenant_id,u.tenant_id tenant_id,u.role::text role,u.mfa_enabled
       from sessions s join users u on u.id=s.user_id
       where s.id_hash=$1`,
      [tokenHash(raw)]
    );
    if (!rows[0]) return reply.code(401).send({ error: "unauthorized" });
    const userRow = rows[0];
    req.principal = { id: userRow.id, homeTenantId: userRow.home_tenant_id, tenantId: userRow.tenant_id, role: userRow.role };

    if (isMfaRequired(userRow.role) && !userRow.mfa_enabled) {
      const allowed = ["/api/mfa/status", "/api/mfa/enroll/start", "/api/mfa/enroll/verify", "/api/logout"];
      if (!allowed.includes(path)) {
        return reply.code(403).send({ error: "mfa_enrollment_required", message: "MFA enrollment is required for your role." });
      }
    }
  });

  app.setErrorHandler((error: any, req, reply) => {
    const statusCode = typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600
      ? error.statusCode
      : error instanceof z.ZodError
      ? 400
      : 500;

    if (statusCode < 500) {
      if (typeof error.errorResponseBuilder === "function" || error.error === "rate_limited" || statusCode === 429) {
        if (typeof error.retryAfterSeconds === "number") {
          reply.header("Retry-After", error.retryAfterSeconds.toString());
        }
        return reply.code(429).send({
          error: "rate_limited",
          message: error.message || "Rate limit exceeded. Please try again later.",
          ...(typeof error.retryAfterSeconds === "number" ? { retryAfterSeconds: error.retryAfterSeconds } : {})
        });
      }
      return reply.code(statusCode).send({
        error: error.code || error.error || "client_error",
        message: error.message || "Bad Request"
      });
    }

    return reply.code(500).send({
      error: "internal_error",
      requestId: req.id,
      message: "An internal server error occurred"
    });
  });

  // Endpoints
  app.post("/api/login", async (req, reply) => {
    const input = z.object({ identifier: z.string(), password: z.string() }).parse(req.body);
    const identifier = input.identifier.trim();
    const normalizedIdentifier = identifier.toLowerCase();
    const identifierHash = tokenHash(normalizedIdentifier);

    const throttleRes = await db.query("select failures, locked_until, lock_count from login_throttle where identifier_hash=$1", [identifierHash]);
    const throttle = throttleRes.rows[0];
    if (throttle && throttle.locked_until && new Date(throttle.locked_until).getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(throttle.locked_until).getTime() - Date.now()) / 1000));
      reply.header("Retry-After", retryAfterSeconds.toString());
      return reply.code(429).send({
        error: "too_many_attempts",
        message: "Account is temporarily locked due to too many failed attempts. Try again later.",
        retryAfterSeconds
      });
    }

    const { rows } = await db.query(
      "select id, tenant_id, role, password_hash, username, email, mfa_enabled from users where active and (lower(email::text)=lower($1) or lower(coalesce(username::text,''))=lower($1)) limit 1",
      [identifier]
    );
    const u = rows[0];

    if (!u) {
      await dummyVerifyPassword(input.password);
      await recordLoginFailure(db, identifierHash);
      return reply.code(401).send({ error: "invalid_credentials", message: "Invalid username/email or password" });
    }

    const passwordOk = await verifyPassword(input.password, u.password_hash);
    if (!passwordOk) {
      await recordLoginFailure(db, identifierHash, u.id, u.tenant_id);
      return reply.code(401).send({ error: "invalid_credentials", message: "Invalid username/email or password" });
    }

    if (u.mfa_enabled) {
      const mfaToken = createSignedMfaToken({
        userId: u.id,
        tenantId: u.tenant_id,
        role: u.role,
        identifierHash,
        attempts: 0,
        expiresAt: Date.now() + 5 * 60 * 1000
      }, config.SESSION_SECRET);

      return { mfaRequired: true, mfaToken };
    }

    await db.query("delete from login_throttle where identifier_hash=$1", [identifierHash]);
    const token = randomBytes(32).toString("base64url");
    await db.query("insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '12 hours')", [tokenHash(token), u.id, u.tenant_id]);
    reply.setCookie("session", token, { path: "/", httpOnly: true });
    return { user: { id: u.id, role: u.role, mfaRequired: false, mfaEnrollmentRequired: isMfaRequired(u.role) } };
  });

  app.post("/api/login/mfa", async (req, reply) => {
    const body = z.object({ mfaToken: z.string(), code: z.string() }).parse(req.body);
    const payload = verifySignedMfaToken(body.mfaToken, config.SESSION_SECRET);
    if (!payload) return reply.code(401).send({ error: "invalid_mfa_token", message: "MFA session expired or invalid." });

    const throttleRes = await db.query("select failures, locked_until from login_throttle where identifier_hash=$1", [payload.identifierHash]);
    const throttle = throttleRes.rows[0];
    if (throttle && throttle.locked_until && new Date(throttle.locked_until).getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(1, Math.ceil((new Date(throttle.locked_until).getTime() - Date.now()) / 1000));
      reply.header("Retry-After", retryAfterSeconds.toString());
      return reply.code(429).send({ error: "too_many_attempts", retryAfterSeconds });
    }

    const { rows } = await db.query(
      "select id, tenant_id, role, mfa_enabled, mfa_secret_ciphertext, mfa_secret_iv, mfa_secret_auth_tag, mfa_last_used_step from users where id=$1 and tenant_id=$2 and active limit 1",
      [payload.userId, payload.tenantId]
    );
    const u = rows[0];
    if (!u || !u.mfa_enabled) return reply.code(401).send({ error: "invalid_credentials" });

    const dec = decryptJson({ ciphertext: u.mfa_secret_ciphertext, iv: u.mfa_secret_iv, authTag: u.mfa_secret_auth_tag }, encryptionKeys);
    const secret = typeof dec === "string" ? dec : dec.secret;

    const totpRes = verifyTotp(body.code, secret, { lastUsedStep: u.mfa_last_used_step });
    if (totpRes.valid) {
      await db.query("update users set mfa_last_used_step=$1 where id=$2", [totpRes.step.toString(), u.id]);
      await db.query("delete from login_throttle where identifier_hash=$1", [payload.identifierHash]);
      const token = randomBytes(32).toString("base64url");
      await db.query("insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '12 hours')", [tokenHash(token), u.id, u.tenant_id]);
      reply.setCookie("session", token, { path: "/", httpOnly: true });
      return { user: { id: u.id, role: u.role } };
    }

    const codeHash = tokenHash(body.code.trim().toUpperCase());
    const recoveryRes = await db.query("select id from user_recovery_codes where user_id=$1 and code_hash=$2 and used_at is null limit 1", [u.id, codeHash]);
    if (recoveryRes.rows[0]) {
      await db.query("update user_recovery_codes set used_at=now() where id=$1", [recoveryRes.rows[0].id]);
      await db.query("delete from login_throttle where identifier_hash=$1", [payload.identifierHash]);
      const token = randomBytes(32).toString("base64url");
      await db.query("insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '12 hours')", [tokenHash(token), u.id, u.tenant_id]);
      reply.setCookie("session", token, { path: "/", httpOnly: true });
      return { user: { id: u.id, role: u.role, recoveryCodeUsed: true } };
    }

    await recordLoginFailure(db, payload.identifierHash, u.id, u.tenant_id);
    return reply.code(401).send({ error: "invalid_mfa_code", message: "Invalid code" });
  });

  app.post("/api/mfa/enroll/start", async (req, reply) => {
    const p = req.principal!;
    const { rows } = await db.query("select id, email from users where id=$1 and tenant_id=$2 and active limit 1", [p.id, p.tenantId]);
    const u = rows[0];
    const { secretBase32 } = generateTotpSecret();
    const enrollmentToken = createSignedMfaToken({ userId: u.id, tenantId: p.tenantId, secretBase32, expiresAt: Date.now() + 10 * 60 * 1000 }, config.SESSION_SECRET);
    return { secret: secretBase32, enrollmentToken };
  });

  app.post("/api/mfa/enroll/verify", async (req, reply) => {
    const p = req.principal!;
    const body = z.object({ enrollmentToken: z.string(), code: z.string() }).parse(req.body);
    const payload = verifySignedMfaToken(body.enrollmentToken, config.SESSION_SECRET);
    if (!payload || payload.userId !== p.id) return reply.code(400).send({ error: "invalid_enrollment_token" });

    const totpRes = verifyTotp(body.code, payload.secretBase32);
    if (!totpRes.valid) return reply.code(400).send({ error: "invalid_mfa_code" });

    const enc = encryptJson({ secret: payload.secretBase32 }, config.DATA_ENCRYPTION_KEY_BASE64);
    const recoveryCodes = generateRecoveryCodes(10);
    await db.query(
      `update users set mfa_secret_ciphertext=$1, mfa_secret_iv=$2, mfa_secret_auth_tag=$3, mfa_last_used_step=$4, mfa_enabled=true where id=$5`,
      [enc.ciphertext, enc.iv, enc.authTag, totpRes.step.toString(), p.id]
    );
    for (const code of recoveryCodes) {
      await db.query("insert into user_recovery_codes (user_id, code_hash) values ($1, $2)", [p.id, tokenHash(code.trim().toUpperCase())]);
    }
    return { ok: true, recoveryCodes };
  });

  app.post("/api/mfa/disable", async (req, reply) => {
    const p = req.principal!;
    if (isMfaRequired(p.role)) return reply.code(403).send({ error: "mfa_required_for_role" });
    await db.query("update users set mfa_enabled=false where id=$1", [p.id]);
    return { ok: true };
  });

  app.post("/api/signup", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(14), setupCode: z.string() }).parse(req.body);
    if (body.setupCode !== config.ORDERGRID_SIGNUP_CODE) return reply.code(403).send({ error: "invalid_signup_code" });
    return { ok: true };
  });

  app.get("/api/dashboard", async (req) => {
    return { status: "ok", principal: req.principal };
  });

  return app;
}
