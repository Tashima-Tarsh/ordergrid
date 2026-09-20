import ExcelJS from "exceljs";
import type { Db } from "./db.js";

export type UserDashboardFilters={from?:string;to?:string;userId?:string};

function dateClauses(column:string,filters:UserDashboardFilters,params:any[]){
  const clauses:string[]=[];
  if(filters.from){params.push(filters.from);clauses.push(`${column} >= $${params.length}::date`)}
  if(filters.to){params.push(filters.to);clauses.push(`${column} < ($${params.length}::date + interval '1 day')`)}
  return clauses;
}
function moneyMinor(value:unknown){return Number(value||0)}
function signedRewardExpression(alias="re"){
  return `case when ${alias}.event_type in ('CREDITED','ADJUSTED') then ${alias}.units
    when ${alias}.event_type in ('REDEEMED','REVERSED') then -${alias}.units else 0 end`;
}

export async function getUserDashboard(db:Db,tenantId:string,filters:UserDashboardFilters={}){
  const params:any[]=[tenantId];
  const userClause=filters.userId?(()=>{params.push(filters.userId);return ` and au.id=$${params.length}::uuid`})():"";
  const batchDate=dateClauses("b.created_at",filters,params);
  const orderDate=dateClauses("po.created_at",filters,params);
  const refundDate=dateClauses("rf.requested_at",filters,params);
  const rewardDate=dateClauses("re.occurred_at",filters,params);
  const cardDate=dateClauses("vc.created_at",filters,params);
  const invoiceDate=dateClauses("gi.created_at",filters,params);
  const basketDate=dateClauses("cb.created_at",filters,params);

  const sql=`
    with accessible_users as (
      select distinct u.id,u.email::text email,
        case when u.tenant_id=$1 then u.role::text else da.role::text end role,
        u.active
      from users u
      left join dealer_access da on da.user_id=u.id and da.tenant_id=$1
      where u.tenant_id=$1 or da.tenant_id=$1
    ),
    batch_stats as (
      select b.created_by user_id,count(*)::int batches,
        coalesce(sum(b.estimated_total_minor),0)::bigint estimated_minor
      from order_batches b
      where b.tenant_id=$1 ${batchDate.length?"and "+batchDate.join(" and "):""}
      group by b.created_by
    ),
    basket_orders as (
      select cb.id,b.created_by,cb.status,cb.created_at,
        coalesce(sum(po.amount_minor),0)::bigint amount_minor,
        bool_or(po.status in ('CANCELLED','REFUNDED')) cancelled_or_refunded
      from checkout_baskets cb
      join order_batches b on b.id=cb.batch_id
      left join purchase_orders po on po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id
      where cb.tenant_id=$1 ${orderDate.length?"and "+orderDate.map(x=>x.replaceAll("po.created_at","cb.created_at")).join(" and "):""}
      group by cb.id,b.created_by,cb.status,cb.created_at
    ),
    order_stats as (
      select created_by user_id,
        count(*)::int orders,
        count(*) filter(where status='CONFIRMED')::int confirmed_orders,
        count(*) filter(where cancelled_or_refunded)::int cancelled_refunded_orders,
        count(*) filter(where status in ('FAILED','REQUIRES_ACTION'))::int attention_orders,
        coalesce(sum(amount_minor),0)::bigint order_value_minor,
        coalesce(sum(amount_minor) filter(where status='CONFIRMED'),0)::bigint confirmed_value_minor
      from basket_orders
      group by created_by
    ),
    refund_stats as (
      select b.created_by user_id,
        count(rf.id)::int refunds,
        coalesce(sum(rf.amount_minor),0)::bigint refund_minor,
        count(rf.id) filter(where rf.status='SETTLED')::int settled_refunds,
        coalesce(sum(rf.amount_minor) filter(where rf.status='SETTLED'),0)::bigint settled_refund_minor,
        coalesce(sum(rf.amount_minor) filter(where rf.status in ('REQUESTED','INITIATED','PROCESSING')),0)::bigint pending_refund_minor
      from retailer_refunds rf
      join checkout_baskets cb on cb.id=rf.checkout_basket_id
      join order_batches b on b.id=cb.batch_id
      where rf.tenant_id=$1 ${refundDate.length?"and "+refundDate.join(" and "):""}
      group by b.created_by
    ),
    reward_stats as (
      select b.created_by user_id,
        count(re.id)::int reward_events,
        coalesce(sum(${signedRewardExpression("re")}),0)::bigint reward_units
      from retailer_reward_events re
      join checkout_baskets cb on cb.id=re.checkout_basket_id
      join order_batches b on b.id=cb.batch_id
      where re.tenant_id=$1 ${rewardDate.length?"and "+rewardDate.join(" and "):""}
      group by b.created_by
    ),
    card_created_stats as (
      select vc.created_by user_id,count(vc.id)::int cards_created,
        coalesce(sum(vc.balance_minor),0)::bigint card_limit_minor
      from virtual_cards vc
      where vc.tenant_id=$1 and vc.created_by is not null ${cardDate.length?"and "+cardDate.join(" and "):""}
      group by vc.created_by
    ),
    card_used_stats as (
      select b.created_by user_id,count(distinct cb.virtual_card_id)::int cards_used
      from checkout_baskets cb
      join order_batches b on b.id=cb.batch_id
      where cb.tenant_id=$1 and cb.virtual_card_id is not null ${basketDate.length?"and "+basketDate.join(" and "):""}
      group by b.created_by
    ),
    gst_stats as (
      select b.created_by user_id,count(gi.id)::int gst_invoices,
        coalesce(sum(gi.total_minor),0)::bigint gst_invoice_minor
      from gst_invoices gi
      join checkout_baskets cb on cb.id=gi.checkout_basket_id
      join order_batches b on b.id=cb.batch_id
      where gi.tenant_id=$1 ${invoiceDate.length?"and "+invoiceDate.join(" and "):""}
      group by b.created_by
    ),
    action_stats as (
      select b.created_by user_id,count(cb.id)::int human_actions
      from checkout_baskets cb
      join order_batches b on b.id=cb.batch_id
      where cb.tenant_id=$1 and cb.status in ('REQUIRES_ACTION','FAILED') ${basketDate.length?"and "+basketDate.join(" and "):""}
      group by b.created_by
    )
    select au.id user_id,au.email,au.role,au.active,
      coalesce(bs.batches,0)::int batches,coalesce(bs.estimated_minor,0)::bigint estimated_minor,
      coalesce(os.orders,0)::int orders,coalesce(os.confirmed_orders,0)::int confirmed_orders,
      coalesce(os.cancelled_refunded_orders,0)::int cancelled_refunded_orders,
      coalesce(os.attention_orders,0)::int attention_orders,
      coalesce(os.order_value_minor,0)::bigint order_value_minor,coalesce(os.confirmed_value_minor,0)::bigint confirmed_value_minor,
      coalesce(rs.refunds,0)::int refunds,coalesce(rs.refund_minor,0)::bigint refund_minor,
      coalesce(rs.settled_refunds,0)::int settled_refunds,coalesce(rs.settled_refund_minor,0)::bigint settled_refund_minor,
      coalesce(rs.pending_refund_minor,0)::bigint pending_refund_minor,
      coalesce(rws.reward_events,0)::int reward_events,coalesce(rws.reward_units,0)::bigint reward_units,
      coalesce(ccs.cards_created,0)::int cards_created,coalesce(ccs.card_limit_minor,0)::bigint card_limit_minor,
      coalesce(cus.cards_used,0)::int cards_used,coalesce(gs.gst_invoices,0)::int gst_invoices,
      coalesce(gs.gst_invoice_minor,0)::bigint gst_invoice_minor,coalesce(ast.human_actions,0)::int human_actions
    from accessible_users au
    left join batch_stats bs on bs.user_id=au.id
    left join order_stats os on os.user_id=au.id
    left join refund_stats rs on rs.user_id=au.id
    left join reward_stats rws on rws.user_id=au.id
    left join card_created_stats ccs on ccs.user_id=au.id
    left join card_used_stats cus on cus.user_id=au.id
    left join gst_stats gs on gs.user_id=au.id
    left join action_stats ast on ast.user_id=au.id
    where 1=1 ${userClause}
    order by coalesce(os.order_value_minor,0) desc,au.email
  `;
  const users=(await db.query(sql,params)).rows;

  const detailParams:any[]=[tenantId];
  const detailClauses=["cb.tenant_id=$1"];
  if(filters.from){detailParams.push(filters.from);detailClauses.push(`cb.created_at >= $${detailParams.length}::date`)}
  if(filters.to){detailParams.push(filters.to);detailClauses.push(`cb.created_at < ($${detailParams.length}::date + interval '1 day')`)}
  if(filters.userId){detailParams.push(filters.userId);detailClauses.push(`b.created_by=$${detailParams.length}::uuid`)}
  const recentOrders=(await db.query(`
    select cb.id order_id,cb.status,cb.retailer,cb.retailer_order_id,cb.failure_code,cb.created_at,cb.updated_at,
      b.id batch_id,b.name batch_name,u.id user_id,u.email::text user_email,
      c.external_reference customer_reference,a.recipient,a.city,a.postal_code,
      ra.account_reference retailer_account_reference,vc.masked_number virtual_card_masked,
      coalesce((select sum(po.amount_minor) from purchase_orders po where po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id),0)::bigint amount_minor,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.checkout_basket_id=cb.id),0)::bigint refund_minor,
      coalesce((select max(rf.status) from retailer_refunds rf where rf.checkout_basket_id=cb.id),'') refund_status,
      coalesce((select sum(${signedRewardExpression("re")}) from retailer_reward_events re where re.checkout_basket_id=cb.id),0)::bigint reward_units
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    left join addresses a on a.id=cb.address_id
    left join customers c on c.id=cb.customer_id
    left join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join virtual_cards vc on vc.id=cb.virtual_card_id
    where ${detailClauses.join(" and ")}
    order by cb.created_at desc
    limit 250
  `,detailParams)).rows;

  const totals=users.reduce((acc:any,row:any)=>{
    for(const key of ["batches","orders","confirmed_orders","cancelled_refunded_orders","attention_orders","order_value_minor","confirmed_value_minor","refunds","refund_minor","settled_refunds","settled_refund_minor","pending_refund_minor","reward_units","cards_created","cards_used","gst_invoices","gst_invoice_minor","human_actions"]){
      acc[key]=(acc[key]||0)+Number(row[key]||0);
    }
    return acc;
  },{users:users.length});

  return {users,recentOrders,totals,filters};
}

