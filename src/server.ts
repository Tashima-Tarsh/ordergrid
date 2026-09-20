import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import multipart from "@fastify/multipart";
import ExcelJS from "exceljs";
import { randomBytes, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { audit, createDb } from "./db.js";
import { decryptJson, encryptJson, hashPassword, tokenHash, verifyPassword } from "./security.js";
import { createOrderQueue } from "./queue.js";
import { retailerForProductUrl, validateRetailerOrderId, verifiedRetailerUrl } from "./retailers.js";
import { syncCheckoutBaskets } from "./baskets.js";
import { disconnectTenantIssuer, loadTenantIssuer, testAndSaveEnKashConnection } from "./issuer-connections.js";
import { assignAvailableVirtualCard, assignFundingRoute } from "./funding-router.js";
import { ensureBasketVirtualCard } from "./card-provisioning.js";

const config=loadConfig(), db=createDb(config), jobs=config.REDIS_URL?createOrderQueue(config.REDIS_URL):null;
async function getAutomationPolicy(tenantId:string){
  await db.query(
    "insert into automation_policies(tenant_id) values($1) on conflict(tenant_id) do nothing",
    [tenantId]
  );
  const {rows}=await db.query(
    "select automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,failure_pause_percent,updated_at from automation_policies where tenant_id=$1",
    [tenantId]
  );
  return rows[0] as {
    automation_enabled:boolean;
    auto_assign_virtual_card:boolean;
    auto_continue_checkout:boolean;
    max_active_orders:number;
    failure_pause_percent:number|string;
    updated_at:string;
  };
}
const app=Fastify({logger:{redact:["req.headers.authorization","req.headers.cookie","password"]},trustProxy:true,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}});
await app.register(rateLimit,{max:120,timeWindow:"1 minute"}); await app.register(cookie,{secret:config.SESSION_SECRET});
await app.register(multipart,{limits:{fileSize:5_000_000,files:1}});
await app.register(staticPlugin,{root:join(dirname(fileURLToPath(import.meta.url)),"../public"),prefix:"/"});

declare module "fastify" { interface FastifyRequest { principal?:{id:string;homeTenantId:string;tenantId:string;role:string} } }
app.addHook("preHandler",async(req,reply)=>{
  if(!req.url.startsWith("/api/")||req.url==="/api/health"||req.url==="/api/login")return;
  const raw=req.cookies.session;if(!raw)return reply.code(401).send({error:"unauthorized"});
  const {rows}=await db.query(`
    select u.id,u.tenant_id home_tenant_id,
      coalesce(s.active_tenant_id,u.tenant_id) tenant_id,
      case
        when coalesce(s.active_tenant_id,u.tenant_id)=u.tenant_id then u.role::text
        else da.role::text
      end role
    from sessions s
    join users u on u.id=s.user_id
    left join dealer_access da
      on da.user_id=u.id
     and da.tenant_id=coalesce(s.active_tenant_id,u.tenant_id)
    where s.id_hash=$1 and s.expires_at>now() and u.active
      and (coalesce(s.active_tenant_id,u.tenant_id)=u.tenant_id or da.id is not null)
  `,[tokenHash(raw)]);
  if(!rows[0])return reply.code(401).send({error:"unauthorized"});
  req.principal={id:rows[0].id,homeTenantId:rows[0].home_tenant_id,tenantId:rows[0].tenant_id,role:rows[0].role};
});

app.get("/api/health",async()=>{await db.query("select 1");return {status:"ok"}});
app.post("/api/login",{config:{rateLimit:{max:8,timeWindow:"15 minutes"}}},async(req,reply)=>{
  const input=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body);
  const {rows}=await db.query("select id,tenant_id,role,password_hash from users where lower(email::text)=lower($1) and active limit 1",[input.email]);
  const u=rows[0];
  if(!u||!await verifyPassword(input.password,u.password_hash))return reply.code(401).send({error:"invalid_credentials"});
  const token=randomBytes(32).toString("base64url");
  await db.query("insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '12 hours')",[tokenHash(token),u.id,u.tenant_id]);
  reply.setCookie("session",token,{httpOnly:true,secure:config.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:43200});
  const tenant=await db.query("select id,name from tenants where id=$1",[u.tenant_id]);
  return {user:{id:u.id,role:u.role},dealer:tenant.rows[0]};
});
app.post("/api/logout",async(req,reply)=>{const raw=req.cookies.session;if(raw)await db.query("delete from sessions where id_hash=$1",[tokenHash(raw)]);reply.clearCookie("session",{path:"/"});return {ok:true}});
app.get("/api/dealer-network",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    with accessible as (
      select u.tenant_id
      from users u
      where u.id=$1
      union
      select da.tenant_id
      from dealer_access da
      join dealer_relationships dr on dr.child_tenant_id=da.tenant_id and dr.status='ACTIVE'
      where da.user_id=$1
    )
    select
      t.id,t.name,
      case when t.id=$2 then 'MAIN' else 'SUB' end dealer_type,
      (t.id=$3) active,
      coalesce((select count(*) from users u where u.tenant_id=t.id and u.active),0)::int user_count,
      coalesce((select count(*) from customers c where c.tenant_id=t.id and c.active),0)::int customer_count,
      coalesce((select count(*) from retailer_accounts ra where ra.tenant_id=t.id),0)::int retailer_account_count,
      coalesce((select count(*) from checkout_baskets cb where cb.tenant_id=t.id),0)::int order_count,
      coalesce((select count(*) from checkout_baskets cb where cb.tenant_id=t.id and cb.status='CONFIRMED'),0)::int confirmed_count,
      coalesce((select count(*) from virtual_cards vc where vc.tenant_id=t.id),0)::int virtual_card_count,
      exists(select 1 from issuer_connections ic where ic.tenant_id=t.id and ic.status='CONNECTED') funding_connected
    from tenants t
    join accessible a on a.tenant_id=t.id
    order by case when t.id=$2 then 0 else 1 end,t.name
  `,[p.id,p.homeTenantId,p.tenantId]);
  const parent=await db.query("select parent_tenant_id from dealer_relationships where child_tenant_id=$1 limit 1",[p.homeTenantId]);
  return {
    homeTenantId:p.homeTenantId,
    activeTenantId:p.tenantId,
    canCreateSubdealer:p.role==="OWNER"&&p.tenantId===p.homeTenantId&&!parent.rows[0],
    dealers:rows
  };
});

app.post("/api/dealer-context",async(req,reply)=>{
  const p=req.principal!,raw=req.cookies.session;
  if(!raw)return reply.code(401).send({error:"unauthorized"});
  const body=z.object({tenantId:z.string().uuid()}).parse(req.body);
  const access=await db.query(`
    select t.id,t.name,
      case when t.id=$2 then u.role::text else da.role::text end role
    from tenants t
    join users u on u.id=$1
    left join dealer_access da on da.user_id=u.id and da.tenant_id=t.id
    left join dealer_relationships dr on dr.child_tenant_id=t.id
    where t.id=$3
      and (t.id=$2 or (da.id is not null and dr.status='ACTIVE'))
    limit 1
  `,[p.id,p.homeTenantId,body.tenantId]);
  if(!access.rows[0])return reply.code(403).send({error:"dealer_access_denied"});
  await db.query("update sessions set active_tenant_id=$1 where id_hash=$2",[body.tenantId,tokenHash(raw)]);
  await audit(db,body.tenantId,p.id,"dealer.context_switched","tenant",body.tenantId,{fromTenantId:p.tenantId});
  return {dealer:{id:access.rows[0].id,name:access.rows[0].name},role:access.rows[0].role};
});

app.post("/api/dealers",async(req,reply)=>{
  const p=req.principal!;
  if(p.role!=="OWNER"||p.tenantId!==p.homeTenantId)return reply.code(403).send({error:"main_dealer_owner_required"});
  const existingParent=await db.query("select 1 from dealer_relationships where child_tenant_id=$1",[p.homeTenantId]);
  if(existingParent.rows[0])return reply.code(409).send({error:"subdealer_cannot_create_subdealer"});
  const body=z.object({
    name:z.string().min(2).max(120),
    ownerEmail:z.string().email(),
    ownerPassword:z.string().min(14).max(200)
  }).parse(req.body);
  const existingUser=await db.query("select id from users where lower(email::text)=lower($1) limit 1",[body.ownerEmail]);
  if(existingUser.rows[0])return reply.code(409).send({error:"email_already_in_use"});
  const client=await db.connect();
  try{
    await client.query("begin");
    const tenant=await client.query("insert into tenants(name) values($1) returning id,name",[body.name.trim()]);
    const childTenantId=tenant.rows[0].id;
    const owner=await client.query(
      "insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,'OWNER') returning id,email,role",
      [childTenantId,body.ownerEmail.toLowerCase(),await hashPassword(body.ownerPassword)]
    );
    await client.query(
      "insert into dealer_relationships(parent_tenant_id,child_tenant_id,created_by) values($1,$2,$3)",
      [p.tenantId,childTenantId,p.id]
    );
    await client.query(
      `insert into dealer_access(user_id,tenant_id,role,created_by)
       select id,$1,'OWNER',$2 from users
       where tenant_id=$3 and active and role='OWNER'
       on conflict(user_id,tenant_id) do update set role='OWNER',updated_at=now()`,
      [childTenantId,p.id,p.tenantId]
    );
    await client.query("commit");
    await audit(db,p.tenantId,p.id,"subdealer.created","tenant",childTenantId,{name:tenant.rows[0].name,ownerUserId:owner.rows[0].id});
    return reply.code(201).send({dealer:tenant.rows[0],owner:{id:owner.rows[0].id,email:owner.rows[0].email,role:owner.rows[0].role}});
  }catch(error){
    await client.query("rollback");throw error;
  }finally{client.release()}
});

app.get("/api/dealer-users",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select u.id,u.email,
      case when u.tenant_id=$1 then u.role::text else da.role::text end role,
      (u.tenant_id=$1) home_user,
      u.active
    from users u
    left join dealer_access da on da.user_id=u.id and da.tenant_id=$1
    where (u.tenant_id=$1 or da.id is not null)
    order by case when u.tenant_id=$1 then 0 else 1 end,u.email
  `,[p.tenantId]);
  return {users:rows};
});

