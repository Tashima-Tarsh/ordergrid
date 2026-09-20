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
import { disconnectTenantIssuer, loadTenantIssuer, testAndSaveBankConnection, testAndSaveEnKashConnection } from "./issuer-connections.js";
import { assignAvailableVirtualCard, assignFundingRoute } from "./funding-router.js";
import { ensureBasketVirtualCard } from "./card-provisioning.js";
import { buildGstWorkbook, createGstInvoice, renderGstInvoiceHtml } from "./gst-reporting.js";
import { stateCodeForName, validateGstin } from "./gst.js";
import { BANK_VIRTUAL_CARD_PROFILES } from "./bank-card-issuer.js";
import { buildUserDashboardCsv, buildUserDashboardWorkbook, getUserDashboard } from "./user-dashboard-reporting.js";

const config=loadConfig(), db=createDb(config), jobs=config.REDIS_URL?createOrderQueue(config.REDIS_URL):null;
type AutomationPolicy={
  automation_enabled:boolean;
  auto_assign_virtual_card:boolean;
  auto_continue_checkout:boolean;
  max_active_orders:number;
  failure_pause_percent:number|string;
  max_price_increase_percent:number|string;
  max_order_value_minor:number|string;
  max_batch_variance_percent:number|string;
  price_breach_action:"PAUSE_ORDER"|"PAUSE_BATCH";
  run_mode:"MANUAL"|"CONTINUOUS";
  inherit_parent_policy:boolean;
  allow_child_policy_relaxation:boolean;
  updated_at:string;
  inherited_from_tenant_id?:string|null;
  effective_source?:"LOCAL"|"INHERITED_GUARDRAILS"|"CHILD_OVERRIDE_ALLOWED";
};
async function readAutomationPolicy(tenantId:string){
  await db.query("insert into automation_policies(tenant_id) values($1) on conflict(tenant_id) do nothing",[tenantId]);
  const {rows}=await db.query(
    "select automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,failure_pause_percent,max_price_increase_percent,max_order_value_minor,max_batch_variance_percent,price_breach_action,run_mode,inherit_parent_policy,allow_child_policy_relaxation,updated_at from automation_policies where tenant_id=$1",
    [tenantId]
  );
  return rows[0] as AutomationPolicy;
}
function minCap(a:number,b:number){
  if(a<=0)return b;
  if(b<=0)return a;
  return Math.min(a,b);
}
async function getAutomationPolicy(tenantId:string){
  const local=await readAutomationPolicy(tenantId);
  const relation=await db.query("select parent_tenant_id from dealer_relationships where child_tenant_id=$1 and status='ACTIVE' limit 1",[tenantId]);
  const parentTenantId=relation.rows[0]?.parent_tenant_id as string|undefined;
  if(!parentTenantId||!local.inherit_parent_policy)return {...local,inherited_from_tenant_id:null,effective_source:"LOCAL" as const};
  const parent=await readAutomationPolicy(parentTenantId);
  if(parent.allow_child_policy_relaxation){
    return {...local,inherited_from_tenant_id:parentTenantId,effective_source:"CHILD_OVERRIDE_ALLOWED" as const};
  }
  return {
    ...local,
    automation_enabled:Boolean(parent.automation_enabled&&local.automation_enabled),
    auto_assign_virtual_card:Boolean(parent.auto_assign_virtual_card&&local.auto_assign_virtual_card),
    auto_continue_checkout:Boolean(parent.auto_continue_checkout&&local.auto_continue_checkout),
    max_active_orders:Math.min(Number(parent.max_active_orders),Number(local.max_active_orders)),
    failure_pause_percent:Math.min(Number(parent.failure_pause_percent),Number(local.failure_pause_percent)),
    max_price_increase_percent:Math.min(Number(parent.max_price_increase_percent),Number(local.max_price_increase_percent)),
    max_order_value_minor:minCap(Number(parent.max_order_value_minor),Number(local.max_order_value_minor)),
    max_batch_variance_percent:Math.min(Number(parent.max_batch_variance_percent),Number(local.max_batch_variance_percent)),
    price_breach_action:(parent.price_breach_action==="PAUSE_BATCH"||local.price_breach_action==="PAUSE_BATCH"?"PAUSE_BATCH":"PAUSE_ORDER") as "PAUSE_ORDER"|"PAUSE_BATCH",
    run_mode:(parent.run_mode==="MANUAL"?"MANUAL":local.run_mode) as "MANUAL"|"CONTINUOUS",
    allow_child_policy_relaxation:false,
    inherited_from_tenant_id:parentTenantId,
    effective_source:"INHERITED_GUARDRAILS" as const
  };
}
async function claimReadyBaskets(tenantId:string,userId:string,requestedLimit:number,policy:AutomationPolicy){
  if(!policy.automation_enabled)return {error:"autopilot_paused" as const,claimed:0,ids:[] as string[]};
  const effectiveLimit=Math.min(requestedLimit,Number(policy.max_active_orders||8));
  const client=await db.connect();
  const ids:string[]=[];
  try{
    await client.query("begin");
    await client.query("update checkout_baskets set status='READY',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[tenantId]);
    const picked=await client.query("select id from checkout_baskets where tenant_id=$1 and status='READY' order by created_at for update skip locked limit $2",[tenantId,effectiveLimit]);
    for(const row of picked.rows){
      await client.query("update checkout_baskets set status='CLAIMED',claimed_by=$1,execution_worker_id=null,expires_at=now()+interval '20 minutes',updated_at=now() where id=$2",[userId,row.id]);
      ids.push(row.id);
    }
    await client.query("commit");
  }catch(error){
    await client.query("rollback");throw error;
  }finally{client.release()}
  for(const basketId of ids){
    const commercial=await db.query(
      `select b.payment_route,coalesce(sum(po.amount_minor),0)::bigint expected_minor
       from checkout_baskets cb
       join order_batches b on b.id=cb.batch_id
       left join purchase_orders po on po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id
       where cb.id=$1 and cb.tenant_id=$2
       group by b.payment_route`,
      [basketId,tenantId]
    );
    const expectedMinor=Number(commercial.rows[0]?.expected_minor||0);
    const paymentRoute=String(commercial.rows[0]?.payment_route||"");
    if(Number(policy.max_order_value_minor)>0&&expectedMinor>Number(policy.max_order_value_minor)){
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',commercial_status='REVIEW_REQUIRED',failure_code='ORDER_VALUE_POLICY_REQUIRED',failure_message='Expected order value exceeds the Autopilot order-value policy',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
        [basketId,tenantId]
      );
      continue;
    }

    await assignFundingRoute(db,tenantId,basketId);
    if(policy.auto_assign_virtual_card){
      let cardId=await assignAvailableVirtualCard(db,tenantId,basketId);
      if(!cardId){
        let fundingCeiling=Math.ceil(expectedMinor*(1+Number(policy.max_price_increase_percent)/100));
        if(Number(policy.max_order_value_minor)>0)fundingCeiling=Math.min(fundingCeiling,Number(policy.max_order_value_minor));
        const card=await ensureBasketVirtualCard(db,config,tenantId,basketId,userId,fundingCeiling);
        cardId=card.cardId;
        if(card.status==="PROGRAMME_REQUIRED"||card.status==="CARDHOLDER_PROFILE_REQUIRED"){
          await db.query(
            "update checkout_baskets set status='REQUIRES_ACTION',failure_code='PAYMENT_SETUP_REQUIRED',failure_message='Payment setup required before checkout can continue',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
            [basketId,tenantId]
          );
        }
      }
    }else if(paymentRoute==="Corporate virtual card"){
      const assigned=await db.query("select virtual_card_id from checkout_baskets where id=$1 and tenant_id=$2",[basketId,tenantId]);
      if(!assigned.rows[0]?.virtual_card_id){
        await db.query(
          "update checkout_baskets set status='REQUIRES_ACTION',failure_code='CARD_ASSIGNMENT_REQUIRED',failure_message='Order is waiting for manual virtual-card assignment',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
          [basketId,tenantId]
        );
      }
    }
  }
  return {claimed:ids.length,ids};
}
const app=Fastify({logger:{redact:["req.headers.authorization","req.headers.cookie","password"]},trustProxy:true,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}});
await app.register(rateLimit,{max:600,timeWindow:"1 minute"}); await app.register(cookie,{secret:config.SESSION_SECRET});
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
  const p=req.principal!,policy=await getAutomationPolicy(p.tenantId),localPolicy=await readAutomationPolicy(p.tenantId);
  const [accounts,orders,cards,batches]=await Promise.all([
    db.query("select count(*)::int total,count(*) filter(where credential_status in ('STORED','READY'))::int credentials_ready,count(*) filter(where auth_status='READY')::int authenticated,count(*) filter(where auth_status in ('AUTH_REQUIRED','CHALLENGE','LOCKED'))::int needs_attention from retailer_accounts where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status in ('READY','CLAIMED'))::int ready,count(*) filter(where status='OPENED')::int in_progress,count(*) filter(where status in ('REQUIRES_ACTION','FAILED'))::int needs_attention,count(*) filter(where status='CONFIRMED')::int confirmed,count(*) filter(where virtual_card_id is not null)::int cards_assigned,count(*) filter(where commercial_status='APPROVED')::int price_approved,count(*) filter(where commercial_status='REVIEW_REQUIRED')::int price_review from checkout_baskets where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status='ACTIVE')::int active from virtual_cards where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where status in ('APPROVED','PARTIAL'))::int active,count(*) filter(where status='COMPLETE')::int complete from order_batches where tenant_id=$1",[p.tenantId])
  ]);
  const a=accounts.rows[0]||{},o=orders.rows[0]||{},v=cards.rows[0]||{},b=batches.rows[0]||{};
  return {
    policy,
    localPolicy,
    summary:{
      ready:Number(o.ready||0),
      inProgress:Number(o.in_progress||0),
      needsAttention:Number(o.needs_attention||0),
      confirmed:Number(o.confirmed||0),
      priceApproved:Number(o.price_approved||0),
      priceReview:Number(o.price_review||0)
    },
    workflows:[
      {id:"accounts",name:"Account authentication",status:Number(a.needs_attention||0)>0?"NEEDS_ATTENTION":Number(a.total||0)>0?"ACTIVE":"READY",detail:Number(a.authenticated||0)+" authenticated · "+Number(a.credentials_ready||0)+" credentials ready"},
      {id:"preparation",name:"Order validation & preparation",status:Number(o.ready||0)>0?"ACTIVE":Number(o.total||0)>0?"READY":"IDLE",detail:Number(o.ready||0)+" orders prepared for next action"},
      {id:"commercial",name:"Price & commercial validation",status:Number(o.price_review||0)>0?"NEEDS_ATTENTION":Number(o.price_approved||0)>0?"ACTIVE":"READY",detail:Number(o.price_approved||0)+" price checks approved · "+Number(o.price_review||0)+" need review"},
      {id:"cards",name:"Virtual-card assignment",status:Number(o.cards_assigned||0)>0?"ACTIVE":Number(o.total||0)>0?"READY":"READY",detail:Number(o.cards_assigned||0)+" order cards assigned · "+Number(v.active||0)+" active cards"},
      {id:"checkout",name:"Checkout continuation",status:Number(o.needs_attention||0)>0?"NEEDS_ATTENTION":Number(o.in_progress||0)>0?"ACTIVE":Number(o.ready||0)>0?"READY":"IDLE",detail:Number(o.in_progress||0)+" in progress · "+Number(o.ready||0)+" ready"},
      {id:"confirmation",name:"Retailer confirmation",status:Number(o.confirmed||0)>0?"ACTIVE":"READY",detail:Number(o.confirmed||0)+" retailer-confirmed orders"},
      {id:"batch",name:"Batch protection",status:Number(b.active||0)>0?"ACTIVE":"READY",detail:"Failure pause "+Number(policy.failure_pause_percent)+"% · batch variance "+Number(policy.max_batch_variance_percent)+"%"},
      {id:"reconciliation",name:"Order reconciliation",status:Number(b.complete||0)>0?"ACTIVE":"READY",detail:Number(b.complete||0)+" completed batches"}
    ],
    mandatoryRules:[
      {name:"One order, one virtual card",status:"ENFORCED"},
      {name:"Final payable amount checked before final retailer submission",status:"ENFORCED"},
      {name:"Retailer-confirmed completion evidence",status:"ENFORCED"},
      {name:"Protected verification is never bypassed",status:"ENFORCED"}
    ],
    canEdit:["OWNER","APPROVER"].includes(p.role),
    canRelaxChildren:p.role==="OWNER"&&p.tenantId===p.homeTenantId
  };
});

