(()=>{
  const $=s=>document.querySelector(s);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  const money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  const confirmedStatuses=new Set(['CONFIRMED','SHIPPED','DELIVERED']);
  let loading=false;

  async function request(path){
    const response=await fetch(path,{headers:{accept:'application/json'}});
    if(!response.ok)throw new Error(String(response.status));
    return response.json();
  }

  function setStep(name,state,label,summary){
    const row=document.querySelector('[data-flow-step="'+name+'"]');
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

  function render({batches,tasks,recipientRecords}){
    const batch=batches[0]||null;
    const products=groupProducts(tasks);
    const recipientCount=new Set(tasks.map(t=>t.address_id).filter(Boolean)).size;
    const confirmed=tasks.filter(t=>confirmedStatuses.has(t.status)).length;
    const needsAttention=tasks.filter(t=>['REQUIRES_ACTION','FAILED'].includes(t.status)).length;
    const inProgress=tasks.filter(t=>t.status==='OPENED').length;
    const waiting=tasks.filter(t=>['REQUIRES_ACTION','CLAIMED','READY'].includes(t.status)).length;
    const total=tasks.reduce((sum,t)=>sum+Number(t.amount_minor||0),0);
    const hasBatch=Boolean(batch);
    const approved=Boolean(batch&&['APPROVED','PARTIAL','COMPLETE'].includes(batch.status))||tasks.length>0;
    const allConfirmed=tasks.length>0&&confirmed===tasks.length;

    setStep(
      'products',
      products.length?'complete':'current',
      products.length?'DONE':'START',
      products.length?products.length+' product'+(products.length===1?'':'s')+' selected for this batch.':'Add the products you want to place.'
    );

    setStep(
      'recipients',
      recipientCount?'complete':products.length?'current':'waiting',
      recipientCount?'DONE':'WAITING',
      recipientCount?recipientCount+' recipient'+(recipientCount===1?'':'s')+' included in this batch.':'Add recipients and their retailer accounts.'
    );

    setStep(
      'approval',
      approved?'complete':recipientCount?'current':'waiting',
      approved?'APPROVED':'WAITING',
      approved?(batch?.payment_route||'Payment method')+' selected for this batch.':'Review the order value and payment method.'
    );

    if(allConfirmed){
      setStep('checkout','complete','DONE','All orders have completed checkout.');
    }else if(needsAttention){
      setStep('checkout','current','NEEDS ATTENTION',needsAttention+' order'+(needsAttention===1?'':'s')+' need your attention before completion.');
    }else if(inProgress){
      setStep('checkout','current','IN PROGRESS',inProgress+' order'+(inProgress===1?' is':'s are')+' currently in checkout.');
    }else if(approved){
      setStep('checkout','current','READY',waiting+' order'+(waiting===1?' is':'s are')+' ready to continue.');
    }else{
      setStep('checkout','waiting','WAITING','Approved orders will appear here when ready.');
    }

    if(allConfirmed){
      setStep('confirmation','complete','COMPLETE',confirmed+' confirmed order'+(confirmed===1?'':'s')+'.');
    }else if(confirmed){
      setStep('confirmation','current',confirmed+' CONFIRMED',confirmed+' confirmed · '+(tasks.length-confirmed)+' remaining.');
    }else{
      setStep('confirmation','waiting','WAITING','Confirmed retailer order numbers will appear here.');
    }

    const recipientHost=$('#recipientAccounts');
    if(recipientHost){
      recipientHost.innerHTML=recipientRecords.length?recipientRecords.slice(0,12).map(r=>{
        const amazon=r.retailer_accounts?.amazon;
        const flipkart=r.retailer_accounts?.flipkart;
        const account=amazon?'Amazon · '+amazon:flipkart?'Flipkart · '+flipkart:'Account not added';
        return '<div class="recipient-account"><div><strong>'+esc(r.customer_reference)+'</strong><span>'+esc(r.recipient)+' · '+esc(r.city)+' '+esc(r.postal_code)+'</span></div><small>'+esc(account)+'</small></div>';
      }).join('')+(recipientRecords.length>12?'<div class="recipient-more">+'+(recipientRecords.length-12)+' more recipients</div>':''):'<p class="muted">No recipients added yet.</p>';
    }

    if($('#engineName'))$('#engineName').textContent='Checkout ready';
    if($('#engineStatus'))$('#engineStatus').textContent=approved?'AVAILABLE':'WAITING';
    if($('#engineMeta'))$('#engineMeta').textContent=approved?'Continue approved orders from Bulk orders.':'Approve the batch to continue to checkout.';
    $('#engineDot')?.classList.toggle('online',approved);

    const cartBatch=$('#cartBatchName');
    if(cartBatch)cartBatch.textContent=batch?batch.name:'No active batch';

    const cartItems=$('#cartItems');
    if(cartItems){
      cartItems.innerHTML=products.length?products.map(p=>
        '<div class="cart-item"><div><strong>'+esc(p.title)+'</strong><small>'+esc(p.retailer)+' · Qty '+p.quantity+'</small></div><div class="cart-item-price">'+money(p.total)+'</div></div>'
      ).join(''):'<p class="muted">Add products to see them here.</p>';
    }

    if($('#cartRecipients'))$('#cartRecipients').textContent=String(recipientCount);
    if($('#cartLines'))$('#cartLines').textContent=String(tasks.length||batch?.item_count||0);
    if($('#cartPayment'))$('#cartPayment').textContent=batch?.payment_route||'—';
    if($('#cartSubtotal'))$('#cartSubtotal').textContent=money(total||batch?.estimated_total_minor||0);

    if($('#cartProgressText')){
      $('#cartProgressText').textContent=
        !tasks.length?'Nothing ready yet.':
        allConfirmed?'All orders confirmed.':
        needsAttention?needsAttention+' need attention · '+confirmed+' confirmed':
        inProgress?inProgress+' in progress · '+confirmed+' confirmed':
        waiting+' ready · '+confirmed+' confirmed';
    }
  }

  async function load(){
    if(loading)return;
    loading=true;
    try{
      const [batchData,taskData,recipientData]=await Promise.all([
        request('/api/batches'),
        request('/api/checkout-tasks'),
        request('/api/recipients').catch(()=>({recipients:[]}))
      ]);
      render({
        batches:batchData.batches||[],
        tasks:taskData.tasks||[],
        recipientRecords:recipientData.recipients||[]
      });
    }catch(error){
      console.debug('Fulfilment refresh skipped',error);
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