app.post("/api/dealer-users",async(req,reply)=>{
  const p=req.principal!;
  if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});
  const body=z.object({
    email:z.string().email(),
    role:z.enum(["OWNER","APPROVER","BUYER","AUDITOR"]),
    password:z.string().min(14).max(200).optional()
  }).parse(req.body);
  const existing=await db.query("select id,tenant_id,email,active from users where lower(email::text)=lower($1) limit 1",[body.email]);
  if(existing.rows[0]){
    if(existing.rows[0].tenant_id===p.tenantId){
      await db.query("update users set role=$1,active=true where id=$2",[body.role,existing.rows[0].id]);
      await audit(db,p.tenantId,p.id,"dealer_user.updated","user",existing.rows[0].id,{role:body.role});
      return {user:{id:existing.rows[0].id,email:existing.rows[0].email,role:body.role,homeUser:true}};
    }
    await db.query(
      `insert into dealer_access(user_id,tenant_id,role,created_by)
       values($1,$2,$3,$4)
       on conflict(user_id,tenant_id) do update set role=excluded.role,updated_at=now()`,
      [existing.rows[0].id,p.tenantId,body.role,p.id]
    );
    await audit(db,p.tenantId,p.id,"dealer_access.granted","user",existing.rows[0].id,{role:body.role});
    return {user:{id:existing.rows[0].id,email:existing.rows[0].email,role:body.role,homeUser:false}};
  }
  if(!body.password)return reply.code(400).send({error:"password_required_for_new_user"});
  const {rows}=await db.query(
    "insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,$4) returning id,email,role",
    [p.tenantId,body.email.toLowerCase(),await hashPassword(body.password),body.role]
  );
  await audit(db,p.tenantId,p.id,"dealer_user.created","user",rows[0].id,{role:body.role});
  return reply.code(201).send({user:{...rows[0],homeUser:true}});
});

app.delete("/api/dealer-users/:userId",async(req,reply)=>{
  const p=req.principal!;
  if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});
  const userId=z.string().uuid().parse((req.params as any).userId);
  if(userId===p.id)return reply.code(409).send({error:"cannot_remove_current_user"});
  const target=await db.query("select id,tenant_id from users where id=$1",[userId]);
  if(!target.rows[0])return reply.code(404).send({error:"user_not_found"});
  if(target.rows[0].tenant_id===p.tenantId){
    await db.query("update users set active=false where id=$1 and tenant_id=$2",[userId,p.tenantId]);
    await db.query("delete from sessions where user_id=$1",[userId]);
    await audit(db,p.tenantId,p.id,"dealer_user.deactivated","user",userId);
  }else{
    const removed=await db.query("delete from dealer_access where user_id=$1 and tenant_id=$2 returning id",[userId,p.tenantId]);
    if(!removed.rows[0])return reply.code(404).send({error:"dealer_access_not_found"});
    await audit(db,p.tenantId,p.id,"dealer_access.revoked","user",userId);
  }
  return {ok:true};
});

app.get("/api/dashboard",async(req)=>{const p=req.principal!;const [b,o]=await Promise.all([db.query("select status,count(*)::int count,coalesce(sum(estimated_total_minor),0)::bigint total from order_batches where tenant_id=$1 group by status",[p.tenantId]),db.query("select status,count(*)::int count from purchase_orders where tenant_id=$1 group by status",[p.tenantId])]);return {batches:b.rows,orders:o.rows};});
app.get("/api/automation",async(req)=>{
  const p=req.principal!,policy=await getAutomationPolicy(p.tenantId);
  const [accounts,orders,cards,batches]=await Promise.all([
    db.query("select count(*)::int total,count(*) filter(where credential_status in ('STORED','READY'))::int credentials_ready,count(*) filter(where auth_status='READY')::int authenticated,count(*) filter(where auth_status in ('AUTH_REQUIRED','CHALLENGE','LOCKED'))::int needs_attention from retailer_accounts where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status in ('READY','CLAIMED'))::int ready,count(*) filter(where status='OPENED')::int in_progress,count(*) filter(where status in ('REQUIRES_ACTION','FAILED'))::int needs_attention,count(*) filter(where status='CONFIRMED')::int confirmed,count(*) filter(where virtual_card_id is not null)::int cards_assigned from checkout_baskets where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status='ACTIVE')::int active from virtual_cards where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status in ('APPROVED','PARTIAL'))::int active,count(*) filter(where status='COMPLETE')::int complete from order_batches where tenant_id=$1",[p.tenantId])
  ]);
  const a=accounts.rows[0]||{},o=orders.rows[0]||{},v=cards.rows[0]||{},b=batches.rows[0]||{};
  return {
    policy,
    summary:{
      ready:Number(o.ready||0),
      inProgress:Number(o.in_progress||0),
      needsAttention:Number(o.needs_attention||0),
      confirmed:Number(o.confirmed||0)
    },
    workflows:[
      {id:"accounts",name:"Account authentication",status:Number(a.needs_attention||0)>0?"NEEDS_ATTENTION":Number(a.total||0)>0?"ACTIVE":"READY",detail:Number(a.authenticated||0)+" authenticated · "+Number(a.credentials_ready||0)+" credentials ready"},
      {id:"cards",name:"Virtual-card assignment",status:Number(o.cards_assigned||0)>0?"ACTIVE":Number(o.total||0)>0?"READY":"READY",detail:Number(o.cards_assigned||0)+" order cards assigned · "+Number(v.active||0)+" active cards"},
      {id:"checkout",name:"Checkout continuation",status:Number(o.needs_attention||0)>0?"NEEDS_ATTENTION":Number(o.in_progress||0)>0?"ACTIVE":Number(o.ready||0)>0?"READY":"IDLE",detail:Number(o.in_progress||0)+" in progress · "+Number(o.ready||0)+" ready"},
      {id:"confirmation",name:"Retailer confirmation",status:Number(o.confirmed||0)>0?"ACTIVE":"READY",detail:Number(o.confirmed||0)+" retailer-confirmed orders"},
      {id:"batch",name:"Batch protection",status:Number(b.active||0)>0?"ACTIVE":"READY",detail:"Pause threshold "+Number(policy.failure_pause_percent)+"% · "+Number(b.active||0)+" active batches"},
      {id:"reconciliation",name:"Order reconciliation",status:Number(b.complete||0)>0?"ACTIVE":"READY",detail:Number(b.complete||0)+" completed batches"}
    ],
    mandatoryRules:[
      {name:"One order, one virtual card",status:"ENFORCED"},
      {name:"Retailer-confirmed completion evidence",status:"ENFORCED"},
      {name:"Protected verification is never bypassed",status:"ENFORCED"}
    ],
    canEdit:["OWNER","APPROVER"].includes(p.role)
  };
});

