import type { Pool, PoolClient } from "pg";

async function assignRetailerAccount(
  client:PoolClient,
  tenantId:string,
  basketId:string,
  customerId:string,
  retailer:string
){
  const candidate=await client.query(
    `select ra.id,ra.account_reference,ra.session_status
     from retailer_accounts ra
     left join execution_workers ew on ew.tenant_id=ra.tenant_id and ew.id=ra.session_worker_id
     left join lateral (
       select count(*)::int active_orders
       from checkout_baskets active_cb
       where active_cb.retailer_account_id=ra.id
         and active_cb.id<>$4
         and active_cb.status in ('CLAIMED','OPENED','REQUIRES_ACTION')
     ) usage on true
     where ra.tenant_id=$1
       and ra.retailer=$2
       and ra.active
       and ra.auth_status not in ('LOCKED','DISABLED')
       and (ra.retailer<>'flipkart' or (ra.session_status='READY' and (ra.session_target_expires_at is null or ra.session_target_expires_at>now()) and ew.last_seen>now()-interval '30 seconds'))
       and (ra.customer_id=$3 or ra.customer_id is null)
       and (ra.cooldown_until is null or ra.cooldown_until<=now())
       and usage.active_orders < ra.max_concurrent_orders
     order by
       case when ra.customer_id=$3 then 0 else 1 end,
       usage.active_orders,
       ra.last_assigned_at nulls first,
       ra.created_at,
       ra.id
     for update of ra skip locked
     limit 1`,
    [tenantId,retailer,customerId,basketId]
  );
  let account=candidate.rows[0];

  if(!account){
    const customer=await client.query(
      "select external_reference from customers where id=$1 and tenant_id=$2",
      [customerId,tenantId]
    );
    if(!customer.rows[0])throw new Error("basket_customer_not_found");
    const fallback=await client.query(
      `insert into retailer_accounts(
         tenant_id,customer_id,retailer,account_reference,auth_status,session_status,active,max_concurrent_orders
       )
       values($1,$2,$3,$4,'AUTH_REQUIRED','NOT_CONFIGURED',true,1)
       on conflict(tenant_id,customer_id,retailer) where customer_id is not null
       do update set updated_at=now()
       returning id,account_reference,session_status`,
      [tenantId,customerId,retailer,String(customer.rows[0].external_reference)]
    );
    account=fallback.rows[0];
  }

  const isReady=account.session_status==='READY';
  await client.query(
    `update checkout_baskets
     set retailer_account_id=$1,account_reference=$2,
         status=case when $5::boolean=false and $6='flipkart' then 'REQUIRES_ACTION' else status end,
         failure_code=case when $5::boolean=false and $6='flipkart' then 'LOGIN_REQUIRED' else failure_code end,
         failure_message=case when $5::boolean=false and $6='flipkart' then 'Flipkart authentication is required for this account' else failure_message end,
         updated_at=now()
     where id=$3 and tenant_id=$4`,
    [account.id,account.account_reference,basketId,tenantId,isReady,retailer]
  );
  await client.query(
    "update retailer_accounts set last_assigned_at=now(),updated_at=now() where id=$1 and tenant_id=$2",
    [account.id,tenantId]
  );
}

export async function syncCheckoutBaskets(db:Pool, tenantId:string, batchId:string) {
  const client=await db.connect();
  try {
    await client.query("begin");

    // Every recipient resolves to one immutable OrderGrid customer.
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

    // Create the checkout basket first. Retailer-account assignment happens
    // separately so a tenant can use an N-sized reusable account pool.
    await client.query(`
      insert into checkout_baskets(
        tenant_id,batch_id,address_id,customer_id,
        retailer_account_id,account_reference,retailer,status,updated_at
      )
      select distinct
        po.tenant_id,
        bi.batch_id,
        bi.address_id,
        a.customer_id,
        bi.retailer_account_id,
        ra.account_reference,
        po.retailer,
        'READY',
        now()
      from purchase_orders po
      join batch_items bi on bi.id=po.batch_item_id
      join addresses a on a.id=bi.address_id
      left join retailer_accounts ra on ra.id=bi.retailer_account_id and ra.tenant_id=po.tenant_id
      where po.tenant_id=$1
        and bi.batch_id=$2
        and bi.address_id is not null
        and a.customer_id is not null
        and po.status='REQUIRES_ACTION'
      on conflict(batch_id,address_id,retailer)
      do update set
        customer_id=excluded.customer_id,
        retailer_account_id=coalesce(excluded.retailer_account_id,checkout_baskets.retailer_account_id),
        account_reference=coalesce(excluded.account_reference,checkout_baskets.account_reference),
        updated_at=now()
    `,[tenantId,batchId]);

    const unassigned=await client.query(
      `select id,customer_id,retailer
       from checkout_baskets
       where tenant_id=$1 and batch_id=$2 and retailer_account_id is null
       order by created_at,id
       for update`,
      [tenantId,batchId]
    );
    for(const basket of unassigned.rows){
      await assignRetailerAccount(
        client,
        tenantId,
        String(basket.id),
        String(basket.customer_id),
        String(basket.retailer)
      );
    }

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
