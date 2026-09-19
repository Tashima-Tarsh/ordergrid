import type { Pool } from "pg";

export async function syncCheckoutBaskets(db:Pool, tenantId:string, batchId:string) {
  const client=await db.connect();
  try {
    await client.query("begin");
    await client.query(`
      insert into checkout_baskets(
        tenant_id,batch_id,address_id,account_reference,retailer,status,updated_at
      )
      select distinct
        po.tenant_id,
        bi.batch_id,
        bi.address_id,
        a.reference,
        po.retailer,
        'READY',
        now()
      from purchase_orders po
      join batch_items bi on bi.id=po.batch_item_id
      left join addresses a on a.id=bi.address_id
      where po.tenant_id=$1
        and bi.batch_id=$2
        and bi.address_id is not null
        and po.status='REQUIRES_ACTION'
      on conflict(batch_id,address_id,retailer)
      do update set account_reference=excluded.account_reference,updated_at=now()
    `,[tenantId,batchId]);
    await client.query(`
      update purchase_orders po
      set checkout_basket_id=cb.id,updated_at=now()
      from batch_items bi,checkout_baskets cb
      where po.batch_item_id=bi.id
        and cb.tenant_id=po.tenant_id
        and cb.batch_id=bi.batch_id
        and cb.address_id=bi.address_id
        and cb.retailer=po.retailer
        and po.tenant_id=$1
        and bi.batch_id=$2
    `,[tenantId,batchId]);
    await client.query("commit");
  } catch(error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