app.put("/api/automation/policy",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"policy_permission_required"});
  const body=z.object({
    automationEnabled:z.boolean(),
    autoAssignVirtualCard:z.boolean(),
    autoContinueCheckout:z.boolean(),
    maxActiveOrders:z.number().int().min(1).max(50),
    failurePausePercent:z.number().min(0).max(100)
  }).parse(req.body);
  const {rows}=await db.query(
    "insert into automation_policies(tenant_id,automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,failure_pause_percent,updated_by,updated_at) values($1,$2,$3,$4,$5,$6,$7,now()) on conflict(tenant_id) do update set automation_enabled=excluded.automation_enabled,auto_assign_virtual_card=excluded.auto_assign_virtual_card,auto_continue_checkout=excluded.auto_continue_checkout,max_active_orders=excluded.max_active_orders,failure_pause_percent=excluded.failure_pause_percent,updated_by=excluded.updated_by,updated_at=now() returning automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,failure_pause_percent,updated_at",
    [p.tenantId,body.automationEnabled,body.autoAssignVirtualCard,body.autoContinueCheckout,body.maxActiveOrders,body.failurePausePercent,p.id]
  );
  await audit(db,p.tenantId,p.id,"automation.policy_updated","automation_policy",p.tenantId,body);
  return {policy:rows[0]};
});

app.get("/api/control-center",async(req)=>{
  const p=req.principal!;
  const [customers,accounts,baskets,cards,issuers,retailers]=await Promise.all([
    db.query(`select count(*)::int total from customers where tenant_id=$1 and active`,[p.tenantId]),
    db.query(`
      select count(*)::int total,
        count(*) filter(where credential_status in ('STORED','READY'))::int credentials_stored,
        count(*) filter(where auth_status='READY')::int authenticated,
        count(*) filter(where auth_status in ('AUTH_REQUIRED','CHALLENGE','LOCKED'))::int needs_attention
      from retailer_accounts where tenant_id=$1
    `,[p.tenantId]),
    db.query(`
      select count(*)::int total,
        count(*) filter(where cb.status in ('READY','CLAIMED'))::int ready,
        count(*) filter(where cb.status='OPENED')::int in_progress,
        count(*) filter(where cb.status in ('REQUIRES_ACTION','FAILED'))::int needs_attention,
        count(*) filter(where cb.status='CONFIRMED')::int confirmed,
        count(*) filter(where cb.virtual_card_id is not null)::int cards_bound,
        count(*) filter(where b.payment_route='Corporate virtual card' and cb.virtual_card_id is null and cb.status<>'CONFIRMED')::int cards_needed
      from checkout_baskets cb
      join order_batches b on b.id=cb.batch_id
      where cb.tenant_id=$1
    `,[p.tenantId]),
    db.query(`select count(*)::int total,count(*) filter(where status='ACTIVE')::int active from virtual_cards where tenant_id=$1`,[p.tenantId]),
    db.query(`select count(*)::int connected from issuer_connections where tenant_id=$1 and status='CONNECTED'`,[p.tenantId]),
    db.query(`select retailer,count(*)::int accounts from retailer_accounts where tenant_id=$1 group by retailer order by count(*) desc,retailer limit 50`,[p.tenantId])
  ]);
  return {
    service:"AVAILABLE",
    customers:Number(customers.rows[0]?.total||0),
    accounts:accounts.rows[0]||{total:0,credentials_stored:0,authenticated:0,needs_attention:0},
    orders:baskets.rows[0]||{total:0,ready:0,in_progress:0,needs_attention:0,confirmed:0,cards_bound:0,cards_needed:0},
    cards:{...cards.rows[0],programme_connected:Number(issuers.rows[0]?.connected||0)>0},
    retailers:retailers.rows
  };
});

app.get("/api/batches",async(req)=>{const p=req.principal!;const {rows}=await db.query(`select b.id,b.name,b.status,b.currency,b.payment_route,b.estimated_total_minor,b.created_at,count(i.id)::int item_count,count(distinct i.address_id)::int recipient_count from order_batches b left join batch_items i on i.batch_id=b.id where b.tenant_id=$1 group by b.id order by b.created_at desc limit 100`,[p.tenantId]);return {batches:rows};});
const retailerAccountColumns:Record<string,string>={
  amazon_account:"amazon-in",amazon_in_account:"amazon-in",amazon_user_id:"amazon-in",amazon_username:"amazon-in",amazon_login:"amazon-in",
  flipkart_account:"flipkart",flipkart_user_id:"flipkart",flipkart_username:"flipkart",flipkart_login:"flipkart",
  myntra_account:"myntra",myntra_user_id:"myntra",myntra_login:"myntra",
  ajio_account:"ajio",ajio_user_id:"ajio",ajio_login:"ajio",
  tata_cliq_account:"tatacliq",tatacliq_account:"tatacliq",tatacliq_user_id:"tatacliq",tatacliq_login:"tatacliq",
  meesho_account:"meesho",meesho_user_id:"meesho",meesho_login:"meesho",
  nykaa_account:"nykaa",nykaa_user_id:"nykaa",nykaa_login:"nykaa",
  jiomart_account:"jiomart",jiomart_user_id:"jiomart",jiomart_login:"jiomart"
};
const retailerPasswordColumns:Record<string,string[]>={
  "amazon-in":["amazon_password","amazon_in_password"],
  flipkart:["flipkart_password"],
  myntra:["myntra_password"],
  ajio:["ajio_password"],
  tatacliq:["tatacliq_password","tata_cliq_password"],
  meesho:["meesho_password"],
  nykaa:["nykaa_password"],
  jiomart:["jiomart_password"]
};
const retailerAliases:Record<string,string>={
  amazon:"amazon-in","amazon.in":"amazon-in","amazon-in":"amazon-in",
  flipkart:"flipkart","flipkart.com":"flipkart",myntra:"myntra","myntra.com":"myntra",
  ajio:"ajio","ajio.com":"ajio",tatacliq:"tatacliq","tatacliq.com":"tatacliq",
  meesho:"meesho","meesho.com":"meesho",nykaa:"nykaa","nykaa.com":"nykaa",
  jiomart:"jiomart","jiomart.com":"jiomart"
};
function retailerFromImport(value:string){
  const raw=value.trim().toLowerCase();
  if(!raw)return null;
  if(retailerAliases[raw])return retailerAliases[raw]!;
  try{
    const url=/^https:\/\//i.test(raw)?raw:`https://${raw.replace(/^www\./,"")}/`;
    return retailerForProductUrl(url).id;
  }catch{return null}
}

