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
  startedAt:number;
};

export function startManagedExecutionSupervisor(db:Db,config:Config){
  if(process.env.ORDERGRID_MANAGED_EXECUTION!=="true")return {stop:async()=>{}};

  const workers=new Map<string,ManagedWorker>();
  let stopping=false;
  let timer:NodeJS.Timeout|null=null;
  function resolveBrowserPath(): string {
    const configured = process.env.ORDERGRID_CHROME_PATH;
    if (configured && existsSync(configured)) return configured;
    const candidates = [
      configured,
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      join(process.cwd(), ".ordergrid", "chrome", "chrome-linux64", "chrome")
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return candidates[0] || join(process.cwd(), ".ordergrid", "chrome", "chrome-linux64", "chrome");
  }

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
    const browserPath = resolveBrowserPath();
    if(!existsSync(browserPath)){
      console.error(`Managed execution browser is not installed at ${browserPath}`);
      return;
    }

    const {rows}=await db.query(`
      select distinct on (t.id)
        t.id tenant_id,u.id user_id,u.role::text role
      from tenants t
      join users u on u.tenant_id=t.id and u.active and u.role::text in ('OWNER','APPROVER','BUYER')
      order by t.id,
        case u.role::text when 'OWNER' then 0 when 'APPROVER' then 1 else 2 end,
        u.id
    `);
    const activeTenants=new Set(rows.map(row=>String(row.tenant_id)));

    for(const tenantId of [...workers.keys()]){
      const entry=workers.get(tenantId);
      if(!activeTenants.has(tenantId)||!entry||entry.process.exitCode!==null||Date.now()-entry.startedAt>12*60*60*1000)await stopWorker(tenantId);
    }

    for(const row of rows){
      const tenantId=String(row.tenant_id);
      await db.query(
        `update retailer_accounts
         set session_status='VERIFYING',
             session_challenge_code=null,
             session_check_verify_only=true,
             session_check_requested_at=coalesce(session_check_requested_at,now()),
             session_check_claimed_at=null,
             updated_at=now()
         where tenant_id=$1
           and active
           and retailer in ('amazon-in','flipkart')
           and (retailer='flipkart' or credential_status in ('STORED','READY'))
           and (otp_cooldown_until is null or otp_cooldown_until<=now())
           and (
             (session_status in ('UNKNOWN','ERROR') and (session_checked_at is null or session_checked_at<=now()-interval '10 minutes'))
             or (session_status='READY' and (
               session_target_expires_at is null
               or session_target_expires_at<=now()
               or session_worker_id is null
               or not exists(
                 select 1 from execution_workers ew
                 where ew.tenant_id=retailer_accounts.tenant_id
                   and ew.id=retailer_accounts.session_worker_id
                   and ew.last_seen>now()-interval '30 seconds'
               )
             ))
           )`,
        [tenantId]
      );
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
          ORDERGRID_MANAGED_WORKER:"1",
          ORDERGRID_PARALLEL:process.env.ORDERGRID_MANAGED_PARALLEL||"2",
          ORDERGRID_PRODUCT_CHECK_PARALLEL:process.env.ORDERGRID_PRODUCT_CHECK_PARALLEL||"2",
          ORDERGRID_BASKETS:process.env.ORDERGRID_MANAGED_BASKETS||"10",
          ORDERGRID_DAEMON:"1"
        },
        stdio:"inherit"
      });
      workers.set(tenantId,{process:child,sessionHash,startedAt:Date.now()});
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
