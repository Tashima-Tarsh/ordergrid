(()=>{
const fulfilmentStyle=document.createElement('link');
fulfilmentStyle.rel='stylesheet';
fulfilmentStyle.href='fulfilment.css';
document.head.appendChild(fulfilmentStyle);

const style=document.createElement('style');
style.textContent=`
body.product-shell{padding-left:216px}
body.product-shell header{padding-left:234px;padding-right:18px}
body.product-shell main{max-width:1600px;width:100%;margin:0 auto;padding:14px 18px 28px}
.menu-trigger{display:none!important}
.app-sidebar{
  position:fixed;z-index:500;pointer-events:auto;isolation:isolate;inset:0 auto 0 0;width:216px;
  padding:16px 12px 18px;background:linear-gradient(180deg,#0b0e13,#10161d 62%,#0d1218);color:#fff;
  border-right:1px solid rgba(255,255,255,.07);box-shadow:12px 0 34px rgba(2,8,18,.08)
}
.sidebar-brand{display:flex;align-items:center;gap:9px;height:42px;padding:0 8px 12px;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.075)}
.sidebar-brand-mark{width:27px;height:27px;display:grid;place-items:center;border-radius:9px;background:#f5f7f8;color:#0e151d;font-size:9px;font-weight:950;letter-spacing:-.04em}
.sidebar-brand strong{display:block;font-size:11px;letter-spacing:.11em}.sidebar-brand small{display:block;margin-top:1px;color:#6f8292;font-size:7px;letter-spacing:.08em}
.nav-label{padding:4px 9px 7px;color:#637687;font-size:8px;font-weight:900;letter-spacing:.13em}
.app-sidebar button{
  position:relative;z-index:2;pointer-events:auto;display:flex;width:100%;align-items:center;gap:10px;
  min-height:37px;padding:7px 9px;margin:2px 0;border:1px solid transparent;border-radius:10px;background:transparent;
  color:#8fa0af;font-size:11px;font-weight:680;text-align:left;box-shadow:none;cursor:pointer;
}
.app-sidebar button:hover{background:rgba(255,255,255,.05);color:#e7edf2;transform:none}
.app-sidebar button.active{background:rgba(255,255,255,.085);border-color:rgba(255,255,255,.075);color:#fff;transform:none}
.nav-icon{
  width:23px;height:23px;display:grid;place-items:center;border-radius:7px;background:rgba(255,255,255,.045);
  color:#7d91a1;font-size:11px;font-weight:900;transition:.16s
}
.app-sidebar button.active .nav-icon{background:#f2f5f7;color:#121820;box-shadow:0 4px 12px rgba(0,0,0,.12)}
.nav-foot{position:absolute;bottom:17px;left:20px;right:20px;padding-top:10px;border-top:1px solid rgba(255,255,255,.07);font-size:8px;color:#617485;letter-spacing:.04em}
.workspace-title{display:flex;align-items:center;justify-content:space-between;gap:14px}
.view-section{display:none!important}
.view-section.view-active{display:block!important}
@media(max-width:900px){
  body.product-shell{padding-left:0}
  body.product-shell header{padding-left:16px;padding-right:16px}
  body.product-shell main{padding:12px 12px 24px}
  .menu-trigger{display:flex!important}
  .app-sidebar{transform:translateX(-100%);transition:.2s;width:min(82vw,270px)}
  body.nav-open .app-sidebar{transform:none}
  body.nav-open:after{content:'';position:fixed;z-index:450;inset:0;background:rgba(2,8,18,.42);backdrop-filter:blur(3px)}
  .workspace-title{align-items:flex-start;flex-direction:column}
}`;
document.head.appendChild(style);
document.body.classList.add('product-shell');

const head=document.querySelector('header');
const menu=document.createElement('button');
menu.className='menu-trigger secondary';
menu.innerHTML='<span>☰</span> Menu';
head.querySelector('.head-actions')?.prepend(menu);

const side=document.createElement('aside');
side.className='app-sidebar';
side.setAttribute('aria-label','Primary navigation');

// The 7 canonical OrderGrid sections
const items=[
  ['dashboard','⌂','Dashboard'],
  ['flipkart-accounts','★','Flipkart Accounts'],
  ['bulk-orders','▦','Bulk Orders'],
  ['action-required','⚡','Action Required'],
  ['funding','◆','Funding'],
  ['reports','▣','Reports'],
  ['settings','⚙','Settings']
];

side.innerHTML=
  '<div class="sidebar-brand"><span class="sidebar-brand-mark">OG</span><div><strong>ORDERGRID</strong><small>PROCUREMENT OS</small></div></div>'+
  '<div class="nav-label">WORKSPACE</div>'+
  items.map(x=>`<button type="button" data-view="${x[0]}"><span class="nav-icon">${x[1]}</span><span>${x[2]}</span></button>`).join('')+
  '<div class="nav-foot">Production workspace · secure operations</div>';
document.body.appendChild(side);

const main=document.querySelector('main');
const title=document.createElement('section');
title.className='workspace-title';
main.prepend(title);

const copy={
  'dashboard':['Dashboard','Live procurement command, metrics and recent execution.'],
  'flipkart-accounts':['Flipkart Accounts','Authorised accounts, delivery addresses, OTP status and health.'],
  'bulk-orders':['Bulk Orders','Products, allocation preview, approval, cart and checkout execution.'],
  'action-required':['Action Required','Human action inbox for OTPs, CAPTCHAs, 3DS and login renewals.'],
  'funding':['Funding','Card programmes, master funding source and virtual card inventory.'],
  'reports':['Reports','Reconciliation reports, corporate settlement ledger and GST tax billing.'],
  'settings':['Settings','Workspace users, roles, autopilot policies and worker configuration.']
};

const hashByView={
  'dashboard':'dashboard',
  'flipkart-accounts':'flipkart-accounts',
  'bulk-orders':'bulk-orders',
  'action-required':'action-required',
  'funding':'funding',
  'reports':'reports',
  'settings':'settings'
};

const legacyViewAlias={
  'control':'settings',
  'control-center':'settings',
  'overview':'dashboard',
  'fulfilment':'bulk-orders',
  'bulk':'bulk-orders',
  'action':'action-required',
  'human-actions':'action-required',
  'cards':'funding',
  'gst':'reports',
  'gst-invoices':'reports',
  'payments':'reports',
  'rewards':'flipkart-accounts',
  'retailer-users':'flipkart-accounts'
};

function normalizeView(v){
  const raw=String(v||'').replace(/^#\/?/,'').replace(/\/$/,'').trim().toLowerCase();
  return hashByView[raw]||legacyViewAlias[raw]||'dashboard';
}

function classifySection(s){
  if(s===title||s.tagName==='DIALOG')return 'hidden';
  if(s.classList.contains('command-dashboard')||s.classList.contains('hero')||s.classList.contains('metrics')||s.classList.contains('user-dashboard')||s.classList.contains('provider-strip'))return 'dashboard';
  if(s.classList.contains('rewards-centre'))return 'flipkart-accounts';
  if(s.classList.contains('bulk-checkout')||s.classList.contains('fulfilment-commerce')||s.classList.contains('checkout-panel'))return 'bulk-orders';
  if(s.classList.contains('human-action-centre'))return 'action-required';
  if(s.classList.contains('funding-workspace'))return 'funding';
  if(s.classList.contains('gst-compliance')||s.querySelector('h2')?.textContent==='Corporate settlement ledger'||s.querySelector('.eyebrow')?.textContent==='PAYMENT & COMPLIANCE')return 'reports';
  if(s.classList.contains('control-center')||s.classList.contains('automation-control-center'))return 'settings';
  return s.dataset.view||'dashboard';
}

function updateSections(){
  const sections=[...main.children].filter(x=>x!==title&&x.tagName!=='DIALOG');
  sections.forEach(s=>{
    const v=classifySection(s);
    s.dataset.view=v;
    s.classList.add('view-section');
  });
  return sections;
}

function show(requestedView,{updateHash=true}={}){
  const view=normalizeView(requestedView);
  const sections=updateSections();
  sections.forEach(s=>s.classList.toggle('view-active',s.dataset.view===view));
  side.querySelectorAll('button[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  title.innerHTML=`<div><p class="eyebrow">ORDERGRID</p><h1>${copy[view][0]}</h1><p>${copy[view][1]}</p></div>`;
  document.body.classList.remove('nav-open');
  document.documentElement.scrollTop=0;
  try{localStorage.setItem('ordergrid-view',view)}catch{}
  if(updateHash){
    const next='#/'+hashByView[view];
    if(location.hash!==next)history.replaceState(null,'',next);
  }
}
window.ordergridNavigate=view=>show(view);

document.querySelector('#controlCenterTop')?.addEventListener('click',e=>{e.preventDefault();show('settings')});
menu.type='button';
menu.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();document.body.classList.toggle('nav-open')});
side.querySelectorAll('button[data-view]').forEach(button=>{
  button.addEventListener('click',e=>{
    e.preventDefault();e.stopPropagation();
    const view=button.dataset.view;
    show(view);
    if(view==='funding')window.dispatchEvent(new CustomEvent('ordergrid:cards-open'));
    if(view==='reports')window.dispatchEvent(new CustomEvent('ordergrid:gst-open'));
    if(view==='action-required')window.dispatchEvent(new CustomEvent('ordergrid:human-actions-open'));
    if(view==='bulk-orders')window.dispatchEvent(new CustomEvent('ordergrid:bulk-refresh'));
    if(view==='flipkart-accounts')window.dispatchEvent(new CustomEvent('ordergrid:update'));
  });
});
document.addEventListener('click',e=>{
  if(!document.body.classList.contains('nav-open'))return;
  if(e.target.closest?.('.app-sidebar')||e.target.closest?.('.menu-trigger'))return;
  document.body.classList.remove('nav-open');
});
window.addEventListener('hashchange',()=>{const view=normalizeView(location.hash);if(view)show(view,{updateHash:false})});

let initial=normalizeView(location.hash);
if(!initial||initial==='dashboard'){try{initial=normalizeView(localStorage.getItem('ordergrid-view'))||'dashboard'}catch{initial='dashboard'}}
show(initial);

const fulfilmentScript=document.createElement('script');
fulfilmentScript.src='fulfilment.js';
fulfilmentScript.defer=true;
document.body.appendChild(fulfilmentScript);
})();