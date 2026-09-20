import pg from "pg";
import { createPrivateKey, sign as signPayload } from "node:crypto";
import type { Config } from "./config.js";

type QueryResult={rows:any[];rowCount:number|null};

function restore(value:any):any{
  if(Array.isArray(value))return value.map(restore);
  if(value&&typeof value==="object"){
    if(typeof value.__bytea==="string")return Buffer.from(value.__bytea,"base64");
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,restore(v)]));
  }
  return value;
}

class BridgeDb {
  private key;
  constructor(private config:Config){
    this.key=createPrivateKey(Buffer.from(config.DATABASE_BRIDGE_PRIVATE_KEY_B64!,"base64"));
  }
  async query(text:string,values:any[]=[]):Promise<QueryResult>{
    const body=JSON.stringify({text,values});
    const timestamp=String(Date.now());
    const signature=signPayload("RSA-SHA256",Buffer.from(timestamp+"\n"+body),this.key).toString("base64url");
    const response=await fetch(this.config.DATABASE_BRIDGE_URL!,{
      method:"POST",
      headers:{
        "content-type":"application/json",
        "x-ordergrid-timestamp":timestamp,
        "x-ordergrid-signature":signature
      },
      body,
      signal:AbortSignal.timeout(15_000)
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String((payload as any).error||`database_bridge_${response.status}`));
    return {rows:restore((payload as any).rows||[]),rowCount:Number.isInteger((payload as any).rowCount)?(payload as any).rowCount:null};
  }
  async end(){}
}

export const createDb = (config: Config): any => {
  if(config.DATABASE_BRIDGE_URL)return new BridgeDb(config);
  return new pg.Pool({
    connectionString: config.DATABASE_URL!,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
  });
};

export type Db = ReturnType<typeof createDb>;

export async function audit(db: Db, tenantId: string, actorId: string | null, action: string, entityType: string, entityId: string | null, metadata: object = {}) {
  await db.query(`insert into audit_log(tenant_id, actor_id, action, entity_type, entity_id, metadata)
    values ($1,$2,$3,$4,$5,$6)`, [tenantId, actorId, action, entityType, entityId, metadata]);
}
