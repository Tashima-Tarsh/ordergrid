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
import { hashPassword, tokenHash, verifyPassword } from "./security.js";
import { createOrderQueue } from "./queue.js";
import { retailerForProductUrl, validateRetailerOrderId, verifiedRetailerUrl } from "./retailers.js";
import { syncCheckoutBaskets } from "./baskets.js";
import { createVirtualCardIssuer } from "./card-issuer.js";

const config=loadConfig(), db=createDb(config), jobs=config.REDIS_URL?createOrderQueue(config.REDIS_URL):null, cardIssuer=createVirtualCardIssuer(config);
const app=Fastify({logger:{redact:["req.headers.authorization","req.headers.cookie","password"]},trustProxy:true,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}});
await app.register(rateLimit,{max:120,timeWindow:"1 minute"}); await app.register(cookie,{secret:config.SESSION_SECRET});
await app.register(multipart,{limits:{fileSize:5_000_000,files:1}});
await app.register(staticPlugin,{root:join(dirname(fileURLToPath(import.meta.url)),"../public"),prefix:"/"});

declare module "fastify" { interface FastifyRequest { principal?:{id:string;tenantId:string;role:string} } }
app.addHook("preHandler",async(req,reply)=>{ if(!req.url.startsWith("/api/")||req.url==="/api/health"||req.url==="/api/login")return; const raw=req.cookies.session; if(!raw)return reply.code(401).send({error:"unauthorized"}); const {rows}=await db.query(`select u.id,u.tenant_id,u.role from sessions s join users u on u.id=s.user_id where s.id_hash=$1 and s.expires_at>now() and u.active`,[tokenHash(raw)]); if(!rows[0])return reply.code(401).send({error:"unauthorized"}); req.principal={id:rows[0].id,tenantId:rows[0].tenant_id,role:rows[0].role}; });

