import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import multipart from "@fastify/multipart";
import ExcelJS from "exceljs";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const port=Number(process.env.PORT??3000);
const email=(process.env.DEMO_EMAIL??"demo@ordergrid.in").toLowerCase();
const password=process.env.DEMO_PASSWORD??"OrderGridDemo2026!";
const secret=process.env.SESSION_SECRET??randomBytes(32).toString("hex");
const session=randomBytes(32).toString("base64url");
type Address={id:string;recipient:string;phone:string;line1:string;line2?:string;city:string;state:string;postal_code:string;country:string;reference?:string;amazon_account?:string;flipkart_account?:string};
type Batch={id:string;name:string;status:string;currency:string;estimated_total_minor:number;created_at:string;item_count:number;recipient_count:number;payment_route:string};
type Item={id:string;batchId:string;product_url:string;retailer:string;requested_quantity:number;addressId:string;unit_price_minor:number};
type Task={id:string;batch_id:string;address_id:string;status:string;amount_minor:number;failure_message:string;failure_code?:string;product_url:string;title:string;requested_quantity:number;recipient:string;city:string;postal_code:string;retailer:string;account_reference:string;retailer_order_id?:string};
type Basket={id:string;batch_id:string;status:string;retailer:string;account_reference:string;customer_reference:string;recipient:string;city:string;postal_code:string;payment_route:string;batch_name:string;item_count:number;amount_minor:number;auth_status:string;failure_code?:string;failure_message?:string};
const addresses=new Map<string,Address>(),items:Item[]=[],batches:Batch[]=[],tasks:Task[]=[],baskets:Basket[]=[];
const addressesByReference=(reference:string)=>[...addresses.values()].find(a=>(a.reference||a.id)===reference);
const app=Fastify({logger:true,trustProxy:true});
await app.register(helmet,{contentSecurityPolicy:{directives:{defaultSrc:["'self'"],styleSrc:["'self'","'unsafe-inline'"],scriptSrc:["'self'"],imgSrc:["'self'","data:"]}}});
await app.register(rateLimit,{max:120,timeWindow:"1 minute"});
await app.register(cookie,{secret});
await app.register(multipart,{limits:{fileSize:5_000_000,files:1}});
await app.register(staticPlugin,{root:join(dirname(fileURLToPath(import.meta.url)),"../public"),prefix:"/"});
const same=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
app.addHook("preHandler",async(req,reply)=>{if(!req.url.startsWith("/api/")||req.url==="/api/health"||req.url==="/api/login")return;if(req.cookies.demo_session!==session)return reply.code(401).send({error:"unauthorized"});});
app.get("/api/health",async()=>({status:"ok",mode:"showroom"}));
app.post("/api/login",{config:{rateLimit:{max:8,timeWindow:"15 minutes"}}},async(req,reply)=>{const body=z.object({email:z.string().email(),password:z.string()}).parse(req.body);if(!same(body.email.toLowerCase(),email)||!same(body.password,password))return reply.code(401).send({error:"invalid_credentials"});reply.setCookie("demo_session",session,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",path:"/",maxAge:43200});return {user:{role:"OWNER"}};});
app.post("/api/logout",async(_,reply)=>{reply.clearCookie("demo_session",{path:"/"});return {ok:true}});
app.get("/api/dashboard",async()=>{const batchGroups=new Map<string,Batch[]>(),taskGroups=new Map<string,Task[]>();for(const b of batches)batchGroups.set(b.status,[...(batchGroups.get(b.status)??[]),b]);for(const t of tasks)taskGroups.set(t.status,[...(taskGroups.get(t.status)??[]),t]);return {batches:[...batchGroups].map(([status,list])=>({status,count:list.length,total:list.reduce((n,b)=>n+b.estimated_total_minor,0)})),orders:[...taskGroups].map(([status,list])=>({status,count:list.length}))};});
app.get("/api/batches",async()=>({batches}));
app.get("/api/checkout-tasks",async()=>({tasks}));
app.get("/api/cards/provider",async()=>({provider:"disabled",configured:false,source:"showroom"}));
app.get("/api/cards",async()=>({cards:[],provider:"disabled",configured:false,source:"showroom"}));
app.post("/api/cards/provider/connect",async(_,reply)=>reply.code(409).send({error:"showroom_preview_only",message:"Issuer connection is available on the production OrderGrid API."}));
app.delete("/api/cards/provider",async(_,reply)=>reply.code(409).send({error:"showroom_preview_only"}));
app.get("/api/runtime",async()=>({api:"OrderGrid API",mode:"showroom",checkoutEngine:{id:"ordergrid-checkout-engine",status:"ONLINE",capacity:8,sessionModel:"isolated-retailer-profiles"},database:"in-memory-showroom"}));
app.get("/api/execution-workers",async()=>({workers:[{id:"ordergrid-checkout-engine",hostname:"OrderGrid Cloud Checkout Engine",mode:"BULK",last_seen:new Date().toISOString(),capacity:8,kind:"SHOWROOM"}]}));
app.get("/api/recipients",async()=>({recipients:[...addresses.values()].map(a=>({id:a.id,customer_reference:a.reference||a.id,recipient:a.recipient,phone:a.phone,city:a.city,state:a.state,postal_code:a.postal_code,retailer_accounts:{amazon:a.amazon_account||null,flipkart:a.flipkart_account||null}}))}));
app.get("/api/bulk-baskets",async()=>({baskets}));
app.post("/api/bulk-queue/claim",async(req)=>{const body=z.object({limit:z.number().int().min(1).max(25).default(10)}).parse(req.body??{});let claimed=0;for(const basket of baskets.filter(b=>b.status==="READY").slice(0,body.limit)){basket.status="OPENED";basket.auth_status="SESSION READY";basket.failure_code=undefined;basket.failure_message="Checkout engine accepted this basket. Retailer-controlled authentication/payment challenges remain protected.";for(const task of tasks.filter(t=>t.batch_id===basket.batch_id&&t.address_id===addressesByReference(basket.customer_reference)?.id&&t.retailer===basket.retailer))task.status="PLACED";claimed++;}return {claimed,engine:"ordergrid-checkout-engine"};});
app.post("/api/bulk-queue/:id/retry",async(req,reply)=>{const id=String((req.params as any).id),basket=baskets.find(b=>b.id===id);if(!basket)return reply.code(404).send({error:"basket_not_found"});basket.status="READY";basket.auth_status="READY";basket.failure_code=undefined;basket.failure_message=undefined;return {id,status:basket.status};});

app.post("/api/address-books/import",async(req,reply)=>{const file=await req.file();if(!file)return reply.code(400).send({error:"file_required"});const buffer=await file.toBuffer();let rows:string[][]=[];if(file.filename.toLowerCase().endsWith(".xlsx")){const book=new ExcelJS.Workbook();await book.xlsx.load(buffer as any);const sheet=book.worksheets[0];if(!sheet)return reply.code(400).send({error:"empty_workbook"});sheet.eachRow(r=>rows.push((r.values as any[]).slice(1).map(v=>String(v??"").trim())));}else rows=buffer.toString("utf8").replace(/^\uFEFF/,"").split(/\r?\n/).filter(Boolean).map(line=>line.split(",").map(v=>v.trim().replace(/^"|"$/g,"")));
  if(rows.length<2)return reply.code(400).send({error:"no_address_rows"});const headers=rows[0]!.map(h=>h.toLowerCase().replace(/[ _-]+/g,"_"));for(const h of ["recipient","phone","line1","city","state","postal_code"])if(!headers.includes(h))return reply.code(400).send({error:"missing_column",column:h});const val=(row:string[],name:string)=>row[headers.indexOf(name)]??"";const ids:string[]=[];for(const row of rows.slice(1)){if(!row.some(Boolean))continue;const id=randomUUID();addresses.set(id,{id,recipient:val(row,"recipient"),phone:val(row,"phone"),line1:val(row,"line1"),line2:val(row,"line2"),city:val(row,"city"),state:val(row,"state"),postal_code:val(row,"postal_code"),country:val(row,"country")||"IN",reference:val(row,"reference")||"CUST-"+String(addresses.size+1).padStart(3,"0"),amazon_account:val(row,"amazon_account"),flipkart_account:val(row,"flipkart_account")});ids.push(id);}return reply.code(201).send({addressBook:{id:randomUUID(),name:file.filename},addressIds:ids,count:ids.length});});
app.post("/api/batches",async(req,reply)=>{const input=z.object({name:z.string().min(3),paymentRoute:z.string().default("Corporate virtual card"),items:z.array(z.object({productUrl:z.string().url(),quantity:z.number().int().positive(),addressId:z.string().uuid(),estimatedUnitPriceMinor:z.number().int().positive()})).min(1)}).parse(req.body);const id=randomUUID(),created_at=new Date().toISOString(),total=input.items.reduce((n,i)=>n+i.quantity*i.estimatedUnitPriceMinor,0),recipient_count=new Set(input.items.map(i=>i.addressId)).size;const batch={id,name:input.name,status:"AWAITING_APPROVAL",currency:"INR",estimated_total_minor:total,created_at,item_count:input.items.length,recipient_count,payment_route:input.paymentRoute};batches.unshift(batch);for(const i of input.items){const host=new URL(i.productUrl).hostname;items.push({id:randomUUID(),batchId:id,product_url:i.productUrl,retailer:host.includes("amazon.")?"amazon-in":host.includes("flipkart.")?"flipkart":host,requested_quantity:i.quantity,addressId:i.addressId,unit_price_minor:i.estimatedUnitPriceMinor});}return reply.code(201).send({id,status:batch.status});});
app.post("/api/batches/:id/approve",async(req,reply)=>{
  const id=z.string().uuid().parse((req.params as any).id),batch=batches.find(b=>b.id===id);
  if(!batch||batch.status!=="AWAITING_APPROVAL")return reply.code(409).send({error:"batch_not_approvable"});
  batch.status="APPROVED";
  const basketGroups=new Map<string,{address:Address;retailer:string;account:string;tasks:Task[]}>();
  for(const item of items.filter(i=>i.batchId===id)){
    const a=addresses.get(item.addressId)!;
    const account=item.retailer==="amazon-in"?(a.amazon_account||a.reference||a.id):item.retailer==="flipkart"?(a.flipkart_account||a.reference||a.id):(a.reference||a.id);
    const task:Task={id:randomUUID(),batch_id:id,address_id:a.id,status:"REQUIRES_ACTION",amount_minor:item.unit_price_minor*item.requested_quantity,failure_message:"Ready for OrderGrid Checkout Engine",product_url:item.product_url,title:new URL(item.product_url).hostname+" product",requested_quantity:item.requested_quantity,recipient:a.recipient,city:a.city,postal_code:a.postal_code,retailer:item.retailer,account_reference:account};
    tasks.unshift(task);
    const key=a.id+":"+item.retailer,group=basketGroups.get(key)||{address:a,retailer:item.retailer,account,tasks:[]};
    group.tasks.push(task);basketGroups.set(key,group);
  }
  for(const group of basketGroups.values()){
    baskets.unshift({id:randomUUID(),batch_id:id,status:"READY",retailer:group.retailer,account_reference:group.account,customer_reference:group.address.reference||group.address.id,recipient:group.address.recipient,city:group.address.city,postal_code:group.address.postal_code,payment_route:batch.payment_route,batch_name:batch.name,item_count:group.tasks.length,amount_minor:group.tasks.reduce((n,t)=>n+t.amount_minor,0),auth_status:"READY"});
  }
  return {ok:true,baskets:basketGroups.size};
});
app.get("/api/reports/orders.csv",async(_,reply)=>{const csv=["customer_reference,recipient,retailer,account_reference,status,amount_minor",...baskets.map(b=>[b.customer_reference,b.recipient,b.retailer,b.account_reference,b.status,b.amount_minor].map(v=>`"${String(v).replaceAll('"','""')}"`).join(","))].join("\n");reply.header("content-type","text/csv; charset=utf-8").header("content-disposition",'attachment; filename="ordergrid-orders.csv"');return csv;});
app.setErrorHandler((error,req,reply)=>{req.log.error(error);if(error instanceof z.ZodError)return reply.code(400).send({error:"invalid_request",issues:error.issues});return reply.code(500).send({error:"internal_error"});});
await app.listen({port,host:"0.0.0.0"});
