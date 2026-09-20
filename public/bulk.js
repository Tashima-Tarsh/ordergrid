(()=>{
  const host=document.createElement('section');
  host.className='panel bulk-checkout';
  host.innerHTML=`
    <div class="panel-head">
      <div><p class="eyebrow">ORDERGRID BULK ORDERING</p><h2>Execution control</h2></div>
      <div class="bulk-controls">
        <select id="bulkClaimSize"><option>5</option><option selected>10</option><option>20</option><option>25</option></select>
        <button id="bulkRun">Place bulk orders</button>
        <button id="bulkRefresh" class="secondary">Refresh</button>
        <a class="report-link" href="/api/reports/orders.csv">Download report</a>
      </div>
    </div>
    <div class="bulk-truth">
      <div><span>CUSTOMER / RETAILER BASKETS</span><strong id="bulkBasketCount">0</strong></div>
      <div><span>PRODUCT LINES</span><strong id="bulkLineCount">0</strong></div>
      <div><span>RUNNING / READY</span><strong id="bulkReadyCount">0</strong></div>
      <div><span>CONFIRMED</span><strong id="bulkConfirmedCount">0</strong></div>
      <div><span>EXECUTION WORKERS</span><strong id="bulkWorkerCount">0</strong></div>
    </div>
    <div class="secure-note"><strong>Bulk orders are placed by OrderGrid workers.</strong> The customer does not open products one-by-one or paste retailer order IDs. If a retailer explicitly requires login, OTP, CAPTCHA, 3DS or another authentication step, only that basket pauses while the worker keeps the secure session alive.</div>
    <div id="bulkQueue"><p class="muted">Create and approve a fulfilment batch to generate OrderGrid baskets.</p></div>
  `;
  document.querySelector('.autopilot-suite').before(host);

  const style=document.createElement('style');
  style.textContent=`
    .bulk-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bulk-controls select{padding:10px;border:1px solid #d8e0e8;border-radius:8px}
    .bulk-truth{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:14px 0}.bulk-truth div{padding:14px;border:1px solid #e2e8f0;border-radius:12px;background:#fff}
    .bulk-truth span{display:block;font-size:10px;color:#64748b}.bulk-truth strong{font-size:22px}.bulk-row{display:grid;grid-template-columns:minmax(260px,1fr) repeat(3,minmax(110px,auto));gap:12px;align-items:center;padding:14px 0;border-top:1px solid #e5e7eb}
    .bulk-row small{display:block;color:#64748b;margin-top:3px}.bulk-status{font-weight:800;font-size:12px}.bulk-exception{margin-top:6px;padding:7px 9px;background:#fff7ed;border-radius:8px;color:#9a3412;font-size:12px}
    .bulk-action{display:flex;justify-content:flex-end;gap:6px;flex-wrap:wrap}.bulk-action button,.bulk-action a{white-space:nowrap}.amazon-open-link{display:inline-block;text-decoration:none}
    @media(max-width:900px){.bulk-truth{grid-template-columns:1fr 1fr}.bulk-row{grid-template-columns:1fr}.bulk-action{justify-content:flex-start}}@media(max-width:520px){.bulk-truth{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);

  const esc=value=>{const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML};
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  let baskets=[],workers=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function statusLabel(status){
    return ({READY:'READY',CLAIMED:'QUEUED',OPENED:'RUNNING',REQUIRES_ACTION:'AUTHORIZATION REQUIRED',CONFIRMED:'CONFIRMED',FAILED:'FAILED'})[status]||status;
  }
  function render(){
    const ready=baskets.filter(b=>b.status==='READY').length;
    const queued=baskets.filter(b=>b.status==='CLAIMED').length;
    const running=baskets.filter(b=>['OPENED','REQUIRES_ACTION'].includes(b.status)).length;
    const confirmed=baskets.filter(b=>b.status==='CONFIRMED').length;
    const lines=baskets.reduce((n,b)=>n+Number(b.item_count||0),0);
    document.querySelector('#bulkBasketCount').textContent=baskets.length;
    document.querySelector('#bulkLineCount').textContent=lines;
    document.querySelector('#bulkReadyCount').textContent=ready+queued+running;
    document.querySelector('#bulkConfirmedCount').textContent=confirmed;
    document.querySelector('#bulkWorkerCount').textContent=workers.length?workers.length+' ONLINE':'OFFLINE';
    const runButton=document.querySelector('#bulkRun');
    runButton.disabled=!ready;
    runButton.title=ready?(workers.length?'Queue ready baskets for the online OrderGrid worker':'Queue ready baskets now; the Windows worker can connect afterwards'):'No READY baskets to queue';
    document.querySelector('#bulkQueue').innerHTML=baskets.length?baskets.map(b=>`
      <div class="bulk-row" data-basket="${b.id}">
        <div><strong>${esc(b.customer_reference||b.recipient)} · ${esc(b.retailer)}</strong><small>${esc(b.recipient)} · account ${esc(b.account_reference||'unbound')} · auth ${esc(b.auth_status||'unknown')}</small><small>${esc(b.batch_name)} · ${esc(b.city)} ${esc(b.postal_code)} · ${esc(b.payment_route)}</small>${b.failure_message?`<div class="bulk-exception"><b>${esc(b.failure_code||'ACTION REQUIRED')}</b> · ${esc(b.failure_message)}</div>`:''}</div>
        <div><small>Items</small><strong>${b.item_count}</strong></div>
        <div><small>Basket value</small><strong>${money(b.amount_minor)}</strong></div>
        <div><small>Status</small><span class="bulk-status">${esc(statusLabel(b.status))}</span><div class="bulk-action">${b.retailer==='amazon-in'?'<a class="secondary amazon-open-link" href="/api/bulk-baskets/'+encodeURIComponent(b.id)+'/browser-checkout?redirect=1">Continue to real Amazon cart</a>':''}${['REQUIRES_ACTION','FAILED'].includes(b.status)?'<button class="secondary" data-retry>Retry basket</button>':''}</div></div>
      </div>`).join(''):'<p class="muted">No baskets yet. Create and approve a fulfilment batch.</p>';
  }
  async function load(){
    try{
      const [basketData,workerData]=await Promise.all([request('/api/bulk-baskets'),request('/api/execution-workers')]);
      baskets=basketData.baskets||[];workers=workerData.workers||[];render();
    }catch(error){console.error(error)}
  }
  document.querySelector('#bulkRun').onclick=async()=>{
    const button=document.querySelector('#bulkRun');
    button.disabled=true;button.textContent='Queuing baskets…';
    try{
      const result=await request('/api/bulk-queue/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limit:Number(document.querySelector('#bulkClaimSize').value)})});
      await load();
      if(window.toast){const message=result.claimed?(workers.length?result.claimed+' basket(s) queued for OrderGrid execution':result.claimed+' basket(s) queued · start Windows worker to execute'):'No READY baskets were available to queue';window.toast(message)}
    }catch(error){alert(error.message)}
    finally{button.textContent='Place bulk orders';await load()}
  };
  document.querySelector('#bulkRefresh').onclick=load;
  host.onclick=async event=>{
    const retry=event.target.closest('[data-retry]');if(!retry)return;
    const row=retry.closest('[data-basket]');retry.disabled=true;
    try{await request(`/api/bulk-queue/${row.dataset.basket}/retry`,{method:'POST'});await load();if(window.toast)window.toast('Basket returned to OrderGrid execution queue')}
    catch(error){alert(error.message)}
    finally{retry.disabled=false}
  };
  window.addEventListener('ordergrid:bulk-refresh',load);
  window.addEventListener('ordergrid:update',load);
  setInterval(load,5000);
  load();
})();