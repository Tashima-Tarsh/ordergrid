import ExcelJS from "exceljs";
import type { Db } from "./db.js";
import { calculateGstInvoice, financialYearForDate, stateCodeForName, type GstLineInput } from "./gst.js";

type Filters={from?:string;to?:string;userId?:string};

function money(n:number){return (n/100).toFixed(2)}
function esc(v:unknown){return String(v??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]!))}
function descriptionFor(row:any){
  if(row.title)return String(row.title);
  try{return new URL(String(row.product_url)).hostname+" purchase"}catch{return "Procurement item"}
}

export async function createGstInvoice(db:Db,tenantId:string,userId:string,basketId:string,invoiceDate=new Date()){
  const existing=await db.query("select * from gst_invoices where tenant_id=$1 and checkout_basket_id=$2 limit 1",[tenantId,basketId]);
  if(existing.rows[0])return existing.rows[0];

  const profile=await db.query("select * from gst_profiles where tenant_id=$1",[tenantId]);
  if(!profile.rows[0])throw new Error("gst_profile_required");
  const supplier=profile.rows[0];

  const basket=await db.query(`
    select cb.id,cb.customer_id,cb.status,cb.retailer,cb.retailer_order_id,
      c.external_reference,c.display_name,c.legal_name,c.gstin,c.state_code,
      a.recipient,a.line1,a.line2,a.city,a.state,a.postal_code,a.country
    from checkout_baskets cb
    join addresses a on a.id=cb.address_id
    join customers c on c.id=cb.customer_id
    where cb.id=$1 and cb.tenant_id=$2
    limit 1
  `,[basketId,tenantId]);
  const buyer=basket.rows[0];
  if(!buyer)throw new Error("basket_not_found");
  if(buyer.status!=="CONFIRMED")throw new Error("confirmed_order_required");

  const buyerStateCode=String(buyer.state_code||stateCodeForName(buyer.state)||"");
  if(!/^\d{2}$/.test(buyerStateCode))throw new Error("buyer_state_code_required");

  const rows=await db.query(`
    select po.id,po.amount_minor,bi.title,bi.product_url,bi.requested_quantity,
      bi.hsn_sac,bi.gst_rate,bi.cess_rate,bi.price_includes_gst
    from purchase_orders po
    join batch_items bi on bi.id=po.batch_item_id
    where po.checkout_basket_id=$1 and po.tenant_id=$2
    order by po.created_at
  `,[basketId,tenantId]);
  if(!rows.rows.length)throw new Error("invoice_lines_required");

  const lineInputs:GstLineInput[]=rows.rows.map((row:any)=>{
    if(row.gst_rate===null||row.gst_rate===undefined||!row.hsn_sac)throw new Error("gst_classification_required");
    return {
      description:descriptionFor(row),
      hsnSac:String(row.hsn_sac),
      quantity:Number(row.requested_quantity||1),
      amountMinor:Number(row.amount_minor||0),
      gstRate:Number(row.gst_rate),
      cessRate:Number(row.cess_rate||0),
      priceIncludesGst:Boolean(row.price_includes_gst)
    };
  });
  const totals=calculateGstInvoice(lineInputs,String(supplier.state_code),buyerStateCode);
  const financialYear=financialYearForDate(invoiceDate);
  const client=await db.connect();
  try{
    await client.query("begin");
    await client.query(
      "insert into gst_invoice_counters(tenant_id,financial_year,next_number) values($1,$2,1) on conflict do nothing",
      [tenantId,financialYear]
    );
    const counter=await client.query(
      "select next_number from gst_invoice_counters where tenant_id=$1 and financial_year=$2 for update",
      [tenantId,financialYear]
    );
    const seq=Number(counter.rows[0]?.next_number||1);
    await client.query(
      "update gst_invoice_counters set next_number=next_number+1 where tenant_id=$1 and financial_year=$2",
      [tenantId,financialYear]
    );
    const prefix=String(supplier.invoice_prefix||"OG").replace(/[^A-Z0-9_-]/gi,"").slice(0,12)||"OG";
    const invoiceNumber=`${prefix}/${financialYear}/${String(seq).padStart(6,"0")}`;
    const supplierSnapshot={
      legalName:supplier.legal_name,tradeName:supplier.trade_name,gstin:supplier.gstin,
      addressLine1:supplier.address_line1,addressLine2:supplier.address_line2,city:supplier.city,
      state:supplier.state,stateCode:supplier.state_code,postalCode:supplier.postal_code,
      signatoryName:supplier.signatory_name,eInvoiceApplicable:Boolean(supplier.e_invoice_applicable)
    };
    const buyerSnapshot={
      legalName:buyer.legal_name||buyer.display_name||buyer.recipient,
      gstin:buyer.gstin||null,
      externalReference:buyer.external_reference,
      addressLine1:buyer.line1,addressLine2:buyer.line2,city:buyer.city,state:buyer.state,
      stateCode:buyerStateCode,postalCode:buyer.postal_code,country:buyer.country||"IN"
    };
    const status=supplier.e_invoice_applicable?"IRN_REQUIRED":"READY";
    const inserted=await client.query(
      `insert into gst_invoices(
        tenant_id,checkout_basket_id,customer_id,invoice_number,invoice_date,financial_year,status,
        supplier_snapshot,buyer_snapshot,line_snapshot,taxable_minor,cgst_minor,sgst_minor,igst_minor,cess_minor,total_minor,
        place_of_supply_state_code,reverse_charge,created_by
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,false,$18)
      returning *`,
      [
        tenantId,basketId,buyer.customer_id,invoiceNumber,invoiceDate.toISOString().slice(0,10),financialYear,status,
        supplierSnapshot,buyerSnapshot,totals.lines,totals.taxableMinor,totals.cgstMinor,totals.sgstMinor,
        totals.igstMinor,totals.cessMinor,totals.totalMinor,buyerStateCode,userId
      ]
    );
    await client.query("commit");
    return inserted.rows[0];
  }catch(error){
    await client.query("rollback");
    throw error;
  }finally{client.release()}
}