app.post("/api/address-books/import",async(req,reply)=>{
  const p=req.principal!;
  const file=await req.file();
  if(!file)return reply.code(400).send({error:"file_required"});
  const buffer=await file.toBuffer();
  let rows:string[][]=[];
  if(file.filename.toLowerCase().endsWith(".xlsx")){
    const workbook=new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet=workbook.worksheets[0];
    if(!sheet)return reply.code(400).send({error:"empty_workbook"});
    sheet.eachRow(r=>rows.push((r.values as any[]).slice(1).map(v=>String(v??"").trim())));
  }else{
    rows=buffer.toString("utf8").replace(/^\uFEFF/,"").split(/\r?\n/).filter(Boolean).map(line=>line.split(",").map(v=>v.trim().replace(/^"|"$/g,"")));
  }
  if(rows.length<2)return reply.code(400).send({error:"no_address_rows"});
  const headers=rows[0]!.map(h=>h.toLowerCase().replace(/[ _-]+/g,"_"));
  const required=["recipient","phone","line1","city","state","postal_code"];
  for(const h of required)if(!headers.includes(h))return reply.code(400).send({error:"missing_column",column:h});
  const value=(row:string[],name:string)=>{const i=headers.indexOf(name);return i<0?"":row[i]??""};
  const client=await db.connect();
  try{
    await client.query("begin");
    const book=await client.query("insert into address_books(tenant_id,name,created_by) values($1,$2,$3) returning id,name",[p.tenantId,file.filename.replace(/\.[^.]+$/,"").slice(0,120),p.id]);
    const ids:string[]=[];
    let retailerAccountsBound=0,credentialsStored=0;
    for(const row of rows.slice(1)){
      if(!row.some(Boolean))continue;
      const phone=value(row,"phone").replace(/\D/g,"");
      const postal=value(row,"postal_code").replace(/\D/g,"");
      if(phone.length<10||postal.length!==6)throw new Error("Invalid phone or postal code in address file");
      const externalReference=(value(row,"reference").trim()||`CUST-${randomUUID()}`).slice(0,160);
      const customer=await client.query(
        `insert into customers(tenant_id,external_reference,display_name,phone)
         values($1,$2,$3,$4)
         on conflict(tenant_id,external_reference) do update
         set display_name=excluded.display_name,phone=excluded.phone,updated_at=now()
         returning id,external_reference`,
        [p.tenantId,externalReference,value(row,"recipient"),phone]
      );
      const customerId=customer.rows[0].id;
      const inserted=await client.query(
        `insert into addresses(address_book_id,customer_id,recipient,phone,line1,line2,city,state,postal_code,country,reference)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [book.rows[0].id,customerId,value(row,"recipient"),phone,value(row,"line1"),value(row,"line2")||null,value(row,"city"),value(row,"state"),postal,(value(row,"country")||"IN").toUpperCase(),externalReference]
      );
      ids.push(inserted.rows[0].id);
      const importedAccounts=new Map<string,{accountReference:string;password:string}>();
      for(const [column,retailer] of Object.entries(retailerAccountColumns)){
        const accountReference=value(row,column).trim();
        if(!accountReference||importedAccounts.has(retailer))continue;
        const password=(retailerPasswordColumns[retailer]||[]).map(name=>value(row,name).trim()).find(Boolean)||"";
        importedAccounts.set(retailer,{accountReference,password});
      }
      const genericRetailer=retailerFromImport(value(row,"retailer"));
      const genericLogin=(value(row,"retailer_login")||value(row,"retailer_user_id")||value(row,"retailer_username")).trim();
      if(genericRetailer&&genericLogin&&!importedAccounts.has(genericRetailer)){
        importedAccounts.set(genericRetailer,{accountReference:genericLogin,password:value(row,"retailer_password").trim()});
      }
      for(const [retailer,credential] of importedAccounts){
        const account=await client.query(
          `insert into retailer_accounts(tenant_id,customer_id,retailer,account_reference,auth_status,credential_status)
           values($1,$2,$3,$4,'AUTH_REQUIRED',$5)
           on conflict(tenant_id,customer_id,retailer) do update
           set account_reference=excluded.account_reference,
               credential_status=case when excluded.credential_status='STORED' then 'STORED' else retailer_accounts.credential_status end,
               updated_at=now()
           returning id`,
          [p.tenantId,customerId,retailer,credential.accountReference.slice(0,240),credential.password?"STORED":"MISSING"]
        );
        retailerAccountsBound++;
        if(credential.password){
          const encrypted=encryptJson({password:credential.password},config.DATA_ENCRYPTION_KEY_BASE64);
          await client.query(
            `insert into private.retailer_credentials(tenant_id,retailer_account_id,ciphertext,iv,auth_tag,created_by,updated_at)
             values($1,$2,$3,$4,$5,$6,now())
             on conflict(tenant_id,retailer_account_id) do update
             set ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,created_by=excluded.created_by,updated_at=now()`,
            [p.tenantId,account.rows[0].id,encrypted.ciphertext,encrypted.iv,encrypted.authTag,p.id]
          );
          await client.query("update retailer_accounts set credential_status='STORED',last_credential_update_at=now(),updated_at=now() where id=$1",[account.rows[0].id]);
          credentialsStored++;
        }
      }
    }
    if(!ids.length)throw new Error("No valid address rows");
    await client.query("commit");
    await audit(db,p.tenantId,p.id,"address_book.imported","address_book",book.rows[0].id,{count:ids.length,retailerAccountsBound,credentialsStored});
    return reply.code(201).send({addressBook:book.rows[0],addressIds:ids,count:ids.length,retailerAccountsBound,credentialsStored});
  }catch(e){
    await client.query("rollback");
    throw e;
  }finally{
    client.release();
  }
});

app.get("/api/recipients",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select a.id,c.external_reference customer_reference,a.recipient,a.phone,a.city,a.state,a.postal_code,
      coalesce(jsonb_object_agg(ra.retailer,ra.account_reference) filter(where ra.id is not null),'{}'::jsonb) retailer_accounts
    from addresses a
    join address_books ab on ab.id=a.address_book_id
    join customers c on c.id=a.customer_id
    left join retailer_accounts ra on ra.customer_id=c.id and ra.tenant_id=ab.tenant_id
    where ab.tenant_id=$1
    group by a.id,c.external_reference
    order by a.created_at desc
    limit 5000
  `,[p.tenantId]);
  return {recipients:rows};
});

app.get("/api/customers",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select c.id,c.external_reference,c.display_name,c.phone,c.active,
      count(distinct ra.id)::int retailer_account_count,
      count(distinct a.id)::int address_count
    from customers c
    left join retailer_accounts ra on ra.customer_id=c.id and ra.tenant_id=c.tenant_id
    left join addresses a on a.customer_id=c.id
    where c.tenant_id=$1
    group by c.id
    order by c.external_reference
    limit 2000
  `,[p.tenantId]);
  return {customers:rows};
});

app.get("/api/retailer-accounts",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select ra.id,ra.customer_id,c.external_reference customer_reference,c.display_name,
      ra.retailer,ra.account_reference,ra.profile_key,ra.auth_status,ra.credential_status,ra.last_authenticated_at,ra.last_credential_update_at,ra.updated_at
    from retailer_accounts ra
    join customers c on c.id=ra.customer_id
    where ra.tenant_id=$1
    order by c.external_reference,ra.retailer
    limit 5000
  `,[p.tenantId]);
  return {accounts:rows};
});

app.put("/api/customers/:customerId/retailer-accounts/:retailer",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const customerId=z.string().uuid().parse((req.params as any).customerId);
  const retailer=z.string().regex(/^(amazon-in|flipkart|myntra|ajio|tatacliq|meesho|nykaa|jiomart|store:[a-z0-9.-]+)$/).parse((req.params as any).retailer);
  const body=z.object({accountReference:z.string().min(1).max(240)}).parse(req.body);
  const customer=await db.query("select 1 from customers where id=$1 and tenant_id=$2 and active",[customerId,p.tenantId]);
  if(!customer.rows[0])return reply.code(404).send({error:"customer_not_found"});
  const {rows}=await db.query(
    `insert into retailer_accounts(tenant_id,customer_id,retailer,account_reference,auth_status)
     values($1,$2,$3,$4,'AUTH_REQUIRED')
     on conflict(tenant_id,customer_id,retailer) do update
     set account_reference=excluded.account_reference,auth_status='AUTH_REQUIRED',updated_at=now()
     returning id,customer_id,retailer,account_reference,profile_key,auth_status`,
    [p.tenantId,customerId,retailer,body.accountReference]
  );
  await audit(db,p.tenantId,p.id,"retailer_account.bound","retailer_account",rows[0].id,{customerId,retailer});
  return rows[0];
});

app.get("/api/checkout-tasks",async(req)=>{const p=req.principal!;const {rows}=await db.query(`select po.id,po.status,po.amount_minor,po.failure_message,bi.product_url,bi.title,bi.requested_quantity,a.id address_id,a.recipient,a.city,a.postal_code from purchase_orders po join batch_items bi on bi.id=po.batch_item_id left join addresses a on a.id=bi.address_id where po.tenant_id=$1 order by po.created_at desc limit 250`,[p.tenantId]);return {tasks:rows};});

