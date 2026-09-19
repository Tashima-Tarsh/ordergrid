import type { Db } from "./db.js";

export async function assignFundingRoute(db:Db,tenantId:string,basketId:string){
  const basket=await db.query(`
    select cb.id,cb.retailer,b.payment_route,coalesce(sum(po.amount_minor),0)::bigint amount_minor
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    left join purchase_orders po on po.checkout_basket_id=cb.id
    where cb.id=$1 and cb.tenant_id=$2
    group by cb.id,b.payment_route
  `,[basketId,tenantId]);
  const row=basket.rows[0];
  if(!row||row.payment_route!=="Corporate virtual card")return null;
  const amount=Number(row.amount_minor||0);

  const routed=await db.query(`
    select fp.id policy_id,fp.issuer_provider,fp.issuer_connection_id
    from funding_policies fp
    join issuer_connections ic
      on ic.id=fp.issuer_connection_id
     and ic.tenant_id=fp.tenant_id
     and ic.status='CONNECTED'
    where fp.tenant_id=$1 and fp.active
      and (fp.retailer is null or fp.retailer=$2)
      and fp.min_amount_minor <= $3
      and (fp.max_amount_minor is null or fp.max_amount_minor >= $3)
    order by case when fp.retailer=$2 then 0 else 1 end,fp.priority asc,fp.created_at asc
    limit 1
  `,[tenantId,row.retailer,amount]);

  let route=routed.rows[0]??null;
  if(!route){
    const only=await db.query(`
      select id issuer_connection_id,provider issuer_provider
      from issuer_connections
      where tenant_id=$1 and status='CONNECTED'
      order by provider
      limit 2
    `,[tenantId]);
    if(only.rows.length===1)route={policy_id:null,...only.rows[0]};
  }
  if(!route)return null;
  await db.query("update checkout_baskets set issuer_connection_id=$1,updated_at=now() where id=$2 and tenant_id=$3",[route.issuer_connection_id,basketId,tenantId]);
  return route;
}


export async function assignAvailableVirtualCard(db:Db,tenantId:string,basketId:string){
  const client=await db.connect();
  try{
    await client.query("begin");
    const basket=await client.query(`
      select cb.id,cb.customer_id,cb.issuer_connection_id,cb.virtual_card_id,
        ic.provider,coalesce(sum(po.amount_minor),0)::bigint amount_minor
      from checkout_baskets cb
      left join issuer_connections ic on ic.id=cb.issuer_connection_id
      left join purchase_orders po on po.checkout_basket_id=cb.id
      where cb.id=$1 and cb.tenant_id=$2
      group by cb.id,ic.provider
      for update of cb
    `,[basketId,tenantId]);
    const row=basket.rows[0];
    if(!row||row.virtual_card_id||!row.issuer_connection_id||!row.provider){
      await client.query("commit");
      return row?.virtual_card_id??null;
    }
    const card=await client.query(`
      select id
      from virtual_cards
      where tenant_id=$1 and provider=$2 and status='ACTIVE'
        and balance_minor >= $3
        and checkout_basket_id is null
        and (customer_id is null or customer_id=$4)
      order by case when customer_id=$4 then 0 else 1 end,created_at
      for update skip locked
      limit 1
    `,[tenantId,row.provider,Number(row.amount_minor||0),row.customer_id]);
    if(!card.rows[0]){
      await client.query("commit");
      return null;
    }
    await client.query("update virtual_cards set customer_id=$1,checkout_basket_id=$2,updated_at=now() where id=$3",[row.customer_id,basketId,card.rows[0].id]);
    await client.query("update checkout_baskets set virtual_card_id=$1,updated_at=now() where id=$2 and tenant_id=$3",[card.rows[0].id,basketId,tenantId]);
    await client.query("commit");
    return card.rows[0].id as string;
  }catch(error){
    await client.query("rollback");
    throw error;
  }finally{
    client.release();
  }
}
