(()=>{
const automations=[
  {id:'validate',icon:'✓',name:'File validation',desc:'Check columns, addresses and duplicate records.',on:true},
  {id:'price',icon:'₹',name:'Price guard',desc:'Pause checkout when the estimate changes.',on:true},
  {id:'offline',icon:'↻',name:'Offline recovery',desc:'Resume prepared work after connectivity returns.',on:true},
  {id:'retry',icon:'⟳',name:'Failure recovery',desc:'Retry temporary connector failures safely.',on:true},
  {id:'invoice',icon:'G',name:'GST reconciliation',desc:'Match invoices with orders and settlements.',on:true},
  {id:'rewards',icon:'★',name:'Rewards ledger',desc:'Track estimated and confirmed SuperCoins.',on:true},
  {id:'notify',icon:'↗',name:'Customer updates',desc:'Prepare consolidated completion notifications.',on:false},
  {id:'watch',icon:'◉',name:'Availability watch',desc:'Keep unavailable products in the action queue.',on:false}
];
const prefKey='ordergrid-automations',lastSyncKey='ordergrid-last-sync';
let prefs={};try{prefs=JSON.parse(localStorage.getItem(prefKey))||{}}catch{}
automations.forEach(a=>{if(!(a.id in prefs))prefs[a.id]=a.on});
const grid=document.querySelector('#automationGrid');
grid.innerHTML=automations.map(a=>`<label class="automation-card"><span class="automation-icon">${a.icon}</span><span class="automation-copy"><strong>${a.name}</strong><small>${a.desc}</small></span><input type="checkbox" data-automation="${a.id}" ${prefs[a.id]?'checked':''}><span class="toggle"></span></label>`).join('');
function data(){try{return JSON.parse(localStorage.getItem('ordergrid-demo'))||{}}catch{return{}}}
function update(){
  const s=data(),tasks=s.tasks||[],batches=s.batches||[],settlements=s.settlements||[],pending=tasks.filter(t=>!t.settled),online=navigator.onLine,active=Object.values(prefs).filter(Boolean).length;
  document.body.classList.toggle('offline',!online);
  document.querySelector('#networkStatus').textContent=online?'Ready':'Check connection';
  document.querySelector('#brainStatus').textContent=online?'READY':'PAUSED';
  document.querySelector('#queueCount').textContent=`${pending.length} ${pending.length===1?'order':'orders'}`;
  document.querySelector('#automationCount').textContent=`${active} active`;
  document.querySelector('#answerRequested').textContent=tasks.length;
  document.querySelector('#answerEligible').textContent=tasks.length;
  document.querySelector('#answerPlaced').textContent=settlements.length;
  document.querySelector('#answerPending').textContent=pending.length;
  const exceptions=[];
  if(!online&&pending.length)exceptions.push(`${pending.length} approved orders will continue when your connection returns.`);
  if(tasks.length&&!settlements.length&&online)exceptions.push('Payment authorization is required to place approved orders.');
  if(batches.some(b=>!['Amazon India','Flipkart'].includes(b.store)))exceptions.push('One or more store orders need review.');
  document.querySelector('#exceptionCount').textContent=`${exceptions.length} open`;
  document.querySelector('#exceptionBadge').textContent=exceptions.length?'ACTION':'CLEAR';
  document.querySelector('#exceptionList').innerHTML=exceptions.length?exceptions.map(x=>`<div class="exception-item"><b></b><span>${x}</span></div>`).join(''):'<p>No intervention required.</p>';
  const badge=document.querySelector('#outcomeBadge'),answer=document.querySelector('#brainAnswer'),next=document.querySelector('#nextAction');
  if(!tasks.length){badge.textContent='AWAITING INPUT';answer.textContent='Upload a requirement to receive a consolidated validation, payment and fulfilment answer.';next.textContent='Create a fulfilment batch to begin validation.'}
  else if(pending.length&&!online){badge.textContent='PAUSED';answer.textContent=`${tasks.length} orders are prepared. ${pending.length} will continue when your connection returns.`;next.textContent='You can return to this page after your connection is restored.'}
  else if(pending.length){badge.textContent='READY';answer.textContent=`${tasks.length} orders are prepared. ${pending.length} are ready to continue.`;next.textContent='Review the order total and continue checkout.'}
  else{badge.textContent='COMPLETED';answer.textContent=`All ${settlements.length} orders are complete with payment and invoice records.`;next.textContent='Download records or create the next fulfilment batch.'}
}
grid.addEventListener('change',e=>{const id=e.target.dataset.automation;if(!id)return;prefs[id]=e.target.checked;localStorage.setItem(prefKey,JSON.stringify(prefs));update();document.querySelector('#toast').textContent=`${automations.find(a=>a.id===id).name} ${prefs[id]?'enabled':'paused'}`;document.querySelector('#toast').classList.add('show');setTimeout(()=>document.querySelector('#toast').classList.remove('show'),1800)});
document.querySelector('#syncNow').onclick=()=>{const b=document.querySelector('#syncNow');b.disabled=true;b.textContent=navigator.onLine?'Refreshing…':'Waiting for connection';setTimeout(()=>{if(navigator.onLine){localStorage.setItem(lastSyncKey,new Date().toISOString());b.textContent='Updated';update()}setTimeout(()=>{b.disabled=false;b.textContent='Refresh'},1200)},900)};
document.querySelector('#healthCheck').onclick=()=>{const b=document.querySelector('#healthCheck');b.disabled=true;b.textContent='Reviewing…';setTimeout(()=>{b.textContent='All clear';setTimeout(()=>{b.disabled=false;b.textContent='Review orders'},1400)},1100)};
window.addEventListener('online',update);window.addEventListener('offline',update);window.addEventListener('storage',update);window.addEventListener('ordergrid:update',update);setInterval(update,2500);const manifest=document.createElement('link');manifest.rel='manifest';manifest.href='manifest.webmanifest';document.head.appendChild(manifest);if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});update();
})();