app.get("/api/automation/preflight",async(req)=>{
  const p=req.principal!,policy=await getAutomationPolicy(p.tenantId);
  const [orders,accounts,issuer]=await Promise.all([
    db.query(`
      select
        count(distinct cb.id) filter(where cb.status='READY')::int ready,
        count(distinct cb.id) filter(where cb.status in ('REQUIRES_ACTION','FAILED'))::int needs_attention,
        coalesce(sum(po.amount_minor) filter(where cb.status in ('READY','CLAIMED','OPENED')),0)::bigint approved_exposure_minor,
        count(po.id) filter(where po.amount_minor>0)::int priced_lines
      from checkout_baskets cb
      left join purchase_orders po on po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id
      where cb.tenant_id=$1
    `,[p.tenantId]),
    db.query("select count(*)::int total,count(*) filter(where auth_status='READY')::int authenticated,count(*) filter(where credential_status in ('STORED','READY'))::int credentials_ready from retailer_accounts where tenant_id=$1",[p.tenantId]),
    db.query("select count(*)::int connected from issuer_connections where tenant_id=$1 and status='CONNECTED'",[p.tenantId])
  ]);
  const o=orders.rows[0]||{},a=accounts.rows[0]||{};
  return {
    eligibleOrders:Number(o.ready||0),
    needsAttention:Number(o.needs_attention||0),
    retailerAccounts:Number(a.total||0),
    authenticatedAccounts:Number(a.authenticated||0),
    credentialReadyAccounts:Number(a.credentials_ready||0),
    pricedLines:Number(o.priced_lines||0),
    approvedExposureMinor:Number(o.approved_exposure_minor||0),
    cardProgrammeConnected:Number(issuer.rows[0]?.connected||0)>0,
    policy
  };
});

app.post("/api/automation/start",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  await db.query("update automation_policies set automation_enabled=true,updated_by=$1,updated_at=now() where tenant_id=$2",[p.id,p.tenantId]);
  const policy=await getAutomationPolicy(p.tenantId);
  const result=await claimReadyBaskets(p.tenantId,p.id,Number(policy.max_active_orders||8),policy);
  if("error" in result)return reply.code(409).send({error:result.error});
  await audit(db,p.tenantId,p.id,"automation.started","automation_policy",p.tenantId,{claimed:result.claimed});
  return {started:true,...result,policy};
});

app.post("/api/automation/pause",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"policy_permission_required"});
  await db.query("update automation_policies set automation_enabled=false,updated_by=$1,updated_at=now() where tenant_id=$2",[p.id,p.tenantId]);
  await audit(db,p.tenantId,p.id,"automation.paused","automation_policy",p.tenantId);
  return {paused:true};
});

app.put("/api/automation/policy",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"policy_permission_required"});
  const body=z.object({
    automationEnabled:z.boolean(),
    autoAssignVirtualCard:z.boolean(),
    autoContinueCheckout:z.boolean(),
    maxActiveOrders:z.number().int().min(1).max(50),
    failurePausePercent:z.number().min(0).max(100),
    maxPriceIncreasePercent:z.number().min(0).max(100),
    maxOrderValueMinor:z.number().int().min(0),
    maxBatchVariancePercent:z.number().min(0).max(100),
    priceBreachAction:z.enum(["PAUSE_ORDER","PAUSE_BATCH"]),
    runMode:z.enum(["MANUAL","CONTINUOUS"]),
    inheritParentPolicy:z.boolean(),
    allowChildPolicyRelaxation:z.boolean().default(false)
  }).parse(req.body);
  const allowRelaxation=p.role==="OWNER"&&p.tenantId===p.homeTenantId?body.allowChildPolicyRelaxation:false;
  const {rows}=await db.query(
    `insert into automation_policies(
      tenant_id,automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,failure_pause_percent,
      max_price_increase_percent,max_order_value_minor,max_batch_variance_percent,price_breach_action,run_mode,
      inherit_parent_policy,allow_child_policy_relaxation,updated_by,updated_at
    ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
    on conflict(tenant_id) do update set
      automation_enabled=excluded.automation_enabled,
      auto_assign_virtual_card=excluded.auto_assign_virtual_card,
      auto_continue_checkout=excluded.auto_continue_checkout,
      max_active_orders=excluded.max_active_orders,
      failure_pause_percent=excluded.failure_pause_percent,
      max_price_increase_percent=excluded.max_price_increase_percent,
      max_order_value_minor=excluded.max_order_value_minor,
      max_batch_variance_percent=excluded.max_batch_variance_percent,
      price_breach_action=excluded.price_breach_action,
      run_mode=excluded.run_mode,
      inherit_parent_policy=excluded.inherit_parent_policy,
      allow_child_policy_relaxation=excluded.allow_child_policy_relaxation,
      updated_by=excluded.updated_by,updated_at=now()
    returning *`,
    [p.tenantId,body.automationEnabled,body.autoAssignVirtualCard,body.autoContinueCheckout,body.maxActiveOrders,body.failurePausePercent,
     body.maxPriceIncreasePercent,body.maxOrderValueMinor,body.maxBatchVariancePercent,body.priceBreachAction,body.runMode,
     body.inheritParentPolicy,allowRelaxation,p.id]
  );
  await audit(db,p.tenantId,p.id,"automation.policy_updated","automation_policy",p.tenantId,body);
  return {localPolicy:rows[0],policy:await getAutomationPolicy(p.tenantId)};
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
      const gstin=value(row,"gstin").trim().toUpperCase()||null;
      if(gstin&&!validateGstin(gstin))throw new Error(`Invalid GSTIN for ${externalReference}`);
      const stateCode=(value(row,"state_code").replace(/\D/g,"").slice(0,2)||stateCodeForName(value(row,"state"))||null);
      const customer=await client.query(
        `insert into customers(tenant_id,external_reference,display_name,legal_name,phone,gstin,state_code)
         values($1,$2,$3,$4,$5,$6,$7)
         on conflict(tenant_id,external_reference) do update
         set display_name=excluded.display_name,legal_name=excluded.legal_name,phone=excluded.phone,
             gstin=excluded.gstin,state_code=excluded.state_code,updated_at=now()
         returning id,external_reference`,
        [p.tenantId,externalReference,value(row,"recipient"),value(row,"legal_name")||value(row,"recipient"),phone,gstin,stateCode]
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
    group by a.id,c.external_reference,c.created_at
    order by c.created_at desc,a.id
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
  const query=z.object({
    retailer:z.string().max(120).optional(),
    poolOnly:z.enum(["true","false"]).optional(),
    limit:z.coerce.number().int().min(1).max(1000).default(500),
    offset:z.coerce.number().int().min(0).default(0)
  }).parse(req.query??{});
  const params:any[]=[p.tenantId],where=["ra.tenant_id=$1"];
  if(query.retailer){params.push(query.retailer);where.push(`ra.retailer=$${params.length}`)}
  if(query.poolOnly==="true")where.push("ra.customer_id is null");
  const limitParam=params.length+1,offsetParam=params.length+2;
  const {rows}=await db.query(`
    select ra.id,ra.customer_id,c.external_reference customer_reference,c.display_name,
      ra.retailer,ra.account_reference,ra.label,ra.profile_key,ra.auth_status,ra.credential_status,
      ra.active,ra.max_concurrent_orders,ra.last_assigned_at,ra.last_authenticated_at,ra.last_credential_update_at,ra.updated_at,
      coalesce((select count(*) from checkout_baskets cb where cb.retailer_account_id=ra.id and cb.status in ('CLAIMED','OPENED','REQUIRES_ACTION')),0)::int active_orders,
      coalesce((select sum(case
        when re.event_type in ('CREDITED','ADJUSTED') then re.units
        when re.event_type in ('REDEEMED','REVERSED') then -re.units
        else 0 end) from retailer_reward_events re where re.retailer_account_id=ra.id),0)::int reward_balance,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.retailer_account_id=ra.id and rf.status='SETTLED'),0)::bigint settled_refund_minor,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.retailer_account_id=ra.id and rf.status in ('REQUESTED','INITIATED','PROCESSING')),0)::bigint pending_refund_minor
    from retailer_accounts ra
    left join customers c on c.id=ra.customer_id
    where ${where.join(" and ")}
    order by ra.retailer,coalesce(ra.label,ra.account_reference),ra.id
    limit $${limitParam} offset $${offsetParam}
  `,[...params,query.limit,query.offset]);
  const totals=await db.query(`
    select count(*)::int total,
      count(*) filter(where customer_id is null)::int pooled,
      count(*) filter(where active)::int active,
      count(*) filter(where auth_status='READY')::int ready,
      count(*) filter(where auth_status in ('LOCKED','DISABLED'))::int unavailable
    from retailer_accounts where tenant_id=$1
      and ($2::text is null or retailer=$2)
  `,[p.tenantId,query.retailer??null]);
  return {accounts:rows,summary:totals.rows[0],limit:query.limit,offset:query.offset};
});

