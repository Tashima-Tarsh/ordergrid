(()=>{
  const form=document.querySelector('#batchForm');
  if(!form)return;
  const labels=[...form.querySelector('.steps').children];
  const productRows=document.querySelector('#productRows');
  const addProduct=document.querySelector('#addProduct');
  const fileLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('input[type="file"]'));
  const paymentLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('select[name="paymentMode"]'));
  const nameLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('input[name="name"]'));
  const sample=document.querySelector('#sample');
  const preview=document.querySelector('#recipientPreview');
  const actions=form.querySelector('.modal-actions');
  const formError=document.querySelector('#formError');
  let flipkartAccounts=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  const rupeesFromMinor=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2}).format(Number(value||0)/100);

  const approval=document.createElement('section');
  approval.className='wizard-review';
  approval.innerHTML='<p class="eyebrow">BATCH APPROVAL</p><h3>Approve one bulk execution</h3><div id="wizardSummary"></div><label class="approval-check"><input id="wizardApproval" type="checkbox"><span>I confirm the products, recipients, quantities, payment route and estimated value.</span></label>';
  actions.before(approval);

  const checkout=document.createElement('section');
  checkout.className='wizard-review';
  checkout.innerHTML='<p class="eyebrow">READY TO EXECUTE</p><h3>OrderGrid bulk checkout</h3><p>Every Flipkart mobile must have a fresh authenticated product check before approval. OrderGrid uses the verified item price and account quantity ceiling.</p><div id="wizardFinal"></div>';
  actions.before(checkout);

  const nav=document.createElement('div');
  nav.className='wizard-nav';
  nav.innerHTML='<button type="button" class="secondary" id="wizardBack">Back</button><button type="button" id="wizardNext">Continue</button>';
  actions.before(nav);
  const back=nav.querySelector('#wizardBack'),next=nav.querySelector('#wizardNext');

  function productMarkup(){
    return '<div class="two"><label>Flipkart mobile URL<input name="url" type="url" required placeholder="https://www.flipkart.com/.../p/itm...?pid=MOB..."></label><label>Verified Flipkart price (₹)<input name="price" type="number" min="1" step="0.01" placeholder="Run product allocation" required readonly></label></div>'+
      '<div class="flipkart-pool-allocation"><div><strong>Multi-account allocation</strong><span>OrderGrid verifies each ready Flipkart user and stops when total verified capacity reaches your requested units.</span></div><button type="button" data-allocate-flipkart>Allocate across ready accounts</button><span class="allocation-state">NOT PLANNED</span><div class="allocation-result"><span>Example: 40 units with a verified limit of 2/account uses 20 accounts × 2 units.</span></div></div>'+
      '<div class="flipkart-product-check"><label>Single-account check<select name="retailerAccountId"><option value="">Loading accounts…</option></select></label><button type="button" class="secondary" data-check-flipkart>Check one account</button><span class="product-check-state">NOT CHECKED</span><input name="productCheckId" type="hidden"><div class="product-check-result"><span>Optional manual mode: choose one saved account and verify that account only.</span></div></div>'+
      '<div class="two" style="align-items:end"><label>Total units required<input name="quantity" type="number" min="1" max="5000" value="1" required><small class="verified-quantity-note">Pool allocation will split this total across verified account limits.</small></label><button type="button" class="secondary remove-product" data-remove-product style="align-self:end;margin-bottom:8px">Remove product</button></div>'+
      '<input name="hsnSac" type="hidden" value="8517"><input name="gstRate" type="hidden" value="18"><input name="cessRate" type="hidden" value="0"><input name="priceIncludesGst" type="hidden" value="true">';
  }
  function productEntry(){
    const node=document.createElement('div');
    node.className='product-entry';
    node.innerHTML=productMarkup();
    enhanceRow(node);
    return node;
  }
  function accountOptionHtml(){
    const ready=flipkartAccounts.filter(a=>a.active!==false&&a.session_status==='READY');
    if(!flipkartAccounts.length)return '<option value="">No Flipkart accounts connected</option>';
    if(!ready.length)return '<option value="">No session-ready Flipkart account</option>'+flipkartAccounts.map(a=>'<option value="'+esc(a.id)+'" disabled>'+esc(a.label||a.account_reference)+' · '+esc(a.session_status||a.auth_status||'NOT READY')+'</option>').join('');
    return ready.map((a,i)=>'<option value="'+esc(a.id)+'"'+(i===0?' selected':'')+'>'+esc(a.label||a.account_reference)+' · SESSION READY</option>').join('')+
      flipkartAccounts.filter(a=>!ready.includes(a)).map(a=>'<option value="'+esc(a.id)+'" disabled>'+esc(a.label||a.account_reference)+' · '+esc(a.session_status||a.auth_status||'NOT READY')+'</option>').join('');
  }
  function populateAccountSelect(row){
    const select=row.querySelector('[name="retailerAccountId"]');
    if(select)select.innerHTML=accountOptionHtml();
  }
  function invalidateRow(row,message='Run product allocation after changing the URL, quantity or account.'){
    row.dataset.productVerified='false';
    row.dataset.productTitle='';
    row.dataset.maxQuantity='';
    delete row.dataset.allocationPlan;
    const checkId=row.querySelector('[name="productCheckId"]');if(checkId)checkId.value='';
    const price=row.querySelector('[name="price"]');if(price)price.value='';
    const qty=row.querySelector('[name="quantity"]');if(qty){qty.max='5000';if(Number(qty.value)<1)qty.value='1'}
    const account=row.querySelector('[name="retailerAccountId"]');if(account)account.disabled=false;
    const state=row.querySelector('.product-check-state');if(state){state.textContent='NOT CHECKED';state.className='product-check-state'}
    const result=row.querySelector('.product-check-result');if(result)result.innerHTML='<span>'+esc(message)+'</span>';
    const allocationState=row.querySelector('.allocation-state');if(allocationState){allocationState.textContent='NOT PLANNED';allocationState.className='allocation-state'}
    const allocationResult=row.querySelector('.allocation-result');if(allocationResult)allocationResult.innerHTML='<span>Set total units, then let OrderGrid verify enough ready accounts to cover the quantity.</span>';
    const note=row.querySelector('.verified-quantity-note');if(note)note.textContent='Pool allocation will split this total across verified account limits.';
    if(preview?.dataset.poolGenerated==='true'){preview.textContent='';delete preview.dataset.poolGenerated}
  }
  function enhanceRow(row){
    if(!row.querySelector('.flipkart-product-check')){
      row.innerHTML=productMarkup();
    }
    const url=row.querySelector('[name="url"]');if(url)url.placeholder='https://www.flipkart.com/.../p/itm...?pid=MOB...';
    const price=row.querySelector('[name="price"]');if(price){price.readOnly=true;if(price.value==='1299')price.value=''}
    populateAccountSelect(row);
    if(!row.dataset.productVerified)invalidateRow(row,'Paste a Flipkart mobile link, choose the saved account, then run Check product.');
  }
  function normalizeRemoveButtons(){
    const rows=[...productRows.querySelectorAll('.product-entry')];
    rows.forEach(row=>{const remove=row.querySelector('[data-remove-product]');if(remove)remove.hidden=rows.length===1});
  }
  async function loadFlipkartAccounts(){
    try{
      const data=await request('/api/retailer-accounts?retailer=flipkart&limit=500');
      flipkartAccounts=data.accounts||[];
    }catch{flipkartAccounts=[]}
    for(const row of productRows.querySelectorAll('.product-entry'))populateAccountSelect(row);
  }
  async function pollProductCheck(commandId,timeoutMs=180000){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      const data=await request('/api/products/flipkart/mobile/check/'+encodeURIComponent(commandId));
      if(data.status==='COMPLETED'||data.status==='FAILED')return data;
      await new Promise(resolve=>setTimeout(resolve,850));
    }
    throw new Error('Flipkart product check timed out. Keep the native OrderGrid worker online and try again.');
  }
  function renderVerified(row,command){
    const r=command.result||{},state=row.querySelector('.product-check-state'),result=row.querySelector('.product-check-result');
    if(command.status==='FAILED')throw new Error(command.error||'Native product check failed');
    if(r.state!=='READY'){
      row.dataset.productVerified='false';
      if(state){state.textContent=String(r.state||'REVIEW REQUIRED').replaceAll('_',' ');state.className='product-check-state attention'}
      if(result)result.innerHTML='<strong>'+esc(r.message||'Flipkart verification is incomplete.')+'</strong>'+(r.title?'<span>'+esc(r.title)+'</span>':'');
      throw new Error(r.message||'Flipkart product check requires review');
    }
    const max=Number(r.maxQuantity||0),priceMinor=Number(r.sellingPriceMinor||0);
    if(!r.isMobile||!r.maxQuantityVerified||max<1||priceMinor<1)throw new Error('Flipkart did not return a complete mobile/price/quantity verification');
    row.dataset.productVerified='true';
    row.dataset.productTitle=String(r.title||'Flipkart mobile');
    row.dataset.maxQuantity=String(max);
    row.querySelector('[name="productCheckId"]').value=command.id;
    row.querySelector('[name="price"]').value=(priceMinor/100).toFixed(2);
    const qty=row.querySelector('[name="quantity"]');qty.max=String(max);if(Number(qty.value)>max||Number(qty.value)<1)qty.value=String(Math.min(max,1));
    const note=row.querySelector('.verified-quantity-note');if(note)note.textContent='Verified maximum for this saved Flipkart account: '+max;
    if(state){state.textContent='VERIFIED';state.className='product-check-state verified'}
    if(result)result.innerHTML=
      '<div><span>PRODUCT</span><strong>'+esc(r.title||'Flipkart mobile')+'</strong></div>'+
      '<div><span>CURRENT PRICE</span><strong>'+esc(rupeesFromMinor(priceMinor))+'</strong></div>'+
      '<div><span>SELLER</span><strong>'+esc(r.seller||'Shown by Flipkart')+'</strong></div>'+
      '<div><span>STOCK</span><strong>'+(r.available===false?'OUT OF STOCK':'AVAILABLE')+'</strong></div>'+
      '<div><span>MAX / ACCOUNT</span><strong>'+esc(max)+'</strong></div>'+
      '<div><span>CHECKED</span><strong>'+esc(new Date(r.checkedAt||Date.now()).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}))+'</strong></div>';
  }
  async function checkProduct(row,button){
    const url=String(row.querySelector('[name="url"]').value||'').trim(),accountId=String(row.querySelector('[name="retailerAccountId"]').value||'');
    if(!url)throw new Error('Paste the Flipkart mobile URL first.');
    if(!/^https:\/\/(?:www\.)?flipkart\.com\//i.test(url))throw new Error('This flow accepts Flipkart product URLs only.');
    if(!accountId)throw new Error('Select a session-ready Flipkart account.');
    invalidateRow(row,'Checking the live Flipkart page and account quantity limit…');
    const state=row.querySelector('.product-check-state');state.textContent='CHECKING';state.className='product-check-state checking';
    button.disabled=true;button.textContent='Checking Flipkart…';
    try{
      const started=await request('/api/products/flipkart/mobile/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productUrl:url,retailerAccountId:accountId})});
      const completed=await pollProductCheck(started.commandId);
      renderVerified(row,completed);
      if(window.toast)window.toast('Flipkart mobile verified');
    }finally{button.disabled=false;button.textContent='Check product'}
  }

  function parseAllocation(row){
    try{return row.dataset.allocationPlan?JSON.parse(row.dataset.allocationPlan):null}catch{return null}
  }
  function updatePoolPreview(){
    const rows=[...productRows.querySelectorAll('.product-entry')],plans=rows.map(parseAllocation);
    if(rows.length&&plans.every(plan=>plan?.complete)){
      const accountIds=new Set(plans.flatMap(plan=>plan.allocations.map(a=>a.retailerAccountId)));
      const units=plans.reduce((sum,plan)=>sum+Number(plan.totalQuantity||0),0);
      preview.textContent=accountIds.size+' Flipkart user/address profiles allocated · '+units+' total units';
      preview.dataset.poolGenerated='true';
    }
  }
  function renderAllocation(row,plan){
    const allocations=plan.allocations||[];
    if(!plan.complete||!allocations.length)throw new Error('Verified account capacity is insufficient for the requested total.');
    row.dataset.allocationPlan=JSON.stringify(plan);
    row.dataset.productVerified='true';
    row.dataset.productTitle=String(allocations[0].title||'Flipkart mobile');
    row.dataset.maxQuantity=String(plan.verifiedCapacity||plan.allocatedQuantity||0);
    const checkId=row.querySelector('[name="productCheckId"]');if(checkId)checkId.value=allocations[0].productCheckId||'';
    const price=row.querySelector('[name="price"]');
    if(price)price.value=(Number(allocations[0].sellingPriceMinor||0)/100).toFixed(2);
    const qty=row.querySelector('[name="quantity"]');if(qty){qty.max='5000';qty.value=String(plan.totalQuantity)}
    const account=row.querySelector('[name="retailerAccountId"]');if(account)account.disabled=true;
    const state=row.querySelector('.allocation-state');if(state){state.textContent='ALLOCATED';state.className='allocation-state verified'}
    const single=row.querySelector('.product-check-state');if(single){single.textContent='POOL MODE';single.className='product-check-state verified'}
    const note=row.querySelector('.verified-quantity-note');if(note)note.textContent=plan.totalQuantity+' total units allocated across '+allocations.length+' verified Flipkart accounts.';
    const priceText=plan.priceRangeMinor
      ?(plan.priceRangeMinor.min===plan.priceRangeMinor.max?rupeesFromMinor(plan.priceRangeMinor.min):rupeesFromMinor(plan.priceRangeMinor.min)+' – '+rupeesFromMinor(plan.priceRangeMinor.max))
      :rupeesFromMinor(allocations[0].sellingPriceMinor);
    const maxes=allocations.map(a=>Number(a.maxQuantity||0)).filter(Boolean);
    const result=row.querySelector('.allocation-result');
    if(result)result.innerHTML=
      '<div><span>TOTAL UNITS</span><strong>'+esc(plan.totalQuantity)+'</strong></div>'+
      '<div><span>ACCOUNTS USED</span><strong>'+esc(allocations.length)+'</strong></div>'+
      '<div><span>VERIFIED CAPACITY</span><strong>'+esc(plan.verifiedCapacity)+'</strong></div>'+
      '<div><span>PRICE</span><strong>'+esc(priceText)+'</strong></div>'+
      '<div><span>MAX / ACCOUNT</span><strong>'+esc(Math.min(...maxes))+(Math.min(...maxes)!==Math.max(...maxes)?'–'+esc(Math.max(...maxes)):'')+'</strong></div>'+
      '<div class="wide"><span>ALLOCATIONS</span><strong>'+allocations.map(a=>esc(a.accountReference)+' · '+esc(a.quantity)+' / '+esc(a.maxQuantity)+' · '+esc(a.postalCode||'')).join('<br>')+'</strong></div>';
    updatePoolPreview();
  }
  async function allocateAcrossPool(row,button){
    const url=String(row.querySelector('[name="url"]').value||'').trim();
    const totalQuantity=Number(row.querySelector('[name="quantity"]').value||0);
    if(!url)throw new Error('Paste the Flipkart mobile URL first.');
    if(!/^https:\/\/(?:www\.)?flipkart\.com\//i.test(url))throw new Error('This flow accepts Flipkart product URLs only.');
    if(!Number.isInteger(totalQuantity)||totalQuantity<1||totalQuantity>5000)throw new Error('Enter a total quantity from 1 to 5000.');
    invalidateRow(row,'Pool allocation is verifying live account limits…');
    const state=row.querySelector('.allocation-state'),result=row.querySelector('.allocation-result');
    button.disabled=true;button.textContent='Allocating…';
    try{
      for(let cycle=0;cycle<20;cycle++){
        const plan=await request('/api/products/flipkart/mobile/allocation/plan',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({productUrl:url,totalQuantity})
        });
        if(state){state.textContent=plan.verifiedCapacity+' / '+totalQuantity+' VERIFIED';state.className='allocation-state checking'}
        if(result)result.innerHTML='<span>'+esc(plan.verifiedAccounts)+' account(s) verified · '+esc(plan.checkingAccounts)+' checking · '+esc(plan.checkRequiredAccounts)+' still available to check.</span>';
        if(plan.complete){
          renderAllocation(row,plan);
          if(window.toast)window.toast(totalQuantity+' units allocated across '+plan.allocations.length+' Flipkart accounts');
          return;
        }
        let commandIds=(plan.checking||[]).slice(0,10).map(x=>x.commandId).filter(Boolean);
        if(!commandIds.length){
          const next=(plan.checkRequired||[]).slice(0,10);
          if(!next.length){
            const reason=plan.eligibleAccounts
              ?'Only '+plan.verifiedCapacity+' units could be verified across '+plan.eligibleAccounts+' eligible accounts.'
              :'No session-ready, worker-online Flipkart accounts with bound delivery addresses are available.';
            throw new Error(reason);
          }
          const started=await Promise.allSettled(next.map(account=>request('/api/products/flipkart/mobile/check',{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({productUrl:url,retailerAccountId:account.retailerAccountId})
          })));
          commandIds=started.filter(x=>x.status==='fulfilled').map(x=>x.value.commandId).filter(Boolean);
          if(!commandIds.length)throw new Error('OrderGrid could not start a product check on any eligible Flipkart account.');
        }
        if(state)state.textContent='VERIFYING '+commandIds.length+' ACCOUNT'+(commandIds.length===1?'':'S');
        await Promise.all(commandIds.map(id=>pollProductCheck(id).catch(()=>null)));
      }
      throw new Error('Allocation did not converge. Refresh account sessions and try again.');
    }finally{
      button.disabled=false;
      button.textContent='Allocate across ready accounts';
    }
  }

  addProduct.onclick=()=>{productRows.appendChild(productEntry());normalizeRemoveButtons()};
  productRows.addEventListener('click',async event=>{
    const remove=event.target.closest('[data-remove-product]');
    if(remove){remove.closest('.product-entry').remove();normalizeRemoveButtons();return}
    const allocate=event.target.closest('[data-allocate-flipkart]');
    if(allocate){
      try{await allocateAcrossPool(allocate.closest('.product-entry'),allocate)}
      catch(error){
        formError.textContent=error.message;
        const state=allocate.closest('.product-entry').querySelector('.allocation-state');
        if(state){state.textContent='REVIEW REQUIRED';state.className='allocation-state attention'}
      }
      return;
    }
    const check=event.target.closest('[data-check-flipkart]');
    if(check){try{await checkProduct(check.closest('.product-entry'),check)}catch(error){formError.textContent=error.message}}
  });
  productRows.addEventListener('input',event=>{
    if(event.target.matches('[name="url"],[name="quantity"]'))invalidateRow(event.target.closest('.product-entry'));
  });
  productRows.addEventListener('change',event=>{
    if(event.target.matches('[name="retailerAccountId"]'))invalidateRow(event.target.closest('.product-entry'));
  });

  let current=1;
  const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0));
  function productData(){
    return [...productRows.querySelectorAll('.product-entry')].map((row,i)=>{
      const allocationPlan=parseAllocation(row);
      const allocationValue=allocationPlan?.allocations?.reduce((sum,a)=>sum+Number(a.sellingPriceMinor||0)*Number(a.quantity||0),0)/100||0;
      return {
        index:i+1,
        url:row.querySelector('[name="url"]').value,
        price:Number(row.querySelector('[name="price"]').value||0),
        quantity:Number(row.querySelector('[name="quantity"]').value||0),
        productCheckId:row.querySelector('[name="productCheckId"]').value,
        hsnSac:row.querySelector('[name="hsnSac"]').value,
        gstRate:Number(row.querySelector('[name="gstRate"]').value||0),
        cessRate:Number(row.querySelector('[name="cessRate"]').value||0),
        priceIncludesGst:row.querySelector('[name="priceIncludesGst"]').checked,
        title:row.dataset.productTitle||'Flipkart mobile',
        maxQuantity:Number(row.dataset.maxQuantity||0),
        allocationPlan,
        allocationValue
      };
    });
  }
  function summary(){
    const data=new FormData(form),products=productData(),recipientText=preview.textContent.trim()||'Recipient file ready';
    const unitTotal=products.reduce((sum,p)=>sum+(p.allocationPlan?p.allocationValue:p.price*p.quantity),0);
    return '<div class="wizard-summary-grid">'+
      '<div><span>Batch</span><strong>'+esc(data.get('name')||'—')+'</strong></div>'+
      '<div><span>Verified Flipkart mobiles</span><strong>'+products.length+'</strong></div>'+
      '<div><span>Estimated basket value</span><strong>'+esc(money(unitTotal))+'</strong></div>'+
      '<div><span>Payment route</span><strong>'+esc(data.get('paymentMode')||'—')+'</strong></div>'+
      '<div class="wide-summary"><span>Product checks</span><strong>'+products.map(p=>p.allocationPlan
        ?esc(p.title)+' · '+p.quantity+' total units · '+p.allocationPlan.allocations.length+' accounts · verified capacity '+p.allocationPlan.verifiedCapacity
        :esc(p.title)+' · '+money(p.price)+' · Qty '+p.quantity+' / max '+p.maxQuantity).join('<br>')+'</strong></div>'+
      '<div class="wide-summary"><span>Recipients</span><strong>'+esc(recipientText)+'</strong></div>'+
      '<div class="wide-summary"><span>Execution model</span><strong>'+esc(products.every(p=>p.allocationPlan)?'Total quantity split across exact verified Flipkart accounts and their bound delivery addresses':'Verified Flipkart mobile price + account quantity limit, then grouped fulfilment execution')+'</strong></div>'+
      '</div>';
  }
  function show(step){
    current=step;
    const rows=[...productRows.querySelectorAll('.product-entry')],pooled=rows.length>0&&rows.every(row=>parseAllocation(row)?.complete);
    if(step===2&&pooled)updatePoolPreview();
    [nameLabel,productRows,addProduct,paymentLabel].filter(Boolean).forEach(x=>x.hidden=step!==1);
    if(fileLabel)fileLabel.hidden=step!==2||pooled;
    if(sample)sample.hidden=step!==2||pooled;
    if(preview)preview.hidden=step!==2;
    approval.hidden=step!==3;
    checkout.hidden=step!==4;
    labels.forEach((x,i)=>{x.classList.toggle('active',i===step-1);x.classList.toggle('complete',i<step-1)});
    back.hidden=step===1;next.hidden=step===4;actions.hidden=step!==4;nav.hidden=step===4;
    if(step===3)approval.querySelector('#wizardSummary').innerHTML=summary();
    if(step===4)checkout.querySelector('#wizardFinal').innerHTML=summary();
  }
  function validateProducts(){
    if(!form.querySelector('input[name="name"]').reportValidity())return false;
    const rows=[...productRows.querySelectorAll('.product-entry')],poolCount=rows.filter(row=>parseAllocation(row)?.complete).length;
    if(poolCount>0&&poolCount!==rows.length){formError.textContent='Use multi-account allocation for every product in this batch, or use single-account mode for every product.';return false}
    for(const row of rows){
      if(row.dataset.productVerified!=='true'){formError.textContent='Run product allocation or Check one account for every Flipkart mobile before continuing.';return false}
      for(const input of row.querySelectorAll('input'))if(!input.reportValidity())return false;
      const qty=Number(row.querySelector('[name="quantity"]').value),plan=parseAllocation(row),max=Number(row.dataset.maxQuantity||0);
      if(plan){
        if(!plan.complete||Number(plan.totalQuantity)!==qty||Number(plan.allocatedQuantity)!==qty){formError.textContent='The account allocation no longer matches the requested total. Run allocation again.';return false}
      }else if(!max||qty>max){formError.textContent='Quantity exceeds the verified Flipkart account limit. Recheck the product.';return false}
    }
    return true;
  }
  next.onclick=()=>{
    if(current===1&&!validateProducts())return;
    if(current===2){
      // Pool-mode batches carry addresses inside the allocation plan — no CSV needed
      const rows=[...productRows.querySelectorAll('.product-entry')];
      const allPooled=rows.length>0&&rows.every(row=>parseAllocation(row)?.complete);
      if(!allPooled&&!preview.textContent.trim()){
        formError.textContent='Upload a recipient CSV/XLSX, use sample recipients, or complete multi-account allocation.';
        return;
      }
    }
    if(current===3&&!document.querySelector('#wizardApproval').checked){formError.textContent='Confirm the batch details to continue.';return}
    formError.textContent='';show(Math.min(4,current+1));
  };
  back.onclick=()=>show(Math.max(1,current-1));
  document.addEventListener('click',event=>{if(event.target.closest('#newBatch,#emptyNew,#titleNewBatch'))setTimeout(()=>{while(productRows.children.length>1)productRows.lastElementChild.remove();for(const row of productRows.querySelectorAll('.product-entry')){enhanceRow(row);invalidateRow(row,'Paste a Flipkart mobile link, choose the saved account, then run Check product.')}normalizeRemoveButtons();loadFlipkartAccounts();show(1)},0)});
  form.addEventListener('reset',()=>setTimeout(()=>{while(productRows.children.length>1)productRows.lastElementChild.remove();for(const row of productRows.querySelectorAll('.product-entry')){enhanceRow(row);invalidateRow(row)}normalizeRemoveButtons();show(1)},0));

  const style=document.createElement('style');
  style.textContent=`
    .steps>*{padding:8px 10px;border-radius:8px}.steps .active{background:#071522;color:#fff}.steps .complete{background:#ecfdf5;color:#047857}
    .product-entry{padding:14px;margin:10px 0;border:1px solid #dce2ea;border-radius:12px;background:#f8fafc}.product-entry+.product-entry{margin-top:12px}
    .flipkart-pool-allocation{display:grid;grid-template-columns:minmax(260px,1fr) auto auto;gap:10px;align-items:center;margin:12px 0;padding:14px;border:1px solid #bfe3d5;border-radius:12px;background:#f4fbf8}.flipkart-pool-allocation>div:first-child strong,.flipkart-pool-allocation>div:first-child span{display:block}.flipkart-pool-allocation>div:first-child span{margin-top:4px;color:#64748b;font-size:11px;line-height:1.4}.allocation-state{padding:6px 9px;border-radius:999px;background:#eef2f7;color:#64748b;font-size:10px;font-weight:900;letter-spacing:.06em;white-space:nowrap}.allocation-state.checking{background:#eff6ff;color:#1d4ed8}.allocation-state.verified{background:#dcfce7;color:#047857}.allocation-state.attention{background:#fff7ed;color:#9a3412}.allocation-result{grid-column:1/-1;display:grid;grid-template-columns:repeat(5,minmax(100px,1fr));gap:8px}.allocation-result>div{padding:9px;border:1px solid #dceee7;border-radius:9px;background:#fff}.allocation-result>div.wide{grid-column:1/-1}.allocation-result span{display:block;color:#667085;font-size:9px;letter-spacing:.06em}.allocation-result strong{display:block;margin-top:3px;font-size:11px;overflow-wrap:anywhere}.allocation-result>span{grid-column:1/-1;font-size:11px;letter-spacing:0}
    .flipkart-product-check{display:grid;grid-template-columns:minmax(210px,1fr) auto auto;gap:10px;align-items:end;margin:12px 0;padding:13px;border:1px solid #d9e4ee;border-radius:12px;background:#fff}.flipkart-product-check label{margin:0}.flipkart-product-check select{display:block;width:100%;margin-top:6px;border:1px solid #cfd7e2;border-radius:8px;padding:.78rem;background:#fff}.product-check-state{align-self:center;padding:6px 9px;border-radius:999px;background:#f1f5f9;color:#64748b;font-size:10px;font-weight:900;letter-spacing:.06em}.product-check-state.checking{background:#eff6ff;color:#1d4ed8}.product-check-state.verified{background:#ecfdf5;color:#047857}.product-check-state.attention{background:#fff7ed;color:#9a3412}.product-check-result{grid-column:1/-1;display:grid;grid-template-columns:2fr repeat(5,minmax(90px,1fr));gap:8px;padding-top:2px}.product-check-result>div{padding:9px;border:1px solid #edf1f4;border-radius:9px;background:#fbfcfd}.product-check-result span{display:block;color:#667085;font-size:9px;letter-spacing:.06em}.product-check-result strong{display:block;margin-top:3px;font-size:11px;overflow-wrap:anywhere}.product-check-result>span{grid-column:1/-1;font-size:11px;letter-spacing:0}
    .gst-product-grid{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1.2fr auto;gap:10px;align-items:end}.gst-inclusive{display:flex!important;gap:8px;align-items:center;padding:11px 0}.gst-inclusive input{width:auto!important}.remove-product{align-self:end;margin-bottom:1px}.wizard-review{padding:18px;margin:16px 0;border:1px solid #dce2ea;border-radius:12px;background:#f8fafc}
    .wizard-review h3{margin:5px 0 12px}.wizard-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.wizard-summary-grid div{padding:11px;border-radius:9px;background:#fff;border:1px solid #e2e8f0}.wizard-summary-grid span{display:block;color:#64748b;font-size:12px}.wizard-summary-grid strong{display:block;margin-top:3px;overflow-wrap:anywhere}.wide-summary{grid-column:1/-1}.wizard-nav{display:flex;justify-content:space-between;margin-top:20px}
    @media(max-width:900px){.flipkart-pool-allocation,.flipkart-product-check{grid-template-columns:1fr 1fr}.allocation-result,.product-check-result{grid-template-columns:1fr 1fr 1fr}.gst-product-grid{grid-template-columns:1fr 1fr 1fr}.gst-inclusive{align-self:end}}@media(max-width:600px){.flipkart-pool-allocation,.allocation-result,.flipkart-product-check,.product-check-result,.gst-product-grid{grid-template-columns:1fr}.wizard-summary-grid{grid-template-columns:1fr}.wide-summary{grid-column:auto}.steps{overflow:auto;justify-content:flex-start;gap:6px}.steps>*{white-space:nowrap}}
  `;
  document.head.appendChild(style);

  for(const row of productRows.querySelectorAll('.product-entry'))enhanceRow(row);
  normalizeRemoveButtons();
  loadFlipkartAccounts();
  show(1);
})();