import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { tokenHash } from "./security.js";

type ManagedWorker={
  process:ChildProcess;
  sessionHash:string;
};

export function startManagedExecutionSupervisor(db:Db,config:Config){
  if(process.env.ORDERGRID_MANAGED_EXECUTION!=="true")return {stop:async()=>{}};

  const workers=new Map<string,ManagedWorker>();
  let stopping=false;
  let timer:NodeJS.Timeout|null=null;
  const browserPath=process.env.ORDERGRID_CHROME_PATH||join(process.cwd(),".ordergrid","chrome","chrome-linux64","chrome");

  async function stopWorker(tenantId:string){
    const entry=workers.get(tenantId);
    if(!entry)return;
    workers.delete(tenantId);
    try{entry.process.kill("SIGTERM")}catch{}
    await db.query("delete from sessions where id_hash=$1",[entry.sessionHash]).catch(()=>{});
  }

  async function reconcile(){
    if(stopping)return;
    if(!config.WORKER_API_TOKEN)return;
    if(!existsSync(browserPath)){
      console.error(`Managed execution browser is not installed at ${browserPath}`);
      return;
    }

    const {rows}=await db.query(`
      select distinct on (t.id)
        t.id tenant_id,u.id user_id,u.role::text role
      from tenants t
      join retailer_accounts ra on ra.tenant_id=t.id and ra.active
      join users u on u.tenant_id=t.id and u.active and u.role::text in ('OWNER','APPROVER','BUYER')
      order by t.id,
        case u.role::text when 'OWNER' then 0 when 'APPROVER' then 1 else 2 end,
        u.id
    `);
    const activeTenants=new Set(rows.map(row=>String(row.tenant_id)));

    for(const tenantId of [...workers.keys()]){
      const entry=workers.get(tenantId);
      if(!activeTenants.has(tenantId)||!entry||entry.process.exitCode!==null)await stopWorker(tenantId);
    }

    for(const row of rows){
      const tenantId=String(row.tenant_id);
      const existing=workers.get(tenantId);
      if(existing&&existing.process.exitCode===null)continue;

      const sessionToken=randomBytes(32).toString("base64url");
      const sessionHash=tokenHash(sessionToken);
      await db.query(
        "insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '24 hours')",
        [sessionHash,row.user_id,tenantId]
      );
      const profileRoot=join(process.cwd(),".ordergrid","managed-profiles",tenantId);
      await mkdir(profileRoot,{recursive:true,mode:0o700});

      const child=spawn(process.execPath,[join(process.cwd(),"agent","index.mjs")],{
        env:{
          ...process.env,
          ORDERGRID_URL:`http://127.0.0.1:${config.PORT}`,
          ORDERGRID_SESSION_TOKEN:sessionToken,
          ORDERGRID_WORKER_TOKEN:config.WORKER_API_TOKEN,
          ORDERGRID_PROFILE_ROOT:profileRoot,
          ORDERGRID_CHROME_PATH:browserPath,
          ORDERGRID_HEADLESS:"1",
          ORDERGRID_PARALLEL:process.env.ORDERGRID_MANAGED_PARALLEL||"2",
          ORDERGRID_PRODUCT_CHECK_PARALLEL:process.env.ORDERGRID_PRODUCT_CHECK_PARALLEL||"2",
          ORDERGRID_BASKETS:process.env.ORDERGRID_MANAGED_BASKETS||"10",
          ORDERGRID_DAEMON:"1"
        },
        stdio:"inherit"
      });
      workers.set(tenantId,{process:child,sessionHash});
      child.once("exit",()=>{
        const current=workers.get(tenantId);
        if(current?.process===child)workers.delete(tenantId);
        db.query("delete from sessions where id_hash=$1",[sessionHash]).catch(()=>{});
      });
      child.once("error",error=>console.error("Managed execution worker failed to start",tenantId,error));
      console.log("Managed execution worker started",tenantId,child.pid??"");
    }
  }

  void reconcile().catch(error=>console.error("Managed execution supervisor error",error));
  timer=setInterval(()=>void reconcile().catch(error=>console.error("Managed execution supervisor error",error)),15_000);
  timer.unref();

  return {
    stop:async()=>{
      stopping=true;
      if(timer)clearInterval(timer);
      await Promise.all([...workers.keys()].map(stopWorker));
    }
  };
}