app.post("/api/execution-worker/heartbeat",async(req)=>{const p=req.principal!;const body=z.object({workerId:z.string().min(8).max(128),hostname:z.string().max(120).optional(),mode:z.enum(["BULK"]).default("BULK")}).parse(req.body??{});await db.query(`insert into execution_workers(id,tenant_id,user_id,hostname,mode,last_seen) values($1,$2,$3,$4,$5,now()) on conflict(tenant_id,id) do update set user_id=excluded.user_id,hostname=excluded.hostname,mode=excluded.mode,last_seen=now()`,[body.workerId,p.tenantId,p.id,body.hostname??null,body.mode]);return {ok:true};});
app.get("/api/execution-workers",async(req)=>{const p=req.principal!;const {rows}=await db.query("select id,hostname,mode,last_seen from execution_workers where tenant_id=$1 and last_seen>now()-interval '30 seconds' order by last_seen desc",[p.tenantId]);return {workers:rows};});
app.post("/api/execution-worker/:workerId/claim",async(req,reply)=>{const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId),body=z.object({limit:z.number().int().min(1).max(25).default(25)}).parse(req.body??{}),client=await db.connect();try{await client.query("begin");const live=await client.query("select 1 from execution_workers where tenant_id=$1 and id=$2 and last_seen>now()-interval '30 seconds' for update",[p.tenantId,workerId]);if(!live.rows[0]){await client.query("rollback");return reply.code(409).send({error:"execution_worker_not_online"})}const picked=await client.query("select id from checkout_baskets where tenant_id=$1 and status='CLAIMED' and execution_worker_id is null and expires_at>now() order by created_at for update skip locked limit $2",[p.tenantId,body.limit]);for(const row of picked.rows)await client.query("update checkout_baskets set execution_worker_id=$1,updated_at=now() where id=$2",[workerId,row.id]);await client.query("commit");return {assigned:picked.rows.length};}catch(error){await client.query("rollback");throw error}finally{client.release()}});


