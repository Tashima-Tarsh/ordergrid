(()=>{
  const $=s=>document.querySelector(s);
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  let invoices=[],baskets=[],profile=null,loading=false;

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function showTab(name){
    document.querySelectorAll('[data-gst-tab]').forEach(button=>button.classList.toggle('active',button.dataset.gstTab===name));
    document.querySelectorAll('[data-gst-panel]').forEach(panel=>{
      const active=panel.dataset.gstPanel===name;
      panel.classList.toggle('active',active);
      panel.hidden=!active;
    });
  }

  function humanError(error){
    const value=String(error?.message||error||'Unable to complete GST action');
    const map={
      'gst profile required':'Save the GST profile before creating invoices.',
      'confirmed order required':'Only retailer-confirmed orders can be invoiced.',
      'buyer state code required':'The buyer/delivery record needs a valid GST state code.',
      'gst classification required':'HSN/SAC and GST rate are required on every product line.',
      'invoice lines required':'No invoiceable order lines were found.'
    };
    return map[value.toLowerCase()]||value;
  }

  function fillProfile(value){
    profile=value||null;
    const form=$('#gstProfileForm');
    if(form&&profile){
      for(const [name,field] of Object.entries({
        legalName:'legal_name',tradeName:'trade_name',gstin:'gstin',addressLine1:'address_line1',addressLine2:'address_line2',
        city:'city',state:'state',stateCode:'state_code',postalCode:'postal_code',invoicePrefix:'invoice_prefix',signatoryName:'signatory_name'
      })){
        const input=form.elements.namedItem(name);if(input)input.value=profile[field]??'';
      }
      form.elements.namedItem('eInvoiceApplicable').checked=Boolean(profile.e_invoice_applicable);
      $('#gstProfileMessage').textContent='GST profile saved and active.';
    }
  }

  function statusClass(status){
    const value=String(status||'').toUpperCase();
    return value==='READY'?'ready':value==='IRN_REQUIRED'?'attention':'neutral';
  }

  function invoiceRow(inv,compact=false){
    return '<div class="gst-invoice-row '+(compact?'compact ':'')+statusClass(inv.status)+'" data-invoice="'+esc(inv.id)+'">'+
      '<div class="gst-invoice-identity"><span class="gst-invoice-icon">▣</span><div><strong>'+esc(inv.invoice_number)+'</strong><small>'+esc(inv.invoice_date)+' · '+money(inv.total_minor)+'</small></div></div>'+
      '<span class="gst-invoice-status '+statusClass(inv.status)+'">'+esc(String(inv.status||'DRAFT').replaceAll('_',' '))+'</span>'+
      (!compact?'<div class="gst-invoice-actions"><button type="button" class="secondary" data-print>Print / PDF</button>'+(inv.status==='IRN_REQUIRED'?'<button type="button" data-irn>Attach IRN</button>':'')+'</div>':'')+
    '</div>';
  }

  function render(){
    const confirmed=baskets.filter(x=>x.status==='CONFIRMED');
    const ready=invoices.filter(x=>x.status==='READY').length;
    const irn=invoices.filter(x=>x.status==='IRN_REQUIRED').length;
    const total=invoices.reduce((sum,x)=>sum+Number(x.total_minor||0),0);

    const select=$('#gstBasket');
    if(select){
      const previous=select.value;
      select.innerHTML=confirmed.length
        ?'<option value="">Select confirmed order</option>'+confirmed.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.customer_reference||x.recipient||'Customer')+' · '+esc(x.retailer)+' · '+money(x.amount_minor)+'</option>').join('')
        :'<option value="">No confirmed orders available</option>';
      if(previous&&confirmed.some(x=>x.id===previous))select.value=previous;
    }

    if($('#invoiceCount'))$('#invoiceCount').textContent=String(invoices.length);
    if($('#gstInvoiceTotal'))$('#gstInvoiceTotal').textContent=String(invoices.length);
    if($('#gstReadyCount'))$('#gstReadyCount').textContent=String(ready);
    if($('#gstIrnCount'))$('#gstIrnCount').textContent=String(irn);
    if($('#gstConfirmedCount'))$('#gstConfirmedCount').textContent=String(confirmed.length);
    if($('#gstInvoiceValue'))$('#gstInvoiceValue').textContent=money(total);

    if($('#gstProfileState'))$('#gstProfileState').textContent=profile?'ACTIVE':'SETUP';
    if($('#gstProfileMeta'))$('#gstProfileMeta').textContent=profile?(profile.gstin+' · '+profile.state):'Configure business GSTIN';
    if($('#gstSupplierReady'))$('#gstSupplierReady').textContent=profile?(profile.legal_name+' · '+profile.gstin):'Configure GST profile';

    const badge=$('#gstEinvoiceBadge');
    if(badge){
      badge.className='gst-status-chip '+(profile?(profile.e_invoice_applicable?'attention':'ready'):'neutral');
      badge.textContent=!profile?'PROFILE REQUIRED':profile.e_invoice_applicable?'IRN REQUIRED':'STANDARD GST';
    }
    if($('#gstEinvoiceMeta'))$('#gstEinvoiceMeta').textContent=!profile
      ?'Complete the GST profile before billing.'
      :profile.e_invoice_applicable
        ?'Invoices stay IRN REQUIRED until the authorised IRP result is attached.'
        :'Invoices can become ready without an IRN step for this profile setting.';

    const recent=$('#gstRecentInvoices');
    if(recent)recent.innerHTML=invoices.length?invoices.slice(0,5).map(inv=>invoiceRow(inv,true)).join(''):'<div class="gst-empty"><strong>No invoices yet</strong><span>Create the first invoice from a confirmed order.</span></div>';

    const list=$('#gstInvoiceList');
    if(list)list.innerHTML=invoices.length?invoices.map(inv=>invoiceRow(inv,false)).join(''):'<div class="gst-empty"><strong>No GST invoices created yet</strong><span>Confirmed orders will become available in Billing.</span></div>';

    const message=$('#gstBillingMessage');
    if(message&&!message.dataset.manual){
      message.textContent=!profile?'Complete GST profile first, then create invoices from confirmed orders.':
        confirmed.length?confirmed.length+' confirmed order'+(confirmed.length===1?' is':'s are')+' ready for billing.':'No confirmed orders are waiting for billing.';
    }
  }

  async function load({quiet=false}={}){
    if(loading)return;
    loading=true;
    const refresh=$('#refreshGst');
    if(refresh){refresh.disabled=true;refresh.classList.add('is-refreshing')}
    try{
      const [profileData,invoiceData,basketData]=await Promise.all([
        request('/api/gst/profile'),request('/api/gst/invoices'),request('/api/bulk-baskets')
      ]);
      fillProfile(profileData.profile);
      invoices=invoiceData.invoices||[];
      baskets=basketData.baskets||[];
      render();
      if(!quiet)window.toast?.('GST workspace refreshed');
    }catch(error){
      const message=$('#gstBillingMessage');if(message){message.dataset.manual='1';message.textContent=humanError(error)}
    }finally{
      loading=false;
      if(refresh){refresh.disabled=false;refresh.classList.remove('is-refreshing')}
    }
  }

  document.querySelectorAll('[data-gst-tab]').forEach(button=>button.addEventListener('click',()=>showTab(button.dataset.gstTab)));
  document.querySelectorAll('[data-gst-open-tab]').forEach(button=>button.addEventListener('click',()=>showTab(button.dataset.gstOpenTab)));

  $('#gstNewInvoice')?.addEventListener('click',()=>{
    showTab('billing');
    setTimeout(()=>$('#gstBasket')?.focus(),0);
  });
  $('#refreshGst')?.addEventListener('click',()=>load());
  $('#downloadGstReport')?.addEventListener('click',()=>window.location.assign('/api/reports/gst.xlsx'));

  $('#gstBasket')?.addEventListener('change',()=>{
    const message=$('#gstBillingMessage');if(!message)return;
    delete message.dataset.manual;
    const basket=baskets.find(x=>x.id===$('#gstBasket').value);
    message.textContent=basket?'Ready to create invoice for '+(basket.customer_reference||basket.recipient||'selected order')+' · '+money(basket.amount_minor):'Choose a confirmed order to generate its invoice.';
  });

  $('#gstProfileForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form),button=form.querySelector('button[type="submit"]');
    button.disabled=true;$('#gstProfileMessage').textContent='Saving GST profile…';
    try{
      const result=await request('/api/gst/profile',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
        legalName:String(data.get('legalName')),tradeName:String(data.get('tradeName')||'')||null,gstin:String(data.get('gstin')).trim().toUpperCase(),
        addressLine1:String(data.get('addressLine1')),addressLine2:String(data.get('addressLine2')||'')||null,city:String(data.get('city')),state:String(data.get('state')),
        stateCode:String(data.get('stateCode')).replace(/\D/g,'').padStart(2,'0').slice(-2),postalCode:String(data.get('postalCode')).replace(/\D/g,''),
        invoicePrefix:String(data.get('invoicePrefix')).trim().toUpperCase(),eInvoiceApplicable:Boolean(data.get('eInvoiceApplicable')),
        signatoryName:String(data.get('signatoryName')||'')||null
      })});
      fillProfile(result.profile);render();window.toast?.('GST profile saved');
    }catch(error){$('#gstProfileMessage').textContent=humanError(error)}
    finally{button.disabled=false}
  });

  $('#createGstInvoice')?.addEventListener('click',async()=>{
    const basketId=$('#gstBasket')?.value;
    const message=$('#gstBillingMessage');
    if(!basketId){if(message){message.dataset.manual='1';message.textContent='Select a confirmed order first.'}return}
    const button=$('#createGstInvoice');button.disabled=true;button.textContent='Creating invoice…';
    if(message){message.dataset.manual='1';message.textContent='Calculating tax and generating invoice…'}
    try{
      const invoice=await request('/api/gst/invoices',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({basketId})});
      if(!invoices.some(x=>x.id===invoice.id))invoices.unshift(invoice);
      render();
      if(message){message.dataset.manual='1';message.textContent=invoice.status==='IRN_REQUIRED'?'Invoice created. Attach IRN/QR before issue.':'Invoice created and ready.'}
      showTab('invoices');
      window.toast?.(invoice.status==='IRN_REQUIRED'?'GST invoice created · IRN required':'GST invoice ready');
    }catch(error){
      if(message){message.dataset.manual='1';message.textContent=humanError(error)}
      if(String(error.message).toLowerCase().includes('gst profile'))showTab('profile');
    }finally{button.disabled=false;button.textContent='Create GST invoice →'}
  });

  function openIrn(id){
    const dialog=$('#gstIrnDialog'),form=$('#gstIrnForm');if(!dialog||!form)return;
    form.reset();form.elements.invoiceId.value=id;$('#gstIrnError').textContent='';dialog.showModal();
  }
  function closeIrn(){$('#gstIrnDialog')?.close()}

  $('#gstCompliance')?.addEventListener('click',event=>{
    const row=event.target.closest('[data-invoice]');if(!row)return;
    const id=row.dataset.invoice;
    if(event.target.closest('[data-print]')){window.open('/api/gst/invoices/'+encodeURIComponent(id)+'/print','_blank','noopener');return}
    if(event.target.closest('[data-irn]'))openIrn(id);
  });
  $('#closeGstIrn')?.addEventListener('click',closeIrn);
  $('#cancelGstIrn')?.addEventListener('click',closeIrn);
  $('#gstIrnDialog')?.addEventListener('click',event=>{if(event.target===$('#gstIrnDialog'))closeIrn()});

  $('#gstIrnForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,data=new FormData(form),button=form.querySelector('button[type="submit"]');
    button.disabled=true;$('#gstIrnError').textContent='';
    try{
      await request('/api/gst/invoices/'+encodeURIComponent(String(data.get('invoiceId')))+'/irn',{
        method:'PATCH',headers:{'content-type':'application/json'},
        body:JSON.stringify({irn:String(data.get('irn')).trim(),signedQr:String(data.get('signedQr')).trim()})
      });
      closeIrn();await load({quiet:true});showTab('invoices');window.toast?.('IRN attached · invoice ready');
    }catch(error){$('#gstIrnError').textContent=humanError(error)}
    finally{button.disabled=false}
  });

  window.addEventListener('ordergrid:update',()=>load({quiet:true}));
  window.addEventListener('ordergrid:gst-open',()=>load({quiet:true}));
  showTab('billing');
  load({quiet:true});
})();