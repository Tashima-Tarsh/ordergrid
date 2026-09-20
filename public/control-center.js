(()=>{
  const section=document.createElement('section');
  section.className='control-center';
  section.innerHTML=`
    <div class="control-hero">
      <div>
        <p class="eyebrow">CONTROL CENTER</p>
        <h2 id="ccDealerName">Everything in one place</h2>
        <p>See dealer network, account readiness, checkout, cards and confirmed orders.</p>
      </div>
      <span class="control-available"><b></b> Checkout available</span>
    </div>

    <section class="dealer-network">
      <div class="dealer-network-head">
        <div><span>DEALER NETWORK</span><h3>Main dealer & sub-dealers</h3><p>Each dealer keeps its own users, customer accounts, orders and funding.</p></div>
        <div class="dealer-network-actions">
          <button class="secondary" id="ccManageUsers">Manage users</button>
          <button id="ccAddDealer" hidden>＋ Add sub-dealer</button>
        </div>
      </div>
      <div id="ccDealerList" class="dealer-list"><p class="muted">Loading dealer network…</p></div>
    </section>

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

  const dialog=document.createElement('dialog');
  dialog.className='dealer-dialog';
  dialog.innerHTML=`
    <form id="dealerCreateForm" method="dialog">
      <div class="dialog-head"><div><small>NEW SUB-DEALER</small><h3>Create dealer workspace</h3></div><button type="button" class="secondary" data-close>×</button></div>
      <p class="dialog-copy">The sub-dealer receives its own users, retailer accounts, addresses, orders, cards and funding setup.</p>
      <label>Dealer name<input name="name" required minlength="2" maxlength="120" placeholder="North Region Dealer"></label>
      <label>Owner email<input name="ownerEmail" type="email" required placeholder="owner@example.com"></label>
      <label>Owner password<input name="ownerPassword" type="password" required minlength="14" autocomplete="new-password"></label>
      <p class="form-error" id="dealerCreateError"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit">Create sub-dealer</button></div>
    </form>`;
  document.body.appendChild(dialog);

  const usersDialog=document.createElement('dialog');
  usersDialog.className='dealer-dialog dealer-users-dialog';
  usersDialog.innerHTML=`
    <div class="dialog-head"><div><small>DEALER USERS</small><h3>People & permissions</h3></div><button type="button" class="secondary" data-close>×</button></div>
    <div id="dealerUsersList" class="dealer-users-list"><p class="muted">Loading users…</p></div>
    <form id="dealerUserForm">
      <div class="user-form-grid">
        <label>Email<input name="email" type="email" required></label>
        <label>Role<select name="role"><option value="BUYER">Buyer</option><option value="APPROVER">Approver</option><option value="AUDITOR">Auditor</option><option value="OWNER">Owner</option></select></label>
        <label class="user-password">Password for a new user<input name="password" type="password" minlength="14" autocomplete="new-password" placeholder="Leave blank if user already exists"></label>
      </div>
      <p class="form-error" id="dealerUserError"></p>
      <button type="submit">Add or update user</button>
    </form>`;
  document.body.appendChild(usersDialog);

  const $=s=>section.querySelector(s);
  const number=v=>new Intl.NumberFormat('en-IN').format(Number(v||0));
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  let network=null;

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function renderNetwork(data){
    network=data;
    const dealers=data.dealers||[];
    const active=dealers.find(d=>d.active);
    $('#ccDealerName').textContent=active?active.name:'Everything in one place';
    $('#ccAddDealer').hidden=!data.canCreateSubdealer;
    $('#ccDealerList').innerHTML=dealers.length?dealers.map(d=>`
      <article class="dealer-row ${d.active?'active':''}">
        <div class="dealer-identity">
          <span class="dealer-type">${d.dealer_type==='MAIN'?'MAIN DEALER':'SUB-DEALER'}</span>
          <strong>${esc(d.name)}</strong>
          <small>${number(d.user_count)} users · ${number(d.retailer_account_count)} retailer accounts</small>
        </div>
        <div class="dealer-metric"><span>Customers</span><strong>${number(d.customer_count)}</strong></div>
        <div class="dealer-metric"><span>Orders</span><strong>${number(d.order_count)}</strong></div>
        <div class="dealer-metric"><span>Confirmed</span><strong>${number(d.confirmed_count)}</strong></div>
        <div class="dealer-metric"><span>Cards</span><strong>${number(d.virtual_card_count)}</strong></div>
        <div class="dealer-funding"><span class="${d.funding_connected?'ready':'setup'}">${d.funding_connected?'Funding ready':'Funding setup'}</span></div>
        <div class="dealer-open">${d.active?'<span class="active-dealer">Current</span>':'<button class="secondary" data-switch-dealer="'+esc(d.id)+'">Open</button>'}</div>
      </article>
    `).join(''):'<p class="muted">No dealer workspaces available.</p>';
  }

  async function loadNetwork(){
    try{renderNetwork(await request('/api/dealer-network'))}catch{}
  }

  async function loadControl(){
    try{
      const data=await request('/api/control-center');
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
      $('#ccRetailers').innerHTML=retailers.length?retailers.map(r=>`<div><span>${esc(String(r.retailer).replace(/^store:/,''))}</span><strong>${number(r.accounts)}</strong></div>`).join(''):'<p class="muted">No retailer accounts yet.</p>';
    }catch{}
  }

  async function loadUsers(){
    const target=usersDialog.querySelector('#dealerUsersList');
    target.innerHTML='<p class="muted">Loading users…</p>';
    try{
      const data=await request('/api/dealer-users');
      target.innerHTML=(data.users||[]).length?(data.users||[]).map(u=>`
        <div class="dealer-user-row" data-user-id="${esc(u.id)}">
          <div><strong>${esc(u.email)}</strong><small>${u.home_user?'Dealer user':'Shared access'}</small></div>
          <span>${esc(u.role)}</span>
          <button class="secondary" data-remove-user="${esc(u.id)}">Remove</button>
        </div>`).join(''):'<p class="muted">No users yet.</p>';
    }catch(error){target.innerHTML='<p class="form-error">'+esc(error.message)+'</p>'}
  }

  section.addEventListener('click',async event=>{
    const go=event.target.closest('[data-go]');
    if(go){if(typeof window.ordergridNavigate==='function')window.ordergridNavigate(go.dataset.go);else document.querySelector('.app-sidebar button[data-view="'+go.dataset.go+'"]')?.click();return}
    if(event.target.closest('[data-action="new"]')){document.querySelector('#newBatch')?.click();return}
    if(event.target.closest('#ccAddDealer')){dialog.showModal();return}
    if(event.target.closest('#ccManageUsers')){usersDialog.showModal();await loadUsers();return}
    const switcher=event.target.closest('[data-switch-dealer]');
    if(switcher){
      switcher.disabled=true;
      try{
        await request('/api/dealer-context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tenantId:switcher.dataset.switchDealer})});
        localStorage.setItem('ordergrid-view','control');
        location.reload();
      }catch(error){alert(error.message);switcher.disabled=false}
    }
  });

  dialog.addEventListener('click',e=>{if(e.target.closest('[data-close]'))dialog.close()});
  usersDialog.addEventListener('click',async e=>{
    if(e.target.closest('[data-close]')){usersDialog.close();return}
    const remove=e.target.closest('[data-remove-user]');
    if(remove){
      if(!confirm('Remove this person from the current dealer?'))return;
      remove.disabled=true;
      try{await request('/api/dealer-users/'+encodeURIComponent(remove.dataset.removeUser),{method:'DELETE'});await loadUsers();await loadNetwork()}
      catch(error){alert(error.message);remove.disabled=false}
    }
  });

  dialog.querySelector('#dealerCreateForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const form=e.currentTarget,button=form.querySelector('button[type="submit"]'),fd=new FormData(form);
    dialog.querySelector('#dealerCreateError').textContent='';
    button.disabled=true;button.textContent='Creating…';
    try{
      await request('/api/dealers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:fd.get('name'),ownerEmail:fd.get('ownerEmail'),ownerPassword:fd.get('ownerPassword')})});
      form.reset();dialog.close();await loadNetwork();if(window.toast)window.toast('Sub-dealer created');
    }catch(error){dialog.querySelector('#dealerCreateError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Create sub-dealer'}
  });

  usersDialog.querySelector('#dealerUserForm').addEventListener('submit',async e=>{
    e.preventDefault();
    const form=e.currentTarget,button=form.querySelector('button[type="submit"]'),fd=new FormData(form);
    usersDialog.querySelector('#dealerUserError').textContent='';
    button.disabled=true;
    const payload={email:fd.get('email'),role:fd.get('role')};
    if(String(fd.get('password')||''))payload.password=fd.get('password');
    try{
      await request('/api/dealer-users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      form.reset();await loadUsers();await loadNetwork();if(window.toast)window.toast('User access updated');
    }catch(error){usersDialog.querySelector('#dealerUserError').textContent=error.message}
    finally{button.disabled=false}
  });

  async function load(){await Promise.all([loadNetwork(),loadControl()])}
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,15000);
  load();
})();