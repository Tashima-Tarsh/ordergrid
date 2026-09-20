(()=>{
  const host=document.querySelector('[data-bulk-root]')||document.body;
  if(!document.querySelector('#bulkRun')) return;

  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  let baskets=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function statusLabel(status){
    return ({
      READY:'READY',
      CLAIMED:'READY',
      OPENED:'IN PROGRESS',
      REQUIRES_ACTION:'NEEDS ATTENTION',
      CONFIRMED:'CONFIRMED',
      FAILED:'NEEDS ATTENTION'
    })[status]||'IN PROGRESS';
  }

  function attentionText(b){
    const code=String(b.failure_code||'');
    if(/LOGIN|PASSWORD/i.test(code)) return 'Sign in required';
    if(/OTP/i.test(code)) return 'Verification code required';
    if(/CAPTCHA/i.test(code)) return 'Verification required';
    if(/PAYMENT|3DS|CARD/i.test(code)) return 'Payment confirmation required';
    if(b.status==='FAILED') return 'Please review this order';
    return '';
  }

  function render(){
    const ready=baskets.filter(b=>['READY','CLAIMED'].includes(b.status)).length;
    const running=baskets.filter(b=>['OPENED','REQUIRES_ACTION'].includes(b.status)).length;
    const confirmed=baskets.filter(b=>b.status==='CONFIRMED').length;
    const lines=baskets.reduce((n,b)=>n+Number(b.item_count||0),0);

    document.querySelector('#bulkBasketCount').textContent=String(baskets.length);
    document.querySelector('#bulkLineCount').textContent=String(lines);
    document.querySelector('#bulkReadyCount').textContent=String(ready+running);
    document.querySelector('#bulkConfirmedCount').textContent=String(confirmed);

    const availability=document.querySelector('#bulkWorkerCount');
    if(availability){availability.textContent='AVAILABLE';availability.previousElementSibling.textContent='CHECKOUT'}

    const runButton=document.querySelector('#bulkRun');
    runButton.disabled=!baskets.some(b=>b.status==='READY');
    runButton.title=runButton.disabled?'No new orders are waiting to be prepared':'Prepare all new orders for checkout';

    document.querySelector('#bulkQueue').innerHTML=baskets.length?baskets.map(b=>{
      const note=attentionText(b);
      const action=b.retailer==='amazon-in'
        ?'<a class="secondary amazon-open-link" href="/api/bulk-baskets/'+encodeURIComponent(b.id)+'/browser-checkout?redirect=1">Continue checkout</a>'
        :'';
      const retry=['REQUIRES_ACTION','FAILED'].includes(b.status)
        ?'<button class="secondary" data-retry>Try again</button>'
        :'';
      return `
      <div class="bulk-row" data-basket="${esc(b.id)}">
        <div class="bulk-order-copy">
          <strong>${esc(b.customer_reference||b.recipient)} · ${esc(b.retailer)}</strong>
          <small>${esc(b.recipient)} · ${esc(b.account_reference||'Account not added')}</small>
          <small>${esc(b.city)} ${esc(b.postal_code)} · ${esc(b.payment_route)}</small>
          ${note?'<div class="bulk-exception"><b>NEEDS ATTENTION</b> · '+esc(note)+'</div>':''}
        </div>
        <div><small>Items</small><strong>${Number(b.item_count||0)}</strong></div>
        <div><small>Order value</small><strong>${money(b.amount_minor)}</strong></div>
        <div>
          <small>Status</small>
          <span class="bulk-status">${esc(statusLabel(b.status))}</span>
          <div class="bulk-action">${action}${retry}</div>
        </div>
      </div>`;
    }).join(''):'<div class="bulk-empty"><strong>No orders yet</strong><span>Create and approve a fulfilment batch to see customer orders here.</span></div>';
  }

  async function load(){
    try{
      const data=await request('/api/bulk-baskets');
      baskets=data.baskets||[];
      render();
    }catch(error){console.error(error)}
  }

  document.querySelector('#bulkRun').onclick=async()=>{
    const button=document.querySelector('#bulkRun');
    button.disabled=true;button.textContent='Preparing orders…';
    try{
      const result=await request('/api/bulk-queue/claim',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({limit:Number(document.querySelector('#bulkClaimSize').value)})
      });
      await load();
      if(window.toast)window.toast(result.claimed?result.claimed+' order(s) ready for checkout':'No new orders are waiting');
    }catch(error){alert(error.message)}
    finally{button.textContent='Prepare orders';await load()}
  };

  document.querySelector('#bulkRefresh').onclick=load;
  host.onclick=async event=>{
    const retry=event.target.closest('[data-retry]');
    if(!retry)return;
    const row=retry.closest('[data-basket]');
    retry.disabled=true;
    try{
      await request('/api/bulk-queue/'+row.dataset.basket+'/retry',{method:'POST'});
      await load();
      if(window.toast)window.toast('Order is ready to continue');
    }catch(error){alert(error.message)}
    finally{retry.disabled=false}
  };

  window.addEventListener('ordergrid:bulk-refresh',load);
  window.addEventListener('ordergrid:update',load);
  setInterval(load,5000);
  load();
})();