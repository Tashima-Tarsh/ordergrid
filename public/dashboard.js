(()=>{
const style=document.createElement('link');style.rel='stylesheet';style.href='overview-premium.css';document.head.appendChild(style);
const command=document.querySelector('.command-dashboard');
if(!command)return;
command.classList.add('premium-overview');
command.innerHTML=`
  <div class="overview-shell">
    <section class="overview-hero">
      <div class="overview-hero-top">
        <div class="overview-brandline">
          <span class="overview-live-mark" aria-hidden="true"><i></i></span>
          <div><p class="eyebrow">LIVE EXECUTIVE OVERVIEW</p><h2>OrderGrid command</h2></div>
        </div>
        <span id="brainStatus" class="overview-status">CHECKING</span>
      </div>
      <div class="overview-primary">
        <div class="overview-primary-copy">
          <h3>Procurement command,<br>without the noise.</h3>
          <p id="brainAnswer">Loading live order, dealer and automation status…</p>
        </div>
        <div class="overview-exposure">
          <span>APPROVED EXPOSURE</span>
          <strong id="ovExposure">₹0</strong>
          <small id="ovExposureMeta">Across active procurement</small>
        </div>
      </div>
      <div class="overview-kpis">
        <div class="overview-kpi"><span>ORDER STATUS</span><strong id="networkStatus">Live</strong></div>
        <div class="overview-kpi"><span>READY TO PLACE</span><strong id="queueCount">0 orders</strong></div>
        <div class="overview-kpi"><span>AUTOMATION</span><strong id="automationCount">Checking</strong></div>
        <div class="overview-kpi"><span>NEEDS ATTENTION</span><strong id="exceptionCount">0 open</strong></div>
      </div>
      <div class="overview-hero-actions">
        <button id="syncNow" class="secondary">Refresh overview</button>
        <button id="healthCheck">Review operations</button>
        <button id="ovNewBatch" class="secondary">＋ New batch</button>
      </div>
    </section>

    <section class="overview-healthbar" aria-label="Operational readiness">
      <div class="overview-health-item"><span class="overview-health-icon">A</span><div><span>AUTOPILOT</span><strong id="ovAutopilot">Checking</strong></div></div>
      <div class="overview-health-item"><span class="overview-health-icon">₹</span><div><span>PRICE GUARD</span><strong id="ovPriceGuard">Checking</strong></div></div>
      <div class="overview-health-item"><span class="overview-health-icon">◆</span><div><span>CARD PROGRAMME</span><strong id="ovCards">Checking</strong></div></div>
      <div class="overview-health-item"><span class="overview-health-icon">ID</span><div><span>RETAILER ACCOUNTS</span><strong id="ovAccounts">Checking</strong></div></div>
    </section>

    <div class="overview-grid">
      <article class="overview-card">
        <div class="overview-section-head">
          <div><p class="eyebrow">ORDER PROGRESSION</p><h3>Portfolio movement</h3></div>
          <span id="outcomeBadge" class="overview-chip">LOADING</span>
        </div>
        <div class="overview-progress-grid">
          <div><strong id="answerRequested">0</strong><span>Total orders</span></div>
          <div><strong id="answerEligible">0</strong><span>Eligible now</span></div>
          <div><strong id="answerPlaced">0</strong><span>Confirmed</span></div>
          <div><strong id="answerPending">0</strong><span>Pending</span></div>
        </div>
        <div class="overview-progress-track" aria-hidden="true"><i id="ovProgressBar"></i></div>
        <p id="nextAction" class="overview-next">Loading the next recommended operational action.</p>
      </article>

      <article class="overview-card">
        <div class="overview-section-head">
          <div><p class="eyebrow">ACTION CENTRE</p><h3>Exceptions & intervention</h3></div>
          <span id="exceptionBadge" class="overview-chip">CHECKING</span>
        </div>
        <div id="exceptionList" class="overview-exceptions"><p>Reviewing live controls…</p></div>
      </article>
    </div>

    <div class="overview-network">
      <section class="overview-network-panel">
        <div class="overview-section-head">
          <div><p class="eyebrow">DEALER NETWORK</p><h3>Current operating scope</h3></div>
          <button class="secondary" id="ovOpenControl">Open Control Center</button>
        </div>
        <h4 class="overview-dealer-name" id="ovDealerName">Current dealer</h4>
        <p class="overview-dealer-meta" id="ovDealerMeta">Loading dealer hierarchy…</p>
        <div class="overview-network-stats">
          <div class="overview-network-stat"><span>DEALERS</span><strong id="ovDealerCount">0</strong></div>
          <div class="overview-network-stat"><span>CUSTOMERS</span><strong id="ovCustomerCount">0</strong></div>
          <div class="overview-network-stat"><span>RETAILER ACCOUNTS</span><strong id="ovRetailerCount">0</strong></div>
        </div>
      </section>

      <section class="overview-pulse">
        <div class="overview-section-head"><div><p class="eyebrow">OPERATING PULSE</p><h3>Policy & capacity</h3></div></div>
        <div class="overview-pulse-list">
          <div class="overview-pulse-row"><span>RUN MODE</span><strong id="ovRunMode">—</strong></div>
          <div class="overview-pulse-row"><span>MAX ACTIVE ORDERS</span><strong id="ovConcurrency">—</strong></div>
          <div class="overview-pulse-row"><span>FAILURE PAUSE</span><strong id="ovFailureGuard">—</strong></div>
          <div class="overview-pulse-row"><span>BATCH VARIANCE</span><strong id="ovBatchVariance">—</strong></div>
        </div>
        <p class="overview-refresh-time" id="ovRefreshTime">Waiting for first refresh.</p>
      </section>
    </div>
  </div>`;

const $=s=>command.querySelector(s);
const number=v=>new Intl.NumberFormat('en-IN').format(Number(v||0));
const money=v=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(v||0)/100);
const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
let attentionCount=0;

async function request(path){
  const response=await fetch(path,{headers:{accept:'application/json'}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
  return body;
}
function set(id,value){const el=$(id);if(el)el.textContent=value}
function navigate(view){if(typeof window.ordergridNavigate==='function')window.ordergridNavigate(view);else document.querySelector('.app-sidebar button[data-view="'+view+'"]')?.click()}

async function load(){
  const button=$('#syncNow');
  if(button){button.disabled=true;button.textContent='Refreshing…'}
  try{
    const paths=['/api/control-center','/api/automation','/api/automation/preflight','/api/dealer-network','/api/batches','/api/checkout-tasks'];
    const settled=await Promise.allSettled(paths.map(request));
    const value=i=>settled[i].status==='fulfilled'?settled[i].value:{};
    const control=value(0),automation=value(1),preflight=value(2),network=value(3),batchData=value(4),taskData=value(5);
    const policy=automation.policy||preflight.policy||{};
    const orders=control.orders||{};
    const accounts=control.accounts||{};
    const cards=control.cards||{};
    const tasks=taskData.tasks||[];
    const batches=batchData.batches||[];
    const dealers=network.dealers||[];
    const activeDealer=dealers.find(d=>d.active)||dealers[0]||null;

    const requested=Number(orders.total??tasks.length??0);
    const ready=Number(orders.ready??automation.summary?.ready??0);
    const inProgress=Number(orders.in_progress??automation.summary?.inProgress??0);
    const confirmed=Number(orders.confirmed??automation.summary?.confirmed??tasks.filter(t=>['CONFIRMED','SHIPPED','DELIVERED'].includes(t.status)).length);
    const orderAttention=Number(orders.needs_attention??automation.summary?.needsAttention??0);
    const eligible=Number(preflight.eligibleOrders??(ready+inProgress));
    const pending=Math.max(0,requested-confirmed);
    const approvedExposure=Number(preflight.approvedExposureMinor??batches.reduce((sum,b)=>sum+Number(b.estimated_total_minor||0),0));
    const workflows=automation.workflows||[];
    const programmeConnected=Boolean(cards.programme_connected??preflight.cardProgrammeConnected);
    const accountsTotal=Number(accounts.total||0);
    const credentialsReady=Number(accounts.credentials_stored||0);

    const exceptions=[];
    if(orderAttention>0)exceptions.push(orderAttention+' order'+(orderAttention===1?'':'s')+' require operational review.');
    if(Number(accounts.needs_attention||0)>0)exceptions.push(number(accounts.needs_attention)+' retailer account'+(Number(accounts.needs_attention)===1?'':'s')+' need authentication or credential attention.');
    if(Number(orders.cards_needed||0)>0&&!programmeConnected)exceptions.push(number(orders.cards_needed)+' order'+(Number(orders.cards_needed)===1?'':'s')+' need cards, but the card programme is not connected.');
    if(policy.automation_enabled===false)exceptions.push('Autopilot is paused for the current dealer.');
    if(Number(preflight.needsAttention||0)>orderAttention)exceptions.push(number(preflight.needsAttention)+' order checks need attention before Autopilot can advance.');
    attentionCount=exceptions.length;

    set('#answerRequested',number(requested));
    set('#answerEligible',number(eligible));
    set('#answerPlaced',number(confirmed));
    set('#answerPending',number(pending));
    set('#queueCount',number(ready)+' '+(ready===1?'order':'orders'));
    set('#automationCount',(workflows.length||8)+' workflows');
    set('#exceptionCount',exceptions.length+' open');
    set('#ovExposure',money(approvedExposure));
    set('#ovExposureMeta',batches.length?number(batches.length)+' active / historical batches':'No approved batch exposure yet');
    set('#brainStatus',exceptions.length?'ATTENTION':'HEALTHY');
    set('#networkStatus',navigator.onLine?'Live':'Offline');
    set('#outcomeBadge',requested===0?'AWAITING INPUT':pending===0?'COMPLETE':exceptions.length?'REVIEW':'IN MOTION');
    set('#exceptionBadge',exceptions.length?'ACTION':'CLEAR');

    const completion=requested?Math.min(100,Math.round(confirmed/requested*100)):0;
    const bar=$('#ovProgressBar');if(bar)bar.style.width=completion+'%';

    if(!requested){
      set('#brainAnswer','The command layer is ready. Create a fulfilment batch to begin live procurement tracking.');
      set('#nextAction','Create the first fulfilment batch to establish approved value, recipients and order flow.');
    }else if(exceptions.length){
      set('#brainAnswer',number(requested)+' orders are under management. '+number(orderAttention||preflight.needsAttention||exceptions.length)+' need attention before the portfolio can advance cleanly.');
      set('#nextAction','Review the flagged order, account or payment controls before increasing automation.');
    }else if(pending>0){
      set('#brainAnswer',number(requested)+' orders are under management with '+number(confirmed)+' retailer-confirmed. The remaining portfolio can continue within current policy.');
      set('#nextAction',ready>0?'Continue the '+number(ready)+' ready order'+(ready===1?'':'s')+' or start Autopilot.':'No intervention is required; monitor retailer confirmation.');
    }else{
      set('#brainAnswer','All '+number(confirmed)+' managed orders are retailer-confirmed. The current portfolio is reconciled.');
      set('#nextAction','The portfolio is clear. Start the next fulfilment batch when ready.');
    }

    const exceptionList=$('#exceptionList');
    if(exceptionList)exceptionList.innerHTML=exceptions.length?exceptions.slice(0,5).map(x=>'<div class="overview-exception"><b></b><span>'+esc(x)+'</span></div>').join(''):'<p>No intervention required. Current orders and controls are within policy.</p>';

    set('#ovAutopilot',policy.automation_enabled===false?'Paused':(String(policy.run_mode||'MANUAL')==='CONTINUOUS'?'Continuous':'Ready'));
    set('#ovPriceGuard','+'+Number(policy.max_price_increase_percent??5)+'% ceiling');
    set('#ovCards',programmeConnected?'Connected':(Number(orders.cards_needed||0)>0?'Setup required':'Not required yet'));
    set('#ovAccounts',accountsTotal?number(credentialsReady)+' / '+number(accountsTotal)+' ready':'No accounts yet');
    set('#ovDealerName',activeDealer?.name||'Current dealer');
    set('#ovDealerMeta',activeDealer?(activeDealer.dealer_type==='MAIN'?'Main Dealer workspace':'Sub-dealer workspace')+' · '+number(activeDealer.user_count||0)+' users':'Dealer scope will appear after sign-in.');
    set('#ovDealerCount',number(dealers.length));
    set('#ovCustomerCount',number(activeDealer?.customer_count??control.customers??0));
    set('#ovRetailerCount',number(activeDealer?.retailer_account_count??accountsTotal));
    set('#ovRunMode',String(policy.run_mode||'MANUAL').replaceAll('_',' '));
    set('#ovConcurrency',number(policy.max_active_orders??8));
    set('#ovFailureGuard',Number(policy.failure_pause_percent??5)+'%');
    set('#ovBatchVariance','+'+Number(policy.max_batch_variance_percent??3)+'%');
    set('#ovRefreshTime','Updated '+new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})+' · live server data');
  }catch(error){
    set('#brainStatus','RETRYING');
    set('#brainAnswer','Live overview is reconnecting. '+error.message+'.');
    set('#networkStatus',navigator.onLine?'Reconnecting':'Offline');
  }finally{
    if(button){button.disabled=false;button.textContent='Refresh overview'}
  }
}

$('#syncNow').onclick=load;
$('#healthCheck').onclick=()=>navigate(attentionCount?'autopilot':'bulk');
$('#ovOpenControl').onclick=()=>navigate('control');
$('#ovNewBatch').onclick=()=>document.querySelector('#newBatch')?.click();
window.addEventListener('online',load);
window.addEventListener('ordergrid:update',load);
window.addEventListener('ordergrid:bulk-refresh',load);
setInterval(load,15000);
setTimeout(load,0);
})();