app.post("/api/retailer-accounts/bulk",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const retailerSchema=z.string().regex(/^(amazon-in|flipkart|myntra|ajio|tatacliq|meesho|nykaa|jiomart|store:[a-z0-9.-]+)$/);
  const body=z.object({
    retailer:retailerSchema,
    accounts:z.array(z.object({
      accountReference:z.string().trim().min(1).max(240),
      label:z.string().trim().max(160).optional(),
      password:z.string().max(1000).optional(),
      maxConcurrentOrders:z.number().int().min(1).max(100).default(1)
    })).min(1).max(1000)
  }).parse(req.body);
  const client=await db.connect(),created:any[]=[];
  try{
    await client.query("begin");
    for(const account of body.accounts){
      const saved=await client.query(
        `insert into retailer_accounts(
           tenant_id,customer_id,retailer,account_reference,label,auth_status,active,max_concurrent_orders,created_by,updated_at
         )
         values($1,null,$2,$3,$4,'AUTH_REQUIRED',true,$5,$6,now())
         on conflict(tenant_id,retailer,account_reference) do update set
           label=coalesce(excluded.label,retailer_accounts.label),
           active=true,max_concurrent_orders=excluded.max_concurrent_orders,updated_at=now()
         returning id,retailer,account_reference,label,profile_key,auth_status,credential_status,active,max_concurrent_orders`,
        [p.tenantId,body.retailer,account.accountReference,account.label??null,account.maxConcurrentOrders,p.id]
      );
      const row=saved.rows[0];
      if(account.password){
        const encrypted=encryptJson({password:account.password},config.DATA_ENCRYPTION_KEY_BASE64);
        await client.query(
          `insert into private.retailer_credentials(tenant_id,retailer_account_id,ciphertext,iv,auth_tag,created_by,updated_at)
           values($1,$2,$3,$4,$5,$6,now())
           on conflict(tenant_id,retailer_account_id) do update set
             ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,created_by=excluded.created_by,updated_at=now()`,
          [p.tenantId,row.id,encrypted.ciphertext,encrypted.iv,encrypted.authTag,p.id]
        );
        await client.query(
          "update retailer_accounts set credential_status='STORED',last_credential_update_at=now(),updated_at=now() where id=$1 and tenant_id=$2",
          [row.id,p.tenantId]
        );
        row.credential_status="STORED";
      }
      created.push(row);
    }
    await client.query("commit");
    await audit(db,p.tenantId,p.id,"retailer_accounts.bulk_imported","retailer_account",null,{retailer:body.retailer,count:created.length});
    return reply.code(201).send({count:created.length,accounts:created});
  }catch(error){
    await client.query("rollback");throw error;
  }finally{client.release()}
});

app.patch("/api/retailer-accounts/:id",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({
    label:z.string().trim().max(160).nullable().optional(),
    active:z.boolean().optional(),
    maxConcurrentOrders:z.number().int().min(1).max(100).optional()
  }).refine(v=>Object.keys(v).length>0).parse(req.body);
  const {rows}=await db.query(
    `update retailer_accounts set
       label=case when $1::boolean then $2 else label end,
       active=coalesce($3,active),
       max_concurrent_orders=coalesce($4,max_concurrent_orders),
       updated_at=now()
     where id=$5 and tenant_id=$6
     returning id,retailer,account_reference,label,active,max_concurrent_orders,auth_status,credential_status`,
    [Object.prototype.hasOwnProperty.call(body,"label"),body.label??null,body.active??null,body.maxConcurrentOrders??null,id,p.tenantId]
  );
  if(!rows[0])return reply.code(404).send({error:"retailer_account_not_found"});
  await audit(db,p.tenantId,p.id,"retailer_account.updated","retailer_account",id,{active:body.active,maxConcurrentOrders:body.maxConcurrentOrders});
  return rows[0];
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
    `insert into retailer_accounts(tenant_id,customer_id,retailer,account_reference,auth_status,active,max_concurrent_orders,created_by)
     values($1,$2,$3,$4,'AUTH_REQUIRED',true,1,$5)
     on conflict(tenant_id,customer_id,retailer) where customer_id is not null do update
     set account_reference=excluded.account_reference,auth_status='AUTH_REQUIRED',active=true,updated_at=now()
     returning id,customer_id,retailer,account_reference,profile_key,auth_status`,
    [p.tenantId,customerId,retailer,body.accountReference,p.id]
  );
  await audit(db,p.tenantId,p.id,"retailer_account.bound","retailer_account",rows[0].id,{customerId,retailer});
  return rows[0];
});

app.get("/api/retailer-finance",async(req)=>{
  const p=req.principal!;
  const query=z.object({
    retailer:z.string().max(120).default("flipkart"),
    limit:z.coerce.number().int().min(1).max(1000).default(500),
    offset:z.coerce.number().int().min(0).default(0)
  }).parse(req.query??{});
  const {rows}=await db.query(`
    select ra.id retailer_account_id,ra.account_reference,ra.label,ra.active,ra.auth_status,
      ra.reward_balance_observed,ra.reward_balance_observed_at,ra.reward_tier,
      coalesce(sum(case when re.event_type='PENDING' then re.units else 0 end),0)::int pending_rewards,
      coalesce(ra.reward_balance_observed,sum(case
        when re.event_type in ('CREDITED','ADJUSTED') then re.units
        when re.event_type in ('REDEEMED','REVERSED') then -re.units
        else 0 end),0)::int available_rewards,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.retailer_account_id=ra.id and rf.status='SETTLED'),0)::bigint settled_refund_minor,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.retailer_account_id=ra.id and rf.status in ('REQUESTED','INITIATED','PROCESSING')),0)::bigint pending_refund_minor,
      coalesce((select count(*) from retailer_order_observations roo where roo.retailer_account_id=ra.id and roo.refund_status is not null),0)::int observed_refund_orders,
      coalesce((select max(roo.observed_at) from retailer_order_observations roo where roo.retailer_account_id=ra.id),ra.reward_balance_observed_at)::timestamptz last_reconciled_at,
      coalesce((select count(*) from checkout_baskets cb where cb.retailer_account_id=ra.id),0)::int order_count
    from retailer_accounts ra
    left join retailer_reward_events re on re.retailer_account_id=ra.id
    where ra.tenant_id=$1 and ra.retailer=$2
    group by ra.id
    order by coalesce(ra.label,ra.account_reference),ra.id
    limit $3 offset $4
  `,[p.tenantId,query.retailer,query.limit,query.offset]);
  const totals=await db.query(`
    select
      count(*)::int account_count,
      coalesce((select sum(coalesce(ra2.reward_balance_observed,(
          select sum(case
            when re.event_type in ('CREDITED','ADJUSTED') then re.units
            when re.event_type in ('REDEEMED','REVERSED') then -re.units
            else 0 end)
          from retailer_reward_events re where re.retailer_account_id=ra2.id
        ),0))
        from retailer_accounts ra2
        where ra2.tenant_id=$1 and ra2.retailer=$2),0)::int available_rewards,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf
        join retailer_accounts ra3 on ra3.id=rf.retailer_account_id
        where rf.tenant_id=$1 and ra3.retailer=$2 and rf.status='SETTLED'),0)::bigint settled_refund_minor,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf
        join retailer_accounts ra4 on ra4.id=rf.retailer_account_id
        where rf.tenant_id=$1 and ra4.retailer=$2 and rf.status in ('REQUESTED','INITIATED','PROCESSING')),0)::bigint pending_refund_minor
    from retailer_accounts
    where tenant_id=$1 and retailer=$2
  `,[p.tenantId,query.retailer]);
  return {accounts:rows,summary:totals.rows[0],limit:query.limit,offset:query.offset};
});

app.post("/api/retailer-rewards/events",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const body=z.object({
    retailerAccountId:z.string().uuid(),
    checkoutBasketId:z.string().uuid().optional(),
    purchaseOrderId:z.string().uuid().optional(),
    eventType:z.enum(["PENDING","CREDITED","REDEEMED","REVERSED","ADJUSTED"]),
    units:z.number().int().positive().max(100000000),
    idempotencyKey:z.string().min(4).max(240),
    retailerReference:z.string().max(240).optional(),
    occurredAt:z.string().datetime().optional()
  }).parse(req.body);
  const account=await db.query("select retailer from retailer_accounts where id=$1 and tenant_id=$2",[body.retailerAccountId,p.tenantId]);
  if(!account.rows[0])return reply.code(404).send({error:"retailer_account_not_found"});
  const {rows}=await db.query(
    `insert into retailer_reward_events(
       tenant_id,retailer_account_id,checkout_basket_id,purchase_order_id,retailer,event_type,units,idempotency_key,retailer_reference,occurred_at,created_by
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz,now()),$11)
     on conflict(tenant_id,idempotency_key) do update set retailer_reference=coalesce(excluded.retailer_reference,retailer_reward_events.retailer_reference)
     returning *`,
    [p.tenantId,body.retailerAccountId,body.checkoutBasketId??null,body.purchaseOrderId??null,account.rows[0].retailer,body.eventType,body.units,body.idempotencyKey,body.retailerReference??null,body.occurredAt??null,p.id]
  );
  return reply.code(201).send(rows[0]);
});

app.post("/api/retailer-refunds",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const body=z.object({
    checkoutBasketId:z.string().uuid(),
    purchaseOrderId:z.string().uuid().optional(),
    amountMinor:z.number().int().positive(),
    idempotencyKey:z.string().min(4).max(240),
    retailerRefundReference:z.string().max(240).optional()
  }).parse(req.body);
  const basket=await db.query(
    "select retailer,retailer_account_id,virtual_card_id from checkout_baskets where id=$1 and tenant_id=$2",
    [body.checkoutBasketId,p.tenantId]
  );
  if(!basket.rows[0]?.retailer_account_id)return reply.code(404).send({error:"basket_or_retailer_account_not_found"});
  const {rows}=await db.query(
    `insert into retailer_refunds(
       tenant_id,retailer_account_id,checkout_basket_id,purchase_order_id,virtual_card_id,retailer,amount_minor,status,idempotency_key,retailer_refund_reference,created_by
     ) values($1,$2,$3,$4,$5,$6,$7,'REQUESTED',$8,$9,$10)
     on conflict(tenant_id,idempotency_key) do update set retailer_refund_reference=coalesce(excluded.retailer_refund_reference,retailer_refunds.retailer_refund_reference),updated_at=now()
     returning *`,
    [p.tenantId,basket.rows[0].retailer_account_id,body.checkoutBasketId,body.purchaseOrderId??null,basket.rows[0].virtual_card_id,basket.rows[0].retailer,body.amountMinor,body.idempotencyKey,body.retailerRefundReference??null,p.id]
  );
  return reply.code(201).send(rows[0]);
});

app.patch("/api/retailer-refunds/:id/status",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({
    status:z.enum(["REQUESTED","INITIATED","PROCESSING","SETTLED","FAILED","CANCELLED"]),
    bankReference:z.string().max(240).optional(),
    failureReason:z.string().max(500).optional()
  }).parse(req.body);
  const {rows}=await db.query(
    `update retailer_refunds set
       status=$1,
       bank_reference=coalesce($2,bank_reference),
       failure_reason=case when $1='FAILED' then coalesce($3,failure_reason) else failure_reason end,
       initiated_at=case when $1 in ('INITIATED','PROCESSING','SETTLED') then coalesce(initiated_at,now()) else initiated_at end,
       settled_at=case when $1='SETTLED' then coalesce(settled_at,now()) else settled_at end,
       updated_at=now()
     where id=$4 and tenant_id=$5
     returning *`,
    [body.status,body.bankReference??null,body.failureReason??null,id,p.tenantId]
  );
  if(!rows[0])return reply.code(404).send({error:"refund_not_found"});
  return rows[0];
});

app.get("/api/checkout-tasks",async(req)=>{const p=req.principal!;const {rows}=await db.query(`select po.id,po.status,po.amount_minor,po.failure_message,bi.product_url,bi.title,bi.requested_quantity,a.id address_id,a.recipient,a.city,a.postal_code from purchase_orders po join batch_items bi on bi.id=po.batch_item_id left join addresses a on a.id=bi.address_id where po.tenant_id=$1 order by po.created_at desc limit 250`,[p.tenantId]);return {tasks:rows};});

