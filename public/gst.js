(()=>{
  const $=s=>document.querySelector(s);
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'}).format(Number(n||0)/100);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  let invoices=[],baskets=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function fillProfile(profile){
    const form=$('#gstProfileForm');if(!form||!profile)return;
    for(const [name,value] of Object.entries({
      legalName:profile.legal_name,tradeName:profile.trade_name,gstin:profile.gstin,addressLine1:profile.address_line1,addressLine2:profile.address_line2,
      city:profile.city,state:profile.state,stateCode:profile.state_code,postalCode:profile.postal_code,invoicePrefix:profile.invoice_prefix,
      signatoryName:profile.signatory_name
    })){
      const input=form.elements.namedItem(name);if(input)input.value=value??'';
    }
    form.elements.namedItem('eInvoiceApplicable').checked=Boolean(profile.e_invoice_applicable);
    $('#gstProfileMessage').textContent='GST profile saved for this dealer.';
  }

  function render(){
    const select=$('#gstBasket');
    if(select){
      const confirmed=baskets.filter(x=>x.status==='CONFIRMED');
      select.innerHTML=confirmed.length
        ?'<option value="">Select confirmed order</option>'+confirmed.map(x=>`<option value="${esc(x.id)}">${esc(x.customer_reference||x.recipient)} · ${esc(x.retailer)} · ${money(x.amount_minor)}</option>`).join('')
        :'<option value="">No confirmed baskets yet</option>';
    }
    $('#invoiceCount').textContent=String(invoices.length);
    const list=$('#gstInvoiceList');
    if(list)list.innerHTML=invoices.length?invoices.map(inv=>`
      <div class="gst-invoice-row" data-invoice="${esc(inv.id)}">
        <div><strong>${esc(inv.invoice_number)}</strong><small>${esc(inv.invoice_date)} · ${money(inv.total_minor)}</small></div>
        <span class="status-soft">${esc(inv.status)}</span>
        <button type="button" class="secondary" data-print>Print / PDF</button>
        ${inv.status==='IRN_REQUIRED'?'<button type="button" data-irn>Attach IRN</button>':''}
      </div>`).join(''):'<p class="muted">No GST invoices created yet.</p>';
  }

  async function load(){
    try{
      const [profile,invoiceData,basketData]=await Promise.all([
        request('/api/gst/profile'),request('/api/gst/invoices'),request('/api/bulk-baskets')
      ]);
      fillProfile(profile.profile);
      invoices=invoiceData.invoices||[];
      baskets=basketData.baskets||[];
      render();
    }catch(error){console.error(error)}
  }

  $('#gstProfileForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form),button=form.querySelector('button[type="submit"]');
    button.disabled=true;$('#gstProfileMessage').textContent='Saving…';
    try{
      const result=await request('/api/gst/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
        legalName:String(data.get('legalName')),tradeName:String(data.get('tradeName')||'')||null,gstin:String(data.get('gstin')).trim().toUpperCase(),
        addressLine1:String(data.get('addressLine1')),addressLine2:String(data.get('addressLine2')||'')||null,city:String(data.get('city')),state:String(data.get('state')),
        stateCode:String(data.get('stateCode')).replace(/\D/g,'').padStart(2,'0').slice(-2),postalCode:String(data.get('postalCode')).replace(/\D/g,''),
        invoicePrefix:String(data.get('invoicePrefix')).trim().toUpperCase(),eInvoiceApplicable:Boolean(data.get('eInvoiceApplicable')),
        signatoryName:String(data.get('signatoryName')||'')||null
      })});
      fillProfile(result.profile);window.toast?.('GST profile saved');
    }catch(error){$('#gstProfileMessage').textContent=error.message}
    finally{button.disabled=false}
  });

  $('#downloadGstReport')?.addEventListener('click',()=>{window.location.assign('/api/reports/gst.xlsx')});

  $('#createGstInvoice')?.addEventListener('click',async()=>{
    const basketId=$('#gstBasket')?.value;
    if(!basketId){alert('Select a confirmed order first.');return}
    const button=$('#createGstInvoice');button.disabled=true;button.textContent='Creating…';
    try{
      const invoice=await request('/api/gst/invoices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({basketId})});
      if(!invoices.some(x=>x.id===invoice.id))invoices.unshift(invoice);
      render();window.toast?.(invoice.status==='IRN_REQUIRED'?'Invoice draft created — attach IRN before issue':'GST invoice created');
    }catch(error){alert(error.message)}
    finally{button.disabled=false;button.textContent='Create invoice'}
  });

  $('#gstInvoiceList')?.addEventListener('click',async event=>{
    const row=event.target.closest('[data-invoice]');if(!row)return;
    const id=row.dataset.invoice;
    if(event.target.closest('[data-print]')){window.open(`/api/gst/invoices/${id}/print`,'_blank','noopener');return}
    if(event.target.closest('[data-irn]')){
      const irn=prompt('Enter IRP Invoice Reference Number (IRN):');if(!irn)return;
      const signedQr=prompt('Paste the IRP signed QR payload/reference:');if(!signedQr)return;
      try{
        await request(`/api/gst/invoices/${id}/irn`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({irn,signedQr})});
        await load();window.toast?.('IRN attached; invoice ready');
      }catch(error){alert(error.message)}
    }
  });

  window.addEventListener('ordergrid:update',()=>load());
  load();
})();