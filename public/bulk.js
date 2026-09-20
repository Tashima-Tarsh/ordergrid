(()=>{
  const host=document.createElement('section');
  host.className='panel bulk-checkout';
  host.innerHTML=`
    <div class="panel-head">
      <div><p class="eyebrow">BULK ORDERS</p><h2>Checkout overview</h2></div>
      <div class="bulk-controls">
        <select id="bulkClaimSize" aria-label="Orders to prepare"><option>5</option><option selected>10</option><option>20</option><option>25</option></select>
        <button id="bulkRun">Prepare orders</button>
        <button id="bulkRefresh" class="secondary">Refresh</button>
        <a class="report-link" href="/api/reports/orders.csv">Download report</a>
      </div>
    </div>
    <div class="bulk-truth">
      <div><span>CUSTOMER ORDERS</span><strong id="bulkBasketCount">0</strong></div>
      <div><span>PRODUCT LINES</span><strong id="bulkLineCount">0</strong></div>
      <div><span>READY / IN PROGRESS</span><strong id="bulkReadyCount">0</strong></div>
      <div><span>CONFIRMED</span><strong id="bulkConfirmedCount">0</strong></div>
    </div>
    <div id="bulkQueue"><div class="bulk-empty"><strong>No orders yet</strong><span>Create and approve a fulfilment batch to see customer orders here.</span></div></div>
  `;
  document.querySelector('.autopilot-suite').before(host);

  const style=document.createElement('style');
  style.textContent=`
    .bulk-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bulk-controls select{padding:10px 12px;border:1px solid #d8e0e8;border-radius:10px;background:#fff}
    .bulk-truth{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.bulk-truth div{padding:16px;border:1px solid #e2e8f0;border-radius:14px;background:#fff}
    .bulk-truth span{display:block;font-size:10px;letter-spacing:.08em;color:#64748b;font-weight:800}.bulk-truth strong{display:block;margin-top:5px;font-size:24px;letter-spacing:-.02em}
    .bulk-row{display:grid;grid-template-columns:minmax(300px,1fr) 100px 140px minmax(190px,auto);gap:16px;align-items:center;padding:17px 0;border-top:1px solid #e8edf2}
    .bulk-order-copy strong{font-size:14px}.bulk-row small{display:block;color:#64748b;margin-top:4px;font-size:12px}.bulk-status{display:block;margin-top:4px;font-weight:900;font-size:11px;letter-spacing:.06em}
    .bulk-exception{margin-top:8px;padding:8px 10px;background:#fff7ed;border-radius:9px;color:#9a3412;font-size:12px}
    .bulk-action{display:flex;justify-content:flex-end;gap:7px;flex-wrap:wrap;margin-top:8px}.bulk-action button,.bulk-action a{white-space:nowrap}.amazon-open-link{display:inline-block;text-decoration:none}
    .bulk-empty{padding:42px 16px;text-align:center;color:#64748b}.bulk-empty strong,.bulk-empty span{display:block}.bulk-empty strong{color:#111827;font-size:16px}.bulk-empty span{margin-top:5px}
    @media(max-width:900px){.bulk-truth{grid-template-columns:1fr 1fr}.bulk-row{grid-template-columns:1fr}.bulk-action{justify-content:flex-start}}@media(max-width:520px){.bulk-truth{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);

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
    return ({READY:'READY',CLAIMED:'READY',OPENED:'IN PROGRESS',REQUIRES_ACTION:'NEEDS ATTENTION',CONFIRMED:'CONFIRMED',FAILED:'NEEDS ATTENTION'})[status]||'IN PROGRESS';
  }

  function attentionText(b){
    const code=String(b.failure_code||'');
    if(/LOGIN|PASSWORD/i.test(code))return 'Sign in required';
    if(/OTP/i.test(code))return 'Verification code required';
    if(/CAPTCHA/i.test(code))return 'Verification required';
    if(/PAYMENT|3DS|CARD/i.test(code))return 'Payment confirmation required';
    if(b.status==='FAILED')return 'Please review this order';
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

    const runButton=document.querySelector('#bulkRun');
    runButton.disabled=!baskets.some(b=>b.status==='READY');
    runButton.title=runButton.disabled?'No new orders are waiting':'Prepare all new orders for checkout';

    document.querySelector('#bulkQueue').innerHTML=baskets.length?baskets.map(b=>{
      const note=attentionText(b);
      const action=b.retailer==='amazon-in'?'<a class="secondary amazon-open-link" href="/api/bulk-baskets/'+encodeURIComponent(b.id)+'/browser-checkout?redirect=1">Continue checkout</a>':'';
      const retry=['REQUIRES_ACTION','FAILED'].includes(b.status)?'<button class="secondary" data-retry>Try again</button>':'';
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
          <div><small>Status</small><span class="bulk-status">${esc(statusLabel(b.status))}</span><div class="bulk-action">${action}${retry}</div></div>
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
      const result=await request('/api/bulk-queue/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limit:Number(document.querySelector('#bulkClaimSize').value)})});
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