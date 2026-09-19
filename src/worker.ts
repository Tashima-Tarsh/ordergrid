import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createDb, audit } from "./db.js";
import { ShopifyProvider, ControlledRetailerProvider, DisabledIssuer } from "./providers.js";

const config=loadConfig(),db=createDb(config),connection=new Redis(config.REDIS_URL,{maxRetriesPerRequest:null});
const providers=[new ControlledRetailerProvider(/(^|\.)amazon\.in$/),new ControlledRetailerProvider(/(^|\.)flipkart\.com$/),new ShopifyProvider()];
const issuer=new DisabledIssuer(); let stopping=false;
const worker=new Worker("orders",async job=>{
 if(job.name==="price-batch"){
  const {rows}=await db.query("select * from batch_items where batch_id=$1",[job.data.batchId]); await db.query("update order_batches set status='PRICING',updated_at=now() where id=$1",[job.data.batchId]); let total=0;
  for(const item of rows){const provider=providers.find(p=>p.supports(item.product_url));try{if(!provider)throw new Error("Unsupported retailer");const q=await provider.quote(item.product_url);total+=q.unitPriceMinor*item.requested_quantity;await db.query("update batch_items set title=$1,sku=$2,unit_price_minor=$3,available_quantity=$4,pricing_status='PRICED',pricing_checked_at=now() where id=$5",[q.title,q.sku??null,q.unitPriceMinor,q.availableQuantity??null,item.id]);}catch(e){await db.query("update batch_items set pricing_status='REQUIRES_CONNECTION',pricing_checked_at=now() where id=$1",[item.id]);}}
  await db.query("update order_batches set status='AWAITING_APPROVAL',estimated_total_minor=$1,updated_at=now() where id=$2",[total,job.data.batchId]);await audit(db,job.data.tenantId,null,"batch.priced","order_batch",job.data.batchId,{total});
 }
 if(job.name==="place-batch"){
  const {rows}=await db.query("select bi.*,a.* from batch_items bi left join addresses a on a.id=bi.address_id where bi.batch_id=$1",[job.data.batchId]); await db.query("update order_batches set status='ORDERING',updated_at=now() where id=$1",[job.data.batchId]);
  for(const item of rows){const key=`${job.data.batchId}:${item.id}`;try{const card=await issuer.issue({amountMinor:Number(item.unit_price_minor)*item.requested_quantity,currency:"INR",merchant:item.retailer,idempotencyKey:key});const provider=providers.find(p=>p.supports(item.product_url));if(!provider)throw new Error("Unsupported retailer");const result=await provider.checkout({url:item.product_url,quantity:item.requested_quantity,address:item,paymentToken:card.paymentToken,idempotencyKey:key});await db.query("insert into purchase_orders(tenant_id,batch_item_id,status,retailer,retailer_order_id,amount_minor,virtual_card_reference,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(idempotency_key) do nothing",[job.data.tenantId,item.id,result.status,item.retailer,result.retailerOrderId??null,Number(item.unit_price_minor)*item.requested_quantity,card.reference,key]);}catch(e:any){await db.query("insert into purchase_orders(tenant_id,batch_item_id,status,retailer,idempotency_key,failure_code,failure_message) values($1,$2,'REQUIRES_ACTION',$3,$4,'PROVIDER_ACTION_REQUIRED',$5) on conflict(idempotency_key) do update set failure_message=excluded.failure_message",[job.data.tenantId,item.id,item.retailer,key,String(e.message).slice(0,500)]);}}
  await db.query("update order_batches set status='PARTIAL',updated_at=now() where id=$1",[job.data.batchId]);
 }
},{connection,concurrency:8,lockDuration:120000});
worker.on("failed",(job,error)=>console.error("job failed",job?.id,error));
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{if(stopping)return;stopping=true;await worker.close();connection.disconnect();await db.end();process.exit(0)});
