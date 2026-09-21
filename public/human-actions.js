(()=>{
  const $=s=>document.querySelector(s);
  const esc=value=>{const node=document.createElement('div');node.textContent=String(value??'');return node.innerHTML};
  const money=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)/100);
  const actionMeta={
    RETAILER_OTP:{label:'Retailer OTP',tone:'attention',help:'Enter the one-time retailer OTP here. OrderGrid sends it only to the managed session that requested it.'},
    CARD_CVV:{label:'Card CVV',tone:'payment',help:'Protected card verification remains paused for the authorised user. OrderGrid does not store CVV.'},
    BANK_AUTH:{label:'Bank OTP / 3DS',tone:'payment',help:'Bank or issuer authentication is never bypassed and remains a protected human step.'},
    CAPTCHA:{label:'CAPTCHA',tone:'attention',help:'Retailer CAPTCHA cannot be bypassed. This account remains paused until authorised verification can be completed.'},
    RETAILER_LOGIN:{label:'Retailer login',tone:'attention',help:'OrderGrid will retry the encrypted saved credential; additional retailer verification remains protected.'},
    PAYMENT_METHOD:{label:'Payment setup',tone:'payment',help:'Add or confirm the approved payment method in the retailer session.'},
    REVIEW:{label:'Review required',tone:'review',help:'Review the retailer step, then the worker will resume from the same account profile.'}
  };
  let actions=[];

  const host=document.createElement('section');
  host.className='panel human-action-centre';
  host.innerHTML=`
    <div class="panel-head">
      <div><p class="eyebrow">HUMAN ACTION QUEUE</p><h2>Exceptions without losing the task</h2><p class="human-action-sub">Only orders that genuinely need you appear here. OrderGrid keeps the same retailer account, managed browser profile, order and virtual-card context.</p></div>
      <div class="head-actions"><span class="pill" id="humanActionStatus">0 WAITING</span><button type="button" class="secondary" id="refreshHumanActions">Refresh</button></div>
    </div>
    <div class="human-action-metrics">
      <div><span>WAITING</span><strong id="humanActionCount">0</strong></div>
      <div><span>RETAILER VERIFY</span><strong id="humanRetailerCount">0</strong></div>
      <div><span>PAYMENT VERIFY</span><strong id="humanPaymentCount">0</strong></div>
      <div><span>LIVE SESSIONS</span><strong id="humanLiveCount">0</strong></div>
    </div>
    <div id="humanActionQueue" class="human-action-list"><div class="human-action-empty"><strong>No human action required</strong><span>OrderGrid surfaces OTP, CAPTCHA, CVV and bank authentication here only when human action is required.</span></div></div>
  `;
  const anchor=document.querySelector('.funding-workspace')||document.querySelector('.rewards-centre');
  if(anchor)anchor.before(host);
  else document.querySelector('main')?.appendChild(host);

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function toast(message){
    if(window.toast)return window.toast(message);
    const node=$('#toast');if(!node)return;
    node.textContent=message;node.classList.add('show');setTimeout(()=>node.classList.remove('show'),2400);
  }
  function render(){
    const retailerCount=actions.filter(a=>['RETAILER_OTP','CAPTCHA','RETAILER_LOGIN'].includes(a.action_type)).length;
    const paymentCount=actions.filter(a=>['CARD_CVV','BANK_AUTH','PAYMENT_METHOD'].includes(a.action_type)).length;
    const liveCount=actions.filter(a=>a.worker_online).length;
    $('#humanActionCount').textContent=String(actions.length);
    $('#humanRetailerCount').textContent=String(retailerCount);
    $('#humanPaymentCount').textContent=String(paymentCount);
    $('#humanLiveCount').textContent=String(liveCount);
    $('#humanActionStatus').textContent=actions.length?actions.length+' WAITING':'CLEAR';

    $('#humanActionQueue').innerHTML=actions.length?actions.map(action=>{
      const meta=actionMeta[action.action_type]||actionMeta.REVIEW;
      const worker=action.worker_online?'MANAGED SESSION ONLINE':'MANAGED EXECUTION RECONNECTING';
      const actionControl=action.action_type==='RETAILER_OTP'
        ?'<div class="managed-otp"><input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="Enter OTP" data-order-otp-input><button type="button" data-submit-order-otp '+(action.worker_online?'':'disabled')+'>Verify OTP</button></div>'
        :'<span class="managed-action-note">'+(action.worker_online?'Order remains paused safely until this protected step is completed.':'Order remains queued; managed execution will reconnect automatically.')+'</span>';
      return `
        <article class="human-action-row" data-basket-id="${esc(action.id)}">
          <div class="human-action-badge ${esc(meta.tone)}">${esc(meta.label)}</div>
          <div class="human-action-copy">
            <strong>${esc(action.customer_reference||action.recipient)} · ${esc(action.retailer)}</strong>
            <span>${esc(action.account_label||action.account_reference||'Retailer account')} · ${esc(action.recipient)}</span>
            <small>${esc(meta.help)}</small>
            ${action.failure_message?'<small class="human-action-reason">'+esc(action.failure_message)+'</small>':''}
          </div>
          <div class="human-action-value"><span>ORDER VALUE</span><strong>${money(action.amount_minor)}</strong><small>${esc(action.payment_status||'PENDING')}</small></div>
          <div class="human-action-worker"><span>EXECUTION</span><strong class="${action.worker_online?'worker-live':'worker-offline'}">${worker}</strong><small>${action.worker_online?'Encrypted account session is attached':'No customer desktop action is required to reconnect'}</small></div>
          <div class="human-action-buttons">${actionControl}</div>
        </article>`;
    }).join(''):'<div class="human-action-empty"><strong>No human action required</strong><span>OrderGrid surfaces OTP, CAPTCHA, CVV and bank authentication here only when human action is required.</span></div>';
  }
  async function load(){
    try{
      const data=await request('/api/human-actions');
      actions=data.actions||[];render();
    }catch(error){console.error(error)}
  }
  host.addEventListener('click',async event=>{
    const button=event.target.closest('[data-submit-order-otp]');if(!button)return;
    const row=button.closest('[data-basket-id]');if(!row)return;
    const input=row.querySelector('[data-order-otp-input]');
    const otp=String(input?.value||'').trim();
    if(!/^\d{4,8}$/.test(otp)){alert('Enter the 4–8 digit retailer OTP.');return}
    button.disabled=true;const previous=button.textContent;button.textContent='Verifying…';
    try{
      await request('/api/human-actions/'+encodeURIComponent(row.dataset.basketId)+'/otp',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})
      });
      if(input)input.value='';
      toast('OTP sent securely to the managed retailer session. This order will resume automatically if verification succeeds.');
      setTimeout(()=>load().catch(()=>{}),1800);
    }catch(error){alert(error.message)}
    finally{button.textContent=previous;setTimeout(()=>{button.disabled=false},1200)}
  });
  $('#refreshHumanActions')?.addEventListener('click',load);
  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,5000);
  load();
})();