export async function buildGstWorkbook(db:Db,tenantId:string,filters:Filters={}){
  const profile=await db.query("select * from gst_profiles where tenant_id=$1",[tenantId]);
  if(!profile.rows[0])throw new Error("gst_profile_required");
  const supplier=profile.rows[0];
  const params:any[]=[tenantId];
  const clauses=["po.tenant_id=$1"];
  if(filters.from){params.push(filters.from);clauses.push(`po.created_at >= $${params.length}::date`)}
  if(filters.to){params.push(filters.to);clauses.push(`po.created_at < ($${params.length}::date + interval '1 day')`)}
  if(filters.userId){params.push(filters.userId);clauses.push(`b.created_by=$${params.length}::uuid`)}
  const result=await db.query(`
    select po.id order_id,po.retailer,po.retailer_order_id,po.status,po.amount_minor,po.created_at,
      bi.title,bi.product_url,bi.requested_quantity,bi.hsn_sac,bi.gst_rate,bi.cess_rate,bi.price_includes_gst,
      u.id user_id,u.email::text user_email,c.external_reference customer_reference,c.display_name,c.legal_name,c.gstin,c.state_code,
      a.recipient,a.state,a.postal_code
    from purchase_orders po
    join batch_items bi on bi.id=po.batch_item_id
    join order_batches b on b.id=bi.batch_id
    join users u on u.id=b.created_by
    left join addresses a on a.id=bi.address_id
    left join customers c on c.id=a.customer_id
    where ${clauses.join(" and ")}
    order by u.email,po.created_at,po.id
  `,params);

  const rows=result.rows.map((row:any)=>{
    const buyerStateCode=String(row.state_code||stateCodeForName(row.state)||"");
    let calc:any=null,error="";
    try{
      if(row.gst_rate===null||row.gst_rate===undefined||!row.hsn_sac)throw new Error("GST classification required");
      if(!/^\d{2}$/.test(buyerStateCode))throw new Error("Buyer state code required");
      calc=calculateGstInvoice([{
        description:descriptionFor(row),hsnSac:String(row.hsn_sac),quantity:Number(row.requested_quantity||1),
        amountMinor:Number(row.amount_minor||0),gstRate:Number(row.gst_rate),cessRate:Number(row.cess_rate||0),
        priceIncludesGst:Boolean(row.price_includes_gst)
      }],String(supplier.state_code),buyerStateCode);
    }catch(e:any){error=String(e.message||e)}
    return {row,buyerStateCode,calc,error};
  });

  const workbook=new ExcelJS.Workbook();
  workbook.creator="OrderGrid";
  workbook.created=new Date();
  const summary=workbook.addWorksheet("User Summary",{views:[{state:"frozen",ySplit:1}]});
  summary.columns=[
    {header:"User",key:"user",width:34},{header:"Orders",key:"orders",width:12},{header:"Taxable Value",key:"taxable",width:18},
    {header:"CGST",key:"cgst",width:14},{header:"SGST",key:"sgst",width:14},{header:"IGST",key:"igst",width:14},
    {header:"Cess",key:"cess",width:14},{header:"Invoice Total",key:"total",width:18},{header:"Rows Needing GST Data",key:"errors",width:24}
  ];
  summary.getRow(1).font={bold:true};
  summary.autoFilter={from:"A1",to:"I1"};
  const grouped=new Map<string,any>();
  for(const x of rows){
    const key=String(x.row.user_email);
    const g=grouped.get(key)||{user:key,orders:new Set<string>(),taxable:0,cgst:0,sgst:0,igst:0,cess:0,total:0,errors:0};
    g.orders.add(String(x.row.order_id));
    if(x.calc){
      g.taxable+=x.calc.taxableMinor;g.cgst+=x.calc.cgstMinor;g.sgst+=x.calc.sgstMinor;g.igst+=x.calc.igstMinor;g.cess+=x.calc.cessMinor;g.total+=x.calc.totalMinor;
    }else g.errors++;
    grouped.set(key,g);
  }
  for(const g of grouped.values())summary.addRow({user:g.user,orders:g.orders.size,taxable:Number(money(g.taxable)),cgst:Number(money(g.cgst)),sgst:Number(money(g.sgst)),igst:Number(money(g.igst)),cess:Number(money(g.cess)),total:Number(money(g.total)),errors:g.errors});
  for(const col of ["C","D","E","F","G","H"])summary.getColumn(col).numFmt='₹#,##0.00';

  const detail=workbook.addWorksheet("GST Detail",{views:[{state:"frozen",ySplit:1}]});
  detail.columns=[
    {header:"User",key:"user",width:30},{header:"Order ID",key:"orderId",width:38},{header:"Retailer Order",key:"retailerOrder",width:24},
    {header:"Date",key:"date",width:20},{header:"Customer Ref",key:"customerRef",width:20},{header:"Buyer GSTIN",key:"buyerGstin",width:18},
    {header:"Place of Supply",key:"pos",width:16},{header:"HSN/SAC",key:"hsn",width:14},{header:"Description",key:"description",width:42},
    {header:"Qty",key:"qty",width:10},{header:"GST %",key:"gstRate",width:10},{header:"Cess %",key:"cessRate",width:10},
    {header:"Taxable",key:"taxable",width:16},{header:"CGST",key:"cgst",width:14},{header:"SGST",key:"sgst",width:14},
    {header:"IGST",key:"igst",width:14},{header:"Cess",key:"cess",width:14},{header:"Total",key:"total",width:16},{header:"Validation",key:"validation",width:30}
  ];
  detail.getRow(1).font={bold:true};detail.autoFilter={from:"A1",to:"S1"};
  for(const x of rows){
    const line=x.calc?.lines?.[0];
    detail.addRow({
      user:x.row.user_email,orderId:x.row.order_id,retailerOrder:x.row.retailer_order_id||"",date:new Date(x.row.created_at),
      customerRef:x.row.customer_reference||"",buyerGstin:x.row.gstin||"",pos:x.buyerStateCode,hsn:x.row.hsn_sac||"",
      description:descriptionFor(x.row),qty:Number(x.row.requested_quantity||1),gstRate:x.row.gst_rate===null?"":Number(x.row.gst_rate),
      cessRate:Number(x.row.cess_rate||0),taxable:line?Number(money(line.taxableMinor)):"",cgst:line?Number(money(line.cgstMinor)):"",
      sgst:line?Number(money(line.sgstMinor)):"",igst:line?Number(money(line.igstMinor)):"",cess:line?Number(money(line.cessMinor)):"",
      total:line?Number(money(line.totalMinor)):Number(money(Number(x.row.amount_minor||0))),validation:x.error||"OK"
    });
  }
  detail.getColumn("D").numFmt="dd-mmm-yyyy hh:mm";
  for(const col of ["M","N","O","P","Q","R"])detail.getColumn(col).numFmt='₹#,##0.00';

  const meta=workbook.addWorksheet("GST Profile");
  meta.addRows([
    ["Field","Value"],["Supplier legal name",supplier.legal_name],["GSTIN",supplier.gstin],["State",supplier.state],
    ["State code",supplier.state_code],["Invoice prefix",supplier.invoice_prefix],["e-Invoice applicable",supplier.e_invoice_applicable?"YES":"NO"],
    ["Note","Rows marked with validation errors are excluded from GST totals until HSN/SAC, GST rate and state code are supplied."]
  ]);
  meta.getRow(1).font={bold:true};meta.getColumn(1).width=26;meta.getColumn(2).width=70;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function renderGstInvoiceHtml(invoice:any){
  const supplier=invoice.supplier_snapshot||{},buyer=invoice.buyer_snapshot||{},lines=invoice.line_snapshot||[];
  const draft=invoice.status==="IRN_REQUIRED"&&!invoice.irn;
  const rows=lines.map((line:any,i:number)=>`<tr><td>${i+1}</td><td>${esc(line.description)}</td><td>${esc(line.hsnSac)}</td><td>${line.quantity}</td><td>₹${money(line.taxableMinor)}</td><td>${line.gstRate}%</td><td>₹${money(line.cgstMinor)}</td><td>₹${money(line.sgstMinor)}</td><td>₹${money(line.igstMinor)}</td><td>₹${money(line.cessMinor)}</td><td>₹${money(line.totalMinor)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(invoice.invoice_number)} · GST Tax Invoice</title><style>
  body{font-family:Arial,sans-serif;color:#111;margin:32px}h1{margin:0;font-size:24px}.top,.parties,.totals{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:18px 0}.box{border:1px solid #aaa;padding:14px;border-radius:6px}.label{font-size:11px;color:#555;text-transform:uppercase}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #aaa;padding:7px;text-align:right}th:nth-child(2),td:nth-child(2),th:nth-child(3),td:nth-child(3){text-align:left}.draft{padding:10px;background:#fff3cd;border:1px solid #e5c35b;margin:16px 0;font-weight:700}.sign{margin-top:55px;text-align:right}@media print{body{margin:10mm}.no-print{display:none}}</style></head><body>
  ${draft?'<div class="draft">DRAFT — e-Invoice IRN / signed QR required before issue.</div>':""}
  <div class="top"><div><h1>TAX INVOICE</h1><div class="label">Invoice number</div><strong>${esc(invoice.invoice_number)}</strong><div class="label">Date</div>${esc(invoice.invoice_date)}</div>
  <div><div class="label">Place of supply</div>State code ${esc(invoice.place_of_supply_state_code)}<div class="label">Reverse charge</div>${invoice.reverse_charge?"Yes":"No"}${invoice.irn?`<div class="label">IRN</div>${esc(invoice.irn)}`:""}</div></div>
  <div class="parties"><div class="box"><div class="label">Supplier</div><strong>${esc(supplier.legalName)}</strong><br>${esc(supplier.tradeName||"")}<br>${esc(supplier.addressLine1)} ${esc(supplier.addressLine2||"")}<br>${esc(supplier.city)}, ${esc(supplier.state)} - ${esc(supplier.postalCode)}<br><strong>GSTIN: ${esc(supplier.gstin)}</strong></div>
  <div class="box"><div class="label">Recipient / Bill to</div><strong>${esc(buyer.legalName)}</strong><br>${esc(buyer.addressLine1)} ${esc(buyer.addressLine2||"")}<br>${esc(buyer.city)}, ${esc(buyer.state)} - ${esc(buyer.postalCode)}<br><strong>GSTIN/UIN: ${esc(buyer.gstin||"Unregistered")}</strong></div></div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th>Qty</th><th>Taxable value</th><th>GST rate</th><th>CGST</th><th>SGST</th><th>IGST</th><th>Cess</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
  <div class="totals"><div></div><div class="box"><div>Taxable value: <strong>₹${money(Number(invoice.taxable_minor))}</strong></div><div>CGST: ₹${money(Number(invoice.cgst_minor))}</div><div>SGST: ₹${money(Number(invoice.sgst_minor))}</div><div>IGST: ₹${money(Number(invoice.igst_minor))}</div><div>Cess: ₹${money(Number(invoice.cess_minor))}</div><div>Invoice total: <strong>₹${money(Number(invoice.total_minor))}</strong></div></div></div>
  ${invoice.signed_qr?'<div class="box"><div class="label">IRP signed QR payload/reference</div>'+esc(invoice.signed_qr)+'</div>':""}
  <div class="sign">For ${esc(supplier.legalName)}<br><br><br><strong>${esc(supplier.signatoryName||"Authorized Signatory")}</strong></div>
  <button class="no-print" onclick="window.print()">Print / Save PDF</button></body></html>`;
}
