import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createDb, audit } from "./db.js";
import { ShopifyProvider, ControlledRetailerProvider } from "./providers.js";
import { syncCheckoutBaskets } from "./baskets.js";

const config=loadConfig();
if(!config.REDIS_URL)throw new Error("REDIS_URL is required to run the background worker");
const db=createDb(config),connection=new Redis(config.REDIS_URL,{maxRetriesPerRequest:null});
const providers=[new ControlledRetailerProvider(/(^|\.)amazon\.in$/),new ControlledRetailerProvider(/(^|\.)flipkart\.com$/),new ShopifyProvider()];
let stopping=false;

const worker=new Worker("orders",async job=>{
 if(job.name==="price-batch"){
  const {rows}=await db.query("select * from batch_items where batch_id=$1",[job.data.batchId]);
  await db.query("update order_batches set status='PRICING',updated_at=now() where id=$1",[job.data.batchId]);
  let total=0;
  for(const item of rows){
    const provider=providers.find(p=>p.supports(item.product_url));
    try{
      if(!provider)throw new Error("Unsupported retailer");
      const q=await provider.quote(item.product_url);
      total+=q.unitPriceMinor*item.requested_quantity;
      await db.query("update batch_items set title=$1,sku=$2,unit_price_minor=$3,available_quantity=$4,pricing_status='PRICED',pricing_checked_at=now() where id=$5",[q.title,q.sku??null,q.unitPriceMinor,q.availableQuantity??null,item.id]);
    }catch{
      await db.query("update batch_items set pricing_status='REQUIRES_CONNECTION',pricing_checked_at=now() where id=$1",[item.id]);
    }
  }
  await db.query("update order_batches set status='AWAITING_APPROVAL',estimated_total_minor=$1,updated_at=now() where id=$2",[total,job.data.batchId]);
  await audit(db,job.data.tenantId,null,"batch.priced","order_batch",job.data.batchId,{total});
 }
 if(job.name==="place-batch"){
  const {rows}=await db.query("select id batch_item_id,retailer,requested_quantity,unit_price_minor from batch_items where batch_id=$1",[job.data.batchId]);
  await db.query("update order_batches set status='ORDERING',updated_at=now() where id=$1",[job.data.batchId]);
  for(const item of rows){
    const key=`${job.data.batchId}:${item.batch_item_id}`,amountMinor=Number(item.unit_price_minor)*item.requested_quantity;
    await db.query("insert into purchase_orders(tenant_id,batch_item_id,status,retailer,amount_minor,idempotency_key) values($1,$2,'REQUIRES_ACTION',$3,$4,$5) on conflict(idempotency_key) do update set amount_minor=excluded.amount_minor,failure_code=null,failure_message=null,updated_at=now()",[job.data.tenantId,item.batch_item_id,item.retailer,amountMinor,key]);
  }
  await syncCheckoutBaskets(db,job.data.tenantId,job.data.batchId);
  await db.query("update order_batches set status='PARTIAL',updated_at=now() where id=$1",[job.data.batchId]);
  await audit(db,job.data.tenantId,null,"batch.execution_ready","order_batch",job.data.batchId,{items:rows.length});
 }
},{connection,concurrency:8,lockDuration:120000});

worker.on("failed",(job,error)=>console.error("job failed",job?.id,error));
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{if(stopping)return;stopping=true;await worker.close();connection.disconnect();await db.end();process.exit(0)});
