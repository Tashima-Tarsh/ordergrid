(()=>{
  const form=document.querySelector('#batchForm');
  if(!form)return;
  const labels=[...form.querySelector('.steps').children];
  const productRows=document.querySelector('#productRows');
  const addProduct=document.querySelector('#addProduct');
  const fileLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('input[type="file"]'));
  const paymentLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('select[name="paymentMode"]'));
  const nameLabel=[...form.querySelectorAll(':scope > label')].find(x=>x.querySelector('input[name="name"]'));
  const sample=document.querySelector('#sample');
  const preview=document.querySelector('#recipientPreview');
  const actions=form.querySelector('.modal-actions');

  const approval=document.createElement('section');
  approval.className='wizard-review';
  approval.innerHTML='<p class="eyebrow">BATCH APPROVAL</p><h3>Approve one bulk execution</h3><div id="wizardSummary"></div><label class="approval-check"><input id="wizardApproval" type="checkbox"><span>I confirm the products, recipients, quantities, payment route and estimated value.</span></label>';
  actions.before(approval);

  const checkout=document.createElement('section');
  checkout.className='wizard-review';
  checkout.innerHTML='<p class="eyebrow">READY TO EXECUTE</p><h3>OrderGrid bulk checkout</h3><p>OrderGrid will create one basket per customer and retailer, run baskets in parallel and surface only retailer-controlled challenges for intervention.</p><div id="wizardFinal"></div>';
  actions.before(checkout);

  const nav=document.createElement('div');
  nav.className='wizard-nav';
  nav.innerHTML='<button type="button" class="secondary" id="wizardBack">Back</button><button type="button" id="wizardNext">Continue</button>';
  actions.before(nav);
  const back=nav.querySelector('#wizardBack'),next=nav.querySelector('#wizardNext');

  function productEntry(){
    const node=document.createElement('div');
    node.className='product-entry';
    node.innerHTML='<div class="two"><label>Product URL<input name="url" type="url" required placeholder="https://www.amazon.in/dp/..."></label><label>Estimated unit price (₹)<input name="price" type="number" min="1" step="0.01" value="1299" required></label></div><div class="two"><label>Quantity per recipient<input name="quantity" type="number" min="1" max="100" value="1" required></label><button type="button" class="secondary remove-product" data-remove-product>Remove product</button></div>';
    return node;
  }
  function normalizeRemoveButtons(){
    const rows=[...productRows.querySelectorAll('.product-entry')];
    rows.forEach((row,i)=>row.querySelector('[data-remove-product]').hidden=rows.length===1);
  }
  addProduct.onclick=()=>{productRows.appendChild(productEntry());normalizeRemoveButtons()};
  productRows.onclick=e=>{const remove=e.target.closest('[data-remove-product]');if(!remove)return;remove.closest('.product-entry').remove();normalizeRemoveButtons()};

  let current=1;
  const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0));
  function productData(){
    return [...productRows.querySelectorAll('.product-entry')].map((row,i)=>({
      index:i+1,
      url:row.querySelector('[name="url"]').value,
      price:Number(row.querySelector('[name="price"]').value||0),
      quantity:Number(row.querySelector('[name="quantity"]').value||0)
    }));
  }
  function summary(){
    const data=new FormData(form),products=productData(),recipientText=preview.textContent.trim()||'Recipient file ready';
    const unitTotal=products.reduce((sum,p)=>sum+p.price*p.quantity,0);
    return '<div class="wizard-summary-grid">'+
      `<div><span>Batch</span><strong>${data.get('name')||'—'}</strong></div>`+
      `<div><span>Products per customer</span><strong>${products.length}</strong></div>`+
      `<div><span>Estimated basket value</span><strong>${money(unitTotal)}</strong></div>`+
      `<div><span>Payment route</span><strong>${data.get('paymentMode')||'—'}</strong></div>`+
      `<div class="wide-summary"><span>Recipients</span><strong>${recipientText}</strong></div>`+
      `<div class="wide-summary"><span>Execution model</span><strong>Grouped by customer + retailer, processed concurrently inside OrderGrid control</strong></div>`+
      '</div>';
  }
  function show(step){
    current=step;
    [nameLabel,productRows,addProduct,paymentLabel].filter(Boolean).forEach(x=>x.hidden=step!==1);
    [fileLabel,sample,preview].filter(Boolean).forEach(x=>x.hidden=step!==2);
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
  function validateProducts(){
    if(!form.querySelector('input[name="name"]').reportValidity())return false;
    for(const row of productRows.querySelectorAll('.product-entry')){
      for(const input of row.querySelectorAll('input'))if(!input.reportValidity())return false;
    }
    return true;
  }
  next.onclick=()=>{
    if(current===1&&!validateProducts())return;
    if(current===2&&!preview.textContent.trim()){document.querySelector('#formError').textContent='Upload a recipient CSV/XLSX or use sample recipients.';return}
    if(current===3&&!document.querySelector('#wizardApproval').checked){document.querySelector('#formError').textContent='Confirm the batch details to continue.';return}
    document.querySelector('#formError').textContent='';
    show(Math.min(4,current+1));
  };
  back.onclick=()=>show(Math.max(1,current-1));
  document.addEventListener('click',event=>{if(event.target.closest('#newBatch,#emptyNew,#titleNewBatch'))setTimeout(()=>{while(productRows.children.length>1)productRows.lastElementChild.remove();normalizeRemoveButtons();show(1)},0)});
  form.addEventListener('reset',()=>setTimeout(()=>{while(productRows.children.length>1)productRows.lastElementChild.remove();normalizeRemoveButtons();show(1)},0));

  const style=document.createElement('style');
  style.textContent=`
    .steps>*{padding:8px 10px;border-radius:8px}.steps .active{background:#071522;color:#fff}.steps .complete{background:#ecfdf5;color:#047857}
    .product-entry{padding:14px;margin:10px 0;border:1px solid #dce2ea;border-radius:12px;background:#f8fafc}.product-entry+.product-entry{margin-top:12px}
    .remove-product{align-self:end;margin-bottom:1px}.wizard-review{padding:18px;margin:16px 0;border:1px solid #dce2ea;border-radius:12px;background:#f8fafc}
    .wizard-review h3{margin:5px 0 12px}.wizard-summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .wizard-summary-grid div{padding:11px;border-radius:9px;background:#fff;border:1px solid #e2e8f0}.wizard-summary-grid span{display:block;color:#64748b;font-size:12px}
    .wizard-summary-grid strong{display:block;margin-top:3px;overflow-wrap:anywhere}.wide-summary{grid-column:1/-1}.wizard-nav{display:flex;justify-content:space-between;margin-top:20px}
    @media(max-width:600px){.wizard-summary-grid{grid-template-columns:1fr}.wide-summary{grid-column:auto}.steps{overflow:auto;justify-content:flex-start;gap:6px}.steps>*{white-space:nowrap}}
  `;
  document.head.appendChild(style);
  normalizeRemoveButtons();
  show(1);
})();