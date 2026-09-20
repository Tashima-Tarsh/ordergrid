(()=>{
  const $=s=>document.querySelector(s);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  const doneStatuses=new Set(['CONFIRMED','SHIPPED','DELIVERED']);
  let loading=false;

  async function request(path){
    const response=await fetch(path,{headers:{accept:'application/json'}});
    if(!response.ok)throw new Error(String(response.status));
    return response.json();
  }

  function setStep(name,state,label,summary){
    const row=document.querySelector(`[data-flow-step="${name}"]`);
    if(!row)return;
    row.classList.toggle('complete',state==='complete');
    row.classList.toggle('current',state==='current');
    const badge=row.querySelector('.flow-state');
    if(badge)badge.textContent=label;
    const target=row.querySelector('[id$="Summary"]');
    if(target)target.textContent=summary;
  }

  function groupProducts(tasks){
    const groups=new Map();
    for(const task of tasks){
      const key=task.product_url||task.title||task.id;
      const current=groups.get(key)||{title:task.title||task.retailer||'Retailer product',retailer:task.retailer||'',quantity:0,total:0};
      current.quantity+=Number(task.requested_quantity||1);
      current.total+=Number(task.amount_minor||0);
      groups.set(key,current);
    }
    return [...groups.values()];
  }

  function render({batches,tasks,workers,recipients,runtime}){
    const batch=batches[0]||null;
    const products=groupProducts(tasks);
    const recipients=new Set(tasks.map(t=>t.address_id).filter(Boolean)).size;
    const confirmed=tasks.filter(t=>doneStatuses.has(t.status)).length;
    const pending=tasks.filter(t=>!doneStatuses.has(t.status)&&t.status!=='FAILED').length;
    const failed=tasks.filter(t=>t.status==='FAILED').length;
    const total=tasks.reduce((sum,t)=>sum+Number(t.amount_minor||0),0);
    const workerOnline=workers.length>0;
    const engine=workers[0]||runtime?.checkoutEngine||null;
    const hasBatch=Boolean(batch);
    const approved=Boolean(batch&&['APPROVED','PARTIAL','COMPLETE'].includes(batch.status))||tasks.length>0;
    const allConfirmed=tasks.length>0&&confirmed===tasks.length;

    setStep('products',products.length?'complete':hasBatch?'current':'current',products.length?'DONE':'START',products.length?`${products.length} product${products.length===1?'':'s'} in the active procurement batch.`:'Add the products to procure for every recipient.');
    setStep('recipients',recipients?'complete':products.length?'current':'waiting',recipients?'DONE':'WAITING',recipients?`${recipients} recipient${recipients===1?'':'s'} imported and bound to the batch.`:'Import recipients and bind their Amazon / retailer account references.');
    setStep('approval',approved?'complete':recipients?'current':'waiting',approved?'APPROVED':'WAITING',approved?`${batch?.payment_route||'Payment route'} approved for execution.`:'Review estimated value and payment route before execution.');
    if(allConfirmed)setStep('checkout','complete','DONE',`All ${tasks.length} order lines completed retailer checkout.`);
    else if(approved)setStep('checkout','current',workerOnline?'RUNNING':'WORKER OFFLINE',workerOnline?`${pending} order line${pending===1?'':'s'} ready or running through OrderGrid.`:'Start an OrderGrid execution worker to place approved baskets.');
    else setStep('checkout','waiting','WAITING','Approved customer baskets are sent to isolated retailer sessions.');
    if(allConfirmed)setStep('confirmation','complete','COMPLETE',`${confirmed} retailer-confirmed order line${confirmed===1?'':'s'} reconciled.`);
    else if(confirmed)setStep('confirmation','current',`${confirmed} CONFIRMED`,`${confirmed} confirmed; ${pending+failed} still pending or requiring attention.`);
    else setStep('confirmation','waiting','WAITING','Genuine retailer order IDs will appear here after placement.');

    const recipientHost=$('#recipientAccounts');
    if(recipientHost){
      recipientHost.innerHTML=recipients.length?recipients.slice(0,12).map(r=>{
        const amazon=r.retailer_accounts?.amazon;
        const flipkart=r.retailer_accounts?.flipkart;
        const account=amazon?`Amazon · ${amazon}`:flipkart?`Flipkart · ${flipkart}`:'Retailer account not bound';
        return `<div class="recipient-account"><div><strong>${esc(r.customer_reference)}</strong><span>${esc(r.recipient)} · ${esc(r.city)} ${esc(r.postal_code)}</span></div><small>${esc(account)}</small></div>`;
      }).join('')+(recipients.length>12?`<div class="recipient-more">+${recipients.length-12} more recipients</div>`:''):'<p class="muted">No recipients imported yet.</p>';
    }
    if($('#engineName'))$('#engineName').textContent=engine?.hostname||engine?.id||'OrderGrid Checkout Engine';
    if($('#engineStatus'))$('#engineStatus').textContent=workerOnline?'ONLINE':'OFFLINE';
    if($('#engineMeta'))$('#engineMeta').textContent=workerOnline?`${runtime?.api||'OrderGrid API'} connected · ${engine?.hostname||'Windows worker'} · capacity ${engine?.capacity||8}`:`${runtime?.api||'OrderGrid API'} online · start the Windows Checkout Worker for real Amazon execution`;
    $('#engineDot')?.classList.toggle('online',workerOnline);

    const cartBatch=$('#cartBatchName');
    if(cartBatch)cartBatch.textContent=batch?batch.name:'No active batch';
    const cartItems=$('#cartItems');
    if(cartItems)cartItems.innerHTML=products.length?products.map(p=>`
      <div class="cart-item">
        <div><strong>${esc(p.title)}</strong><small>${esc(p.retailer)} · Qty ${p.quantity}</small></div>
        <div class="cart-item-price">${money(p.total)}</div>
      </div>`).join(''):'<p class="muted">Add products to see them here.</p>';
    if($('#cartRecipients'))$('#cartRecipients').textContent=String(recipients);
    if($('#cartLines'))$('#cartLines').textContent=String(tasks.length||batch?.item_count||0);
    if($('#cartPayment'))$('#cartPayment').textContent=batch?.payment_route||'—';
    if($('#cartSubtotal'))$('#cartSubtotal').textContent=money(total||batch?.estimated_total_minor||0);
    if($('#cartProgressText')){
      $('#cartProgressText').textContent=!tasks.length?'Nothing ready to place yet.':allConfirmed?'All retailer orders confirmed.':!workerOnline?`${pending} ready · execution worker offline`:`${pending} ready/running · ${confirmed} confirmed${failed?` · ${failed} failed`:''}`;
    }
  }

  async function load(){
    if(loading)return;
    loading=true;
    try{
      const [batchData,taskData,workerData,recipientData,runtime]=await Promise.all([
        request('/api/batches'),
        request('/api/checkout-tasks'),
        request('/api/execution-workers').catch(()=>({workers:[]})),
        request('/api/recipients').catch(()=>({recipients:[]})),
        request('/api/runtime').catch(()=>null)
      ]);
      render({batches:batchData.batches||[],tasks:taskData.tasks||[],workers:workerData.workers||[],recipients:recipientData.recipients||[],runtime});
    }catch(error){
      console.debug('Fulfilment cart refresh skipped',error);
    }finally{
      loading=false;
    }
  }

  document.addEventListener('click',event=>{
    if(event.target.closest('#flowAddProducts,#flowImportRecipients'))document.querySelector('#newBatch')?.click();
  });
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,5000);
  load();
})();