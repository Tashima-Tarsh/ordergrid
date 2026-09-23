import type { Config } from "./config.js";
import { audit, type Db } from "./db.js";
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

export type CardProvisionStatus =
  | "NOT_FOUND"
  | "NOT_REQUIRED"
  | "PROGRAMME_REQUIRED"
  | "CARDHOLDER_PROFILE_REQUIRED"
  | "CARD_ASSIGNED"
  | "CONTROL_FAILED"
  | "ISSUE_IN_PROGRESS"
  | "ISSUE_UNCERTAIN"
  | "CLEANUP_REQUIRED"
  | "FUNDING_CAP_EXCEEDED";

export type CardProvisionResult = {
  status: CardProvisionStatus;
  cardId: string | null;
};

export async function ensureBasketVirtualCard(
  db: Db,
  config: Config,
  tenantId: string,
  basketId: string,
  userId: string,
  fundingAmountMinor?: number
): Promise<CardProvisionResult> {
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

    // Check existing card assigned to basket or linked by checkout_basket_id (ignoring CLOSED/CANCELLED)
    const existing=await client.query(
      "select * from virtual_cards where tenant_id=$1 and (id=$2 or checkout_basket_id=$3) and status not in ('CLOSED','CANCELLED') order by created_at desc limit 1 for update",
      [tenantId,row.virtual_card_id??null,basketId]
    );
    cardRow=existing.rows[0]||null;

    if(cardRow&&cardRow.status==="ACTIVE"&&Number(cardRow.balance_minor)>0&&row.virtual_card_id===cardRow.id){
      await client.query("commit");
      return {status:"CARD_ASSIGNED" as const,cardId:String(cardRow.id)};
    }

    if(cardRow&&cardRow.status==="ISSUING"){
      if(cardRow.issuing_started_at&&new Date(cardRow.issuing_started_at).getTime()<Date.now()-5*60_000){
        await client.query("update virtual_cards set status='ISSUE_UNCERTAIN',updated_at=now() where id=$1",[cardRow.id]);
        await client.query("commit");
        return {status:"ISSUE_UNCERTAIN" as const,cardId:String(cardRow.id)};
      }
      await client.query("commit");
      return {status:"ISSUE_IN_PROGRESS" as const,cardId:String(cardRow.id)};
    }

    if(cardRow&&cardRow.status==="ISSUE_UNCERTAIN"){
      await client.query("commit");
      return {status:"ISSUE_UNCERTAIN" as const,cardId:String(cardRow.id)};
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
        "select * from virtual_cards where tenant_id=$1 and checkout_basket_id=$2 and status not in ('CLOSED','CANCELLED') limit 1",
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
  const overagePct=typeof config.CARD_FUNDING_MAX_OVERAGE_PCT==="number"?config.CARD_FUNDING_MAX_OVERAGE_PCT:10;
  const hardCeiling=Math.ceil((expectedMinor*(100+overagePct))/100);
  const requestedMinor=Math.floor(Number(fundingAmountMinor||expectedMinor));

  if(requestedMinor>hardCeiling){
    await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    await audit(db,tenantId,userId,"virtual_card.funding_cap_exceeded","checkout_basket",basketId,{
      expectedMinor,
      requestedMinor,
      hardCeiling,
      overagePct
    });
    return {status:"FUNDING_CAP_EXCEEDED" as const,cardId:null};
  }

  const amountMinor=Math.max(expectedMinor,requestedMinor);

  let providerCardId=String(cardRow.provider_card_id||"");
  let providerAccountId=String(cardRow.provider_account_id||"");
  let maskedNumber=cardRow.masked_number?String(cardRow.masked_number):undefined;

  if(!providerCardId||providerCardId.startsWith("PENDING:")){
    const claim=await db.query(
      `update virtual_cards
       set status='ISSUING',issuing_started_at=now(),updated_at=now()
       where id=$1 and status='PENDING_ISSUE' and provider_card_id like 'PENDING:%'
       returning *`,
      [cardId]
    );
    if(!claim.rows[0]){
      const cur=await db.query("select status from virtual_cards where id=$1",[cardId]);
      const curStatus=cur.rows[0]?.status;
      if(curStatus==="ISSUE_UNCERTAIN")return {status:"ISSUE_UNCERTAIN" as const,cardId};
      return {status:"ISSUE_IN_PROGRESS" as const,cardId};
    }

    let issued;
    try{
      issued=await state.issuer.createCard({
        cardholder,
        label:`OrderGrid ${row.retailer} ${basketId}`,
        amountMinor
      });
    }catch(error){
      await db.query("update virtual_cards set status='PENDING_ISSUE',issuing_started_at=null,updated_at=now() where id=$1 and status='ISSUING'",[cardId]).catch(()=>{});
      throw error;
    }

    try{
      const updated=await db.query(
        `update virtual_cards
         set provider=$1,provider_card_id=$2,provider_account_id=$3,masked_number=$4,
             issuer_connection_id=$5,status='PENDING_ISSUE',issuing_started_at=null,updated_at=now()
         where id=$6 and status='ISSUING'
         returning *`,
        [issued.provider,issued.providerCardId,issued.providerAccountId,issued.maskedNumber??null,state.connectionId,cardId]
      );
      if(!updated.rows[0]){
        await db.query("update virtual_cards set status='ISSUE_UNCERTAIN',updated_at=now() where id=$1",[cardId]);
        return {status:"ISSUE_UNCERTAIN" as const,cardId};
      }
      providerCardId=issued.providerCardId;
      providerAccountId=issued.providerAccountId;
      maskedNumber=issued.maskedNumber;
    }catch{
      await db.query("update virtual_cards set status='ISSUE_UNCERTAIN',updated_at=now() where id=$1",[cardId]).catch(()=>{});
      return {status:"ISSUE_UNCERTAIN" as const,cardId};
    }
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

export async function cleanupBasketVirtualCard(db:Db,config:Config,tenantId:string,basketId:string,actorId:string|null=null){
  const card=await db.query(
    "select vc.id,vc.provider,vc.provider_card_id,vc.provider_account_id,vc.issuer_connection_id,vc.status,vc.balance_minor from virtual_cards vc where vc.tenant_id=$1 and vc.checkout_basket_id=$2 and vc.status not in ('CLOSED','CANCELLED') limit 1",
    [tenantId,basketId]
  );
  const row=card.rows[0];
  if(!row)return {cleaned:false,reason:"NO_ACTIVE_CARD"};
  const cardId=String(row.id);
  const providerCardId=String(row.provider_card_id||"");

  if(providerCardId.startsWith("PENDING:")){
    await db.query("update virtual_cards set status='CLOSED',balance_minor=0,updated_at=now() where id=$1",[cardId]);
    await audit(db,tenantId,actorId,"virtual_card.cleaned","virtual_card",cardId,{basketId,provider:row.provider,reason:"PENDING_UNISSUED"});
    return {cleaned:true,cardId};
  }

  try{
    const state=await loadTenantIssuer(db,config,tenantId,row.issuer_connection_id);
    if(!state.issuer.configured()){
      await db.query("update virtual_cards set status='CLEANUP_REQUIRED',updated_at=now() where id=$1",[cardId]);
      await audit(db,tenantId,actorId,"virtual_card.cleanup_failed","virtual_card",cardId,{basketId,reason:"ISSUER_NOT_CONFIGURED"});
      return {cleaned:false,reason:"ISSUER_NOT_CONFIGURED",cardId};
    }
    if(!state.issuer.closeCard){
      await db.query("update virtual_cards set status='CLEANUP_REQUIRED',updated_at=now() where id=$1",[cardId]);
      await audit(db,tenantId,actorId,"virtual_card.cleanup_failed","virtual_card",cardId,{basketId,reason:"CLOSE_CARD_UNSUPPORTED"});
      return {cleaned:false,reason:"CLOSE_CARD_UNSUPPORTED",cardId};
    }
    if(state.issuer.unloadCard&&Number(row.balance_minor)>0){
      await state.issuer.unloadCard({providerCardId,providerAccountId:row.provider_account_id,amountMinor:Number(row.balance_minor)});
    }
    await state.issuer.closeCard({providerCardId,providerAccountId:row.provider_account_id});
    await db.query("update virtual_cards set status='CLOSED',balance_minor=0,updated_at=now() where id=$1",[cardId]);
    await audit(db,tenantId,actorId,"virtual_card.cleaned","virtual_card",cardId,{basketId,provider:row.provider});
    return {cleaned:true,cardId};
  }catch(error:any){
    const reason=String(error?.message||error||"CLEANUP_FAILED").slice(0,250);
    await db.query("update virtual_cards set status='CLEANUP_REQUIRED',updated_at=now() where id=$1",[cardId]);
    await audit(db,tenantId,actorId,"virtual_card.cleanup_failed","virtual_card",cardId,{basketId,error:reason});
    return {cleaned:false,reason,cardId};
  }
}

export async function reconcileOrphanVirtualCards(db:Db,tenantId:string){
  const {rows}=await db.query(
    `select vc.id,vc.provider,vc.provider_card_id,vc.status,vc.created_at,vc.issuing_started_at,vc.checkout_basket_id,cb.status basket_status
     from virtual_cards vc
     left join checkout_baskets cb on cb.id=vc.checkout_basket_id and cb.tenant_id=vc.tenant_id
     where vc.tenant_id=$1
       and (
         (vc.status='PENDING_ISSUE' and vc.created_at<now()-interval '10 minutes')
         or (vc.status='ISSUING' and coalesce(vc.issuing_started_at,vc.created_at)<now()-interval '5 minutes')
         or vc.status in ('ISSUE_UNCERTAIN','CLEANUP_REQUIRED')
         or (vc.status in ('CONTROL_FAILED','LOAD_FAILED') and vc.updated_at<now()-interval '30 minutes')
         or (cb.status in ('CANCELLED','FAILED','EXPIRED') and vc.status='ACTIVE')
       )`,
    [tenantId]
  );
  return rows;
}

export async function applyBasketCardProvisioning(
  db: Db,
  config: Config,
  tenantId: string,
  basketId: string,
  userId: string,
  fundingCeiling: number
): Promise<{ cardId: string | null; assigned: boolean; inProgress: boolean }> {
  try {
    const card = await ensureBasketVirtualCard(db, config, tenantId, basketId, userId, fundingCeiling);
    if (card.status === "CARD_ASSIGNED" && card.cardId) {
      return { cardId: card.cardId, assigned: true, inProgress: false };
    }
    if (card.status === "NOT_REQUIRED") {
      return { cardId: null, assigned: false, inProgress: false };
    }
    if (card.status === "PROGRAMME_REQUIRED" || card.status === "CARDHOLDER_PROFILE_REQUIRED") {
      await db.query(
        "update checkout_baskets set status='REQUIRES_ACTION',failure_code='PAYMENT_SETUP_REQUIRED',failure_message='Payment setup required before checkout can continue',claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$1 and tenant_id=$2",
        [basketId, tenantId]
      );
      return { cardId: null, assigned: false, inProgress: false };
    }
    if (card.status === "ISSUE_IN_PROGRESS") {
      return { cardId: null, assigned: false, inProgress: true };
    }
    const message =
      card.status === "CONTROL_FAILED"
        ? "Virtual card merchant/channel controls could not be applied"
        : card.status === "FUNDING_CAP_EXCEEDED"
        ? "Requested funding amount exceeds safety funding ceiling"
        : card.status === "ISSUE_UNCERTAIN"
        ? "Virtual card issuing status is uncertain; manual review required"
        : card.status === "CLEANUP_REQUIRED"
        ? "Virtual card requires manual cleanup"
        : "Virtual card provisioning failed";

    await db.query(
      "update checkout_baskets set status='REQUIRES_ACTION',failure_code='CARD_SETUP_FAILED',failure_message=$1,claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$2 and tenant_id=$3",
      [message, basketId, tenantId]
    );
    return { cardId: null, assigned: false, inProgress: false };
  } catch (error: any) {
    const errMessage = String(error?.message || "Virtual card provisioning failed unexpectedly").slice(0, 200);
    await db.query(
      "update checkout_baskets set status='REQUIRES_ACTION',failure_code='CARD_SETUP_FAILED',failure_message=$1,claimed_by=null,execution_worker_id=null,expires_at=null,updated_at=now() where id=$2 and tenant_id=$3",
      [errMessage, basketId, tenantId]
    ).catch(() => {});
    return { cardId: null, assigned: false, inProgress: false };
  }
}

