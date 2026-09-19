import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { audit, createDb } from "./db.js";
import { hashPassword, tokenHash, verifyPassword } from "./security.js";
import { createOrderQueue } from "./queue.js";

const config=loadConfig(), db=createDb(config), jobs=createOrderQueue(config.REDIS_URL);
const app=Fastify({logger:{redact:["req.headers.authorization","req.headers.cookie","password"]},trustProxy:true,requestIdHeader:"x-request-id",genReqId:()=>randomUUID()});
await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}});
await app.register(rateLimit,{max:120,timeWindow:"1 minute"}); await app.register(cookie,{secret:config.SESSION_SECRET});
await app.register(staticPlugin,{root:join(dirname(fileURLToPath(import.meta.url)),"../public"),prefix:"/"});

declare module "fastify" { interface FastifyRequest { principal?:{id:string;tenantId:string;role:string} } }
app.addHook("preHandler",async(req,reply)=>{ if(!req.url.startsWith("/api/")||req.url==="/api/health"||req.url==="/api/login")return; const raw=req.cookies.session; if(!raw)return reply.code(401).send({error:"unauthorized"}); const {rows}=await db.query(`select u.id,u.tenant_id,u.role from sessions s join users u on u.id=s.user_id where s.id_hash=$1 and s.expires_at>now() and u.active`,[tokenHash(raw)]); if(!rows[0])return reply.code(401).send({error:"unauthorized"}); req.principal={id:rows[0].id,tenantId:rows[0].tenant_id,role:rows[0].role}; });

app.get("/api/health",async()=>{await db.query("select 1");return {status:"ok"}});
app.post("/api/login",{config:{rateLimit:{max:8,timeWindow:"15 minutes"}}},async(req,reply)=>{const input=z.object({email:z.string().email(),password:z.string().min(1)}).parse(req.body); const {rows}=await db.query("select id,tenant_id,role,password_hash from users where email=$1 and active",[input.email.toLowerCase()]); const u=rows[0]; if(!u||!await verifyPassword(input.password,u.password_hash))return reply.code(401).send({error:"invalid_credentials"}); const token=randomBytes(32).toString("base64url"); await db.query("insert into sessions(id_hash,user_id,expires_at) values($1,$2,now()+interval '12 hours')",[tokenHash(token),u.id]); reply.setCookie("session",token,{httpOnly:true,secure:config.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:43200}); return {user:{id:u.id,role:u.role}};});
app.post("/api/logout",async(req,reply)=>{const raw=req.cookies.session;if(raw)await db.query("delete from sessions where id_hash=$1",[tokenHash(raw)]);reply.clearCookie("session",{path:"/"});return {ok:true}});
app.get("/api/dashboard",async(req)=>{const p=req.principal!;const [b,o]=await Promise.all([db.query("select status,count(*)::int count,coalesce(sum(estimated_total_minor),0)::bigint total from order_batches where tenant_id=$1 group by status",[p.tenantId]),db.query("select status,count(*)::int count from purchase_orders where tenant_id=$1 group by status",[p.tenantId])]);return {batches:b.rows,orders:o.rows};});
app.post("/api/batches",async(req,reply)=>{const p=req.principal!;const input=z.object({name:z.string().min(3).max(120),items:z.array(z.object({productUrl:z.string().url(),quantity:z.number().int().positive().max(10000),addressId:z.string().uuid().optional()})).min(1).max(5000)}).parse(req.body); const c=await db.connect();try{await c.query("begin");const b=await c.query("insert into order_batches(tenant_id,name,created_by) values($1,$2,$3) returning id,status",[p.tenantId,input.name,p.id]);for(const item of input.items){const host=new URL(item.productUrl).hostname;const retailer=host.includes("amazon.")?"amazon-in":host.includes("flipkart.")?"flipkart":host;await c.query("insert into batch_items(batch_id,product_url,retailer,requested_quantity,address_id) values($1,$2,$3,$4,$5)",[b.rows[0].id,item.productUrl,retailer,item.quantity,item.addressId??null]);}await c.query("commit");await audit(db,p.tenantId,p.id,"batch.created","order_batch",b.rows[0].id,{items:input.items.length});await jobs.queue.add("price-batch",{batchId:b.rows[0].id,tenantId:p.tenantId},{jobId:`price:${b.rows[0].id}`,attempts:5,backoff:{type:"exponential",delay:2000},removeOnComplete:1000});return reply.code(201).send(b.rows[0]);}catch(e){await c.query("rollback");throw e}finally{c.release()}});
app.post("/api/batches/:id/approve",async(req,reply)=>{const p=req.principal!;if(!["OWNER","APPROVER"].includes(p.role))return reply.code(403).send({error:"forbidden"});const id=z.string().uuid().parse((req.params as any).id);const {rows}=await db.query("update order_batches set status='APPROVED',approved_by=$1,approved_at=now(),updated_at=now() where id=$2 and tenant_id=$3 and status='AWAITING_APPROVAL' returning id",[p.id,id,p.tenantId]);if(!rows[0])return reply.code(409).send({error:"batch_not_approvable"});await audit(db,p.tenantId,p.id,"batch.approved","order_batch",id);await jobs.queue.add("place-batch",{batchId:id,tenantId:p.tenantId},{jobId:`place:${id}`,attempts:3,backoff:{type:"exponential",delay:5000}});return {ok:true};});
app.get("/*",(_,reply)=>reply.sendFile("index.html"));
app.setErrorHandler((error,req,reply)=>{req.log.error(error);if(error instanceof z.ZodError)return reply.code(400).send({error:"invalid_request",issues:error.issues});return reply.code(500).send({error:"internal_error",requestId:req.id});});

async function bootstrap(){const {rows}=await db.query("select count(*)::int count from users");if(rows[0].count)return;const c=await db.connect();try{await c.query("begin");const t=await c.query("insert into tenants(name) values('OrderGrid') returning id");await c.query("insert into users(tenant_id,email,password_hash,role) values($1,$2,$3,'OWNER')",[t.rows[0].id,config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD)]);await c.query("commit");}catch(e){await c.query("rollback");throw e}finally{c.release()}}
await bootstrap(); await app.listen({port:config.PORT,host:"0.0.0.0"});
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{await app.close();await jobs.queue.close();jobs.connection.disconnect();await db.end();process.exit(0)});
