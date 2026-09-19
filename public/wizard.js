(()=>{
  const form=document.querySelector('#batchForm');
  const dialog=document.querySelector('#batchDialog');
  if(!form||!dialog)return;
  const stepBar=form.querySelector('.steps');
  const labels=[...stepBar.children];
  const allLabels=[...form.querySelectorAll(':scope > label')];
  const rows=[...form.querySelectorAll(':scope > .two')];
  const fileLabel=allLabels.find(x=>x.querySelector('input[type="file"]'));
  const sample=document.querySelector('#sample');
  const preview=document.querySelector('#recipientPreview');
  const actions=form.querySelector('.modal-actions');
  const submit=actions.querySelector('button[type="submit"]');
  const productFields=[allLabels.find(x=>x.textContent.includes('Batch name')),rows[0],rows[1]].filter(Boolean);
  const recipientFields=[fileLabel,sample,preview].filter(Boolean);
  const approval=document.createElement('section');
  approval.className='wizard-review';
  approval.innerHTML='<p class="eyebrow">BATCH APPROVAL</p><h3>Review fulfilment request</h3><div id="wizardSummary"></div><label class="approval-check"><input id="wizardApproval" type="checkbox"><span>I confirm the product, recipients, quantity and estimated value.</span></label>';
  actions.before(approval);
  const checkout=document.createElement('section');
  checkout.className='wizard-review';
  checkout.innerHTML='<p class="eyebrow">READY TO QUEUE</p><h3>Checkout preparation</h3><p>Your approved orders will be added to the operator checkout queue.</p><div id="wizardFinal"></div>';
  actions.before(checkout);
  const nav=document.createElement('div');
  nav.className='wizard-nav';
  nav.innerHTML='<button type="button" class="secondary" id="wizardBack">Back</button><button type="button" id="wizardNext">Continue</button>';
  actions.before(nav);
  const back=nav.querySelector('#wizardBack'),next=nav.querySelector('#wizardNext');
  let current=1;
  function money(value){return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0))}
  function summary(){
    const data=new FormData(form),recipientText=preview.textContent.trim()||'Recipient file ready';
    return `<div class="wizard-summary-grid"><div><span>Batch</span><strong>${data.get('name')||'—'}</strong></div><div><span>Unit price</span><strong>${money(data.get('price'))}</strong></div><div><span>Quantity per recipient</span><strong>${data.get('quantity')||'—'}</strong></div><div><span>Payment route</span><strong>${data.get('paymentMode')||'—'}</strong></div><div class="wide-summary"><span>Recipients</span><strong>${recipientText}</strong></div></div>`;
  }
  function show(step){
    current=step;
    productFields.forEach(x=>x.hidden=step!==1);
    recipientFields.forEach(x=>x.hidden=step!==2);
    approval.hidden=step!==3;
    checkout.hidden=step!==4;
    labels.forEach((x,i)=>{x.classList.toggle('active',i===step-1);x.classList.toggle('complete',i<step-1)});
    back.hidden=step===1;
    next.hidden=step===4;
    actions.hidden=step!==4;
    nav.hidden=step===4;
    if(step===3)approval.querySelector('#wizardSummary').innerHTML=summary();
    if(step===4)checkout.querySelector('#wizardFinal').innerHTML=summary();
  }
  function validateProduct(){
    for(const input of form.querySelectorAll('input[name="name"],input[name="url"],input[name="price"],input[name="quantity"]'))if(!input.reportValidity())return false;
    return true;
  }
  next.onclick=()=>{
    if(current===1&&!validateProduct())return;
    if(current===2&&!preview.textContent.trim()){document.querySelector('#formError').textContent='Upload a recipient CSV or use sample recipients.';return}
    if(current===3&&!document.querySelector('#wizardApproval').checked){document.querySelector('#formError').textContent='Confirm the batch details to continue.';return}
    document.querySelector('#formError').textContent='';
    show(Math.min(4,current+1));
  };
  back.onclick=()=>show(Math.max(1,current-1));
  document.addEventListener('click',event=>{if(event.target.closest('#newBatch,#emptyNew,#titleNewBatch'))setTimeout(()=>show(1),0)});
  form.addEventListener('reset',()=>setTimeout(()=>show(1),0));
  const style=document.createElement('style');
  style.textContent=`
    .steps>*{padding:8px 10px;border-radius:8px}
    .steps .active{background:#071522;color:#fff}
    .steps .complete{background:#ecfdf5;color:#047857}
    .wizard-review{padding:18px;margin:16px 0;border:1px solid #dce2ea;border-radius:12px;background:#f8fafc}
    .wizard-review h3{margin:5px 0 12px}
    .wizard-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .wizard-summary-grid div{padding:11px;border-radius:9px;background:#fff;border:1px solid #e2e8f0}
    .wizard-summary-grid span{display:block;color:#64748b;font-size:12px}
    .wizard-summary-grid strong{display:block;margin-top:3px;overflow-wrap:anywhere}
    .wide-summary{grid-column:1/-1}
    .wizard-nav{display:flex;justify-content:space-between;margin-top:20px}
    @media(max-width:600px){.wizard-summary-grid{grid-template-columns:1fr}.wide-summary{grid-column:auto}.steps{overflow:auto;justify-content:flex-start;gap:6px}.steps>*{white-space:nowrap}}
  `;
  document.head.appendChild(style);
  show(1);
})();
