(()=>{
  const section=document.createElement('section');
  section.className='control-center';
  section.innerHTML=`
    <div class="control-hero">
      <div>
        <p class="eyebrow">CONTROL CENTER</p>
        <h2>Users & operations</h2>
        <p>Manage users, retailer-account readiness, checkout, cards and confirmed orders from one workspace.</p>
      </div>
      <span class="control-available"><b></b> Checkout available</span>
    </div>

    <section class="user-access-panel">
      <div class="user-access-head">
        <div><span>USERS & PERMISSIONS</span><h3>Users</h3><p>Every user works in this OrderGrid workspace with an explicit role and auditable actions.</p></div>
        <button class="secondary" id="ccAddUser">＋ Add user</button>
      </div>
      <div id="ccUserList" class="user-access-list"><p class="muted">Loading users…</p></div>
    </section>

    <div class="control-kpis">
      <article><span>USERS</span><strong id="ccUsers">0</strong><small>Active workspace users</small></article>
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
  dialog.className='user-dialog';
  dialog.innerHTML=`
    <form id="workspaceUserForm">
      <div class="dialog-head"><div><small>WORKSPACE USER</small><h3>Add or update user</h3></div><button type="button" class="secondary" data-close>×</button></div>
      <p class="dialog-copy">Give each person only the role they need. Existing users can be updated without creating another account.</p>
      <label>Email<input name="email" type="email" required></label>
      <label>Role<select name="role"><option value="BUYER">Buyer</option><option value="APPROVER">Approver</option><option value="AUDITOR">Auditor</option><option value="OWNER">Owner</option></select></label>
      <label>Password for a new user<input name="password" type="password" minlength="14" autocomplete="new-password"><small>Leave blank when updating an existing user.</small></label>
      <p class="form-error" id="workspaceUserError"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-close>Cancel</button><button type="submit">Save user</button></div>
    </form>`;
  document.body.appendChild(dialog);

  const $=s=>section.querySelector(s);
  const number=v=>new Intl.NumberFormat('en-IN').format(Number(v||0));
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  let users=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function renderUsers(){
    $('#ccUsers').textContent=number(users.filter(u=>u.active!==false).length);
    $('#ccUserList').innerHTML=users.length?users.map(u=>`
      <article class="workspace-user-row">
        <div class="workspace-user-identity"><span>USER</span><strong>${esc(u.email)}</strong><small>${esc(u.role)} · ${u.active===false?'Inactive':'Active'}</small></div>
        <div class="workspace-user-role"><span>ROLE</span><strong>${esc(u.role)}</strong></div>
        <div class="workspace-user-actions">${u.current_user?'<span class="current-user-chip">YOU</span>':'<button class="secondary" data-edit-user="'+esc(u.id)+'">Edit</button><button class="secondary danger-soft" data-remove-user="'+esc(u.id)+'">Remove</button>'}</div>
      </article>
    `).join(''):'<p class="muted">No users found.</p>';
  }

  async function loadUsers(){
    try{
      const data=await request('/api/users');
      users=data.users||[];
      renderUsers();
    }catch(error){
      $('#ccUserList').innerHTML='<p class="form-error">'+esc(error.message)+'</p>';
    }
  }

  async function loadControl(){
    try{
      const data=await request('/api/control-center');
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

  section.addEventListener('click',async event=>{
    const go=event.target.closest('[data-go]');
    if(go){window.ordergridNavigate?.(go.dataset.go);return}
    if(event.target.closest('[data-action="new"]')){document.querySelector('#newBatch')?.click();return}
    if(event.target.closest('#ccAddUser')){dialog.querySelector('#workspaceUserForm').reset();dialog.querySelector('#workspaceUserError').textContent='';dialog.showModal();return}
    const edit=event.target.closest('[data-edit-user]');
    if(edit){
      const user=users.find(u=>u.id===edit.dataset.editUser);if(!user)return;
      const form=dialog.querySelector('#workspaceUserForm');
      form.elements.email.value=user.email;form.elements.role.value=user.role;form.elements.password.value='';
      dialog.querySelector('#workspaceUserError').textContent='';dialog.showModal();return;
    }
    const remove=event.target.closest('[data-remove-user]');
    if(remove){
      if(!confirm('Remove this user from OrderGrid?'))return;
      remove.disabled=true;
      try{await request('/api/users/'+encodeURIComponent(remove.dataset.removeUser),{method:'DELETE'});await loadUsers();window.toast?.('User removed')}
      catch(error){alert(error.message);remove.disabled=false}
    }
  });

  dialog.addEventListener('click',event=>{if(event.target.closest('[data-close]'))dialog.close()});
  dialog.querySelector('#workspaceUserForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,button=form.querySelector('button[type="submit"]'),fd=new FormData(form);
    dialog.querySelector('#workspaceUserError').textContent='';button.disabled=true;button.textContent='Saving…';
    const payload={email:String(fd.get('email')||''),role:String(fd.get('role')||'BUYER')};
    if(String(fd.get('password')||''))payload.password=String(fd.get('password'));
    try{
      await request('/api/users',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      dialog.close();form.reset();await loadUsers();window.toast?.('User saved');
    }catch(error){dialog.querySelector('#workspaceUserError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Save user'}
  });

  async function load(){await Promise.all([loadUsers(),loadControl()])}
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  window.addEventListener('ordergrid:auth-ready',load);
  setInterval(load,15000);
  load();
})();
