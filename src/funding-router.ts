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
