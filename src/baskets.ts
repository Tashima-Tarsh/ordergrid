import type { Pool } from "pg";

export async function syncCheckoutBaskets(db:Pool, tenantId:string, batchId:string) {
  const client=await db.connect();
  try {
    await client.query("begin");

    // Every recipient must resolve to one immutable OrderGrid customer.
    await client.query(`
      insert into customers(tenant_id,external_reference,display_name,phone)
      select distinct ab.tenant_id,
        coalesce(nullif(a.reference,''),'ADDR-'||a.id::text),
        a.recipient,a.phone
      from batch_items bi
      join addresses a on a.id=bi.address_id
      join address_books ab on ab.id=a.address_book_id
      where bi.batch_id=$2 and ab.tenant_id=$1
      on conflict(tenant_id,external_reference) do update
      set display_name=excluded.display_name,phone=excluded.phone,updated_at=now()
    `,[tenantId,batchId]);
    await client.query(`
      update addresses a set customer_id=c.id
      from address_books ab,customers c,batch_items bi
      where bi.address_id=a.id and bi.batch_id=$2
        and ab.id=a.address_book_id and ab.tenant_id=$1
        and c.tenant_id=ab.tenant_id
        and c.external_reference=coalesce(nullif(a.reference,''),'ADDR-'||a.id::text)
        and a.customer_id is distinct from c.id
    `,[tenantId,batchId]);

    // Create an isolated retailer-account identity when no explicit account mapping
    // was imported yet. No retailer password or OTP secret is stored here.
    await client.query(`
      insert into retailer_accounts(tenant_id,customer_id,retailer,account_reference)
      select distinct po.tenant_id,a.customer_id,po.retailer,
        coalesce(nullif(a.reference,''),c.external_reference)
      from purchase_orders po
      join batch_items bi on bi.id=po.batch_item_id
      join addresses a on a.id=bi.address_id
      join customers c on c.id=a.customer_id
      where po.tenant_id=$1 and bi.batch_id=$2
        and a.customer_id is not null and po.status='REQUIRES_ACTION'
      on conflict(tenant_id,customer_id,retailer) do nothing
    `,[tenantId,batchId]);

    await client.query(`
      insert into checkout_baskets(
        tenant_id,batch_id,address_id,customer_id,retailer_account_id,
        account_reference,retailer,status,updated_at
      )
      select distinct
        po.tenant_id,
        bi.batch_id,
        bi.address_id,
        a.customer_id,
        ra.id,
        ra.account_reference,
        po.retailer,
        'READY',
        now()
      from purchase_orders po
      join batch_items bi on bi.id=po.batch_item_id
      join addresses a on a.id=bi.address_id
      join retailer_accounts ra
        on ra.tenant_id=po.tenant_id
       and ra.customer_id=a.customer_id
       and ra.retailer=po.retailer
      where po.tenant_id=$1
        and bi.batch_id=$2
        and bi.address_id is not null
        and po.status='REQUIRES_ACTION'
      on conflict(batch_id,address_id,retailer)
      do update set
        customer_id=excluded.customer_id,
        retailer_account_id=excluded.retailer_account_id,
        account_reference=excluded.account_reference,
        updated_at=now()
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