async function reportDetails(db:Db,tenantId:string,filters:UserDashboardFilters={}){
  const params:any[]=[tenantId],clauses=["cb.tenant_id=$1"];
  if(filters.from){params.push(filters.from);clauses.push(`cb.created_at >= $${params.length}::date`)}
  if(filters.to){params.push(filters.to);clauses.push(`cb.created_at < ($${params.length}::date + interval '1 day')`)}
  if(filters.userId){params.push(filters.userId);clauses.push(`b.created_by=$${params.length}::uuid`)}
  const orders=await db.query(`
    select u.email::text user_email,b.name batch_name,cb.id order_id,cb.created_at,cb.retailer,cb.retailer_order_id,cb.status,
      coalesce((select sum(po.amount_minor) from purchase_orders po where po.checkout_basket_id=cb.id and po.tenant_id=cb.tenant_id),0)::bigint amount_minor,
      c.external_reference customer_reference,a.recipient,a.city,a.postal_code,
      ra.account_reference retailer_account_reference,vc.masked_number virtual_card_masked,
      coalesce((select sum(rf.amount_minor) from retailer_refunds rf where rf.checkout_basket_id=cb.id),0)::bigint refund_minor,
      coalesce((select max(rf.status) from retailer_refunds rf where rf.checkout_basket_id=cb.id),'') refund_status,
      coalesce((select sum(${signedRewardExpression("re")}) from retailer_reward_events re where re.checkout_basket_id=cb.id),0)::bigint reward_units
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    left join addresses a on a.id=cb.address_id
    left join customers c on c.id=cb.customer_id
    left join retailer_accounts ra on ra.id=cb.retailer_account_id
    left join virtual_cards vc on vc.id=cb.virtual_card_id
    where ${clauses.join(" and ")}
    order by u.email,cb.created_at desc
  `,params);

  const refundParams:any[]=[tenantId],refundClauses=["rf.tenant_id=$1"];
  if(filters.from){refundParams.push(filters.from);refundClauses.push(`rf.requested_at >= $${refundParams.length}::date`)}
  if(filters.to){refundParams.push(filters.to);refundClauses.push(`rf.requested_at < ($${refundParams.length}::date + interval '1 day')`)}
  if(filters.userId){refundParams.push(filters.userId);refundClauses.push(`b.created_by=$${refundParams.length}::uuid`)}
  const refunds=await db.query(`
    select u.email::text user_email,rf.id refund_id,rf.created_at,rf.retailer,rf.status,rf.amount_minor,
      rf.retailer_refund_reference,rf.bank_reference,rf.requested_at,rf.initiated_at,rf.settled_at,
      cb.retailer_order_id,c.external_reference customer_reference,a.recipient,vc.masked_number virtual_card_masked
    from retailer_refunds rf
    join checkout_baskets cb on cb.id=rf.checkout_basket_id
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    left join customers c on c.id=cb.customer_id
    left join addresses a on a.id=cb.address_id
    left join virtual_cards vc on vc.id=rf.virtual_card_id
    where ${refundClauses.join(" and ")}
    order by u.email,rf.created_at desc
  `,refundParams);

  const rewardParams:any[]=[tenantId],rewardClauses=["re.tenant_id=$1"];
  if(filters.from){rewardParams.push(filters.from);rewardClauses.push(`re.occurred_at >= $${rewardParams.length}::date`)}
  if(filters.to){rewardParams.push(filters.to);rewardClauses.push(`re.occurred_at < ($${rewardParams.length}::date + interval '1 day')`)}
  if(filters.userId){rewardParams.push(filters.userId);rewardClauses.push(`b.created_by=$${rewardParams.length}::uuid`)}
  const rewards=await db.query(`
    select u.email::text user_email,re.id reward_event_id,re.occurred_at,re.retailer,re.reward_type,re.event_type,re.units,
      re.retailer_reference,cb.retailer_order_id,ra.account_reference retailer_account_reference
    from retailer_reward_events re
    join checkout_baskets cb on cb.id=re.checkout_basket_id
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    join retailer_accounts ra on ra.id=re.retailer_account_id
    where ${rewardClauses.join(" and ")}
    order by u.email,re.occurred_at desc
  `,rewardParams);

  const cardParams:any[]=[tenantId],cardClauses=["cb.tenant_id=$1","cb.virtual_card_id is not null"];
  if(filters.from){cardParams.push(filters.from);cardClauses.push(`cb.created_at >= ${cardParams.length}::date`)}
  if(filters.to){cardParams.push(filters.to);cardClauses.push(`cb.created_at < (${cardParams.length}::date + interval '1 day')`)}
  if(filters.userId){cardParams.push(filters.userId);cardClauses.push(`b.created_by=${cardParams.length}::uuid`)}
  const cards=await db.query(`
    select distinct u.email::text user_email,vc.id card_id,vc.provider,vc.masked_number,vc.status,vc.balance_minor,
      vc.merchant_control,vc.created_at,cb.id checkout_basket_id,cb.retailer,cb.retailer_order_id
    from checkout_baskets cb
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    join virtual_cards vc on vc.id=cb.virtual_card_id
    where ${cardClauses.join(" and ")}
    order by u.email,vc.created_at desc
  `,cardParams);

  const invoiceParams:any[]=[tenantId],invoiceClauses=["gi.tenant_id=$1"];
  if(filters.from){invoiceParams.push(filters.from);invoiceClauses.push(`gi.created_at >= ${invoiceParams.length}::date`)}
  if(filters.to){invoiceParams.push(filters.to);invoiceClauses.push(`gi.created_at < (${invoiceParams.length}::date + interval '1 day')`)}
  if(filters.userId){invoiceParams.push(filters.userId);invoiceClauses.push(`b.created_by=${invoiceParams.length}::uuid`)}
  const invoices=await db.query(`
    select u.email::text user_email,gi.id invoice_id,gi.invoice_number,gi.invoice_date,gi.status,gi.total_minor,
      gi.taxable_minor,gi.cgst_minor,gi.sgst_minor,gi.igst_minor,gi.cess_minor,gi.irn,
      cb.retailer,cb.retailer_order_id,c.external_reference customer_reference
    from gst_invoices gi
    join checkout_baskets cb on cb.id=gi.checkout_basket_id
    join order_batches b on b.id=cb.batch_id
    join users u on u.id=b.created_by
    left join customers c on c.id=cb.customer_id
    where ${invoiceClauses.join(" and ")}
    order by u.email,gi.created_at desc
  `,invoiceParams);

  return {orders:orders.rows,refunds:refunds.rows,rewards:rewards.rows,cards:cards.rows,invoices:invoices.rows};
}

