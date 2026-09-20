(()=>{
  const section=document.createElement('section');
  section.className='control-center';
  section.innerHTML=`
    <div class="control-hero">
      <div>
        <p class="eyebrow">CONTROL CENTER</p>
        <h2>Everything in one place</h2>
        <p>See account readiness, checkout, cards and confirmed orders across every retailer.</p>
      </div>
      <span class="control-available"><b></b> Checkout available</span>
    </div>
    <div class="control-kpis">
      <article><span>CUSTOMERS</span><strong id="ccCustomers">0</strong><small>Active recipients</small></article>
      <article><span>RETAILER ACCOUNTS</span><strong id="ccAccounts">0</strong><small id="ccAccountReady">0 ready</small></article>
      <article><span>ORDERS</span><strong id="ccOrders">0</strong><small id="ccOrderReady">0 ready</small></article>
      <article><span>CONFIRMED</span><strong id="ccConfirmed">0</strong><small>Retailer confirmed</small></article>
      <article><span>VIRTUAL CARDS</span><strong id="ccCards">0</strong><small id="ccCardsNeeded">0 needed</small></article>
    </div>
    <div class="control-grid">
      <article class="control-card">
        <div class="control-card-head"><div><span>ACCOUNT READINESS</span><h3>Retailer accounts</h3></div><button class="secondary" data-go="fulfilment">Import accounts</button></div>
        <div class="control-stat-list">
          <div><span>Credentials protected</span><strong id="ccCredentials">0</strong></div>
          <div><span>Signed in</span><strong id="ccAuthenticated">0</strong></div>
          <div><span>Needs attention</span><strong id="ccAccountAttention">0</strong></div>
        </div>
      </article>
      <article class="control-card">
        <div class="control-card-head"><div><span>ORDER PROGRESS</span><h3>Checkout</h3></div><button class="secondary" data-go="bulk">View orders</button></div>
        <div class="control-stat-list">
          <div><span>Ready</span><strong id="ccReady">0</strong></div>
          <div><span>In progress</span><strong id="ccProgress">0</strong></div>
          <div><span>Needs attention</span><strong id="ccAttention">0</strong></div>
        </div>
      </article>
      <article class="control-card">
        <div class="control-card-head"><div><span>PAYMENT READINESS</span><h3>Cards & funding</h3></div><button class="secondary" data-go="cards">Open cards</button></div>
        <div class="control-stat-list">
          <div><span>Card programme</span><strong id="ccProgramme">Setup required</strong></div>
          <div><span>Cards assigned</span><strong id="ccBound">0</strong></div>
          <div><span>Orders needing cards</span><strong id="ccNeedCards">0</strong></div>
        </div>
      </article>
      <article class="control-card control-retailers">
        <div class="control-card-head"><div><span>RETAILER MIX</span><h3>Connected accounts</h3></div></div>
        <div id="ccRetailers" class="retailer-list"><p class="muted">No retailer accounts yet.</p></div>
      </article>
    </div>
    <div class="control-actions">
      <button data-action="new">＋ New fulfilment batch</button>
      <button class="secondary" data-go="bulk">Bulk orders</button>
      <button class="secondary" data-go="cards">Cards & funding</button>
      <button class="secondary" data-go="payments">Payments</button>
    </div>
  `;
  const main=document.querySelector('main');
  const anchor=document.querySelector('.command-dashboard')||main.firstElementChild;
  anchor.before(section);

  const $=s=>section.querySelector(s);
  const number=v=>new Intl.NumberFormat('en-IN').format(Number(v||0));

  async function load(){
    try{
      const response=await fetch('/api/control-center',{headers:{accept:'application/json'}});
      if(!response.ok)return;
      const data=await response.json();
      $('#ccCustomers').textContent=number(data.customers);
      $('#ccAccounts').textContent=number(data.accounts?.total);
      $('#ccAccountReady').textContent=number(data.accounts?.credentials_stored)+' credentials ready';
      $('#ccOrders').textContent=number(data.orders?.total);
      $('#ccOrderReady').textContent=number(data.orders?.ready)+' ready';
      $('#ccConfirmed').textContent=number(data.orders?.confirmed);
      $('#ccCards').textContent=number(data.cards?.total);
      $('#ccCardsNeeded').textContent=number(data.orders?.cards_needed)+' needed';
      $('#ccCredentials').textContent=number(data.accounts?.credentials_stored);
      $('#ccAuthenticated').textContent=number(data.accounts?.authenticated);
      $('#ccAccountAttention').textContent=number(data.accounts?.needs_attention);
      $('#ccReady').textContent=number(data.orders?.ready);
      $('#ccProgress').textContent=number(data.orders?.in_progress);
      $('#ccAttention').textContent=number(data.orders?.needs_attention);
      $('#ccProgramme').textContent=data.cards?.programme_connected?'Connected':'Setup required';
      $('#ccBound').textContent=number(data.orders?.cards_bound);
      $('#ccNeedCards').textContent=number(data.orders?.cards_needed);
      const retailers=data.retailers||[];
      $('#ccRetailers').innerHTML=retailers.length?retailers.map(r=>`<div><span>${String(r.retailer).replace(/^store:/,'')}</span><strong>${number(r.accounts)}</strong></div>`).join(''):'<p class="muted">No retailer accounts yet.</p>';
    }catch{}
  }

  section.addEventListener('click',event=>{
    const go=event.target.closest('[data-go]');
    if(go){document.querySelector('[data-view="'+go.dataset.go+'"]')?.click();return}
    if(event.target.closest('[data-action="new"]'))document.querySelector('#newBatch')?.click();
  });
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,5000);
  load();
})();