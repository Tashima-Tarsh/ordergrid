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
  const basket=await db.query(`
    select cb.id,cb.customer_id,cb.virtual_card_id,cb.issuer_connection_id,cb.retailer,
           b.payment_route,coalesce(sum(po.amount_minor),0)::bigint amount_minor
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    left join purchase_orders po on po.checkout_basket_id=cb.id
    where cb.id=$1 and cb.tenant_id=$2
    group by cb.id,b.payment_route
  `,[basketId,tenantId]);
  const row=basket.rows[0];
  if(!row)return {status:"NOT_FOUND" as const,cardId:null};
  if(row.payment_route!=="Corporate virtual card")return {status:"NOT_REQUIRED" as const,cardId:null};
  if(row.virtual_card_id)return {status:"CARD_ASSIGNED" as const,cardId:String(row.virtual_card_id)};

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
  const amountMinor=Math.max(expectedMinor,Math.floor(Number(fundingAmountMinor||expectedMinor)));
  const issued=await state.issuer.createCard({cardholder,label:`OrderGrid ${row.retailer} ${basketId.slice(0,8)}`,amountMinor});
  let cardId:string;
  try{
    const inserted=await db.query(
      `insert into virtual_cards(
        tenant_id,provider,provider_card_id,provider_account_id,label,masked_number,status,
        balance_minor,merchant_control,created_by,customer_id,checkout_basket_id,
        issuer_connection_id,merchant_scope_type,merchant_scope_value,channel_control_status
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'RETAILER',$14,'NOT_APPLIED')
      returning id`,
      [
        tenantId,issued.provider,issued.providerCardId,issued.providerAccountId,
        `Order ${basketId.slice(0,8)}`,issued.maskedNumber??null,issued.status,issued.balanceMinor,
        `Retailer: ${row.retailer}`,userId,row.customer_id,basketId,state.connectionId,row.retailer
      ]
    );
    cardId=inserted.rows[0].id;
  }catch(error:any){
    if(String(error?.code)==="23505"){
      const existing=await db.query("select id from virtual_cards where tenant_id=$1 and checkout_basket_id=$2 limit 1",[tenantId,basketId]);
      if(existing.rows[0])return {status:"CARD_ASSIGNED" as const,cardId:String(existing.rows[0].id)};
    }
    throw error;
  }

  try{
    try{
      const controlStatus=await state.issuer.configureCard({
        providerCardId:issued.providerCardId,
        providerAccountId:issued.providerAccountId,
        onlineAllowed:true,
        posAllowed:false
      });
      await db.query("update virtual_cards set channel_control_status=$1,updated_at=now() where id=$2",[controlStatus,cardId]);
    }catch(error){
      await db.query("update virtual_cards set channel_control_status='FAILED',status='CONTROL_FAILED',updated_at=now() where id=$1",[cardId]);
      await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
      throw error;
    }
    await state.issuer.loadCard({
      providerCardId:issued.providerCardId,
      providerAccountId:issued.providerAccountId,
      amountMinor,
      reference:`ordergrid-order-${basketId}`
    });
    await db.query("update virtual_cards set balance_minor=greatest(balance_minor,$1),status='ACTIVE',updated_at=now() where id=$2",[amountMinor,cardId]);
    await db.query("update checkout_baskets set virtual_card_id=$1,payment_status='CARD_ASSIGNED',updated_at=now() where id=$2 and tenant_id=$3",[cardId,basketId,tenantId]);
    return {status:"CARD_ASSIGNED" as const,cardId};
  }catch(error){
    await db.query("update virtual_cards set status='LOAD_FAILED',updated_at=now() where id=$1",[cardId]);
    await db.query("update checkout_baskets set payment_status='FAILED',updated_at=now() where id=$1 and tenant_id=$2",[basketId,tenantId]);
    throw error;
  }
}
