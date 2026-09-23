import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { CardholderInput } from "./card-issuer.js";
import { loadTenantIssuer } from "./issuer-connections.js";

function configuredCardholder(config:Config):CardholderInput|null{
  if(
    !config.CARDHOLDER_EMAIL||
    !config.CARDHOLDER_MOBILE||
    !config.CARDHOLDER_FIRST_NAME||
    !config.CARDHOLDER_LAST_NAME||
    !config.CARDHOLDER_GENDER||
    !config.CARDHOLDER_PAN||
    !config.CARDHOLDER_SPECIAL_DATE
  )return null;
  return {
    email:config.CARDHOLDER_EMAIL,
    mobile:config.CARDHOLDER_MOBILE,
    firstName:config.CARDHOLDER_FIRST_NAME,
    lastName:config.CARDHOLDER_LAST_NAME,
    gender:config.CARDHOLDER_GENDER,
    pan:config.CARDHOLDER_PAN,
    specialDate:config.CARDHOLDER_SPECIAL_DATE
  };
}

export async function ensureBasketVirtualCard(db:Db,config:Config,tenantId:string,basketId:string,userId:string,fundingAmountMinor?:number){
  const client=await db.connect();
  let row:any=null;
  let cardRow:any=null;
  try{
    await client.query("begin");
    const basket=await client.query(`
      select cb.id,cb.customer_id,cb.virtual_card_id,cb.issuer_connection_id,cb.retailer,cb.payment_status,
             b.payment_route,coalesce(sum(po.amount_minor),0)::bigint amount_minor
      from checkout_baskets cb
      join order_batches b on b.id=cb.batch_id
      left join purchase_orders po on po.checkout_basket_id=cb.id
      where cb.id=$1 and cb.tenant_id=$2
      group by cb.id,b.payment_route
      for update of cb
    `,[basketId,tenantId]);
    row=basket.rows[0];
    if(!row){
      await client.query("rollback");
      return {status:"NOT_FOUND" as const,cardId:null};
    }
    if(row.payment_route!=="Corporate virtual card"){
      await client.query("commit");
      return {status:"NOT_REQUIRED" as const,cardId:null};
    }

    // Check existing card assigned to basket or linked by checkout_basket_id
    const existing=await client.query(
      "select * from virtual_cards where tenant_id=$1 and (id=$2 or checkout_basket_id=$3) order by created_at desc limit 1 for update",
      [tenantId,row.virtual_card_id??null,basketId]
    );
    cardRow=existing.rows[0]||null;

    if(cardRow&&cardRow.status==="ACTIVE"&&Number(cardRow.balance_minor)>0&&row.virtual_card_id===cardRow.id){
      await client.query("commit");
      return {status:"CARD_ASSIGNED" as const,cardId:String(cardRow.id)};
    }

    if(!cardRow){
      const inserted=await client.query(
        `insert into virtual_cards(
          tenant_id,provider,provider_card_id,provider_account_id,label,masked_number,status,
          balance_minor,merchant_control,created_by,customer_id,checkout_basket_id,
          issuer_connection_id,merchant_scope_type,merchant_scope_value,channel_control_status
        ) values($1,'pending',$2,null,$3,null,'PENDING_ISSUE',0,$4,$5,$6,$7,$8,'RETAILER',$9,'NOT_APPLIED')
        returning *`,
        [
          tenantId,`PENDING:${basketId}`,`Order ${basketId.slice(0,8)}`,
          `Retailer: ${row.retailer}`,userId,row.customer_id,basketId,row.issuer_connection_id,row.retailer
        ]
      );
      cardRow=inserted.rows[0];
    }
    await client.query("commit");
  }catch(error:any){
    await client.query("rollback").catch(()=>{});
    if(String(error?.code)==="23505"){
      const existing=await db.query(
        "select * from virtual_cards where tenant_id=$1 and checkout_basket_id=$2 limit 1",
        [tenantId,basketId]
      );
      if(existing.rows[0]){
        cardRow=existing.rows[0];
      }else{
        throw error;
      }
    }else{
      throw error;
    }
  }finally{
    client.release();
  }

  const cardId=String(cardRow.id);
  const state=await loadTenantIssuer(db,config,tenantId,row.issuer_connection_id);
  if(!state.issuer.configured()){
    await db.query("update checkout_baskets set payment_status='VERIFICATION_REQUIRED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    return {status:"PROGRAMME_REQUIRED" as const,cardId:null};
  }
  const configuredHolder=configuredCardholder(config);
  if(state.issuer.provider==="enkash"&&!configuredHolder){
    await db.query("update checkout_baskets set payment_status='VERIFICATION_REQUIRED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    return {status:"CARDHOLDER_PROFILE_REQUIRED" as const,cardId:null};
  }
  const cardholder=configuredHolder??{};

  const expectedMinor=Math.max(100,Number(row.amount_minor||0));
  const maxAllowedCeiling=Math.ceil(expectedMinor*1.5); // 50% max overage safety cap
  const requestedMinor=Math.max(expectedMinor,Math.floor(Number(fundingAmountMinor||expectedMinor)));
  const amountMinor=Math.min(requestedMinor,maxAllowedCeiling);

  let providerCardId=String(cardRow.provider_card_id||"");
  let providerAccountId=String(cardRow.provider_account_id||"");
  let maskedNumber=cardRow.masked_number?String(cardRow.masked_number):undefined;

  if(!providerCardId||providerCardId.startsWith("PENDING:")){
    const issued=await state.issuer.createCard({
      cardholder,
      label:`OrderGrid ${row.retailer} ${basketId.slice(0,8)}`,
      amountMinor
    });
    providerCardId=issued.providerCardId;
    providerAccountId=issued.providerAccountId;
    maskedNumber=issued.maskedNumber;
    await db.query(
      `update virtual_cards
       set provider=$1,provider_card_id=$2,provider_account_id=$3,masked_number=$4,
           issuer_connection_id=$5,status='PENDING_ISSUE',updated_at=now()
       where id=$6`,
      [issued.provider,providerCardId,providerAccountId,maskedNumber??null,state.connectionId,cardId]
    );
  }

  const capabilities=(state.metadata?.capabilities??{}) as Record<string,unknown>;
  const controlsOptional=Boolean(capabilities.controls_optional??capabilities.controlsOptional??false);

  try{
    const controlStatus=await state.issuer.configureCard({
      providerCardId,
      providerAccountId,
      onlineAllowed:true,
      posAllowed:false
    });
    if(controlStatus==="NOT_SUPPORTED"&&!controlsOptional){
      await db.query("update virtual_cards set channel_control_status='NOT_SUPPORTED',status='CONTROL_FAILED',updated_at=now() where id=$1",[cardId]);
      await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
      return {status:"CONTROL_FAILED" as const,cardId};
    }
    await db.query("update virtual_cards set channel_control_status=$1,updated_at=now() where id=$2",[controlStatus,cardId]);
  }catch(error){
    await db.query("update virtual_cards set channel_control_status='FAILED',status='CONTROL_FAILED',updated_at=now() where id=$1",[cardId]);
    await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    throw error;
  }

  try{
    await state.issuer.loadCard({
      providerCardId,
      providerAccountId,
      amountMinor,
      reference:`ordergrid-order-${basketId}`
    });
    await db.query(
      "update virtual_cards set balance_minor=greatest(balance_minor,$1),status='ACTIVE',updated_at=now() where id=$2",
      [amountMinor,cardId]
    );
    await db.query(
      "update checkout_baskets set virtual_card_id=$1,payment_status='CARD_ASSIGNED',updated_at=now() where id=$2 and tenant_id=$3",
      [cardId,basketId,tenantId]
    );
    return {status:"CARD_ASSIGNED" as const,cardId};
  }catch(error){
    await db.query("update virtual_cards set status='LOAD_FAILED',updated_at=now() where id=$1",[cardId]);
    await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    throw error;
  }
}

export async function cleanupBasketVirtualCard(db:Db,config:Config,tenantId:string,basketId:string){
  const card=await db.query(
    "select vc.id,vc.provider,vc.provider_card_id,vc.provider_account_id,vc.issuer_connection_id,vc.status,vc.balance_minor from virtual_cards vc where vc.tenant_id=$1 and vc.checkout_basket_id=$2 limit 1",
    [tenantId,basketId]
  );
  const row=card.rows[0];
  if(!row||row.status==="CLOSED")return {cleaned:false};
  try{
    const state=await loadTenantIssuer(db,config,tenantId,row.issuer_connection_id);
    if(state.issuer.configured()&&!String(row.provider_card_id).startsWith("PENDING:")){
      if(state.issuer.unloadCard&&Number(row.balance_minor)>0){
        await state.issuer.unloadCard({providerCardId:row.provider_card_id,providerAccountId:row.provider_account_id,amountMinor:Number(row.balance_minor)}).catch(()=>{});
      }
      if(state.issuer.closeCard){
        await state.issuer.closeCard({providerCardId:row.provider_card_id,providerAccountId:row.provider_account_id}).catch(()=>{});
      }
    }
  }catch{}
  await db.query("update virtual_cards set status='CLOSED',updated_at=now() where id=$1",[row.id]);
  return {cleaned:true,cardId:row.id};
}

export async function reconcileOrphanVirtualCards(db:Db,tenantId:string){
  const {rows}=await db.query(
    `select vc.id,vc.provider,vc.provider_card_id,vc.status,vc.created_at,vc.checkout_basket_id,cb.status basket_status
     from virtual_cards vc
     left join checkout_baskets cb on cb.id=vc.checkout_basket_id and cb.tenant_id=vc.tenant_id
     where vc.tenant_id=$1
       and (
         (vc.status='PENDING_ISSUE' and vc.created_at<now()-interval '10 minutes')
         or (vc.status in ('CONTROL_FAILED','LOAD_FAILED') and vc.updated_at<now()-interval '30 minutes')
         or (cb.status in ('CANCELLED','FAILED','EXPIRED') and vc.status='ACTIVE')
       )`,
    [tenantId]
  );
  return rows;
}

