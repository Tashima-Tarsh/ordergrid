(()=>{
  const host=document.createElement('section');
  host.className='bulk-checkout bulk-premium-workspace';
  host.innerHTML=`
    <div class="bulk-hero">
      <div class="bulk-hero-copy">
        <span class="bulk-hero-mark">⇉</span>
        <div><p class="eyebrow">BULK ORDERS</p><h2>Checkout queue</h2><p>Prepare customer orders, watch live retailer execution, and resume only the orders that need attention.</p></div>
      </div>
      <div class="bulk-controls">
        <label class="bulk-size-control"><span>PREPARE</span><select id="bulkClaimSize" aria-label="Orders to prepare"><option>5</option><option selected>10</option><option>20</option><option>25</option></select></label>
        <button id="bulkRun">Prepare orders</button>
        <button id="bulkRefresh" class="secondary premium-icon-button" title="Refresh bulk orders" aria-label="Refresh bulk orders">↻</button>
        <a class="bulk-report-link" href="/api/reports/orders.csv">Export CSV</a>
      </div>
    </div>

    <div class="bulk-kpi-strip" aria-label="Bulk order metrics">
      <article class="bulk-kpi-primary"><span>CUSTOMER ORDERS</span><strong id="bulkBasketCount">0</strong><small>Checkout baskets</small></article>
      <article><span>PRODUCT LINES</span><strong id="bulkLineCount">0</strong><small>Across all orders</small></article>
      <article><span>READY / RUNNING</span><strong id="bulkReadyCount">0</strong><small>Active queue</small></article>
      <article><span>CONFIRMED</span><strong id="bulkConfirmedCount">0</strong><small>Retailer-confirmed</small></article>
    </div>

    <section class="bulk-queue-card">
      <div class="bulk-card-head">
        <div><span>ORDER QUEUE</span><strong>Customer checkout status</strong></div>
        <span id="bulkQueueState" class="bulk-state-chip">CLEAR</span>
      </div>
      <div id="bulkQueue" class="bulk-queue">
        <div class="bulk-empty"><strong>No orders yet</strong><span>Create and approve a fulfilment batch to see customer orders here.</span></div>
      </div>
    </section>
  `;

  const anchor=document.querySelector('.human-action-centre')||document.querySelector('.funding-workspace')||document.querySelector('.rewards-centre');
  if(anchor)anchor.before(host);
  else document.querySelector('main')?.appendChild(host);

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
    return ({READY:'READY',CLAIMED:'READY',OPENED:'IN PROGRESS',WAITING_STOCK:'WATCHING STOCK',REQUIRES_ACTION:'NEEDS ATTENTION',CONFIRMED:'CONFIRMED',FAILED:'NEEDS ATTENTION'})[status]||'IN PROGRESS';
  }
  function statusTone(status){
    if(status==='CONFIRMED')return 'confirmed';
    if(['REQUIRES_ACTION','FAILED'].includes(status))return 'attention';
    if(status==='WAITING_STOCK')return 'watching';
    if(['READY','CLAIMED','OPENED'].includes(status))return 'running';
    return 'neutral';
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
    const running=baskets.filter(b=>['OPENED','WAITING_STOCK','REQUIRES_ACTION'].includes(b.status)).length;
    const confirmed=baskets.filter(b=>b.status==='CONFIRMED').length;
    const lines=baskets.reduce((n,b)=>n+Number(b.item_count||0),0);
    const attention=baskets.filter(b=>['REQUIRES_ACTION','FAILED'].includes(b.status)).length;

    host.querySelector('#bulkBasketCount').textContent=String(baskets.length);
    host.querySelector('#bulkLineCount').textContent=String(lines);
    host.querySelector('#bulkReadyCount').textContent=String(ready+running);
    host.querySelector('#bulkConfirmedCount').textContent=String(confirmed);

    const queueState=host.querySelector('#bulkQueueState');
    queueState.textContent=attention?attention+' NEED ATTENTION':ready+running?(ready+running)+' ACTIVE':'CLEAR';
    queueState.className='bulk-state-chip '+(attention?'attention':ready+running?'running':'clear');

    const runButton=host.querySelector('#bulkRun');
    runButton.disabled=!baskets.some(b=>b.status==='READY');
    runButton.title=runButton.disabled?'No new orders are waiting':'Prepare waiting orders for checkout';

    host.querySelector('#bulkQueue').innerHTML=baskets.length?baskets.map(b=>{
      const note=attentionText(b);
      const watching=b.status==='WAITING_STOCK';
      const actionable=['OPENED','REQUIRES_ACTION','FAILED'].includes(b.status)&&!/^STOCK_WATCH_/.test(String(b.failure_code||''));
      const action=actionable?'<button type="button" class="secondary" data-focus-session>Resume session</button>':'';
      const retry=['REQUIRES_ACTION','FAILED'].includes(b.status)&&!/^STOCK_WATCH_/.test(String(b.failure_code||''))?'<button type="button" class="secondary" data-retry>Requeue</button>':'';
      const stockAction=watching
        ?'<button type="button" class="secondary" data-stock-stop>Pause watch</button>'
        :(/^STOCK_WATCH_(PAUSED|EXPIRED)$/.test(String(b.failure_code||''))?'<button type="button" class="secondary" data-stock-resume>Resume watch</button>':'');
      const stockMeta=watching
        ?'<div class="stock-watch-note"><b>AUTO-BUY '+(b.stock_watch_auto_order?'ON':'OFF')+'</b><span>Next '+(b.stock_next_check_at?new Date(b.stock_next_check_at).toLocaleString('en-IN'):'pending')+' · ceiling '+money(b.stock_watch_max_amount_minor||0)+'</span></div>'
        :'';
      const cardInfo=b.card_masked
        ?`<span class="bulk-card-badge">💳 ${esc(b.card_masked)} · ${esc(b.card_status||'ACTIVE')}</span>`
        :(b.payment_route==='Cash on Delivery'?'<span class="bulk-card-badge">💵 Cash on Delivery</span>':'<span class="bulk-card-badge">💳 Card pending</span>');
      const orderIdBadge=b.retailer_order_id
        ?`<div class="bulk-order-id-badge"><strong>ORDER ID</strong><span>${esc(b.retailer_order_id)}</span></div>`
        :'';
      const timeStr=b.created_at?new Date(b.created_at).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'';
      const healthBadge=b.health_score!==undefined&&b.health_score!==null
        ?`<span class="bulk-health-badge">Health: ${b.health_score}%</span>`
        :'';
      return `
        <article class="bulk-order-card" data-basket="${esc(b.id)}">
          <div class="bulk-order-main">
            <div class="bulk-order-avatar">${esc(String(b.retailer||'R').slice(0,1).toUpperCase())}</div>
            <div class="bulk-order-copy">
              <div class="bulk-order-title-row">
                <strong>${esc(b.customer_reference||b.recipient||'Customer order')}</strong>
                ${healthBadge}
                ${timeStr?`<small class="bulk-order-time">${esc(timeStr)}</small>`:''}
              </div>
              <span>${esc(b.retailer)} · ${esc(b.account_label||b.account_reference||'Account not added')}</span>
              <small>${esc(b.recipient)} · ${esc(b.city)} ${esc(b.postal_code)} · ${cardInfo}</small>
              ${orderIdBadge}
              ${stockMeta}
              ${note?'<div class="bulk-exception"><b>Needs attention</b><span>'+esc(note)+'</span></div>':''}
            </div>
          </div>
          <div class="bulk-order-facts">
            <div><span>ITEMS</span><strong>${Number(b.item_count||0)}</strong></div>
            <div><span>VALUE</span><strong>${money(b.amount_minor)}</strong></div>
          </div>
          <div class="bulk-order-state">
            <span class="bulk-status ${statusTone(b.status)}">${esc(statusLabel(b.status))}</span>
            <div class="bulk-action">${action}${retry}${stockAction}</div>
          </div>
        </article>`;
    }).join(''):'<div class="bulk-empty"><strong>No orders yet</strong><span>Create and approve a fulfilment batch to see customer orders here.</span></div>';
  }

  async function load(){
    const refresh=host.querySelector('#bulkRefresh');
    refresh?.classList.add('is-refreshing');
    try{
      const data=await request('/api/bulk-baskets');
      baskets=data.baskets||[];
      render();
    }catch(error){
      console.error(error);
      host.querySelector('#bulkQueue').innerHTML='<div class="bulk-empty error"><strong>Unable to load bulk orders</strong><span>'+esc(error.message)+'</span></div>';
    }finally{refresh?.classList.remove('is-refreshing')}
  }

  host.querySelector('#bulkRun').onclick=async()=>{
    const button=host.querySelector('#bulkRun');
    button.disabled=true;button.textContent='Preparing…';
    try{
      const result=await request('/api/bulk-queue/claim',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({limit:Number(host.querySelector('#bulkClaimSize').value)})
      });
      await load();
      window.toast?.(result.claimed?result.claimed+' order(s) ready for checkout':'No new orders are waiting');
    }catch(error){window.toast?.(error.message)||alert(error.message)}
    finally{button.textContent='Prepare orders';await load()}
  };

  host.querySelector('#bulkRefresh').onclick=load;

  host.onclick=async event=>{
    const stockStop=event.target.closest('[data-stock-stop]');
    const stockResume=event.target.closest('[data-stock-resume]');
    if(stockStop||stockResume){
      const button=stockStop||stockResume,row=button.closest('[data-basket]');if(!row)return;
      button.disabled=true;
      try{
        await request('/api/bulk-queue/'+row.dataset.basket+'/stock-watch',{
          method:'PATCH',headers:{'content-type':'application/json'},
          body:JSON.stringify(stockStop?{enabled:false}:{enabled:true,autoOrder:true,extendDays:30})
        });
        await load();
        window.toast?.(stockStop?'Stock watch paused':'Stock watch resumed');
      }catch(error){window.toast?.(error.message)||alert(error.message)}
      finally{button.disabled=false}
      return;
    }

    const focus=event.target.closest('[data-focus-session]');
    if(focus){
      const row=focus.closest('[data-basket]');if(!row)return;
      focus.disabled=true;const previous=focus.textContent;focus.textContent='Opening…';
      try{
        await request('/api/human-actions/'+row.dataset.basket+'/focus',{method:'POST'});
        window.toast?.('Opening the exact retailer session on the connected worker');
      }catch(error){window.toast?.(error.message)||alert(error.message)}
      finally{focus.textContent=previous;setTimeout(()=>{focus.disabled=false},1200)}
      return;
    }

    const retry=event.target.closest('[data-retry]');
    if(!retry)return;
    const row=retry.closest('[data-basket]');if(!row)return;
    retry.disabled=true;
    try{
      await request('/api/bulk-queue/'+row.dataset.basket+'/retry',{method:'POST'});
      await load();
      window.toast?.('Order task requeued');
    }catch(error){window.toast?.(error.message)||alert(error.message)}
    finally{retry.disabled=false}
  };

  window.addEventListener('ordergrid:bulk-refresh',load);
  window.addEventListener('ordergrid:update',load);
  setInterval(load,15000);
  load();
})();