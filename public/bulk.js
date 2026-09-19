(()=>{
  const host=document.createElement('section');
  host.className='panel bulk-checkout';
  host.innerHTML=`
    <div class="panel-head">
      <div><p class="eyebrow">ORDERGRID BULK CHECKOUT</p><h2>Customer baskets</h2></div>
      <div class="bulk-controls">
        <select id="bulkClaimSize"><option>5</option><option selected>10</option><option>20</option><option>25</option></select>
        <button id="bulkRun">Start bulk run</button>
        <button id="bulkRefresh" class="secondary">Refresh</button>
        <a class="report-link" href="/api/reports/orders.csv">Download report</a>
      </div>
    </div>
    <div class="bulk-truth">
      <div><span>CUSTOMER / RETAILER BASKETS</span><strong id="bulkBasketCount">0</strong></div>
      <div><span>PRODUCT LINES</span><strong id="bulkLineCount">0</strong></div>
      <div><span>READY / RUNNING</span><strong id="bulkReadyCount">0</strong></div>
      <div><span>CONFIRMED</span><strong id="bulkConfirmedCount">0</strong></div>
    </div>
    <div class="secure-note"><strong>OrderGrid remains the control plane.</strong> Each basket combines all products for one customer at one retailer. Baskets run concurrently. Retailer login, OTP, CAPTCHA or 3DS is surfaced only when that retailer requires human action.</div>
    <div id="bulkQueue"><p class="muted">Create and approve a fulfilment batch to generate bulk baskets.</p></div>
    <dialog id="bulkBasketDialog"><div class="payment-modal"><div class="modal-head"><div><p class="eyebrow">BASKET EXECUTION</p><h2 id="bulkBasketTitle">Basket</h2></div><button type="button" class="close" id="bulkBasketClose">×</button></div><div id="bulkBasketDetail"></div><div class="notice"><b>Execution boundary:</b> OrderGrid can orchestrate the basket and keep the isolated session. It will not bypass retailer OTP, CAPTCHA, 3DS or other authentication controls.</div></div></dialog>
  `;
  document.querySelector('.autopilot-suite').before(host);

  const style=document.createElement('style');
  style.textContent=`
    .bulk-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.bulk-controls select{padding:10px;border:1px solid #d8e0e8;border-radius:8px}
    .bulk-truth{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}.bulk-truth div{padding:14px;border:1px solid #e2e8f0;border-radius:12px;background:#fff}
    .bulk-truth span{display:block;font-size:10px;color:#64748b}.bulk-truth strong{font-size:24px}.bulk-row{display:grid;grid-template-columns:minmax(260px,1fr) repeat(4,minmax(100px,auto));gap:12px;align-items:center;padding:14px 0;border-top:1px solid #e5e7eb}
    .bulk-row small{display:block;color:#64748b;margin-top:3px}.bulk-status{font-weight:800;font-size:12px}.bulk-actions{display:flex;gap:8px}.basket-products{display:grid;gap:10px;margin-top:14px}.basket-product{padding:12px;border:1px solid #e2e8f0;border-radius:10px}.basket-product a{overflow-wrap:anywhere}
    @media(max-width:900px){.bulk-truth{grid-template-columns:1fr 1fr}.bulk-row{grid-template-columns:1fr}.bulk-actions{flex-wrap:wrap}}@media(max-width:520px){.bulk-truth{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);

  const esc=value=>{const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML};
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  let baskets=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function render(){
    const ready=baskets.filter(b=>['READY','CLAIMED','OPENED','REQUIRES_ACTION'].includes(b.status)).length;
    const confirmed=baskets.filter(b=>b.status==='CONFIRMED').length;
    const lines=baskets.reduce((n,b)=>n+Number(b.item_count||0),0);
    document.querySelector('#bulkBasketCount').textContent=baskets.length;
    document.querySelector('#bulkLineCount').textContent=lines;
    document.querySelector('#bulkReadyCount').textContent=ready;
    document.querySelector('#bulkConfirmedCount').textContent=confirmed;
    document.querySelector('#bulkQueue').innerHTML=baskets.length?baskets.map(b=>`
      <div class="bulk-row" data-basket="${b.id}">
        <div><strong>${esc(b.recipient)} · ${esc(b.retailer)}</strong><small>${esc(b.batch_name)} · ${esc(b.city)} ${esc(b.postal_code)} · ${esc(b.payment_route)}</small></div>
        <div><small>Items</small><strong>${b.item_count}</strong></div>
        <div><small>Basket value</small><strong>${money(b.amount_minor)}</strong></div>
        <div><small>Status</small><span class="bulk-status">${esc(b.status)}</span></div>
        <div class="bulk-actions"><button class="secondary" data-inspect>Inspect</button>${['CLAIMED','OPENED'].includes(b.status)?'<button data-confirm>Confirm order</button><button class="secondary" data-release>Release</button>':''}</div>
      </div>`).join(''):'<p class="muted">No baskets yet. Create and approve a fulfilment batch.</p>';
  }
  async function load(){
    try{baskets=(await request('/api/bulk-baskets')).baskets||[];render()}catch(error){console.error(error)}
  }
  document.querySelector('#bulkRun').onclick=async()=>{
    const button=document.querySelector('#bulkRun');
    button.disabled=true;button.textContent='Starting baskets…';
    try{
      const result=await request('/api/bulk-queue/claim',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({limit:Number(document.querySelector('#bulkClaimSize').value)})});
      await load();
      if(window.toast)window.toast(`${result.claimed} baskets assigned to bulk execution`);
    }catch(error){alert(error.message)}finally{button.disabled=false;button.textContent='Start bulk run'}
  };
  document.querySelector('#bulkRefresh').onclick=load;
  document.querySelector('#bulkBasketClose').onclick=()=>document.querySelector('#bulkBasketDialog').close();
  host.onclick=async event=>{
    const row=event.target.closest('[data-basket]');
    if(!row)return;
    const basket=baskets.find(x=>x.id===row.dataset.basket);
    if(event.target.closest('[data-release]')){
      if(!confirm(`Release ${basket.recipient} · ${basket.retailer} back to the bulk queue?`))return;
      try{await request(`/api/bulk-queue/${basket.id}/release`,{method:'POST'});await load()}catch(error){alert(error.message)}
      return;
    }
    if(event.target.closest('[data-confirm]')){
      const retailerOrderId=prompt(`Retailer order ID for ${basket.recipient} · ${basket.retailer}:`);
      if(!retailerOrderId)return;
      try{
        await request(`/api/bulk-queue/${basket.id}/confirm`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({retailerOrderId})});
        await load();window.dispatchEvent(new Event('ordergrid:refresh'));
        if(window.toast)window.toast('Basket confirmed from retailer order ID');
      }catch(error){alert(error.message)}
      return;
    }
    if(!event.target.closest('[data-inspect]'))return;
    document.querySelector('#bulkBasketTitle').textContent=`${basket.recipient} · ${basket.retailer}`;
    let detail='<p>This basket has not been claimed for execution yet.</p>';
    try{
      const mine=(await request('/api/bulk-queue')).baskets||[];
      if(mine.some(x=>x.id===basket.id)){
        const opened=await request(`/api/bulk-queue/${basket.id}/open`,{method:'POST',body:'{}'});
        detail=`<div class="basket-products">${opened.items.map((item,i)=>`<div class="basket-product"><strong>Item ${i+1} · Qty ${item.requested_quantity}</strong><small>${money(item.amount_minor)}</small><div>${esc(item.title||'Retailer product')}</div><a href="${esc(item.actionUrl)}" target="_blank" rel="noopener">Verified retailer product</a></div>`).join('')}</div>`;
      }
    }catch(error){detail=`<p>${esc(error.message)}</p>`}
    document.querySelector('#bulkBasketDetail').innerHTML=detail;
    document.querySelector('#bulkBasketDialog').showModal();
  };
  window.addEventListener('ordergrid:bulk-refresh',load);
  window.addEventListener('ordergrid:update',load);
  setInterval(load,30000);
  load();
})();