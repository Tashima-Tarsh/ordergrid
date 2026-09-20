import pg from "pg";
import type { Config } from "./config.js";

export const createDb = (config: Config) => {
  const base={
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  };
  if(config.DATABASE_URL)return new pg.Pool({...base,connectionString:config.DATABASE_URL});
  return new pg.Pool({
    ...base,
    host:config.DB_HOST,
    port:config.DB_PORT,
    database:config.DB_NAME,
    user:config.DB_USER,
    password:config.DB_PASSWORD??config.ORDERGRID_DB_TOKEN
  });
};

export type Db = ReturnType<typeof createDb>;

export async function audit(db: Db, tenantId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: object = {}) {
  await db.query(`insert into audit_log(tenant_id, actor_id, action, entity_type, entity_id, metadata)
    values ($1,$2,$3,$4,$5,$6)`, [tenantId, actorId, action, entityType, entityId, metadata]);
}