app.get("/api/issuers",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query("select id,provider,status,connected_at,updated_at from issuer_connections where tenant_id=$1 order by provider",[p.tenantId]);
  return {issuers:rows};
});
app.get("/api/funding-policies",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select fp.id,fp.name,fp.retailer,fp.issuer_provider,fp.issuer_connection_id,
      fp.min_amount_minor,fp.max_amount_minor,fp.priority,fp.active,ic.status issuer_status
    from funding_policies fp
    left join issuer_connections ic on ic.id=fp.issuer_connection_id
    where fp.tenant_id=$1 order by fp.priority,fp.created_at
  `,[p.tenantId]);
  return {policies:rows};
});
app.post("/api/funding-policies",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const body=z.object({
    name:z.string().min(2).max(120),
    retailer:z.string().max(160).nullable().optional(),
    issuerConnectionId:z.string().uuid(),
    minAmountMinor:z.number().int().min(0).default(0),
    maxAmountMinor:z.number().int().min(0).nullable().optional(),
    priority:z.number().int().min(1).max(10000).default(100)
  }).parse(req.body);
  if(body.maxAmountMinor!==null&&body.maxAmountMinor!==undefined&&body.maxAmountMinor<body.minAmountMinor)return reply.code(400).send({error:"invalid_amount_range"});
  const issuer=await db.query("select id,provider from issuer_connections where id=$1 and tenant_id=$2 and status='CONNECTED'",[body.issuerConnectionId,p.tenantId]);
  if(!issuer.rows[0])return reply.code(409).send({error:"issuer_not_connected"});
  const {rows}=await db.query(
    `insert into funding_policies(tenant_id,name,retailer,issuer_provider,issuer_connection_id,min_amount_minor,max_amount_minor,priority,active)
     values($1,$2,$3,$4,$5,$6,$7,$8,true)
     returning id,name,retailer,issuer_provider,issuer_connection_id,min_amount_minor,max_amount_minor,priority,active`,
    [p.tenantId,body.name,body.retailer??null,issuer.rows[0].provider,body.issuerConnectionId,body.minAmountMinor,body.maxAmountMinor??null,body.priority]
  );
  await audit(db,p.tenantId,p.id,"funding_policy.created","funding_policy",rows[0].id,{issuerProvider:issuer.rows[0].provider,retailer:body.retailer??null});
  return reply.code(201).send(rows[0]);
});
app.delete("/api/funding-policies/:id",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id);
  const {rows}=await db.query("delete from funding_policies where id=$1 and tenant_id=$2 returning id",[id,p.tenantId]);
  if(!rows[0])return reply.code(404).send({error:"funding_policy_not_found"});
  await audit(db,p.tenantId,p.id,"funding_policy.deleted","funding_policy",id);
  return {ok:true};
});

app.get("/api/cards/provider",async(req)=>{const p=req.principal!,state=await loadTenantIssuer(db,config,p.tenantId);return {provider:state.issuer.provider,configured:state.issuer.configured(),source:state.source};});
app.post("/api/cards/provider/connect",async(req,reply)=>{const p=req.principal!;if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});const httpsUrl=z.string().url().refine(v=>new URL(v).protocol==="https:",{message:"HTTPS URL required"});const body=z.object({provider:z.literal("enkash"),baseUrl:httpsUrl,tokenUrl:httpsUrl,partnerId:z.string().min(1).max(200),basicAuth:z.string().min(1).max(1000),username:z.string().min(1).max(200),password:z.string().min(1).max(500),clientId:z.string().min(1).max(200),companyId:z.string().min(1).max(200),cardAccountId:z.string().min(1).max(200)}).parse(req.body);try{const issuer=await testAndSaveEnKashConnection(db,config,{tenantId:p.tenantId,userId:p.id,credentials:{ENKASH_BASE_URL:body.baseUrl,ENKASH_TOKEN_URL:body.tokenUrl,ENKASH_PARTNER_ID:body.partnerId,ENKASH_BASIC_AUTH:body.basicAuth,ENKASH_USERNAME:body.username,ENKASH_PASSWORD:body.password,ENKASH_CLIENT_ID:body.clientId,ENKASH_COMPANY_ID:body.companyId,ENKASH_CARD_ACCOUNT_ID:body.cardAccountId}});await audit(db,p.tenantId,p.id,"issuer.connected","issuer_connection",null,{provider:"enkash"});return {provider:issuer.provider,configured:true,source:"tenant"};}catch(error:any){req.log.warn({err:String(error.message).slice(0,160)},"issuer connection test failed");return reply.code(400).send({error:"issuer_connection_failed",message:String(error.message).slice(0,160)})}});
app.delete("/api/cards/provider",async(req,reply)=>{const p=req.principal!;if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});await disconnectTenantIssuer(db,p.tenantId);await audit(db,p.tenantId,p.id,"issuer.disconnected","issuer_connection",null,{provider:"enkash"});return {ok:true};});
app.get("/api/cards",async(req)=>{
  const p=req.principal!,state=await loadTenantIssuer(db,config,p.tenantId);
  const {rows}=await db.query(`
    select vc.id,vc.provider,vc.provider_card_id,vc.provider_account_id,vc.label,vc.masked_number,
      vc.status,vc.balance_minor,vc.currency,vc.merchant_control,vc.customer_id,vc.checkout_basket_id,vc.created_at,
      c.external_reference customer_reference
    from virtual_cards vc
    left join customers c on c.id=vc.customer_id
    where vc.tenant_id=$1
    order by vc.created_at desc limit 500
  `,[p.tenantId]);
  return {cards:rows,provider:state.issuer.provider,configured:state.issuer.configured(),source:state.source};
});

app.post("/api/cards",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const state=await loadTenantIssuer(db,config,p.tenantId),cardIssuer=state.issuer;
  if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});
  const input=z.object({
    quantity:z.number().int().min(1).max(100),
    amountMinor:z.number().int().min(100),
    merchantControl:z.string().min(1).max(120).default("Approved retailers"),
    label:z.string().max(120).optional(),
    customerId:z.string().uuid().optional(),
    checkoutBasketId:z.string().uuid().optional(),
    cardholder:z.object({
      email:z.string().email(),
      mobile:z.string().regex(/^\d{10,15}$/),
      firstName:z.string().min(1).max(60),
      lastName:z.string().min(1).max(60),
      gender:z.enum(["M","F","O"]),
      pan:z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
      specialDate:z.string().regex(/^\d{2}-\d{2}-\d{4}$/)
    })
  }).parse(req.body);

  let ownerCustomerId=input.customerId??null;
  let ownerBasketId=input.checkoutBasketId??null;
  if(ownerBasketId){
    const basket=await db.query("select customer_id from checkout_baskets where id=$1 and tenant_id=$2",[ownerBasketId,p.tenantId]);
    if(!basket.rows[0])return reply.code(404).send({error:"basket_not_found"});
    if(ownerCustomerId&&ownerCustomerId!==basket.rows[0].customer_id)return reply.code(409).send({error:"basket_customer_mismatch"});
    ownerCustomerId=basket.rows[0].customer_id;
    if(input.quantity!==1)return reply.code(400).send({error:"one_card_per_basket_required"});
  }
  if(ownerCustomerId){
    const customer=await db.query("select 1 from customers where id=$1 and tenant_id=$2 and active",[ownerCustomerId,p.tenantId]);
    if(!customer.rows[0])return reply.code(404).send({error:"customer_not_found"});
  }

  const cards:any[]=[],failures:any[]=[];
  for(let i=0;i<input.quantity;i++){
    try{
      const issued=await cardIssuer.createCard({cardholder:input.cardholder,label:input.label||`OrderGrid card ${i+1}`});
      const inserted=await db.query(
        `insert into virtual_cards(tenant_id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,merchant_control,created_by,customer_id,checkout_basket_id)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,customer_id,checkout_basket_id,created_at`,
        [p.tenantId,issued.provider,issued.providerCardId,issued.providerAccountId,input.label||`Procurement card ${i+1}`,issued.maskedNumber??null,issued.status,issued.balanceMinor,input.merchantControl,p.id,ownerCustomerId,ownerBasketId]
      );
      const card=inserted.rows[0];
      try{
        await cardIssuer.loadCard({providerCardId:issued.providerCardId,providerAccountId:issued.providerAccountId,amountMinor:input.amountMinor,reference:`ordergrid-${card.id}`});
        const loaded=await db.query(
          "update virtual_cards set balance_minor=balance_minor+$1,status='ACTIVE',updated_at=now() where id=$2 returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,customer_id,checkout_basket_id,created_at",
          [input.amountMinor,card.id]
        );
        cards.push(loaded.rows[0]);
        if(ownerBasketId)await db.query("update checkout_baskets set virtual_card_id=$1,updated_at=now() where id=$2 and tenant_id=$3",[card.id,ownerBasketId,p.tenantId]);
        await audit(db,p.tenantId,p.id,"virtual_card.created_and_loaded","virtual_card",card.id,{provider:issued.provider,amountMinor:input.amountMinor,merchantControl:input.merchantControl,customerId:ownerCustomerId,checkoutBasketId:ownerBasketId});
      }catch(error:any){
        await db.query("update virtual_cards set status='LOAD_FAILED',updated_at=now() where id=$1",[card.id]);
        failures.push({index:i+1,providerCardId:issued.providerCardId,error:String(error.message).slice(0,180)});
        await audit(db,p.tenantId,p.id,"virtual_card.load_failed","virtual_card",card.id,{provider:issued.provider,error:String(error.message).slice(0,180)});
      }
    }catch(error:any){failures.push({index:i+1,error:String(error.message).slice(0,180)})}
  }
  return reply.code(cards.length?201:502).send({created:cards.length,failed:failures.length,cards,failures});
});

app.post("/api/cards/:id/load",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const state=await loadTenantIssuer(db,config,p.tenantId),cardIssuer=state.issuer;if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});const id=z.string().uuid().parse((req.params as any).id),body=z.object({amountMinor:z.number().int().min(100)}).parse(req.body);const {rows}=await db.query("select id,provider_card_id,provider_account_id from virtual_cards where id=$1 and tenant_id=$2",[id,p.tenantId]);if(!rows[0])return reply.code(404).send({error:"card_not_found"});await cardIssuer.loadCard({providerCardId:rows[0].provider_card_id,providerAccountId:rows[0].provider_account_id,amountMinor:body.amountMinor,reference:`ordergrid-load-${id}-${Date.now()}`});const updated=await db.query("update virtual_cards set balance_minor=balance_minor+$1,status='ACTIVE',updated_at=now() where id=$2 returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,created_at",[body.amountMinor,id]);await audit(db,p.tenantId,p.id,"virtual_card.loaded","virtual_card",id,{amountMinor:body.amountMinor});return updated.rows[0];});

app.get("/api/bulk-baskets",async(req)=>{
  const p=req.principal!;
  await db.query("update checkout_baskets set status='READY',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);
  const {rows}=await db.query(`
    select cb.id,cb.batch_id,cb.status,cb.retailer,cb.account_reference,cb.expires_at,cb.failure_code,cb.failure_message,
           cb.customer_id,cb.retailer_account_id,cb.issuer_connection_id,cb.virtual_card_id,cb.payment_status,
           c.external_reference customer_reference,
           ra.profile_key,ra.auth_status,ra.credential_status,
           a.recipient,a.city,a.postal_code,b.name batch_name,b.payment_route,
           count(po.id)::int item_count,coalesce(sum(po.amount_minor),0)::bigint amount_minor
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    join addresses a on a.id=cb.address_id
    join customers c on c.id=cb.customer_id
    join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join purchase_orders po on po.checkout_basket_id=cb.id
    where cb.tenant_id=$1
    group by cb.id,c.external_reference,ra.profile_key,ra.auth_status,a.recipient,a.city,a.postal_code,b.name,b.payment_route
    order by cb.created_at desc limit 500
  `,[p.tenantId]);
  return {baskets:rows};
});

app.post("/api/bulk-queue/claim",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const {limit}=z.object({limit:z.number().int().min(1).max(25).default(10)}).parse(req.body??{});const client=await db.connect();try{await client.query("begin");await client.query("update checkout_baskets set status='READY',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);const picked=await client.query("select id from checkout_baskets where tenant_id=$1 and status='READY' order by created_at for update skip locked limit $2",[p.tenantId,limit]);const ids:string[]=[];for(const row of picked.rows){await client.query("update checkout_baskets set status='CLAIMED',claimed_by=$1,execution_worker_id=null,expires_at=now()+interval '20 minutes',updated_at=now() where id=$2",[p.id,row.id]);ids.push(row.id);}await client.query("commit");for(const basketId of ids){
  await assignFundingRoute(db,p.tenantId,basketId);
  let cardId=await assignAvailableVirtualCard(db,p.tenantId,basketId);
  if(!cardId){
    const card=await ensureBasketVirtualCard(db,config,p.tenantId,basketId,p.id);
    cardId=card.cardId;
    if(card.status==="PROGRAMME_REQUIRED"||card.status==="CARDHOLDER_PROFILE_REQUIRED"){
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',failure_code='PAYMENT_SETUP_REQUIRED',failure_message='Payment setup required before checkout can continue',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
        [basketId,p.tenantId]
      );
    }
  }
}await audit(db,p.tenantId,p.id,"bulk_queue.claimed","checkout_basket",null,{count:ids.length});return {claimed:ids.length,ids};}catch(e){await client.query("rollback");throw e}finally{client.release()}});

app.get("/api/bulk-queue",async(req,reply)=>{
  const p=req.principal!,worker=z.string().min(8).max(128).safeParse((req.query as any)?.workerId);
  if(!worker.success)return reply.code(400).send({error:"worker_id_required"});
  await db.query("update checkout_baskets set status='READY',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);
  const {rows}=await db.query(`
    select cb.id,cb.status,cb.retailer,cb.account_reference,cb.expires_at,cb.opened_at,cb.failure_code,cb.failure_message,
           cb.customer_id,cb.retailer_account_id,
           c.external_reference customer_reference,
           ra.profile_key,ra.auth_status,
           a.recipient,a.city,a.postal_code,b.name batch_name,b.payment_route,
           count(po.id)::int item_count,coalesce(sum(po.amount_minor),0)::bigint amount_minor
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    join addresses a on a.id=cb.address_id
    join customers c on c.id=cb.customer_id
    join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join purchase_orders po on po.checkout_basket_id=cb.id
    where cb.tenant_id=$1 and cb.execution_worker_id=$2 and cb.status in ('CLAIMED','OPENED','REQUIRES_ACTION')
    group by cb.id,c.external_reference,ra.profile_key,ra.auth_status,a.recipient,a.city,a.postal_code,b.name,b.payment_route
    order by cb.created_at
  `,[p.tenantId,worker.data]);
  return {baskets:rows};
});

app.post("/api/bulk-queue/:id/open",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id),body=z.object({workerId:z.string().min(8).max(128)}).parse(req.body);
  const {rows}=await db.query(`
    update checkout_baskets cb
    set status='OPENED',opened_at=coalesce(opened_at,now()),expires_at=now()+interval '20 minutes',failure_code=null,failure_message=null,updated_at=now()
    from addresses a,order_batches b,customers c,retailer_accounts ra
    where cb.id=$1 and cb.tenant_id=$2 and cb.execution_worker_id=$3
      and cb.status in ('CLAIMED','OPENED','REQUIRES_ACTION')
      and (cb.expires_at>now() or cb.status='REQUIRES_ACTION')
      and a.id=cb.address_id and b.id=cb.batch_id
      and c.id=cb.customer_id and ra.id=cb.retailer_account_id
    returning cb.id,cb.customer_id,cb.retailer_account_id,cb.retailer,cb.account_reference,
      c.external_reference customer_reference,ra.profile_key,ra.auth_status,
      a.recipient,a.line1,a.line2,a.city,a.state,a.postal_code,a.country,b.payment_route
  `,[id,p.tenantId,body.workerId]);
  if(!rows[0])return reply.code(409).send({error:"basket_unavailable_or_expired"});
  const items=await db.query(`
    select po.id purchase_order_id,bi.product_url,bi.title,bi.requested_quantity,po.amount_minor
    from purchase_orders po join batch_items bi on bi.id=po.batch_item_id
    where po.checkout_basket_id=$1 and po.tenant_id=$2
    order by po.created_at
  `,[id,p.tenantId]);
  const prepared=items.rows.map(item=>({...item,executionUrl:verifiedRetailerUrl(item.product_url)}));
  let credentials:null|{login:string;password:string}=null;
  const storedCredential=await db.query(
    `select ciphertext,iv,auth_tag from private.retailer_credentials where tenant_id=$1 and retailer_account_id=$2 limit 1`,
    [p.tenantId,rows[0].retailer_account_id]
  );
  if(storedCredential.rows[0]){
    const decrypted=decryptJson({
      ciphertext:storedCredential.rows[0].ciphertext,
      iv:storedCredential.rows[0].iv,
      authTag:storedCredential.rows[0].auth_tag
    },config.DATA_ENCRYPTION_KEY_BASE64) as {password?:string};
    if(decrypted.password){
      credentials={login:rows[0].account_reference,password:String(decrypted.password)};
      await db.query("update private.retailer_credentials set last_used_at=now() where tenant_id=$1 and retailer_account_id=$2",[p.tenantId,rows[0].retailer_account_id]);
    }
  }
  await audit(db,p.tenantId,p.id,"bulk_basket.execution_started","checkout_basket",id,{workerId:body.workerId,customerId:rows[0].customer_id,retailerAccountId:rows[0].retailer_account_id,items:prepared.length});
  reply.header("cache-control","no-store");
  return {
    basketId:id,
    customerId:rows[0].customer_id,
    customerReference:rows[0].customer_reference,
    retailerAccountId:rows[0].retailer_account_id,
    profileKey:rows[0].profile_key,
    accountReference:rows[0].account_reference,
    retailer:rows[0].retailer,
    authStatus:rows[0].auth_status,
    credentials,
    paymentRoute:rows[0].payment_route,
    address:{recipient:rows[0].recipient,line1:rows[0].line1,line2:rows[0].line2,city:rows[0].city,state:rows[0].state,postalCode:rows[0].postal_code,country:rows[0].country},
    items:prepared
  };
});

app.post("/api/bulk-queue/:id/progress",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({workerId:z.string().min(8).max(128),state:z.enum(["RUNNING","CHALLENGE","FAILED"]),code:z.string().max(80).optional(),message:z.string().max(500).optional()}).parse(req.body);
  const status=body.state==="RUNNING"?"OPENED":body.state==="CHALLENGE"?"REQUIRES_ACTION":"FAILED";
  const {rows}=await db.query(
    "update checkout_baskets set status=$1,failure_code=$2,failure_message=$3,expires_at=case when $1='OPENED' then now()+interval '20 minutes' else expires_at end,updated_at=now() where id=$4 and tenant_id=$5 and execution_worker_id=$6 and status in ('CLAIMED','OPENED','REQUIRES_ACTION') returning id,status,retailer_account_id",
    [status,body.code??null,body.message??null,id,p.tenantId,body.workerId]
  );
  if(!rows[0])return reply.code(409).send({error:"basket_not_owned_by_worker"});
  if(body.state==="CHALLENGE"){
    const authStatus=/LOGIN|PASSWORD|AUTH/i.test(body.code??"")?"AUTH_REQUIRED":"CHALLENGE";
    await db.query("update retailer_accounts set auth_status=$1,credential_status=case when $1='AUTH_REQUIRED' and credential_status='READY' then 'STORED' else credential_status end,updated_at=now() where id=$2 and tenant_id=$3",[authStatus,rows[0].retailer_account_id,p.tenantId]);
    if(/PAYMENT|3DS|CARD/i.test(body.code??""))await db.query("update checkout_baskets set payment_status='VERIFICATION_REQUIRED',updated_at=now() where id=$1 and tenant_id=$2",[id,p.tenantId]);
  }else if(body.state==="FAILED"){
    await db.query("update checkout_baskets set payment_status=case when payment_status='PENDING' then 'FAILED' else payment_status end,updated_at=now() where id=$1 and tenant_id=$2",[id,p.tenantId]);
  }
  await audit(db,p.tenantId,p.id,"bulk_basket.progress","checkout_basket",id,{workerId:body.workerId,state:body.state,code:body.code??null,retailerAccountId:rows[0].retailer_account_id});
  return {id:rows[0].id,status:rows[0].status};
});

app.get("/api/bulk-baskets/:id/browser-checkout",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);
  const basket=await db.query(
    `select cb.id,cb.retailer from checkout_baskets cb where cb.id=$1 and cb.tenant_id=$2`,
    [id,p.tenantId]
  );
  if(!basket.rows[0])return reply.code(404).send({error:"basket_not_found"});
  const items=await db.query(
    `select bi.product_url,bi.requested_quantity
     from purchase_orders po join batch_items bi on bi.id=po.batch_item_id
     where po.checkout_basket_id=$1 and po.tenant_id=$2
     order by po.created_at`,
    [id,p.tenantId]
  );
  if(!items.rows.length)return reply.code(409).send({error:"basket_has_no_items"});
  let checkoutUrl=verifiedRetailerUrl(items.rows[0].product_url);
  if(basket.rows[0].retailer==="amazon-in"){
    const parts:string[]=[];let n=1;
    for(const item of items.rows){
      const url=new URL(item.product_url);
      const match=url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
      const asin=(match?.[1]||url.searchParams.get("asin")||"").toUpperCase();
      if(!/^[A-Z0-9]{10}$/.test(asin))continue;
      parts.push(`ASIN.${n}=${encodeURIComponent(asin)}`);
      parts.push(`Quantity.${n}=${Math.max(1,Number(item.requested_quantity||1))}`);
      n++;
    }
    if(parts.length)checkoutUrl="https://www.amazon.in/gp/aws/cart/add.html?"+parts.join("&");
  }
  if(String((req.query as any)?.redirect||"")==="1")return reply.redirect(checkoutUrl);
  return {checkoutUrl,retailer:basket.rows[0].retailer,basketId:id};
});

app.post("/api/bulk-queue/:id/retry",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const {rows}=await db.query("update checkout_baskets set status='READY',claimed_by=null,execution_worker_id=null,expires_at=null,opened_at=null,failure_code=null,failure_message=null,updated_at=now() where id=$1 and tenant_id=$2 and status in ('REQUIRES_ACTION','FAILED') returning id,status",[id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"basket_not_retryable"});await audit(db,p.tenantId,p.id,"bulk_basket.retry_requested","checkout_basket",id);return rows[0];});

app.post("/api/bulk-queue/:id/confirm",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({workerId:z.string().min(8).max(128),retailerOrderId:z.string().min(3).max(80)}).parse(req.body);
  const retailerOrderId=validateRetailerOrderId(body.retailerOrderId),client=await db.connect();
  try{
    await client.query("begin");
    const locked=await client.query(
      "select batch_id,customer_id,retailer_account_id from checkout_baskets where id=$1 and tenant_id=$2 and execution_worker_id=$3 and status in ('CLAIMED','OPENED','REQUIRES_ACTION') and (expires_at>now() or status='REQUIRES_ACTION') for update",
      [id,p.tenantId,body.workerId]
    );
    if(!locked.rows[0]){await client.query("rollback");return reply.code(409).send({error:"basket_unavailable_or_expired"})}
    await client.query("update purchase_orders set status='CONFIRMED',retailer_order_id=$1,failure_code=null,failure_message=null,updated_at=now() where checkout_basket_id=$2 and tenant_id=$3 and status in ('REQUIRES_ACTION','PLACED')",[retailerOrderId,id,p.tenantId]);
    await client.query("update checkout_baskets set status='CONFIRMED',payment_status='CONFIRMED',retailer_order_id=$1,confirmed_at=now(),updated_at=now() where id=$2",[retailerOrderId,id]);
    await client.query("update retailer_accounts set auth_status='READY',credential_status=case when credential_status='STORED' then 'READY' else credential_status end,last_authenticated_at=now(),updated_at=now() where id=$1 and tenant_id=$2",[locked.rows[0].retailer_account_id,p.tenantId]);
    await client.query("update order_batches b set status=case when not exists(select 1 from checkout_baskets x where x.batch_id=b.id and x.status<>'CONFIRMED') then 'COMPLETE' else 'PARTIAL' end,updated_at=now() where b.id=$1",[locked.rows[0].batch_id]);
    await client.query("commit");
    await audit(db,p.tenantId,p.id,"bulk_basket.confirmed_by_worker","checkout_basket",id,{workerId:body.workerId,retailerOrderId,customerId:locked.rows[0].customer_id,retailerAccountId:locked.rows[0].retailer_account_id});
    return {id,status:"CONFIRMED",retailerOrderId};
  }catch(e){await client.query("rollback");throw e}finally{client.release()}
});

app.get("/api/reports/orders.csv",async(req,reply)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select po.id,po.status,po.retailer,po.retailer_order_id,po.amount_minor,po.failure_code,po.failure_message,
      c.external_reference customer_reference,ra.account_reference retailer_account_reference,
      a.recipient,a.city,a.postal_code,po.updated_at
    from purchase_orders po
    join batch_items bi on bi.id=po.batch_item_id
    left join addresses a on a.id=bi.address_id
    left join customers c on c.id=a.customer_id
    left join checkout_baskets cb on cb.id=po.checkout_basket_id
    left join retailer_accounts ra on ra.id=cb.retailer_account_id
    where po.tenant_id=$1 order by po.created_at
  `,[p.tenantId]);
  const csvCell=(v:unknown)=>`"${String(v??"").replaceAll('"','""')}"`;
  const columns=["id","customer_reference","retailer","retailer_account_reference","status","retailer_order_id","amount_minor","failure_code","failure_message","recipient","city","postal_code","updated_at"];
  const csv=[columns.join(","),...rows.map(r=>columns.map(k=>csvCell(r[k])).join(","))].join("\n");
  reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",'attachment; filename="ordergrid-orders.csv"');
  return csv;
});