app.post("/api/execution-worker/heartbeat",async(req)=>{const p=req.principal!;const body=z.object({workerId:z.string().min(8).max(128),hostname:z.string().max(120).optional(),mode:z.enum(["BULK"]).default("BULK")}).parse(req.body??{});await db.query(`insert into execution_workers(id,tenant_id,user_id,hostname,mode,last_seen) values($1,$2,$3,$4,$5,now()) on conflict(tenant_id,id) do update set user_id=excluded.user_id,hostname=excluded.hostname,mode=excluded.mode,last_seen=now()`,[body.workerId,p.tenantId,p.id,body.hostname??null,body.mode]);return {ok:true};});
app.get("/api/execution-workers",async(req)=>{const p=req.principal!;const {rows}=await db.query("select id,hostname,mode,last_seen from execution_workers where tenant_id=$1 and last_seen>now()-interval '30 seconds' order by last_seen desc",[p.tenantId]);return {workers:rows};});
app.post("/api/execution-worker/:workerId/claim",async(req,reply)=>{const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId),body=z.object({limit:z.number().int().min(1).max(25).default(25)}).parse(req.body??{}),policy=await getAutomationPolicy(p.tenantId);if(!policy.automation_enabled||!policy.auto_continue_checkout)return reply.code(409).send({error:"checkout_automation_paused"});const effectiveLimit=Math.min(body.limit,Number(policy.max_active_orders||8)),client=await db.connect();try{await client.query("begin");const live=await client.query("select 1 from execution_workers where tenant_id=$1 and id=$2 and last_seen>now()-interval '30 seconds' for update",[p.tenantId,workerId]);if(!live.rows[0]){await client.query("rollback");return reply.code(409).send({error:"execution_worker_not_online"})}const picked=await client.query("select id from checkout_baskets where tenant_id=$1 and status='CLAIMED' and execution_worker_id is null and expires_at>now() order by created_at for update skip locked limit $2",[p.tenantId,effectiveLimit]);for(const row of picked.rows)await client.query("update checkout_baskets set execution_worker_id=$1,updated_at=now() where id=$2",[workerId,row.id]);await client.query("commit");return {assigned:picked.rows.length};}catch(error){await client.query("rollback");throw error}finally{client.release()}});


app.get("/api/human-actions",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(`
    select cb.id,cb.batch_id,cb.status,cb.retailer,cb.account_reference,cb.failure_code,cb.failure_message,
      cb.execution_worker_id,cb.payment_status,cb.virtual_card_id,cb.updated_at,
      c.external_reference customer_reference,a.recipient,a.city,a.postal_code,
      ra.label account_label,ra.profile_key,
      coalesce(sum(po.amount_minor),0)::bigint amount_minor,
      ew.last_seen worker_last_seen,
      (ew.last_seen>now()-interval '30 seconds') worker_online,
      case
        when cb.failure_code='CARD_CVV_REQUIRED' then 'CARD_CVV'
        when cb.failure_code='PAYMENT_AUTH_REQUIRED' or cb.failure_code ~* '3DS' then 'BANK_AUTH'
        when cb.failure_code ~* 'OTP' then 'RETAILER_OTP'
        when cb.failure_code ~* 'CAPTCHA' then 'CAPTCHA'
        when cb.failure_code ~* 'LOGIN|PASSWORD|AUTH' then 'RETAILER_LOGIN'
        when cb.failure_code ~* 'PAYMENT_METHOD|CARD_ASSIGNMENT|PAYMENT_SETUP' then 'PAYMENT_METHOD'
        else 'REVIEW'
      end action_type
    from checkout_baskets cb
    join customers c on c.id=cb.customer_id
    join addresses a on a.id=cb.address_id
    join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join purchase_orders po on po.checkout_basket_id=cb.id
    left join execution_workers ew on ew.tenant_id=cb.tenant_id and ew.id=cb.execution_worker_id
    where cb.tenant_id=$1
      and cb.status in ('REQUIRES_ACTION','FAILED')
      and coalesce(cb.failure_code,'')<>''
    group by cb.id,c.external_reference,a.recipient,a.city,a.postal_code,ra.label,ra.profile_key,ew.last_seen
    order by case when ew.last_seen>now()-interval '30 seconds' then 0 else 1 end,cb.updated_at desc
    limit 500
  `,[p.tenantId]);
  return {actions:rows};
});

app.post("/api/human-actions/:id/focus",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id);
  const basket=await db.query(`
    select cb.id,cb.execution_worker_id,cb.retailer_account_id,cb.retailer,ra.profile_key,ew.last_seen
    from checkout_baskets cb
    join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join execution_workers ew on ew.tenant_id=cb.tenant_id and ew.id=cb.execution_worker_id
    where cb.id=$1 and cb.tenant_id=$2 and cb.status in ('REQUIRES_ACTION','FAILED','OPENED')
    limit 1
  `,[id,p.tenantId]);
  const row=basket.rows[0];
  if(!row)return reply.code(404).send({error:"action_not_found"});
  if(!row.execution_worker_id||!row.last_seen||new Date(row.last_seen).getTime()<Date.now()-30_000)return reply.code(409).send({error:"execution_worker_offline"});
  const existing=await db.query(
    "select id,status from execution_worker_commands where tenant_id=$1 and worker_id=$2 and checkout_basket_id=$3 and command='FOCUS_SESSION' and status in ('PENDING','PROCESSING') order by requested_at desc limit 1",
    [p.tenantId,row.execution_worker_id,id]
  );
  if(existing.rows[0])return {commandId:existing.rows[0].id,status:existing.rows[0].status};
  const {rows}=await db.query(
    `insert into execution_worker_commands(tenant_id,worker_id,checkout_basket_id,command,payload,requested_by)
     values($1,$2,$3,'FOCUS_SESSION',$4,$5) returning id,status`,
    [p.tenantId,row.execution_worker_id,id,{retailer:row.retailer,retailerAccountId:row.retailer_account_id,profileKey:row.profile_key},p.id]
  );
  await audit(db,p.tenantId,p.id,"human_action.focus_requested","checkout_basket",id,{workerId:row.execution_worker_id});
  return {commandId:rows[0].id,status:rows[0].status};
});

app.post("/api/execution-worker/:workerId/commands/claim",async(req,reply)=>{
  const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId);
  const body=z.object({limit:z.number().int().min(1).max(25).default(10)}).parse(req.body??{});
  const client=await db.connect();
  try{
    await client.query("begin");
    const live=await client.query(
      "select 1 from execution_workers where tenant_id=$1 and id=$2 and user_id=$3 and last_seen>now()-interval '30 seconds' for update",
      [p.tenantId,workerId,p.id]
    );
    if(!live.rows[0]){await client.query("rollback");return reply.code(409).send({error:"execution_worker_not_online"})}
    await client.query(
      "update execution_worker_commands set status='PENDING',processing_at=null where tenant_id=$1 and worker_id=$2 and status='PROCESSING' and processing_at<now()-interval '2 minutes'",
      [p.tenantId,workerId]
    );
    const picked=await client.query(
      "select id from execution_worker_commands where tenant_id=$1 and worker_id=$2 and status='PENDING' order by requested_at for update skip locked limit $3",
      [p.tenantId,workerId,body.limit]
    );
    if(!picked.rows.length){await client.query("commit");return {commands:[]}}
    const ids=picked.rows.map(r=>r.id);
    await client.query(
      "update execution_worker_commands set status='PROCESSING',processing_at=now() where tenant_id=$1 and id=any($2::uuid[])",
      [p.tenantId,ids]
    );
    const commands=await client.query(`
      select wc.id,wc.command,wc.checkout_basket_id,wc.payload,
        cb.retailer,cb.retailer_account_id,ra.profile_key
      from execution_worker_commands wc
      left join checkout_baskets cb on cb.id=wc.checkout_basket_id
      left join retailer_accounts ra on ra.id=cb.retailer_account_id
      where wc.tenant_id=$1 and wc.id=any($2::uuid[])
      order by wc.requested_at
    `,[p.tenantId,ids]);
    await client.query("commit");
    return {commands:commands.rows.map(r=>({
      id:r.id,command:r.command,checkoutBasketId:r.checkout_basket_id,retailer:r.retailer,
      retailerAccountId:r.retailer_account_id,profileKey:r.profile_key,payload:r.payload
    }))};
  }catch(error){await client.query("rollback");throw error}finally{client.release()}
});

app.post("/api/execution-worker/:workerId/commands/:commandId/complete",async(req,reply)=>{
  const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId);
  const commandId=z.string().uuid().parse((req.params as any).commandId);
  const body=z.object({ok:z.boolean(),error:z.string().max(300).optional()}).parse(req.body);
  const worker=await db.query("select 1 from execution_workers where tenant_id=$1 and id=$2 and user_id=$3",[p.tenantId,workerId,p.id]);
  if(!worker.rows[0])return reply.code(403).send({error:"worker_access_denied"});
  const {rows}=await db.query(
    "update execution_worker_commands set status=$1,completed_at=now(),error=$2 where id=$3 and tenant_id=$4 and worker_id=$5 and status='PROCESSING' returning id,status",
    [body.ok?"COMPLETED":"FAILED",body.error??null,commandId,p.tenantId,workerId]
  );
  if(!rows[0])return reply.code(404).send({error:"worker_command_not_found"});
  return rows[0];
});

app.post("/api/execution-worker/:workerId/reconciliation/claim",async(req,reply)=>{
  const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId);
  const body=z.object({limit:z.number().int().min(1).max(50).default(25)}).parse(req.body??{});
  const client=await db.connect();
  try{
    await client.query("begin");
    const live=await client.query(
      "select 1 from execution_workers where tenant_id=$1 and id=$2 and user_id=$3 and last_seen>now()-interval '30 seconds' for update",
      [p.tenantId,workerId,p.id]
    );
    if(!live.rows[0]){await client.query("rollback");return reply.code(409).send({error:"execution_worker_not_online"})}
    await client.query(
      "update checkout_baskets set reconciliation_status='ERROR',reconciliation_error='reconciliation lease expired',reconciliation_next_at=now(),updated_at=now() where tenant_id=$1 and execution_worker_id=$2 and reconciliation_status='RUNNING' and reconciliation_last_at<now()-interval '30 minutes'",
      [p.tenantId,workerId]
    );
    const picked=await client.query(`
      select cb.id,cb.retailer_account_id,cb.retailer,cb.retailer_order_id,ra.profile_key,
        coalesce((select sum(po.amount_minor) from purchase_orders po where po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id),0)::bigint amount_minor
      from checkout_baskets cb
      join retailer_accounts ra on ra.id=cb.retailer_account_id
      where cb.tenant_id=$1 and cb.execution_worker_id=$2 and cb.status='CONFIRMED'
        and cb.retailer in ('flipkart','amazon-in')
        and cb.retailer_order_id is not null
        and (cb.reconciliation_next_at is null or cb.reconciliation_next_at<=now())
        and cb.confirmed_at>now()-interval '180 days'
        and cb.reconciliation_status<>'RUNNING'
      order by coalesce(cb.reconciliation_next_at,cb.confirmed_at),cb.confirmed_at
      for update of cb skip locked
      limit $3
    `,[p.tenantId,workerId,body.limit]);
    if(!picked.rows.length){await client.query("commit");return {accounts:[]}}
    const ids=picked.rows.map(r=>r.id);
    await client.query(
      "update checkout_baskets set reconciliation_status='RUNNING',reconciliation_last_at=now(),reconciliation_error=null,updated_at=now() where tenant_id=$1 and id=any($2::uuid[])",
      [p.tenantId,ids]
    );
    await client.query("commit");
    const groups=new Map<string,any>();
    for(const row of picked.rows){
      const key=String(row.retailer_account_id);
      if(!groups.has(key))groups.set(key,{retailerAccountId:key,retailer:row.retailer,profileKey:row.profile_key,basketIds:[],orders:[]});
      const group=groups.get(key)!;
      group.basketIds.push(String(row.id));
      group.orders.push({basketId:String(row.id),retailerOrderId:String(row.retailer_order_id),amountMinor:Number(row.amount_minor||0)});
    }
    return {accounts:[...groups.values()]};
  }catch(error){await client.query("rollback");throw error}finally{client.release()}
});

