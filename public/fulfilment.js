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
    const readyForCheckout=tasks.filter(t=>['READY','CLAIMED'].includes(t.status)).length;
    const total=tasks.reduce((sum,t)=>sum+Number(t.amount_minor||0),0);
    const hasBatch=Boolean(batch);
    const approved=Boolean(batch&&['APPROVED','PARTIAL','COMPLETE'].includes(batch.status))||tasks.length>0;
    const allConfirmed=tasks.length>0&&confirmed===tasks.length;

    if($('#ffBatch'))$('#ffBatch').textContent=batch?batch.name:'None';
    if($('#ffBatchState'))$('#ffBatchState').textContent=batch?String(batch.status||'DRAFT').replaceAll('_',' ')+' · '+(batch.payment_route||'Payment route pending'):'Create procurement to begin';
    if($('#ffProducts'))$('#ffProducts').textContent=String(products.length);
    if($('#ffRecipients'))$('#ffRecipients').textContent=String(recipientCount);
    if($('#ffReady'))$('#ffReady').textContent=String(readyForCheckout);
    if($('#ffAttention'))$('#ffAttention').textContent=String(needsAttention);
    if($('#ffConfirmed'))$('#ffConfirmed').textContent=String(confirmed);
    if($('#ffValue'))$('#ffValue').textContent=money(total||batch?.estimated_total_minor||0);
    if($('#ffPipelineState')){
      $('#ffPipelineState').textContent=allConfirmed?'COMPLETE':needsAttention?'ACTION REQUIRED':inProgress?'RUNNING':approved?'READY':'BUILDING';
      $('#ffPipelineState').className='ff-pipeline-badge '+(allConfirmed?'complete':needsAttention?'attention':inProgress?'running':approved?'ready':'');
    }



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
    if(event.target.closest('#flowNewBatch'))document.querySelector('#newBatch')?.click();
  });
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,15000);
  load();
})();