app.get("/api/health",async()=>{await db.query("select 1");return {status:"ok"}});
app.post("/api/login",{config:{rateLimit:{max:8,timeWindow:"15 minutes"}}},async(req,reply)=>{const input=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body); const {rows}=await db.query("select id,tenant_id,role,password_hash from users where email=$1 and active",[input.email.toLowerCase()]); const u=rows[0]; if(!u||!await verifyPassword(input.password,u.password_hash))return reply.code(401).send({error:"invalid_credentials"}); const token=randomBytes(32).toString("base64url"); await db.query("insert into sessions(id_hash,user_id,expires_at) values($1,$2,now()+interval '12 hours')",[tokenHash(token),u.id]); reply.setCookie("session",token,{httpOnly:true,secure:config.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:43200}); return {user:{id:u.id,role:u.role}};});
app.post("/api/logout",async(req,reply)=>{const raw=req.cookies.session;if(raw)await db.query("delete from sessions where id_hash=$1",[tokenHash(raw)]);reply.clearCookie("session",{path:"/"});return {ok:true}});
app.get("/api/dashboard",async(req)=>{const p=req.principal!;const [b,o]=await Promise.all([db.query("select status,count(*)::int count,coalesce(sum(estimated_total_minor),0)::bigint total from order_batches where tenant_id=$1 group by status",[p.tenantId]),db.query("select status,count(*)::int count from purchase_orders where tenant_id=$1 group by status",[p.tenantId])]);return {batches:b.rows,orders:o.rows};});
app.get("/api/batches",async(req)=>{const p=req.principal!;const {rows}=await db.query(`select b.id,b.name,b.status,b.currency,b.payment_route,b.estimated_total_minor,b.created_at,count(i.id)::int item_count,count(distinct i.address_id)::int recipient_count from order_batches b left join batch_items i on i.batch_id=b.id where b.tenant_id=$1 group by b.id order by b.created_at desc limit 100`,[p.tenantId]);return {batches:rows};});
app.post("/api/address-books/import",async(req,reply)=>{const p=req.principal!;const file=await req.file();if(!file)return reply.code(400).send({error:"file_required"});const buffer=await file.toBuffer();let rows:string[][]=[];if(file.filename.toLowerCase().endsWith(".xlsx")){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer as any);const sheet=workbook.worksheets[0];if(!sheet)return reply.code(400).send({error:"empty_workbook"});sheet.eachRow(r=>rows.push((r.values as any[]).slice(1).map(v=>String(v??"").trim())));}else{rows=buffer.toString("utf8").replace(/^\uFEFF/,"").split(/\r?\n/).filter(Boolean).map(line=>line.split(",").map(v=>v.trim().replace(/^"|"$/g,"")));}if(rows.length<2)return reply.code(400).send({error:"no_address_rows"});const headers=rows[0]!.map(h=>h.toLowerCase().replace(/[ _-]+/g,"_"));const required=["recipient","phone","line1","city","state","postal_code"];for(const h of required)if(!headers.includes(h))return reply.code(400).send({error:"missing_column",column:h});const value=(row:string[],name:string)=>row[headers.indexOf(name)]??"";const c=await db.connect();try{await c.query("begin");const book=await c.query("insert into address_books(tenant_id,name,created_by) values($1,$2,$3) returning id,name",[p.tenantId,file.filename.replace(/\.[^.]+$/,"").slice(0,120),p.id]);const ids:string[]=[];for(const row of rows.slice(1)){if(!row.some(Boolean))continue;const phone=value(row,"phone").replace(/\D/g,"");const postal=value(row,"postal_code").replace(/\D/g,"");if(phone.length<10||postal.length!==6)throw new Error("Invalid phone or postal code in address file");const inserted=await c.query(`insert into addresses(address_book_id,recipient,phone,line1,line2,city,state,postal_code,country,reference) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,[book.rows[0].id,value(row,"recipient"),phone,value(row,"line1"),value(row,"line2")||null,value(row,"city"),value(row,"state"),postal,(value(row,"country")||"IN").toUpperCase(),value(row,"reference")||null]);ids.push(inserted.rows[0].id);}if(!ids.length)throw new Error("No valid address rows");await c.query("commit");await audit(db,p.tenantId,p.id,"address_book.imported","address_book",book.rows[0].id,{count:ids.length});return reply.code(201).send({addressBook:book.rows[0],addressIds:ids,count:ids.length});}catch(e){await c.query("rollback");throw e}finally{c.release()}});
app.get("/api/checkout-tasks",async(req)=>{const p=req.principal!;const {rows}=await db.query(`select po.id,po.status,po.amount_minor,po.failure_message,bi.product_url,bi.title,bi.requested_quantity,a.id address_id,a.recipient,a.city,a.postal_code from purchase_orders po join batch_items bi on bi.id=po.batch_item_id left join addresses a on a.id=bi.address_id where po.tenant_id=$1 order by po.created_at desc limit 250`,[p.tenantId]);return {tasks:rows};});

app.post("/api/execution-worker/heartbeat",async(req)=>{const p=req.principal!;const body=z.object({workerId:z.string().min(8).max(128),hostname:z.string().max(120).optional(),mode:z.enum(["BULK"]).default("BULK")}).parse(req.body??{});await db.query(`insert into execution_workers(id,tenant_id,user_id,hostname,mode,last_seen) values($1,$2,$3,$4,$5,now()) on conflict(tenant_id,id) do update set user_id=excluded.user_id,hostname=excluded.hostname,mode=excluded.mode,last_seen=now()`,[body.workerId,p.tenantId,p.id,body.hostname??null,body.mode]);return {ok:true};});
app.get("/api/execution-workers",async(req)=>{const p=req.principal!;const {rows}=await db.query("select id,hostname,mode,last_seen from execution_workers where tenant_id=$1 and last_seen>now()-interval '30 seconds' order by last_seen desc",[p.tenantId]);return {workers:rows};});


app.get("/api/cards/provider",async()=>({provider:cardIssuer.provider,configured:cardIssuer.configured()}));
app.get("/api/cards",async(req)=>{const p=req.principal!;const {rows}=await db.query("select id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,created_at from virtual_cards where tenant_id=$1 order by created_at desc limit 500",[p.tenantId]);return {cards:rows,provider:cardIssuer.provider,configured:cardIssuer.configured()};});
app.post("/api/cards",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});const input=z.object({
  quantity:z.number().int().min(1).max(100),
  amountMinor:z.number().int().min(100),
  merchantControl:z.string().min(1).max(120).default("Approved retailers"),
  label:z.string().max(120).optional(),
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
const cards:any[]=[],failures:any[]=[];
for(let i=0;i<input.quantity;i++){
  try{
    const issued=await cardIssuer.createCard({cardholder:input.cardholder,label:input.label||`OrderGrid card ${i+1}`});
    const inserted=await db.query("insert into virtual_cards(tenant_id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,merchant_control,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,created_at",[p.tenantId,issued.provider,issued.providerCardId,issued.providerAccountId,input.label||`Procurement card ${i+1}`,issued.maskedNumber??null,issued.status,issued.balanceMinor,input.merchantControl,p.id]);
    const card=inserted.rows[0];
    try{
      await cardIssuer.loadCard({providerCardId:issued.providerCardId,providerAccountId:issued.providerAccountId,amountMinor:input.amountMinor,reference:`ordergrid-${card.id}`});
      const loaded=await db.query("update virtual_cards set balance_minor=balance_minor+$1,status='ACTIVE',updated_at=now() where id=$2 returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,created_at",[input.amountMinor,card.id]);
      cards.push(loaded.rows[0]);
      await audit(db,p.tenantId,p.id,"virtual_card.created_and_loaded","virtual_card",card.id,{provider:issued.provider,amountMinor:input.amountMinor,merchantControl:input.merchantControl});
    }catch(error:any){
      await db.query("update virtual_cards set status='LOAD_FAILED',updated_at=now() where id=$1",[card.id]);
      failures.push({index:i+1,providerCardId:issued.providerCardId,error:String(error.message).slice(0,180)});
      await audit(db,p.tenantId,p.id,"virtual_card.load_failed","virtual_card",card.id,{provider:issued.provider,error:String(error.message).slice(0,180)});
    }
  }catch(error:any){failures.push({index:i+1,error:String(error.message).slice(0,180)})}
}
return reply.code(cards.length?201:502).send({created:cards.length,failed:failures.length,cards,failures});
});
app.post("/api/cards/:id/load",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});if(!cardIssuer.configured())return reply.code(409).send({error:"card_issuer_not_connected"});const id=z.string().uuid().parse((req.params as any).id),body=z.object({amountMinor:z.number().int().min(100)}).parse(req.body);const {rows}=await db.query("select id,provider_card_id,provider_account_id from virtual_cards where id=$1 and tenant_id=$2",[id,p.tenantId]);if(!rows[0])return reply.code(404).send({error:"card_not_found"});await cardIssuer.loadCard({providerCardId:rows[0].provider_card_id,providerAccountId:rows[0].provider_account_id,amountMinor:body.amountMinor,reference:`ordergrid-load-${id}-${Date.now()}`});const updated=await db.query("update virtual_cards set balance_minor=balance_minor+$1,status='ACTIVE',updated_at=now() where id=$2 returning id,provider,provider_card_id,provider_account_id,label,masked_number,status,balance_minor,currency,merchant_control,created_at",[body.amountMinor,id]);await audit(db,p.tenantId,p.id,"virtual_card.loaded","virtual_card",id,{amountMinor:body.amountMinor});return updated.rows[0];});

app.get("/api/bulk-baskets",async(req)=>{const p=req.principal!;await db.query("update checkout_baskets set status='READY',claimed_by=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);const {rows}=await db.query(`
  select cb.id,cb.batch_id,cb.status,cb.retailer,cb.account_reference,cb.expires_at,cb.failure_code,cb.failure_message,
         a.recipient,a.city,a.postal_code,b.name batch_name,b.payment_route,
         count(po.id)::int item_count,coalesce(sum(po.amount_minor),0)::bigint amount_minor
  from checkout_baskets cb
  join order_batches b on b.id=cb.batch_id
  join addresses a on a.id=cb.address_id
  left join purchase_orders po on po.checkout_basket_id=cb.id
  where cb.tenant_id=$1
  group by cb.id,a.recipient,a.city,a.postal_code,b.name,b.payment_route
  order by cb.created_at desc limit 250
`,[p.tenantId]);return {baskets:rows};});

app.post("/api/bulk-queue/claim",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const {limit}=z.object({limit:z.number().int().min(1).max(25).default(10)}).parse(req.body??{});const client=await db.connect();try{await client.query("begin");await client.query("update checkout_baskets set status='READY',claimed_by=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);const picked=await client.query("select id from checkout_baskets where tenant_id=$1 and status='READY' order by created_at for update skip locked limit $2",[p.tenantId,limit]);const ids:string[]=[];for(const row of picked.rows){await client.query("update checkout_baskets set status='CLAIMED',claimed_by=$1,expires_at=now()+interval '20 minutes',updated_at=now() where id=$2",[p.id,row.id]);ids.push(row.id);}await client.query("commit");await audit(db,p.tenantId,p.id,"bulk_queue.claimed","checkout_basket",null,{count:ids.length});return {claimed:ids.length,ids};}catch(e){await client.query("rollback");throw e}finally{client.release()}});

app.get("/api/bulk-queue",async(req)=>{const p=req.principal!;await db.query("update checkout_baskets set status='READY',claimed_by=null,expires_at=null,updated_at=now() where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at<=now()",[p.tenantId]);const {rows}=await db.query(`
  select cb.id,cb.status,cb.retailer,cb.account_reference,cb.expires_at,cb.opened_at,cb.failure_code,cb.failure_message,
         a.recipient,a.city,a.postal_code,b.name batch_name,b.payment_route,
         count(po.id)::int item_count,coalesce(sum(po.amount_minor),0)::bigint amount_minor
  from checkout_baskets cb
  join order_batches b on b.id=cb.batch_id
  join addresses a on a.id=cb.address_id
  left join purchase_orders po on po.checkout_basket_id=cb.id
  where cb.tenant_id=$1 and cb.claimed_by=$2 and cb.status in ('CLAIMED','OPENED')
  group by cb.id,a.recipient,a.city,a.postal_code,b.name,b.payment_route
  order by cb.created_at
`,[p.tenantId,p.id]);return {baskets:rows};});

app.post("/api/bulk-queue/:id/open",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);const {rows}=await db.query(`
  update checkout_baskets cb set status='OPENED',opened_at=coalesce(opened_at,now()),expires_at=now()+interval '20 minutes',failure_code=null,failure_message=null,updated_at=now()
  from addresses a,order_batches b
  where cb.id=$1 and cb.tenant_id=$2 and cb.claimed_by=$3 and cb.status in ('CLAIMED','OPENED') and cb.expires_at>now()
    and a.id=cb.address_id and b.id=cb.batch_id
  returning cb.id,cb.retailer,cb.account_reference,a.recipient,a.line1,a.line2,a.city,a.state,a.postal_code,a.country,b.payment_route
`,[id,p.tenantId,p.id]);if(!rows[0])return reply.code(409).send({error:"basket_unavailable_or_expired"});const items=await db.query(`
  select po.id purchase_order_id,bi.product_url,bi.title,bi.requested_quantity,po.amount_minor
  from purchase_orders po join batch_items bi on bi.id=po.batch_item_id
  where po.checkout_basket_id=$1 and po.tenant_id=$2
  order by po.created_at
`,[id,p.tenantId]);const prepared=items.rows.map(item=>({...item,executionUrl:verifiedRetailerUrl(item.product_url)}));await audit(db,p.tenantId,p.id,"bulk_basket.execution_started","checkout_basket",id,{items:prepared.length});reply.header("cache-control","no-store");return {basketId:id,retailer:rows[0].retailer,accountReference:rows[0].account_reference,paymentRoute:rows[0].payment_route,address:{recipient:rows[0].recipient,line1:rows[0].line1,line2:rows[0].line2,city:rows[0].city,state:rows[0].state,postalCode:rows[0].postal_code,country:rows[0].country},items:prepared};});

app.post("/api/bulk-queue/:id/progress",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id),body=z.object({state:z.enum(["RUNNING","CHALLENGE","FAILED"]),code:z.string().max(80).optional(),message:z.string().max(500).optional()}).parse(req.body);const status=body.state==="RUNNING"?"OPENED":body.state==="CHALLENGE"?"REQUIRES_ACTION":"FAILED";const {rows}=await db.query("update checkout_baskets set status=$1,failure_code=$2,failure_message=$3,expires_at=case when $1='OPENED' then now()+interval '20 minutes' else expires_at end,updated_at=now() where id=$4 and tenant_id=$5 and claimed_by=$6 and status in ('CLAIMED','OPENED','REQUIRES_ACTION') returning id,status",[status,body.code??null,body.message??null,id,p.tenantId,p.id]);if(!rows[0])return reply.code(409).send({error:"basket_not_owned_by_worker"});await audit(db,p.tenantId,p.id,"bulk_basket.progress","checkout_basket",id,{state:body.state,code:body.code??null});return rows[0];});

app.post("/api/bulk-queue/:id/retry",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);if(!["OWNER","APPROVER","BUYER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const {rows}=await db.query("update checkout_baskets set status='READY',claimed_by=null,expires_at=null,opened_at=null,failure_code=null,failure_message=null,updated_at=now() where id=$1 and tenant_id=$2 and status in ('REQUIRES_ACTION','FAILED') returning id,status",[id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"basket_not_retryable"});await audit(db,p.tenantId,p.id,"bulk_basket.retry_requested","checkout_basket",id);return rows[0];});

app.post("/api/bulk-queue/:id/confirm",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id),body=z.object({retailerOrderId:z.string().min(3).max(80)}).parse(req.body),retailerOrderId=validateRetailerOrderId(body.retailerOrderId),client=await db.connect();try{await client.query("begin");const locked=await client.query("select batch_id from checkout_baskets where id=$1 and tenant_id=$2 and claimed_by=$3 and status in ('CLAIMED','OPENED','REQUIRES_ACTION') and (expires_at>now() or status='REQUIRES_ACTION') for update",[id,p.tenantId,p.id]);if(!locked.rows[0]){await client.query("rollback");return reply.code(409).send({error:"basket_unavailable_or_expired"})}await client.query("update purchase_orders set status='CONFIRMED',retailer_order_id=$1,failure_code=null,failure_message=null,updated_at=now() where checkout_basket_id=$2 and tenant_id=$3 and status in ('REQUIRES_ACTION','PLACED')",[retailerOrderId,id,p.tenantId]);await client.query("update checkout_baskets set status='CONFIRMED',retailer_order_id=$1,confirmed_at=now(),updated_at=now() where id=$2",[retailerOrderId,id]);await client.query("update order_batches b set status=case when not exists(select 1 from checkout_baskets x where x.batch_id=b.id and x.status<>'CONFIRMED') then 'COMPLETE' else 'PARTIAL' end,updated_at=now() where b.id=$1",[locked.rows[0].batch_id]);await client.query("commit");await audit(db,p.tenantId,p.id,"bulk_basket.confirmed","checkout_basket",id,{retailerOrderId});return {id,status:"CONFIRMED",retailerOrderId};}catch(e){await client.query("rollback");throw e}finally{client.release()}});

app.post("/api/bulk-queue/:id/release",async(req,reply)=>{const p=req.principal!,id=z.string().uuid().parse((req.params as any).id);const {rowCount}=await db.query("update checkout_baskets set status='READY',claimed_by=null,expires_at=null,opened_at=null,updated_at=now() where id=$1 and tenant_id=$2 and claimed_by=$3 and status in ('CLAIMED','OPENED')",[id,p.tenantId,p.id]);if(!rowCount)return reply.code(404).send({error:"basket_not_found"});await audit(db,p.tenantId,p.id,"bulk_basket.released","checkout_basket",id);return {ok:true}});

app.get("/api/reports/orders.csv",async(req,reply)=>{const p=req.principal!;const {rows}=await db.query(`select po.id,po.status,po.retailer,po.retailer_order_id,po.amount_minor,po.failure_code,po.failure_message,a.recipient,a.city,a.postal_code,po.updated_at from purchase_orders po join batch_items bi on bi.id=po.batch_item_id left join addresses a on a.id=bi.address_id where po.tenant_id=$1 order by po.created_at`,[p.tenantId]);const csvCell=(v:unknown)=>`"${String(v??"").replaceAll('"','""')}"`;const columns=["id","status","retailer","retailer_order_id","amount_minor","failure_code","failure_message","recipient","city","postal_code","updated_at"];const csv=[columns.join(","),...rows.map(r=>columns.map(k=>csvCell(r[k])).join(","))].join("\n");reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",'attachment; filename="ordergrid-orders.csv"');return csv;});

app.post("/api/batches",async(req,reply)=>{const p=req.principal!;const input=z.object({name:z.string().min(3).max(120),paymentRoute:z.enum(["Corporate virtual card","Cash on Delivery"]).default("Corporate virtual card"),items:z.array(z.object({productUrl:z.string().url(),quantity:z.number().int().positive().max(10000),addressId:z.string().uuid().optional(),estimatedUnitPriceMinor:z.number().int().positive().optional()})).min(1).max(5000)}).parse(req.body); const c=await db.connect();try{await c.query("begin");const fullyEstimated=input.items.every(i=>i.estimatedUnitPriceMinor);if(!fullyEstimated&&!jobs)return reply.code(422).send({error:"estimated_price_required"});const total=input.items.reduce((sum,i)=>sum+(i.estimatedUnitPriceMinor??0)*i.quantity,0);const b=await c.query("insert into order_batches(tenant_id,name,created_by,status,estimated_total_minor,payment_route) values($1,$2,$3,$4,$5,$6) returning id,status",[p.tenantId,input.name,fullyEstimated?"AWAITING_APPROVAL":"DRAFT",total,input.paymentRoute]);for(const item of input.items){const retailer=retailerForProductUrl(item.productUrl).id;await c.query("insert into batch_items(batch_id,product_url,retailer,requested_quantity,address_id,unit_price_minor,pricing_status,pricing_checked_at) values($1,$2,$3,$4,$5,$6,$7,$8)",[b.rows[0].id,item.productUrl,retailer,item.quantity,item.addressId??null,item.estimatedUnitPriceMinor??null,item.estimatedUnitPriceMinor?"ESTIMATED":"PENDING",item.estimatedUnitPriceMinor?new Date():null]);}await c.query("commit");await audit(db,p.tenantId,p.id,"batch.created","order_batch",b.rows[0].id,{items:input.items.length,total});if(!fullyEstimated&&jobs)await jobs.queue.add("price-batch",{batchId:b.rows[0].id,tenantId:p.tenantId},{jobId:`price:${b.rows[0].id}`,attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:1000});return reply.code(201).send(b.rows[0]);}catch(e){await c.query("rollback");throw e}finally{c.release()}});
app.post("/api/batches/:id/approve",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const id=z.string().uuid().parse((req.params as any).id);const {rows}=await db.query("update order_batches set status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now() where id=$2 and tenant_id=$3 and status='AWAITING_APPROVAL' returning id",[p.id,id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"batch_not_approvable"});await audit(db,p.tenantId,p.id,"batch.approved","order_batch",id);if(jobs){await jobs.queue.add("place-batch",{batchId:id,tenantId:p.tenantId},{jobId:`place:${id}`,attempts:3,backoff:{type:"exponential",delay:5000}});}else{await db.query(`insert into purchase_orders(tenant_id,batch_item_id,status,retailer,amount_minor,idempotency_key,failure_code,failure_message) select $1,i.id,\'REQUIRES_ACTION\',i.retailer,i.unit_price_minor*i.requested_quantity,$2||i.id,\'BASKET_CHECKOUT_REQUIRED\',\'Grouped checkout basket is ready for execution\' from batch_items i where i.batch_id=$3 on conflict(idempotency_key) do nothing`,[p.tenantId,`basket:${id}:`,id]);await syncCheckoutBaskets(db,p.tenantId,id);}return {ok:true};});
app.get("/*",(_,reply)=>reply.sendFile("index.html"));
app.setErrorHandler((error,req,reply)=>{req.log.error(error);if(error instanceof z.ZodError)return reply.code(400).send({error:"invalid_request",issues:error.issues});return reply.code(500).send({error:"internal_error",requestId:req.id});});

async function bootstrap(){const {rows}=await db.query("select count(*)::int count from users");if(rows[0].count)return;const c=await db.connect();try{await c.query("begin");const t=await c.query("insert into tenants(name) values('OrderGrid') returning id");await c.query("insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,'OWNER')",[t.rows[0].id,config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD)]);await c.query("commit");}catch(e){await c.query("rollback");throw e}finally{c.release()}}
await bootstrap(); await app.listen({port:config.PORT,host:"0.0.0.0"});
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{await app.close();if(jobs){await jobs.queue.close();jobs.connection.disconnect();}await db.end();process.exit(0)});
