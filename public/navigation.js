(()=>{
const fulfilmentStyle=document.createElement('link');
fulfilmentStyle.rel='stylesheet';
fulfilmentStyle.href='fulfilment.css';
document.head.appendChild(fulfilmentStyle);

const style=document.createElement('style');
style.textContent=`
body.product-shell{padding-left:220px}
body.product-shell header{padding-left:238px;padding-right:18px}
body.product-shell main{max-width:1600px;width:100%;margin:0 auto;padding:14px 18px 28px}
.menu-trigger{display:none!important}
.app-sidebar{
  position:fixed;z-index:500;pointer-events:auto;isolation:isolate;inset:0 auto 0 0;width:220px;
  padding:16px 12px 18px;background:#0f172a;color:#fff;
  border-right:1px solid #1e293b;box-shadow:4px 0 24px rgba(15,23,42,.12)
}
.sidebar-brand{display:flex;align-items:center;gap:10px;height:46px;padding:0 6px 12px;margin-bottom:14px;border-bottom:1px solid #1e293b}
.sidebar-brand-mark{width:28px;height:28px;display:grid;place-items:center;border-radius:8px;background:transparent;flex:none}
.sidebar-brand strong{display:block;font-size:12px;font-weight:900;letter-spacing:.1em;color:#ffffff}
.sidebar-brand small{display:block;margin-top:2px;color:#94a3b8;font-size:7.5px;font-weight:700;letter-spacing:.1em}
.nav-label{padding:4px 9px 7px;color:#64748b;font-size:8px;font-weight:900;letter-spacing:.14em}
.app-sidebar button{
  position:relative;z-index:2;pointer-events:auto;display:flex;width:100%;align-items:center;gap:10px;
  min-height:38px;padding:8px 10px;margin:3px 0;border:1px solid transparent;border-radius:8px;background:transparent;
  color:#94a3b8;font-size:12px;font-weight:600;text-align:left;box-shadow:none;cursor:pointer;transition:all .15s ease;
}
.app-sidebar button:hover{background:#1e293b;color:#ffffff;border-color:#334155;transform:none}
.app-sidebar button.active{
  background:#1e293b;
  border-color:#3b82f6;
  color:#ffffff;
  font-weight:700;
  box-shadow:0 1px 3px rgba(0,0,0,.2);
  transform:none
}
.nav-icon{
  width:24px;height:24px;display:grid;place-items:center;border-radius:6px;background:#1e293b;
  color:#94a3b8;font-size:11px;font-weight:800;transition:.15s
}
.app-sidebar button:hover .nav-icon{color:#ffffff;background:#334155}
.app-sidebar button.active .nav-icon{background:#2563eb;color:#ffffff;box-shadow:0 1px 4px rgba(37,99,235,.4)}
.nav-foot{position:absolute;bottom:17px;left:16px;right:16px;padding-top:10px;border-top:1px solid #1e293b;font-size:8px;color:#64748b;letter-spacing:.04em;text-align:center}
.workspace-title{display:flex;align-items:center;justify-content:space-between;gap:14px}
.view-section{display:none!important}
.view-section.view-active{display:block!important}
@media(max-width:900px){
  body.product-shell{padding-left:0}
  body.product-shell header{padding-left:14px;padding-right:14px}
  body.product-shell main{padding:12px 14px 28px}
  .menu-trigger{display:flex!important;align-items:center;gap:6px;padding:6px 10px;font-size:12px;font-weight:700;border-radius:8px}
  .app-sidebar{transform:translateX(-100%);transition:transform .22s cubic-bezier(0.16, 1, 0.3, 1);width:min(85vw,280px)}
  body.nav-open .app-sidebar{transform:none}
  body.nav-open:after{content:'';position:fixed;z-index:450;inset:0;background:rgba(15,23,42,.6);backdrop-filter:blur(2px)}
  .workspace-title{align-items:flex-start;flex-direction:column;gap:4px}
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

const items=[
  ['control','◎','Control Center'],
  ['overview','⌂','Dashboard'],
  ['fulfilment','▦','Fulfilment'],
  ['bulk','⇉','Bulk orders'],
  ['payments','₹','Payments'],
  ['gst','▣','GST & invoices'],
  ['cards','◆','Cards & funding'],
  ['rewards','★','Retailer users']
];

const sidebarLogoSvg = `<svg width="24" height="24" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="ogLgNav" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="50%" stop-color="#2563eb"/><stop offset="100%" stop-color="#6366f1"/></linearGradient><linearGradient id="ogGlNav" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#0284c7"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="#0f172a"/><path d="M16 5.5L25.5 11V21L16 26.5L6.5 21V11L16 5.5Z" stroke="url(#ogGlNav)" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 5.5V16M25.5 11L16 16M6.5 11L16 16" stroke="url(#ogLgNav)" stroke-width="1.8" stroke-linecap="round"/><circle cx="16" cy="5.5" r="2.2" fill="#38bdf8"/><circle cx="25.5" cy="11" r="2.2" fill="#60a5fa"/><circle cx="25.5" cy="21" r="2.2" fill="#818cf8"/><circle cx="16" cy="26.5" r="2.2" fill="#c084fc"/><circle cx="6.5" cy="21" r="2.2" fill="#818cf8"/><circle cx="6.5" cy="11" r="2.2" fill="#38bdf8"/><circle cx="16" cy="16" r="2.8" fill="#ffffff"/></svg>`;

side.innerHTML=
  '<div class="sidebar-brand"><span class="sidebar-brand-mark">' + sidebarLogoSvg + '</span><div><strong>ORDERGRID</strong><small>PROCUREMENT OS</small></div></div>'+
  '<div class="nav-label">WORKSPACE</div>'+
  items.map(x=>`<button type="button" data-view="${x[0]}"><span class="nav-icon">${x[1]}</span><span>${x[2]}</span></button>`).join('')+
  '<div class="nav-foot">Production workspace · secure operations</div>';
document.body.appendChild(side);

const main=document.querySelector('main');
const title=document.createElement('section');
title.className='workspace-title';
main.prepend(title);
const sections=[...main.children].filter(x=>x!==title&&x.tagName!=='DIALOG');
sections.forEach(s=>{
  let view='hidden';
  if(s.classList.contains('control-center'))view='control';
  else if(s.classList.contains('command-dashboard'))view='overview';
  else if(s.classList.contains('metrics'))view='hidden';
  else if(s.classList.contains('bulk-checkout')||s.classList.contains('human-action-centre'))view='bulk';
  else if(s.classList.contains('funding-workspace'))view='cards';
  else if(s.classList.contains('rewards-centre'))view='rewards';
  else if(s.classList.contains('fulfilment-commerce')||s.classList.contains('checkout-panel')||s.querySelector('h2')?.textContent==='Fulfilment batches')view='fulfilment';
  else if(s.classList.contains('gst-compliance'))view='gst';
  else if(s.querySelector('h2')?.textContent==='Corporate settlement ledger')view='payments';
  s.dataset.view=view;
  s.classList.add('view-section');
});

const copy={
  control:['Control Center','Accounts, checkout, cards and order progress.'],
  overview:['Dashboard','Live procurement command and recent execution.'],
  fulfilment:['Fulfilment','Products, allocation, approval and checkout.'],
  bulk:['Bulk orders','Customer orders and checkout intervention.'],
  payments:['Payments','Settlement and completed payment records.'],
  gst:['GST & Invoices','GST billing, invoice register and tax profile.'],
  cards:['Cards & funding','Funding programme and virtual-card inventory.'],
  rewards:['Retailer users','Authorised accounts, addresses and saved sessions.']
};
const hashByView={control:'control-center',overview:'dashboard',fulfilment:'fulfilment',bulk:'bulk-orders',payments:'payments',gst:'gst-invoices',cards:'cards',rewards:'retailer-users'};
const viewByHash=Object.fromEntries(Object.entries(hashByView).map(([view,hash])=>[hash,view]));
const hashView=()=>viewByHash[String(location.hash||'').replace(/^#\/?/,'').replace(/\/$/,'')]||null;

function show(view,{updateHash=true}={}){
  if(!copy[view])view='overview';
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

document.querySelector('#controlCenterTop')?.addEventListener('click',e=>{e.preventDefault();show('control')});
menu.type='button';
menu.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();document.body.classList.toggle('nav-open')});
side.querySelectorAll('button[data-view]').forEach(button=>{
  button.addEventListener('click',e=>{
    e.preventDefault();e.stopPropagation();
    const view=button.dataset.view;
    show(view);
    if(view==='cards')window.dispatchEvent(new CustomEvent('ordergrid:cards-open'));
    if(view==='gst')window.dispatchEvent(new CustomEvent('ordergrid:gst-open'));
  });
});
document.addEventListener('click',e=>{
  if(!document.body.classList.contains('nav-open'))return;
  if(e.target.closest?.('.app-sidebar')||e.target.closest?.('.menu-trigger'))return;
  document.body.classList.remove('nav-open');
});
window.addEventListener('hashchange',()=>{const view=hashView();if(view)show(view,{updateHash:false})});

let initial=hashView();
if(!initial){try{initial=localStorage.getItem('ordergrid-view')||'overview'}catch{initial='overview'}}
show(initial);

const fulfilmentScript=document.createElement('script');
fulfilmentScript.src='fulfilment.js';
fulfilmentScript.defer=true;
document.body.appendChild(fulfilmentScript);
})();