app.post("/api/execution-worker/:workerId/reconciliation/:retailerAccountId",async(req,reply)=>{
  const p=req.principal!,workerId=z.string().min(8).max(128).parse((req.params as any).workerId);
  const retailerAccountId=z.string().uuid().parse((req.params as any).retailerAccountId);
  const body=z.object({
    basketIds:z.array(z.string().uuid()).min(1).max(50),
    reward:z.object({
      balance:z.number().int().nonnegative().nullable().optional(),
      tier:z.string().max(80).nullable().optional(),
      url:z.string().url().optional(),
      excerpt:z.string().max(2000).optional()
    }).nullable().optional(),
    observations:z.array(z.object({
      retailerOrderId:z.string().min(3).max(100),
      orderStatus:z.string().max(80).nullable().optional(),
      refundStatus:z.enum(["REQUESTED","INITIATED","PROCESSING","SETTLED"]).nullable().optional(),
      refundAmountMinor:z.number().int().positive().nullable().optional(),
      rewardUnits:z.number().int().positive().max(1000000).nullable().optional(),
      sourceUrl:z.string().url().optional(),
      excerpt:z.string().max(2000).optional()
    })).max(100).default([]),
    authChallenge:z.enum(["LOGIN_REQUIRED","OTP_REQUIRED","CAPTCHA_REQUIRED"]).nullable().optional(),
    unsupported:z.boolean().default(false),
    error:z.string().max(500).nullable().optional()
  }).parse(req.body);
  const worker=await db.query("select 1 from execution_workers where tenant_id=$1 and id=$2 and user_id=$3",[p.tenantId,workerId,p.id]);
  if(!worker.rows[0])return reply.code(403).send({error:"worker_access_denied"});
  const owned=await db.query(
    "select count(*)::int count from checkout_baskets where tenant_id=$1 and execution_worker_id=$2 and retailer_account_id=$3 and id=any($4::uuid[])",
    [p.tenantId,workerId,retailerAccountId,body.basketIds]
  );
  if(Number(owned.rows[0]?.count||0)!==body.basketIds.length)return reply.code(409).send({error:"reconciliation_basket_mismatch"});
  const account=await db.query("select retailer from retailer_accounts where id=$1 and tenant_id=$2",[retailerAccountId,p.tenantId]);
  if(!account.rows[0])return reply.code(404).send({error:"retailer_account_not_found"});
  const retailer=String(account.rows[0].retailer);
  const client=await db.connect();
  try{
    await client.query("begin");
    if(body.reward&&body.reward.balance!==null&&body.reward.balance!==undefined){
      await client.query(
        "update retailer_accounts set reward_balance_observed=$1,reward_balance_observed_at=now(),reward_tier=coalesce($2,reward_tier),updated_at=now() where id=$3 and tenant_id=$4",
        [body.reward.balance,body.reward.tier??null,retailerAccountId,p.tenantId]
      );
    }
    for(const observation of body.observations){
      const basket=await client.query(
        "select id,virtual_card_id from checkout_baskets where tenant_id=$1 and retailer_account_id=$2 and retailer_order_id=$3 limit 1",
        [p.tenantId,retailerAccountId,observation.retailerOrderId]
      );
      const basketId=basket.rows[0]?.id??null;
      await client.query(`
        insert into retailer_order_observations(
          tenant_id,retailer_account_id,checkout_basket_id,retailer,retailer_order_id,
          order_status,refund_status,refund_amount_minor,reward_units,source_url,excerpt,observed_at,updated_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
        on conflict(tenant_id,retailer_account_id,retailer_order_id) do update set
          checkout_basket_id=coalesce(excluded.checkout_basket_id,retailer_order_observations.checkout_basket_id),
          order_status=coalesce(excluded.order_status,retailer_order_observations.order_status),
          refund_status=coalesce(excluded.refund_status,retailer_order_observations.refund_status),
          refund_amount_minor=coalesce(excluded.refund_amount_minor,retailer_order_observations.refund_amount_minor),
          reward_units=coalesce(excluded.reward_units,retailer_order_observations.reward_units),
          source_url=coalesce(excluded.source_url,retailer_order_observations.source_url),
          excerpt=coalesce(excluded.excerpt,retailer_order_observations.excerpt),
          observed_at=now(),updated_at=now()
      `,[p.tenantId,retailerAccountId,basketId,retailer,observation.retailerOrderId,observation.orderStatus??null,observation.refundStatus??null,observation.refundAmountMinor??null,observation.rewardUnits??null,observation.sourceUrl??null,observation.excerpt??null]);
      if(basketId&&observation.rewardUnits){
        const rewardKey=`auto:${retailer}:${observation.retailerOrderId}:reward`;
        await client.query(`
          insert into retailer_reward_events(
            tenant_id,retailer_account_id,checkout_basket_id,retailer,event_type,units,idempotency_key,retailer_reference,occurred_at,created_by
          ) values($1,$2,$3,$4,'CREDITED',$5,$6,$7,now(),$8)
          on conflict(tenant_id,idempotency_key) do update set
            units=excluded.units,event_type='CREDITED',retailer_reference=excluded.retailer_reference,occurred_at=now()
        `,[p.tenantId,retailerAccountId,basketId,retailer,observation.rewardUnits,rewardKey,observation.retailerOrderId,p.id]);
      }
      if(basketId&&observation.refundStatus&&observation.refundAmountMinor){
        const refundKey=`auto:${retailer}:${observation.retailerOrderId}:refund`;
        const isSettled=observation.refundStatus==="SETTLED";
        await client.query(`
          insert into retailer_refunds(
            tenant_id,retailer_account_id,checkout_basket_id,virtual_card_id,retailer,amount_minor,status,
            idempotency_key,retailer_refund_reference,initiated_at,settled_at,created_by,updated_at
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,
            case when $7 in ('INITIATED','PROCESSING','SETTLED') then now() else null end,
            case when $7='SETTLED' then now() else null end,$10,now())
          on conflict(tenant_id,idempotency_key) do update set
            amount_minor=excluded.amount_minor,status=excluded.status,
            retailer_refund_reference=coalesce(excluded.retailer_refund_reference,retailer_refunds.retailer_refund_reference),
            initiated_at=case when excluded.status in ('INITIATED','PROCESSING','SETTLED') then coalesce(retailer_refunds.initiated_at,now()) else retailer_refunds.initiated_at end,
            settled_at=case when excluded.status='SETTLED' then coalesce(retailer_refunds.settled_at,now()) else retailer_refunds.settled_at end,
            updated_at=now()
        `,[p.tenantId,retailerAccountId,basketId,basket.rows[0]?.virtual_card_id??null,retailer,observation.refundAmountMinor,observation.refundStatus,refundKey,observation.retailerOrderId,p.id]);
      }
    }
    const hasError=Boolean(body.error||body.authChallenge);
    await client.query(
      `update checkout_baskets set
        reconciliation_status=$1,
        reconciliation_last_at=now(),
        reconciliation_next_at=now()+($2::text||' hours')::interval,
        reconciliation_error=$3,
        updated_at=now()
       where tenant_id=$4 and execution_worker_id=$5 and retailer_account_id=$6 and id=any($7::uuid[])`,
      [hasError?"ERROR":"OBSERVED",hasError?"1":"12",body.error??body.authChallenge??null,p.tenantId,workerId,retailerAccountId,body.basketIds]
    );
    if(body.authChallenge){
      await client.query("update retailer_accounts set auth_status='CHALLENGE',updated_at=now() where id=$1 and tenant_id=$2",[retailerAccountId,p.tenantId]);
    }
    await client.query("commit");
    return {ok:true,observations:body.observations.length,rewardObserved:body.reward?.balance??null};
  }catch(error){await client.query("rollback");throw error}finally{client.release()}
});