app.post("/api/batches",async(req,reply)=>{const p=req.principal!;const input=z.object({name:z.string().min(3).max(120),paymentRoute:z.enum(["Corporate virtual card","Cash on Delivery"]).default("Corporate virtual card"),items:z.array(z.object({productUrl:z.string().url(),quantity:z.number().int().positive().max(10000),addressId:z.string().uuid().optional(),estimatedUnitPriceMinor:z.number().int().positive().optional()})).min(1).max(5000)}).parse(req.body); const c=await db.connect();try{await c.query("begin");const fullyEstimated=input.items.every(i=>i.estimatedUnitPriceMinor);if(!fullyEstimated&&!jobs)return reply.code(422).send({error:"estimated_price_required"});const total=input.items.reduce((sum,i)=>sum+(i.estimatedUnitPriceMinor??0)*i.quantity,0);const b=await c.query("insert into order_batches(tenant_id,name,created_by,status,estimated_total_minor,payment_route) values($1,$2,$3,$4,$5,$6) returning id,status",[p.tenantId,input.name,fullyEstimated?"AWAITING_APPROVAL":"DRAFT",total,input.paymentRoute]);for(const item of input.items){const retailer=retailerForProductUrl(item.productUrl).id;await c.query("insert into batch_items(batch_id,product_url,retailer,requested_quantity,address_id,unit_price_minor,pricing_status,pricing_checked_at) values($1,$2,$3,$4,$5,$6,$7,$8)",[b.rows[0].id,item.productUrl,retailer,item.quantity,item.addressId??null,item.estimatedUnitPriceMinor??null,item.estimatedUnitPriceMinor?"ESTIMATED":"PENDING",item.estimatedUnitPriceMinor?new Date():null]);}await c.query("commit");await audit(db,p.tenantId,p.id,"batch.created","order_batch",b.rows[0].id,{items:input.items.length,total});if(!fullyEstimated&&jobs)await jobs.queue.add("price-batch",{batchId:b.rows[0].id,tenantId:p.tenantId},{jobId:`price:${b.rows[0].id}`,attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:1000});return reply.code(201).send(b.rows[0]);}catch(e){await c.query("rollback");throw e}finally{c.release()}});
app.post("/api/batches/:id/approve",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const id=z.string().uuid().parse((req.params as any).id);const {rows}=await db.query("update order_batches set status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now() where id=$2 and tenant_id=$3 and status='AWAITING_APPROVAL' returning id",[p.id,id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"batch_not_approvable"});await audit(db,p.tenantId,p.id,"batch.approved","order_batch",id);if(jobs){await jobs.queue.add("place-batch",{batchId:id,tenantId:p.tenantId},{jobId:`place:${id}`,attempts:3,backoff:{type:"exponential",delay:5000}});}else{await db.query(`insert into purchase_orders(tenant_id,batch_item_id,status,retailer,amount_minor,idempotency_key) select $1,i.id,'REQUIRES_ACTION',i.retailer,i.unit_price_minor*i.requested_quantity,$2||i.id from batch_items i where i.batch_id=$3 on conflict(idempotency_key) do update set amount_minor=excluded.amount_minor,failure_code=null,failure_message=null,updated_at=now()`,[p.tenantId,`basket:${id}:`,id]);await syncCheckoutBaskets(db,p.tenantId,id);}return {ok:true};});
app.setErrorHandler((error,req,reply)=>{req.log.error(error);if(error instanceof z.ZodError)return reply.code(400).send({error:"invalid_request",issues:error.issues});return reply.code(500).send({error:"internal_error",requestId:req.id});});

async function bootstrap(){const {rows}=await db.query("select count(*)::int count from users");if(rows[0].count)return;const c=await db.connect();try{await c.query("begin");const t=await c.query("insert into tenants(name) values('OrderGrid') returning id");await c.query("insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,'OWNER')",[t.rows[0].id,config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD)]);await c.query("commit");}catch(e){await c.query("rollback");throw e}finally{c.release()}}
await bootstrap(); await app.listen({port:config.PORT,host:"0.0.0.0"});
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{await app.close();if(jobs){await jobs.queue.close();jobs.connection.disconnect();}await db.end();process.exit(0)});
