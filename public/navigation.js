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
  color:#8fa0af;font-size:11px;font-weight:680;text-align:left;box-shadow:none
}
.app-sidebar button:hover{background:rgba(255,255,255,.05);color:#e7edf2;transform:none}
.app-sidebar button.active{background:rgba(255,255,255,.085);border-color:rgba(255,255,255,.075);color:#fff;transform:none}
.nav-icon{
  width:23px;height:23px;display:grid;place-items:center;border-radius:7px;background:rgba(255,255,255,.045);
  color:#7d91a1;font-size:10px;font-weight:900;transition:.16s
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