app.get("/api/issuers",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query("select id,provider,status,bank_name,programme_name,card_network,bank_code,integration_mode,capabilities,connected_at,updated_at from issuer_connections where tenant_id=$1 order by bank_name,provider",[p.tenantId]);
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

app.get("/api/cards/banks",async()=>({banks:BANK_VIRTUAL_CARD_PROFILES}));

app.get("/api/cards/provider",async(req)=>{
  const p=req.principal!,state=await loadTenantIssuer(db,config,p.tenantId);
  return {provider:state.issuer.provider,configured:state.issuer.configured(),source:state.source,connectionId:state.connectionId,...state.metadata};
});

app.post("/api/cards/provider/connect",async(req,reply)=>{
  const p=req.principal!;
  if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});
  const publicHttps=z.string().url().refine(value=>{
    try{
      const url=new URL(value),host=url.hostname.toLowerCase();
      if(url.protocol!=="https:"||url.username||url.password)return false;
      if(host==="localhost"||host.endsWith(".local")||host==="::1"||host.startsWith("127.")||host.startsWith("10.")||host.startsWith("192.168.")||host.startsWith("169.254."))return false;
      const m=host.match(/^172\.(\d{1,3})\./);if(m&&Number(m[1])>=16&&Number(m[1])<=31)return false;
      return true;
    }catch{return false}
  },{message:"Public HTTPS URL required"});
  const common={
    bankName:z.string().min(2).max(120),
    programmeName:z.string().min(2).max(120),
    cardNetwork:z.enum(["VISA","MASTERCARD","RUPAY","AMEX","DINERS","OTHER"])
  };
  const enKash=z.object({
    provider:z.literal("enkash"),...common,
    baseUrl:publicHttps,tokenUrl:publicHttps,partnerId:z.string().min(1).max(200),basicAuth:z.string().min(1).max(1000),
    username:z.string().min(1).max(200),password:z.string().min(1).max(500),clientId:z.string().min(1).max(200),
    companyId:z.string().min(1).max(200),cardAccountId:z.string().min(1).max(200)
  });
  const bankCode=z.enum(["hdfc","axis","icici","sbi","yes","kotak","indusind","idfc","bob","custom"]);
  const relativePath=z.string().min(1).max(300).refine(v=>v.startsWith("/")&&!v.startsWith("//"),{message:"Relative API path required"});
  const jsonTemplate=z.string().min(2).max(20000).refine(v=>{try{JSON.parse(v);return true}catch{return false}},{message:"Valid JSON template required"});
  const generic=z.object({
    provider:bankCode,...common,
    integrationMode:z.enum(["PARENT_CARD_API","CUSTOM_BANK_API"]),
    baseUrl:publicHttps,
    authMode:z.enum(["OAUTH2_CLIENT_CREDENTIALS","BEARER","BASIC","API_KEY"]),
    tokenUrl:publicHttps.optional(),
    clientId:z.string().max(500).optional(),clientSecret:z.string().max(2000).optional(),
    bearerToken:z.string().max(8000).optional(),username:z.string().max(500).optional(),password:z.string().max(2000).optional(),
    apiKey:z.string().max(8000).optional(),apiKeyHeader:z.string().regex(/^[A-Za-z0-9-]{1,80}$/).optional(),
    parentAccountReference:z.string().min(2).max(500),
    healthPath:relativePath.optional(),
    createCardPath:relativePath,
    controlCardPath:relativePath.optional(),
    loadCardPath:relativePath.optional(),
    createCardTemplate:jsonTemplate,
    controlCardTemplate:jsonTemplate.optional(),
    loadCardTemplate:jsonTemplate.optional(),
    responseCardIdPath:z.string().min(1).max(300),
    responseAccountIdPath:z.string().max(300).optional(),
    responseMaskedNumberPath:z.string().max(300).optional(),
    responseStatusPath:z.string().max(300).optional(),
    responseBalancePath:z.string().max(300).optional(),
    responseBalanceUnit:z.enum(["MINOR","RUPEES"]).default("MINOR")
  }).superRefine((value,ctx)=>{
    if(value.authMode==="OAUTH2_CLIENT_CREDENTIALS"&&(!value.tokenUrl||!value.clientId||!value.clientSecret))ctx.addIssue({code:"custom",message:"OAuth token URL, client ID and client secret are required"});
    if(value.authMode==="BEARER"&&!value.bearerToken)ctx.addIssue({code:"custom",message:"Bearer token is required"});
    if(value.authMode==="BASIC"&&(!value.username||!value.password))ctx.addIssue({code:"custom",message:"Basic auth username and password are required"});
    if(value.authMode==="API_KEY"&&!value.apiKey)ctx.addIssue({code:"custom",message:"API key is required"});
    if(Boolean(value.controlCardPath)!==Boolean(value.controlCardTemplate))ctx.addIssue({code:"custom",message:"Control API path and template must be supplied together"});
    if(Boolean(value.loadCardPath)!==Boolean(value.loadCardTemplate))ctx.addIssue({code:"custom",message:"Limit/load API path and template must be supplied together"});
  });
  const body=z.union([enKash,generic]).parse(req.body);
  try{
    if(body.provider==="enkash"){
      const saved=await testAndSaveEnKashConnection(db,config,{
        tenantId:p.tenantId,userId:p.id,
        credentials:{ENKASH_BASE_URL:body.baseUrl,ENKASH_TOKEN_URL:body.tokenUrl,ENKASH_PARTNER_ID:body.partnerId,ENKASH_BASIC_AUTH:body.basicAuth,ENKASH_USERNAME:body.username,ENKASH_PASSWORD:body.password,ENKASH_CLIENT_ID:body.clientId,ENKASH_COMPANY_ID:body.companyId,ENKASH_CARD_ACCOUNT_ID:body.cardAccountId},
        metadata:{bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork}
      });
      await audit(db,p.tenantId,p.id,"issuer.connected","issuer_connection",saved.connectionId,{provider:"enkash",bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork});
      return {provider:"enkash",configured:true,source:"tenant",connectionId:saved.connectionId,bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork};
    }
    const saved=await testAndSaveBankConnection(db,config,{
      tenantId:p.tenantId,userId:p.id,
      credentials:{
        bankCode:body.provider,baseUrl:body.baseUrl,authMode:body.authMode,tokenUrl:body.tokenUrl,
        clientId:body.clientId,clientSecret:body.clientSecret,bearerToken:body.bearerToken,username:body.username,password:body.password,
        apiKey:body.apiKey,apiKeyHeader:body.apiKeyHeader,parentAccountReference:body.parentAccountReference,healthPath:body.healthPath,
        createCardPath:body.createCardPath,controlCardPath:body.controlCardPath,loadCardPath:body.loadCardPath,
        createCardTemplate:body.createCardTemplate,controlCardTemplate:body.controlCardTemplate,loadCardTemplate:body.loadCardTemplate,
        responseCardIdPath:body.responseCardIdPath,responseAccountIdPath:body.responseAccountIdPath,responseMaskedNumberPath:body.responseMaskedNumberPath,
        responseStatusPath:body.responseStatusPath,responseBalancePath:body.responseBalancePath,responseBalanceUnit:body.responseBalanceUnit
      },
      metadata:{bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork,bankCode:body.provider,integrationMode:body.integrationMode}
    });
    await audit(db,p.tenantId,p.id,"issuer.connected","issuer_connection",saved.connectionId,{provider:body.provider,bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork,integrationMode:body.integrationMode,capabilities:saved.capabilities});
    return {provider:body.provider,configured:true,source:"tenant",connectionId:saved.connectionId,bankName:body.bankName,programmeName:body.programmeName,cardNetwork:body.cardNetwork,bankCode:body.provider,integrationMode:body.integrationMode,capabilities:saved.capabilities};
  }catch(error:any){
    req.log.warn({err:String(error.message).slice(0,160)},"issuer connection test failed");
    return reply.code(400).send({error:"issuer_connection_failed",message:String(error.message).slice(0,160)});
  }
});

app.delete("/api/cards/provider",async(req,reply)=>{
  const p=req.principal!;
  if(p.role!=="OWNER")return reply.code(403).send({error:"owner_required"});
  const provider=z.string().max(40).optional().parse((req.query as any)?.provider);
  await disconnectTenantIssuer(db,p.tenantId,provider);
  await audit(db,p.tenantId,p.id,"issuer.disconnected","issuer_connection",null,{provider:provider??"all"});
  return {ok:true};
});
app.get("/api/cards",async(req)=>{
  const p=req.principal!,state=await loadTenantIssuer(db,config,p.tenantId);
  const {rows}=await db.query(`
    select vc.id,vc.provider,vc.provider_card_id,vc.provider_account_id,vc.label,vc.masked_number,
      vc.status,vc.balance_minor,vc.currency,vc.merchant_control,vc.customer_id,vc.checkout_basket_id,vc.created_at,
      vc.issuer_connection_id,vc.merchant_scope_type,vc.merchant_scope_value,vc.channel_control_status,
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
  const retailerId=z.string().regex(/^(amazon-in|flipkart|myntra|ajio|tatacliq|meesho|nykaa|jiomart|store:[a-z0-9.-]+)$/);
  const input=z.object({
    quantity:z.number().int().min(1).max(100),
    amountMinor:z.number().int().min(100),
    issuerConnectionId:z.string().uuid().optional(),
    merchantScope:z.object({type:z.enum(["ALL","RETAILER"]),value:retailerId.optional()}).optional(),
    merchantControl:z.string().min(1).max(120).optional(),
    label:z.string().max(120).optional(),
    customerId:z.string().uuid().optional(),
    checkoutBasketId:z.string().uuid().optional(),
    cardholder:z.object({
      email:z.string().email().optional(),
      mobile:z.string().regex(/^\d{10,15}$/).optional(),
      firstName:z.string().min(1).max(60).optional(),
      lastName:z.string().min(1).max(60).optional(),
      gender:z.enum(["M","F","O"]).optional(),
      pan:z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).optional(),
      specialDate:z.string().regex(/^\d{2}-\d{2}-\d{4}$/).optional()
    }).default({})
  }).parse(req.body);
  const scope=input.merchantScope??{type:"ALL" as const,value:undefined};
  if(scope.type==="RETAILER"&&!scope.value)return reply.code(400).send({error:"merchant_required"});
  const state=await loadTenantIssuer(db,config,p.tenantId,input.issuerConnectionId),cardIssuer=state.issuer;
  if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});
  if(cardIssuer.provider==="enkash"){
    const h=input.cardholder;
    if(!h.email||!h.mobile||!h.firstName||!h.lastName||!h.gender||!h.pan||!h.specialDate)return reply.code(400).send({error:"cardholder_profile_required"});
  }

  let ownerCustomerId=input.customerId??null;
  let ownerBasketId=input.checkoutBasketId??null;
  if(ownerBasketId){
    const basket=await db.query("select customer_id,retailer from checkout_baskets where id=$1 and tenant_id=$2",[ownerBasketId,p.tenantId]);
    if(!basket.rows[0])return reply.code(404).send({error:"basket_not_found"});
    if(ownerCustomerId&&ownerCustomerId!==basket.rows[0].customer_id)return reply.code(409).send({error:"basket_customer_mismatch"});
    if(scope.type==="RETAILER"&&scope.value!==basket.rows[0].retailer)return reply.code(409).send({error:"merchant_scope_mismatch"});
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
      const issued=await cardIssuer.createCard({cardholder:input.cardholder,label:input.label||`OrderGrid card ${i+1}`,amountMinor:input.amountMinor});
      const merchantLabel=scope.type==="RETAILER"?`Retailer: ${scope.value}`:"All approved retailers";
      const inserted=await db.query(
        `insert into virtual_cards(
          tenant_id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,merchant_control,
          created_by,customer_id,checkout_basket_id,issuer_connection_id,merchant_scope_type,merchant_scope_value,channel_control_status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'NOT_APPLIED')
        returning *`,
        [
          p.tenantId,issued.provider,issued.providerCardId,issued.providerAccountId,input.label||`Procurement card ${i+1}`,
          issued.maskedNumber??null,issued.status,issued.balanceMinor,merchantLabel,p.id,ownerCustomerId,ownerBasketId,
          state.connectionId,scope.type,scope.value??null
        ]
      );
      const card=inserted.rows[0];
      try{
        const controlStatus=await cardIssuer.configureCard({providerCardId:issued.providerCardId,providerAccountId:issued.providerAccountId,onlineAllowed:true,posAllowed:false});
        await db.query("update virtual_cards set channel_control_status=$1,updated_at=now() where id=$2",[controlStatus,card.id]);
      }catch(error:any){
        await db.query("update virtual_cards set channel_control_status='FAILED',status='CONTROL_FAILED',updated_at=now() where id=$1",[card.id]);
        failures.push({index:i+1,providerCardId:issued.providerCardId,error:"issuer_control_failed"});
        await audit(db,p.tenantId,p.id,"virtual_card.control_failed","virtual_card",card.id,{error:String(error.message).slice(0,180)});
        continue;
      }
      try{
        await cardIssuer.loadCard({providerCardId:issued.providerCardId,providerAccountId:issued.providerAccountId,amountMinor:input.amountMinor,reference:`ordergrid-${card.id}`});
        const loaded=await db.query(
          "update virtual_cards set balance_minor=greatest(balance_minor,$1),status='ACTIVE',updated_at=now() where id=$2 returning *",
          [input.amountMinor,card.id]
        );
        cards.push(loaded.rows[0]);
        if(ownerBasketId)await db.query("update checkout_baskets set virtual_card_id=$1,updated_at=now() where id=$2 and tenant_id=$3",[card.id,ownerBasketId,p.tenantId]);
        await audit(db,p.tenantId,p.id,"virtual_card.created_and_loaded","virtual_card",card.id,{provider:issued.provider,amountMinor:input.amountMinor,merchantScope:scope,customerId:ownerCustomerId,checkoutBasketId:ownerBasketId});
      }catch(error:any){
        await db.query("update virtual_cards set status='LOAD_FAILED',updated_at=now() where id=$1",[card.id]);
        failures.push({index:i+1,providerCardId:issued.providerCardId,error:String(error.message).slice(0,180)});
        await audit(db,p.tenantId,p.id,"virtual_card.load_failed","virtual_card",card.id,{provider:issued.provider,error:String(error.message).slice(0,180)});
      }
    }catch(error:any){failures.push({index:i+1,error:String(error.message).slice(0,180)})}
  }
  return reply.code(cards.length?201:502).send({created:cards.length,failed:failures.length,cards,failures});
});
app.post("/api/cards/:id/load",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id),body=z.object({amountMinor:z.number().int().min(100)}).parse(req.body);
  const {rows}=await db.query("select id,provider_card_id,provider_account_id,issuer_connection_id,channel_control_status from virtual_cards where id=$1 and tenant_id=$2",[id,p.tenantId]);
  if(!rows[0])return reply.code(404).send({error:"card_not_found"});
  if(!["APPLIED","NOT_SUPPORTED"].includes(rows[0].channel_control_status))return reply.code(409).send({error:"card_controls_not_ready"});
  const state=await loadTenantIssuer(db,config,p.tenantId,rows[0].issuer_connection_id),cardIssuer=state.issuer;
  if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});
  if(state.metadata.capabilities?.loadCard===false)return reply.code(409).send({error:"bank_limit_update_not_supported"});
  await cardIssuer.loadCard({providerCardId:rows[0].provider_card_id,providerAccountId:rows[0].provider_account_id,amountMinor:body.amountMinor,reference:`ordergrid-load-${id}-${Date.now()}`});
  const updated=await db.query("update virtual_cards set balance_minor=balance_minor+$1,status='ACTIVE',updated_at=now() where id=$2 returning *",[body.amountMinor,id]);
  await audit(db,p.tenantId,p.id,"virtual_card.loaded","virtual_card",id,{amountMinor:body.amountMinor});
  return updated.rows[0];
});

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
    group by cb.id,c.external_reference,ra.profile_key,ra.auth_status,ra.credential_status,a.recipient,a.city,a.postal_code,b.name,b.payment_route
    order by cb.created_at desc limit 500
  `,[p.tenantId]);
  return {baskets:rows};
});

