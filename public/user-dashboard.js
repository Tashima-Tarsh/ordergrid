(()=>{
  const command=document.querySelector('.command-dashboard .overview-shell');
  if(!command)return;
  const $=s=>document.querySelector(s);
  const esc=value=>{const d=document.createElement('div');d.textContent=String(value??'');return d.innerHTML};
  const number=value=>new Intl.NumberFormat('en-IN').format(Number(value||0));
  const moneyMinor=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)/100);
  const dateText=value=>value?new Date(value).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}):'—';
  let data={users:[],recentOrders:[],totals:{}};

  const section=document.createElement('section');
  section.className='user-dashboard';
  section.innerHTML=`
    <div class="user-dashboard-head">
      <div>
        <p class="eyebrow">USER-WISE OPERATIONS</p>
        <h3>User performance & financial trail</h3>
        <p>Filter the current dealer workspace by user. Orders, refunds, rewards, cards, GST activity and intervention load remain tied to the person who created the fulfilment batch.</p>
      </div>
      <div class="user-dashboard-actions">
        <button type="button" class="secondary" id="userDashExcel">Download Excel</button>
        <button type="button" class="secondary" id="userDashCsv">Download CSV</button>
      </div>
    </div>

    <div class="user-dashboard-filters">
      <label>User<select id="userDashUser"><option value="">All users</option></select></label>
      <label>From<input id="userDashFrom" type="date"></label>
      <label>To<input id="userDashTo" type="date"></label>
      <button type="button" id="userDashApply">Apply</button>
      <button type="button" class="secondary" id="userDashClear">Clear</button>
    </div>

    <div class="user-dashboard-kpis">
      <article><span>ORDERS</span><strong id="udOrders">0</strong><small id="udConfirmed">0 confirmed</small></article>
      <article><span>ORDER VALUE</span><strong id="udOrderValue">₹0</strong><small id="udConfirmedValue">₹0 confirmed</small></article>
      <article><span>REFUNDS</span><strong id="udRefunds">₹0</strong><small id="udPendingRefunds">₹0 pending</small></article>
      <article><span>REWARDS</span><strong id="udRewards">0</strong><small>Net retailer reward units</small></article>
      <article><span>CARDS USED</span><strong id="udCards">0</strong><small id="udCardsCreated">0 created</small></article>
      <article><span>GST INVOICES</span><strong id="udInvoices">0</strong><small id="udInvoiceValue">₹0 invoice value</small></article>
      <article><span>NEEDS ACTION</span><strong id="udAttention">0</strong><small>Orders / human intervention</small></article>
      <article><span>BATCHES</span><strong id="udBatches">0</strong><small id="udUsers">0 users in view</small></article>
    </div>

    <div class="user-dashboard-grid">
      <article class="user-dashboard-card">
        <div class="user-dashboard-card-head"><div><p class="eyebrow">USER SCOREBOARD</p><h4>Users in current scope</h4></div><span id="udUserCount" class="overview-chip">0 USERS</span></div>
        <div class="user-dashboard-table-wrap">
          <table class="user-dashboard-table">
            <thead><tr><th>User</th><th>Orders</th><th>Confirmed</th><th>Value</th><th>Refunds</th><th>Rewards</th><th>Actions</th></tr></thead>
            <tbody id="userDashUsers"><tr><td colspan="7">Loading users…</td></tr></tbody>
          </table>
        </div>
      </article>

      <article class="user-dashboard-card">
        <div class="user-dashboard-card-head"><div><p class="eyebrow">RECENT ACTIVITY</p><h4>Orders with refund & reward context</h4></div><span class="overview-chip" id="udRecentCount">0 ROWS</span></div>
        <div id="userDashRecent" class="user-dashboard-orders"><p class="muted">Loading recent activity…</p></div>
      </article>
    </div>
  `;
  command.appendChild(section);

  async function request(path){
    const response=await fetch(path,{headers:{accept:'application/json'}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function qs(){
    const params=new URLSearchParams();
    const user=$('#userDashUser')?.value,from=$('#userDashFrom')?.value,to=$('#userDashTo')?.value;
    if(user)params.set('userId',user);if(from)params.set('from',from);if(to)params.set('to',to);
    const str=params.toString();return str?'?'+str:'';
  }
  function set(id,value){const node=$(id);if(node)node.textContent=value}
  function populateUsers(users){
    const select=$('#userDashUser');if(!select)return;
    const selected=select.value;
    const options=['<option value="">All users</option>',...users.map(u=>`<option value="${esc(u.user_id)}">${esc(u.email)} · ${esc(u.role)}</option>`)];
    select.innerHTML=options.join('');
    if(users.some(u=>u.user_id===selected))select.value=selected;
  }
  function render(){
    const t=data.totals||{},users=data.users||[],orders=data.recentOrders||[];
    set('#udOrders',number(t.orders));set('#udConfirmed',number(t.confirmed_orders)+' confirmed');
    set('#udOrderValue',moneyMinor(t.order_value_minor));set('#udConfirmedValue',moneyMinor(t.confirmed_value_minor)+' confirmed');
    set('#udRefunds',moneyMinor(t.settled_refund_minor));set('#udPendingRefunds',moneyMinor(t.pending_refund_minor)+' pending');
    set('#udRewards',number(t.reward_units));set('#udCards',number(t.cards_used));set('#udCardsCreated',number(t.cards_created)+' created');
    set('#udInvoices',number(t.gst_invoices));set('#udInvoiceValue',moneyMinor(t.gst_invoice_minor)+' invoice value');
    set('#udAttention',number(Number(t.attention_orders||0)+Number(t.human_actions||0)));
    set('#udBatches',number(t.batches));set('#udUsers',number(t.users)+' users in view');set('#udUserCount',number(users.length)+' USERS');
    set('#udRecentCount',number(orders.length)+' ROWS');

    $('#userDashUsers').innerHTML=users.length?users.map(u=>`
      <tr data-user-id="${esc(u.user_id)}">
        <td><strong>${esc(u.email)}</strong><small>${esc(u.role)}${u.active?'':' · INACTIVE'}</small></td>
        <td>${number(u.orders)}</td>
        <td>${number(u.confirmed_orders)}</td>
        <td>${moneyMinor(u.order_value_minor)}</td>
        <td>${moneyMinor(u.settled_refund_minor)}<small>${number(u.refunds)} records</small></td>
        <td>${number(u.reward_units)}</td>
        <td>${number(Number(u.attention_orders||0)+Number(u.human_actions||0))}</td>
      </tr>`).join(''):'<tr><td colspan="7">No users match this filter.</td></tr>';

    $('#userDashRecent').innerHTML=orders.length?orders.slice(0,40).map(order=>`
      <div class="user-dashboard-order">
        <div>
          <strong>${esc(order.user_email)} · ${esc(order.retailer)}</strong>
          <span>${esc(order.customer_reference||order.recipient||order.order_id)} · ${esc(order.retailer_order_id||'No retailer ID yet')}</span>
          <small>${dateText(order.created_at)} · ${esc(order.retailer_account_reference||'Account unassigned')}</small>
        </div>
        <div><span>STATUS</span><strong>${esc(order.status)}</strong><small>${esc(order.failure_code||'')}</small></div>
        <div><span>ORDER</span><strong>${moneyMinor(order.amount_minor)}</strong><small>${esc(order.virtual_card_masked||'No card')}</small></div>
        <div><span>REFUND</span><strong>${moneyMinor(order.refund_minor)}</strong><small>${esc(order.refund_status||'—')}</small></div>
        <div><span>REWARD</span><strong>${number(order.reward_units)}</strong><small>units</small></div>
      </div>`).join(''):'<div class="user-dashboard-empty">No order activity for this filter.</div>';
  }
  async function load({refreshUsers=true}={}){
    const button=$('#userDashApply');if(button){button.disabled=true;button.textContent='Loading…'}
    try{
      const result=await request('/api/dashboard/users'+qs());
      data=result;
      if(refreshUsers){
        const currentUser=$('#userDashUser')?.value;
        const base=await request('/api/dashboard/users');
        populateUsers(base.users||[]);
        if(currentUser&&[...(base.users||[])].some(u=>u.user_id===currentUser))$('#userDashUser').value=currentUser;
      }
      render();
    }catch(error){
      $('#userDashRecent').innerHTML='<div class="user-dashboard-empty">Dashboard data could not load: '+esc(error.message)+'</div>';
    }finally{if(button){button.disabled=false;button.textContent='Apply'}}
  }
  function download(type){window.location.assign('/api/reports/user-dashboard.'+type+qs())}
  $('#userDashApply')?.addEventListener('click',()=>load({refreshUsers:false}));
  $('#userDashClear')?.addEventListener('click',()=>{$('#userDashUser').value='';$('#userDashFrom').value='';$('#userDashTo').value='';load({refreshUsers:false})});
  $('#userDashExcel')?.addEventListener('click',()=>download('xlsx'));
  $('#userDashCsv')?.addEventListener('click',()=>download('csv'));
  $('#userDashUsers')?.addEventListener('click',event=>{
    const row=event.target.closest('[data-user-id]');if(!row)return;
    $('#userDashUser').value=row.dataset.userId;load({refreshUsers:false});
  });
  window.addEventListener('ordergrid:update',()=>load({refreshUsers:false}));
  window.addEventListener('ordergrid:bulk-refresh',()=>load({refreshUsers:false}));
  setInterval(()=>load({refreshUsers:false}),30000);
  load();
})();