export async function buildUserDashboardWorkbook(db:Db,tenantId:string,filters:UserDashboardFilters={}){
  const dashboard=await getUserDashboard(db,tenantId,filters);
  const detail=await reportDetails(db,tenantId,filters);
  const wb=new ExcelJS.Workbook();wb.creator="OrderGrid";wb.created=new Date();

  const summary=wb.addWorksheet("User Summary",{views:[{state:"frozen",ySplit:1}]});
  summary.columns=[
    {header:"User",key:"email",width:34},{header:"Role",key:"role",width:14},{header:"Batches",key:"batches",width:10},
    {header:"Orders",key:"orders",width:10},{header:"Confirmed",key:"confirmed",width:12},{header:"Attention",key:"attention",width:12},
    {header:"Cancelled/Refunded",key:"cancelled",width:18},{header:"Order Value",key:"value",width:16},{header:"Confirmed Value",key:"confirmedValue",width:18},
    {header:"Refunds",key:"refunds",width:10},{header:"Refund Total",key:"refundTotal",width:16},{header:"Settled Refund",key:"settledRefund",width:18},
    {header:"Pending Refund",key:"pendingRefund",width:18},{header:"Rewards",key:"rewards",width:12},{header:"Cards Used",key:"cardsUsed",width:12},
    {header:"GST Invoices",key:"gstInvoices",width:12},{header:"GST Invoice Value",key:"gstValue",width:18},{header:"Human Actions",key:"humanActions",width:14}
  ];
  summary.getRow(1).font={bold:true};summary.autoFilter={from:"A1",to:"R1"};
  for(const row of dashboard.users)summary.addRow({
    email:row.email,role:row.role,batches:Number(row.batches),orders:Number(row.orders),confirmed:Number(row.confirmed_orders),
    attention:Number(row.attention_orders),cancelled:Number(row.cancelled_refunded_orders),value:moneyMinor(row.order_value_minor)/100,
    confirmedValue:moneyMinor(row.confirmed_value_minor)/100,refunds:Number(row.refunds),refundTotal:moneyMinor(row.refund_minor)/100,
    settledRefund:moneyMinor(row.settled_refund_minor)/100,pendingRefund:moneyMinor(row.pending_refund_minor)/100,
    rewards:Number(row.reward_units),cardsUsed:Number(row.cards_used),gstInvoices:Number(row.gst_invoices),
    gstValue:moneyMinor(row.gst_invoice_minor)/100,humanActions:Number(row.human_actions)
  });
  for(const col of ["H","I","K","L","M","Q"])summary.getColumn(col).numFmt='₹#,##0.00';

  const orders=wb.addWorksheet("Orders",{views:[{state:"frozen",ySplit:1}]});
  orders.columns=[
    {header:"User",key:"user",width:32},{header:"Batch",key:"batch",width:24},{header:"Order ID",key:"orderId",width:38},
    {header:"Created",key:"created",width:20},{header:"Retailer",key:"retailer",width:14},{header:"Retailer Order",key:"retailerOrder",width:24},
    {header:"Status",key:"status",width:16},{header:"Amount",key:"amount",width:14},{header:"Customer",key:"customer",width:18},
    {header:"Recipient",key:"recipient",width:24},{header:"City",key:"city",width:18},{header:"PIN",key:"pin",width:10},
    {header:"Retailer Account",key:"retailerAccount",width:30},{header:"Virtual Card",key:"card",width:18},{header:"Refund",key:"refund",width:14},
    {header:"Refund Status",key:"refundStatus",width:16},{header:"Rewards",key:"rewards",width:12}
  ];
  orders.getRow(1).font={bold:true};orders.autoFilter={from:"A1",to:"Q1"};
  for(const row of detail.orders)orders.addRow({
    user:row.user_email,batch:row.batch_name,orderId:row.order_id,created:new Date(row.created_at),retailer:row.retailer,
    retailerOrder:row.retailer_order_id||"",status:row.status,amount:Number(row.amount_minor||0)/100,customer:row.customer_reference||"",
    recipient:row.recipient||"",city:row.city||"",pin:row.postal_code||"",retailerAccount:row.retailer_account_reference||"",
    card:row.virtual_card_masked||"",refund:Number(row.refund_minor||0)/100,refundStatus:row.refund_status||"",rewards:Number(row.reward_units||0)
  });
  orders.getColumn("D").numFmt="dd-mmm-yyyy hh:mm";for(const col of ["H","O"])orders.getColumn(col).numFmt='₹#,##0.00';

  const refunds=wb.addWorksheet("Refunds",{views:[{state:"frozen",ySplit:1}]});
  refunds.columns=[
    {header:"User",key:"user",width:32},{header:"Refund ID",key:"id",width:38},{header:"Requested",key:"requested",width:20},
    {header:"Retailer",key:"retailer",width:14},{header:"Retailer Order",key:"retailerOrder",width:24},{header:"Status",key:"status",width:16},
    {header:"Amount",key:"amount",width:14},{header:"Customer",key:"customer",width:18},{header:"Recipient",key:"recipient",width:24},
    {header:"Virtual Card",key:"card",width:18},{header:"Retailer Refund Ref",key:"retailerRef",width:24},{header:"Bank Ref",key:"bankRef",width:24},
    {header:"Initiated",key:"initiated",width:20},{header:"Settled",key:"settled",width:20}
  ];
  refunds.getRow(1).font={bold:true};refunds.autoFilter={from:"A1",to:"N1"};
  for(const row of detail.refunds)refunds.addRow({
    user:row.user_email,id:row.refund_id,requested:new Date(row.requested_at),retailer:row.retailer,retailerOrder:row.retailer_order_id||"",
    status:row.status,amount:Number(row.amount_minor||0)/100,customer:row.customer_reference||"",recipient:row.recipient||"",
    card:row.virtual_card_masked||"",retailerRef:row.retailer_refund_reference||"",bankRef:row.bank_reference||"",
    initiated:row.initiated_at?new Date(row.initiated_at):"",settled:row.settled_at?new Date(row.settled_at):""
  });
  for(const col of ["C","M","N"])refunds.getColumn(col).numFmt="dd-mmm-yyyy hh:mm";refunds.getColumn("G").numFmt='₹#,##0.00';

  const rewards=wb.addWorksheet("Rewards",{views:[{state:"frozen",ySplit:1}]});
  rewards.columns=[
    {header:"User",key:"user",width:32},{header:"Occurred",key:"occurred",width:20},{header:"Retailer",key:"retailer",width:14},
    {header:"Account",key:"account",width:30},{header:"Retailer Order",key:"retailerOrder",width:24},{header:"Reward Type",key:"type",width:16},
    {header:"Event",key:"event",width:14},{header:"Units",key:"units",width:12},{header:"Reference",key:"reference",width:24}
  ];
  rewards.getRow(1).font={bold:true};rewards.autoFilter={from:"A1",to:"I1"};
  for(const row of detail.rewards)rewards.addRow({
    user:row.user_email,occurred:new Date(row.occurred_at),retailer:row.retailer,account:row.retailer_account_reference,
    retailerOrder:row.retailer_order_id||"",type:row.reward_type,event:row.event_type,units:Number(row.units||0),reference:row.retailer_reference||""
  });
  rewards.getColumn("B").numFmt="dd-mmm-yyyy hh:mm";

  const cards=wb.addWorksheet("Cards Used",{views:[{state:"frozen",ySplit:1}]});
  cards.columns=[
    {header:"User",key:"user",width:32},{header:"Card ID",key:"id",width:38},{header:"Provider",key:"provider",width:14},
    {header:"Masked Card",key:"masked",width:18},{header:"Status",key:"status",width:14},{header:"Card Limit / Balance",key:"balance",width:18},
    {header:"Merchant Control",key:"merchant",width:22},{header:"Retailer",key:"retailer",width:14},{header:"Retailer Order",key:"retailerOrder",width:24},
    {header:"Created",key:"created",width:20}
  ];
  cards.getRow(1).font={bold:true};cards.autoFilter={from:"A1",to:"J1"};
  for(const row of detail.cards)cards.addRow({
    user:row.user_email,id:row.card_id,provider:row.provider,masked:row.masked_number||"",status:row.status,
    balance:Number(row.balance_minor||0)/100,merchant:row.merchant_control||"",retailer:row.retailer,
    retailerOrder:row.retailer_order_id||"",created:new Date(row.created_at)
  });
  cards.getColumn("F").numFmt='₹#,##0.00';cards.getColumn("J").numFmt="dd-mmm-yyyy hh:mm";

  const invoices=wb.addWorksheet("GST Invoices",{views:[{state:"frozen",ySplit:1}]});
  invoices.columns=[
    {header:"User",key:"user",width:32},{header:"Invoice",key:"invoice",width:24},{header:"Invoice Date",key:"date",width:16},
    {header:"Status",key:"status",width:14},{header:"Retailer",key:"retailer",width:14},{header:"Retailer Order",key:"retailerOrder",width:24},
    {header:"Customer",key:"customer",width:20},{header:"Taxable",key:"taxable",width:14},{header:"CGST",key:"cgst",width:12},
    {header:"SGST",key:"sgst",width:12},{header:"IGST",key:"igst",width:12},{header:"Cess",key:"cess",width:12},
    {header:"Total",key:"total",width:16},{header:"IRN",key:"irn",width:38}
  ];
  invoices.getRow(1).font={bold:true};invoices.autoFilter={from:"A1",to:"N1"};
  for(const row of detail.invoices)invoices.addRow({
    user:row.user_email,invoice:row.invoice_number,date:row.invoice_date,status:row.status,retailer:row.retailer,
    retailerOrder:row.retailer_order_id||"",customer:row.customer_reference||"",taxable:Number(row.taxable_minor||0)/100,
    cgst:Number(row.cgst_minor||0)/100,sgst:Number(row.sgst_minor||0)/100,igst:Number(row.igst_minor||0)/100,
    cess:Number(row.cess_minor||0)/100,total:Number(row.total_minor||0)/100,irn:row.irn||""
  });
  for(const col of ["H","I","J","K","L","M"])invoices.getColumn(col).numFmt='₹#,##0.00';

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildUserDashboardCsv(db:Db,tenantId:string,filters:UserDashboardFilters={}){
  const detail=await reportDetails(db,tenantId,filters);
  const cell=(value:unknown)=>`"${String(value??"").replaceAll('"','""')}"`;
  const columns=["record_type","user","date","retailer","retailer_order_id","status","amount_minor","customer_reference","recipient","retailer_account","virtual_card","reward_units","reference"];
  const rows:string[]=[columns.join(",")];
  for(const row of detail.orders)rows.push([
    "ORDER",row.user_email,row.created_at,row.retailer,row.retailer_order_id||"",row.status,row.amount_minor||0,row.customer_reference||"",row.recipient||"",
    row.retailer_account_reference||"",row.virtual_card_masked||"",row.reward_units||0,row.order_id
  ].map(cell).join(","));
  for(const row of detail.refunds)rows.push([
    "REFUND",row.user_email,row.requested_at,row.retailer,row.retailer_order_id||"",row.status,row.amount_minor||0,row.customer_reference||"",row.recipient||"",
    "",row.virtual_card_masked||"",0,row.retailer_refund_reference||row.refund_id
  ].map(cell).join(","));
  for(const row of detail.rewards)rows.push([
    "REWARD",row.user_email,row.occurred_at,row.retailer,row.retailer_order_id||"",row.event_type,0,"","",row.retailer_account_reference||"","",row.units||0,row.retailer_reference||row.reward_event_id
  ].map(cell).join(","));
  for(const row of detail.cards)rows.push([
    "CARD",row.user_email,row.created_at,row.retailer,row.retailer_order_id||"",row.status,row.balance_minor||0,"","","",row.masked_number||"",0,row.card_id
  ].map(cell).join(","));
  for(const row of detail.invoices)rows.push([
    "GST_INVOICE",row.user_email,row.invoice_date,row.retailer,row.retailer_order_id||"",row.status,row.total_minor||0,row.customer_reference||"","","","",0,row.invoice_number
  ].map(cell).join(","));
  return rows.join("\n");
}