app.post("/api/bulk-queue/claim",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const {limit}=z.object({limit:z.number().int().min(1).max(25).default(10)}).parse(req.body??{});
  const policy=await getAutomationPolicy(p.tenantId);
  const result=await claimReadyBaskets(p.tenantId,p.id,limit,policy);
  if("error" in result)return reply.code(409).send({error:result.error});
  await audit(db,p.tenantId,p.id,"bulk_queue.claimed","checkout_basket",null,{count:result.ids.length});
  return result;
});

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

app.post("/api/bulk-queue/:id/commercial-check",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({
    workerId:z.string().min(8).max(128),
    amountMinor:z.number().int().nonnegative(),
    currency:z.literal("INR").default("INR")
  }).parse(req.body);
  const basket=await db.query(
    "select id,batch_id,status from checkout_baskets where id=$1 and tenant_id=$2 and execution_worker_id=$3 and status in ('CLAIMED','OPENED','REQUIRES_ACTION') limit 1",
    [id,p.tenantId,body.workerId]
  );
  if(!basket.rows[0])return reply.code(409).send({error:"basket_not_owned_by_worker"});
  const expected=await db.query(
    "select coalesce(sum(amount_minor),0)::bigint expected_minor from purchase_orders where tenant_id=$1 and checkout_basket_id=$2",
    [p.tenantId,id]
  );
  const expectedMinor=Number(expected.rows[0]?.expected_minor||0);
  if(expectedMinor<=0)return reply.code(409).send({error:"expected_price_missing"});
  const policy=await getAutomationPolicy(p.tenantId);
  const orderVariancePercent=Math.max(0,(body.amountMinor-expectedMinor)/expectedMinor*100);

  const batchTotals=await db.query(`
    with expected_by_basket as (
      select cb.id,cb.observed_amount_minor,coalesce(sum(po.amount_minor),0)::bigint expected_minor
      from checkout_baskets cb
      left join purchase_orders po on po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id
      where cb.tenant_id=$1 and cb.batch_id=$2
      group by cb.id
    )
    select
      coalesce(sum(expected_minor),0)::bigint expected_batch_minor,
      coalesce(sum(case when id=$3 then $4::bigint else coalesce(observed_amount_minor,expected_minor) end),0)::bigint projected_batch_minor
    from expected_by_basket
  `,[p.tenantId,basket.rows[0].batch_id,id,body.amountMinor]);
  const expectedBatchMinor=Number(batchTotals.rows[0]?.expected_batch_minor||0);
  const projectedBatchMinor=Number(batchTotals.rows[0]?.projected_batch_minor||0);
  const batchVariancePercent=expectedBatchMinor>0?Math.max(0,(projectedBatchMinor-expectedBatchMinor)/expectedBatchMinor*100):0;

  const breaches:string[]=[];
  if(orderVariancePercent>Number(policy.max_price_increase_percent))breaches.push("PRICE_VARIANCE");
  if(Number(policy.max_order_value_minor)>0&&body.amountMinor>Number(policy.max_order_value_minor))breaches.push("ORDER_VALUE");
  if(batchVariancePercent>Number(policy.max_batch_variance_percent))breaches.push("BATCH_VARIANCE");

  await db.query(
    "update checkout_baskets set observed_amount_minor=$1,commercial_variance_percent=$2,commercial_checked_at=now(),updated_at=now() where id=$3 and tenant_id=$4",
    [body.amountMinor,orderVariancePercent,id,p.tenantId]
  );

  if(breaches.length){
    if(policy.price_breach_action==="PAUSE_BATCH"){
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',commercial_status='REVIEW_REQUIRED',failure_code='PRICE_POLICY_REVIEW_REQUIRED',failure_message=$1,execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$2 and batch_id=$3 and status in ('READY','CLAIMED','OPENED','REQUIRES_ACTION')",
        ["Commercial policy review required: "+breaches.join(", "),p.tenantId,basket.rows[0].batch_id]
      );
    }else{
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',commercial_status='REVIEW_REQUIRED',failure_code='PRICE_POLICY_REVIEW_REQUIRED',failure_message=$1,execution_worker_id=null,expires_at=null,updated_at=now() where id=$2 and tenant_id=$3",
        ["Commercial policy review required: "+breaches.join(", "),id,p.tenantId]
      );
    }
    await audit(db,p.tenantId,p.id,"automation.commercial_review","checkout_basket",id,{
      expectedMinor,observedMinor:body.amountMinor,orderVariancePercent,batchVariancePercent,breaches,action:policy.price_breach_action
    });
    return {
      allowed:false,
      status:"REVIEW_REQUIRED",
      expectedAmountMinor:expectedMinor,
      observedAmountMinor:body.amountMinor,
      orderVariancePercent,
      batchVariancePercent,
      breaches,
      action:policy.price_breach_action
    };
  }

  await db.query(
    "update checkout_baskets set commercial_status='APPROVED',failure_code=case when failure_code='PRICE_POLICY_REVIEW_REQUIRED' then null else failure_code end,failure_message=case when failure_code='PRICE_POLICY_REVIEW_REQUIRED' then null else failure_message end,updated_at=now() where id=$1 and tenant_id=$2",
    [id,p.tenantId]
  );
  await audit(db,p.tenantId,p.id,"automation.commercial_approved","checkout_basket",id,{
    expectedMinor,observedMinor:body.amountMinor,orderVariancePercent,batchVariancePercent
  });
  return {
    allowed:true,
    status:"APPROVED",
    approvedAmountMinor:body.amountMinor,
    expectedAmountMinor:expectedMinor,
    observedAmountMinor:body.amountMinor,
    orderVariancePercent,
    batchVariancePercent
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
    const policy=await getAutomationPolicy(p.tenantId);
    const batch=await db.query("select batch_id from checkout_baskets where id=$1 and tenant_id=$2",[id,p.tenantId]);
    if(batch.rows[0]&&Number(policy.failure_pause_percent)<100){
      const counts=await db.query("select count(*)::int total,count(*) filter(where status='FAILED')::int failed from checkout_baskets where tenant_id=$1 and batch_id=$2",[p.tenantId,batch.rows[0].batch_id]);
      const total=Number(counts.rows[0]?.total||0),failed=Number(counts.rows[0]?.failed||0);
      const failurePercent=total?failed/total*100:0;
      if(failurePercent>=Number(policy.failure_pause_percent)){
        await db.query(
          "update checkout_baskets set status='REQUIRES_ACTION',failure_code='POLICY_REVIEW_REQUIRED',failure_message='Batch paused by automation policy after failure threshold was reached',execution_worker_id=null,expires_at=null,updated_at=now() where tenant_id=$1 and batch_id=$2 and status in ('READY','CLAIMED','OPENED')",
          [p.tenantId,batch.rows[0].batch_id]
        );
      }
    }
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
    await client.query("update checkout_baskets set status='CONFIRMED',payment_status='CONFIRMED',retailer_order_id=$1,confirmed_at=now(),reconciliation_status='PENDING',reconciliation_next_at=now()+interval '2 hours',reconciliation_error=null,updated_at=now() where id=$2",[retailerOrderId,id]);
    await client.query("update retailer_accounts set auth_status='READY',credential_status=case when credential_status='STORED' then 'READY' else credential_status end,last_authenticated_at=now(),updated_at=now() where id=$1 and tenant_id=$2",[locked.rows[0].retailer_account_id,p.tenantId]);
    await client.query("update order_batches b set status=case when not exists(select 1 from checkout_baskets x where x.batch_id=b.id and x.status<>'CONFIRMED') then 'COMPLETE' else 'PARTIAL' end,updated_at=now() where b.id=$1",[locked.rows[0].batch_id]);
    await client.query("commit");
    await audit(db,p.tenantId,p.id,"bulk_basket.confirmed_by_worker","checkout_basket",id,{workerId:body.workerId,retailerOrderId,customerId:locked.rows[0].customer_id,retailerAccountId:locked.rows[0].retailer_account_id});
    return {id,status:"CONFIRMED",retailerOrderId};
  }catch(e){await client.query("rollback");throw e}finally{client.release()}
});

app.get("/api/gst/profile",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query("select * from gst_profiles where tenant_id=$1",[p.tenantId]);
  return {profile:rows[0]??null};
});

