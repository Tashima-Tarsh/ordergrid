import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadConfig } from "./config.js";
import { createDb, audit } from "./db.js";
import { ShopifyProvider, ControlledRetailerProvider } from "./providers.js";
import { syncCheckoutBaskets } from "./baskets.js";
import { assignAvailableVirtualCard, assignFundingRoute } from "./funding-router.js";
import { ensureBasketVirtualCard } from "./card-provisioning.js";

const config=loadConfig();
if(!config.REDIS_URL)throw new Error("REDIS_URL is required to run the background worker");
const db=createDb(config),connection=new Redis(config.REDIS_URL,{maxRetriesPerRequest:null});
const providers=[new ControlledRetailerProvider(/(^|\.)amazon\.in$/),new ControlledRetailerProvider(/(^|\.)flipkart\.com$/),new ShopifyProvider()];
let stopping=false;

async function triggerContinuousAutopilot(tenantId:string){
  const policyResult=await db.query(
    `select automation_enabled,auto_assign_virtual_card,auto_continue_checkout,max_active_orders,max_price_increase_percent,max_order_value_minor,run_mode
     from automation_policies where tenant_id=$1 limit 1`,
    [tenantId]
  );
  const policy=policyResult.rows[0];
  if(!policy||!policy.automation_enabled||policy.run_mode!=="CONTINUOUS")return {claimed:0};

  const activeResult=await db.query(
    "select count(*)::int active from checkout_baskets where tenant_id=$1 and status in ('CLAIMED','OPENED') and expires_at>now()",
    [tenantId]
  );
  const slots=Math.max(0,Number(policy.max_active_orders||8)-Number(activeResult.rows[0]?.active||0));
  if(slots<1)return {claimed:0};

  const client=await db.connect();
  const claimed:{id:string;userId:string}[]=[];
  try{
    await client.query("begin");
    const picked=await client.query(
      `select cb.id,b.created_by
       from checkout_baskets cb
       join order_batches b on b.id=cb.batch_id
       where cb.tenant_id=$1 and cb.status='READY'
       order by cb.created_at
       for update of cb skip locked
       limit $2`,
      [tenantId,slots]
    );
    for(const row of picked.rows){
      if(!row.created_by)continue;
      await client.query(
        "update checkout_baskets set status='CLAIMED',claimed_by=$1,execution_worker_id=null,expires_at=now()+interval '20 minutes',updated_at=now() where id=$2",
        [row.created_by,row.id]
      );
      claimed.push({id:String(row.id),userId:String(row.created_by)});
    }
    await client.query("commit");
  }catch(error){
    await client.query("rollback");
    throw error;
  }finally{client.release()}

  for(const basket of claimed){
    const commercial=await db.query(
      `select b.payment_route,coalesce(sum(po.amount_minor),0)::bigint expected_minor
       from checkout_baskets cb
       join order_batches b on b.id=cb.batch_id
       left join purchase_orders po on po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id
       where cb.id=$1 and cb.tenant_id=$2
       group by b.payment_route`,
      [basket.id,tenantId]
    );
    const expectedMinor=Number(commercial.rows[0]?.expected_minor||0);
    const paymentRoute=String(commercial.rows[0]?.payment_route||"");

    if(Number(policy.max_order_value_minor)>0&&expectedMinor>Number(policy.max_order_value_minor)){
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',commercial_status='REVIEW_REQUIRED',failure_code='ORDER_VALUE_POLICY_REQUIRED',failure_message='Expected order value exceeds the Autopilot order-value policy',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
        [basket.id,tenantId]
      );
      continue;
    }

    await assignFundingRoute(db,tenantId,basket.id);
    if(policy.auto_assign_virtual_card){
      let cardId=await assignAvailableVirtualCard(db,tenantId,basket.id);
      if(!cardId){
        let fundingCeiling=Math.ceil(expectedMinor*(1+Number(policy.max_price_increase_percent||0)/100));
        if(Number(policy.max_order_value_minor)>0)fundingCeiling=Math.min(fundingCeiling,Number(policy.max_order_value_minor));
        const card=await ensureBasketVirtualCard(db,config,tenantId,basket.id,basket.userId,fundingCeiling);
        cardId=card.cardId;
        if(card.status==="PROGRAMME_REQUIRED"||card.status==="CARDHOLDER_PROFILE_REQUIRED"){
          await db.query(
            "update checkout_baskets set status='REQUIRES_ACTION',failure_code='PAYMENT_SETUP_REQUIRED',failure_message='Payment setup required before checkout can continue',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
            [basket.id,tenantId]
          );
        }
      }
    }else if(paymentRoute==="Corporate virtual card"){
      const assigned=await db.query("select virtual_card_id from checkout_baskets where id=$1 and tenant_id=$2",[basket.id,tenantId]);
      if(!assigned.rows[0]?.virtual_card_id){
        await db.query(
          "update checkout_baskets set status='REQUIRES_ACTION',failure_code='CARD_ASSIGNMENT_REQUIRED',failure_message='Order is waiting for manual virtual-card assignment',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
          [basket.id,tenantId]
        );
      }
    }
  }

  if(claimed.length)await audit(db,tenantId,null,"automation.continuous_triggered","automation_policy",tenantId,{claimed:claimed.length});
  return {claimed:claimed.length};
}

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
  const automation=await triggerContinuousAutopilot(job.data.tenantId);
  await db.query("update order_batches set status='PARTIAL',updated_at=now() where id=$1",[job.data.batchId]);
  await audit(db,job.data.tenantId,null,"batch.execution_ready","order_batch",job.data.batchId,{items:rows.length,autopilotClaimed:automation.claimed});
 }
},{connection,concurrency:8,lockDuration:120000});

worker.on("failed",(job,error)=>console.error("job failed",job?.id,error));
for(const sig of ["SIGTERM","SIGINT"] as const)process.on(sig,async()=>{if(stopping)return;stopping=true;await worker.close();connection.disconnect();await db.end();process.exit(0)});