app.put("/api/gst/profile",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const body=z.object({
    legalName:z.string().min(2).max(180),tradeName:z.string().max(180).optional().nullable(),
    gstin:z.string().transform(v=>v.trim().toUpperCase()).refine(validateGstin,{message:"Invalid GSTIN"}),
    addressLine1:z.string().min(3).max(240),addressLine2:z.string().max(240).optional().nullable(),
    city:z.string().min(2).max(120),state:z.string().min(2).max(120),stateCode:z.string().regex(/^\d{2}$/),
    postalCode:z.string().regex(/^\d{6}$/),invoicePrefix:z.string().regex(/^[A-Za-z0-9_-]{1,12}$/),
    eInvoiceApplicable:z.boolean().default(false),signatoryName:z.string().max(160).optional().nullable()
  }).parse(req.body);
  if(body.gstin.slice(0,2)!==body.stateCode)return reply.code(400).send({error:"gstin_state_code_mismatch"});
  const {rows}=await db.query(
    `insert into gst_profiles(tenant_id,legal_name,trade_name,gstin,address_line1,address_line2,city,state,state_code,postal_code,invoice_prefix,e_invoice_applicable,signatory_name,updated_by,updated_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
     on conflict(tenant_id) do update set legal_name=excluded.legal_name,trade_name=excluded.trade_name,gstin=excluded.gstin,
       address_line1=excluded.address_line1,address_line2=excluded.address_line2,city=excluded.city,state=excluded.state,state_code=excluded.state_code,
       postal_code=excluded.postal_code,invoice_prefix=excluded.invoice_prefix,e_invoice_applicable=excluded.e_invoice_applicable,
       signatory_name=excluded.signatory_name,updated_by=excluded.updated_by,updated_at=now()
     returning *`,
    [p.tenantId,body.legalName,body.tradeName??null,body.gstin,body.addressLine1,body.addressLine2??null,body.city,body.state,body.stateCode,body.postalCode,body.invoicePrefix.toUpperCase(),body.eInvoiceApplicable,body.signatoryName??null,p.id]
  );
  await audit(db,p.tenantId,p.id,"gst.profile_updated","gst_profile",p.tenantId,{gstin:body.gstin,stateCode:body.stateCode,eInvoiceApplicable:body.eInvoiceApplicable});
  return {profile:rows[0]};
});

app.get("/api/gst/invoices",async(req)=>{
  const p=req.principal!;
  const {rows}=await db.query(
    "select id,checkout_basket_id,invoice_number,invoice_date,status,total_minor,irn,created_at from gst_invoices where tenant_id=$1 order by created_at desc limit 250",
    [p.tenantId]
  );
  return {invoices:rows};
});

app.post("/api/gst/invoices",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const body=z.object({basketId:z.string().uuid(),invoiceDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).parse(req.body);
  try{
    const invoice=await createGstInvoice(db,p.tenantId,p.id,body.basketId,body.invoiceDate?new Date(body.invoiceDate+"T00:00:00Z"):new Date());
    await audit(db,p.tenantId,p.id,"gst.invoice_created","gst_invoice",invoice.id,{basketId:body.basketId,status:invoice.status});
    return reply.code(201).send(invoice);
  }catch(error:any){
    const code=String(error.message||"gst_invoice_failed");
    if(["gst_profile_required","basket_not_found","confirmed_order_required","buyer_state_code_required","gst_classification_required","invoice_lines_required"].includes(code))return reply.code(409).send({error:code});
    throw error;
  }
});

app.patch("/api/gst/invoices/:id/irn",async(req,reply)=>{
  const p=req.principal!;
  if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});
  const id=z.string().uuid().parse((req.params as any).id);
  const body=z.object({irn:z.string().min(20).max(128),signedQr:z.string().min(10).max(10000)}).parse(req.body);
  const {rows}=await db.query(
    "update gst_invoices set irn=$1,signed_qr=$2,status='READY',updated_at=now() where id=$3 and tenant_id=$4 returning id,invoice_number,status,irn",
    [body.irn,body.signedQr,id,p.tenantId]
  );
  if(!rows[0])return reply.code(404).send({error:"invoice_not_found"});
  await audit(db,p.tenantId,p.id,"gst.invoice_irn_attached","gst_invoice",id);
  return rows[0];
});

app.get("/api/gst/invoices/:id/print",async(req,reply)=>{
  const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);
  const {rows}=await db.query("select * from gst_invoices where id=$1 and tenant_id=$2",[id,p.tenantId]);
  if(!rows[0])return reply.code(404).send({error:"invoice_not_found"});
  reply.header("content-type","text/html; charset=utf-8").header("cache-control","no-store");
  return renderGstInvoiceHtml(rows[0]);
});

app.get("/api/reports/gst.xlsx",async(req,reply)=>{
  const p=req.principal!;
  const query=z.object({
    from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId:z.string().uuid().optional()
  }).parse(req.query??{});
  try{
    const buffer=await buildGstWorkbook(db,p.tenantId,query);
    reply.header("content-type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition",'attachment; filename="ordergrid-gst-user-report.xlsx"');
    reply.header("cache-control","no-store");
    return reply.send(buffer);
  }catch(error:any){
    if(String(error.message)==="gst_profile_required")return reply.code(409).send({error:"gst_profile_required"});
    throw error;
  }
});

app.get("/api/dashboard/users",async(req)=>{
  const p=req.principal!;
  const query=z.object({
    from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId:z.string().uuid().optional()
  }).parse(req.query??{});
  return getUserDashboard(db,p.tenantId,query);
});

app.get("/api/reports/user-dashboard.xlsx",async(req,reply)=>{
  const p=req.principal!;
  const query=z.object({
    from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId:z.string().uuid().optional()
  }).parse(req.query??{});
  const buffer=await buildUserDashboardWorkbook(db,p.tenantId,query);
  reply.header("content-type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  reply.header("content-disposition",'attachment; filename="ordergrid-user-dashboard.xlsx"');
  reply.header("cache-control","no-store");
  return reply.send(buffer);
});

app.get("/api/reports/user-dashboard.csv",async(req,reply)=>{
  const p=req.principal!;
  const query=z.object({
    from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    userId:z.string().uuid().optional()
  }).parse(req.query??{});
  const csv=await buildUserDashboardCsv(db,p.tenantId,query);
  reply.header("content-type","text/csv; charset=utf-8");
  reply.header("content-disposition",'attachment; filename="ordergrid-user-dashboard.csv"');
  reply.header("cache-control","no-store");
  return csv;
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

app.post("/api/batches",async(req,reply)=>{
  const p=req.principal!;
  const input=z.object({
    name:z.string().min(3).max(120),
    paymentRoute:z.enum(["Corporate virtual card","Cash on Delivery"]).default("Corporate virtual card"),
    items:z.array(z.object({
      productUrl:z.string().url(),
      quantity:z.number().int().positive().max(10000),
      addressId:z.string().uuid().optional(),
      estimatedUnitPriceMinor:z.number().int().positive().optional(),
      hsnSac:z.string().trim().min(2).max(16).optional(),
      gstRate:z.number().min(0).max(100).optional(),
      cessRate:z.number().min(0).max(100).default(0),
      priceIncludesGst:z.boolean().default(true)
    })).min(1).max(5000)
  }).parse(req.body);

  const fullyEstimated=input.items.every(i=>i.estimatedUnitPriceMinor);
  if(!fullyEstimated&&!jobs)return reply.code(422).send({error:"estimated_price_required"});

  const preparedItems=input.items.map(item=>({...item,retailer:retailerForProductUrl(item.productUrl).id}));
  const addressIds=[...new Set(preparedItems.flatMap(item=>item.addressId?[item.addressId]:[]))];
  if(addressIds.length){
    const owned=await db.query(
      `select count(*)::int count
       from addresses a
       join address_books ab on ab.id=a.address_book_id
       where a.id=any($1::uuid[]) and ab.tenant_id=$2`,
      [addressIds,p.tenantId]
    );
    if(Number(owned.rows[0]?.count||0)!==addressIds.length)return reply.code(404).send({error:"recipient_not_found"});
  }

  const total=preparedItems.reduce((sum,i)=>sum+(i.estimatedUnitPriceMinor??0)*i.quantity,0);
  const c=await db.connect();
  try{
    await c.query("begin");
    const b=await c.query(
      "insert into order_batches(tenant_id,name,created_by,status,estimated_total_minor,payment_route) values($1,$2,$3,$4,$5,$6) returning id,status",
      [p.tenantId,input.name,p.id,fullyEstimated?"AWAITING_APPROVAL":"DRAFT",total,input.paymentRoute]
    );
    for(const item of preparedItems){
      await c.query(
        "insert into batch_items(batch_id,product_url,retailer,requested_quantity,address_id,unit_price_minor,pricing_status,pricing_checked_at,hsn_sac,gst_rate,cess_rate,price_includes_gst) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [b.rows[0].id,item.productUrl,item.retailer,item.quantity,item.addressId??null,item.estimatedUnitPriceMinor??null,item.estimatedUnitPriceMinor?"ESTIMATED":"PENDING",item.estimatedUnitPriceMinor?new Date():null,item.hsnSac??null,item.gstRate??null,item.cessRate??0,item.priceIncludesGst]
      );
    }
    await c.query("commit");
    await audit(db,p.tenantId,p.id,"batch.created","order_batch",b.rows[0].id,{items:preparedItems.length,total});
    if(!fullyEstimated&&jobs){
      await jobs.queue.add("price-batch",{batchId:b.rows[0].id,tenantId:p.tenantId},{
        jobId:`price:${b.rows[0].id}`,
        attempts:5,
        backoff:{type:"exponential",delay:2000},
        removeOnComplete:1000
      });
    }
    return reply.code(201).send(b.rows[0]);
  }catch(e){
    await c.query("rollback");
    throw e;
  }finally{
    c.release();
  }
});
app.post("/api/batches/:id/approve",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const id=z.string().uuid().parse((req.params as any).id);const {rows}=await db.query("update order_batches set status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now() where id=$2 and tenant_id=$3 and status='AWAITING_APPROVAL' returning id",[p.id,id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"batch_not_approvable"});await audit(db,p.tenantId,p.id,"batch.approved","order_batch",id);if(jobs){await jobs.queue.add("place-batch",{batchId:id,tenantId:p.tenantId},{jobId:`place:${id}`,attempts:3,backoff:{type:"exponential",delay:5000}});}else{await db.query(`insert into purchase_orders(tenant_id,batch_item_id,status,retailer,amount_minor,idempotency_key) select $1,i.id,'REQUIRES_ACTION',i.retailer,i.unit_price_minor*i.requested_quantity,$2||i.id from batch_items i where i.batch_id=$3 on conflict(idempotency_key) do update set amount_minor=excluded.amount_minor,failure_code=null,failure_message=null,updated_at=now()`,[p.tenantId,`basket:${id}:`,id]);await syncCheckoutBaskets(db,p.tenantId,id);const automationPolicy=await getAutomationPolicy(p.tenantId);if(automationPolicy.run_mode==="CONTINUOUS"&&automationPolicy.automation_enabled){await claimReadyBaskets(p.tenantId,p.id,Number(automationPolicy.max_active_orders||8),automationPolicy);}}return {ok:true};});
app.setErrorHandler((error,req,reply)=>{req.log.error(error);if(error instanceof z.ZodError)return reply.code(400).send({error:"invalid_request",issues:error.issues});return reply.code(500).send({error:"internal_error",requestId:req.id});});

async function bootstrap(){const {rows}=await db.query("select count(*)::int count from users");if(rows[0].count)return;const adminSecret=config.BOOTSTRAP_ADMIN_PASSWORD??config.BOOTSTRAP_ADMIN_SECRET!;const c=await db.connect();try{await c.query("begin");const t=await c.query("insert into tenants(name) values('OrderGrid') returning id");await c.query("insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,'OWNER')",[t.rows[0].id,config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),await hashPassword(adminSecret)]);await c.query("commit");}catch(e){await c.query("rollback");throw e}finally{c.release()}}
await bootstrap(); await app.listen({port:config.PORT,host:"0.0.0.0"});
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{await app.close();if(jobs){await jobs.queue.close();jobs.connection.disconnect();}await db.end();process.exit(0)});
