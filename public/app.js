if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(rs=>{for(const r of rs)r.unregister()});if('caches' in window){caches.keys().then(ks=>{for(const k of ks)caches.delete(k)})}}
const $=s=>document.querySelector(s),money=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
const state={batches:[],tasks:[],dashboard:{batches:[],orders:[]}};let recipientsFile=null;
const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
function toast(t){const e=$('#toast');e.textContent=t;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2400)}
window.toast=toast;
async function api(path,options={}){const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});let body={};try{body=await response.json()}catch{}if(response.status===401){$('#login').classList.remove('hidden');throw new Error('Sign in to continue')}if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));return body}
async function refresh(){const [dashboard,batches,tasks]=await Promise.all([api('/api/dashboard'),api('/api/batches'),api('/api/checkout-tasks')]);state.dashboard=dashboard;state.batches=batches.batches||[];state.tasks=tasks.tasks||[];render()}
function render(){const pending=state.tasks.filter(t=>t.status==='REQUIRES_ACTION'),confirmed=state.tasks.filter(t=>['CONFIRMED','SHIPPED','DELIVERED'].includes(t.status)),total=state.tasks.reduce((n,t)=>n+Number(t.amount_minor||0),0);
  const recipientCount=new Set(state.tasks.map(t=>t.address_id).filter(Boolean)).size;$('#batchCount').textContent=state.batches.length;$('#recipientCount').textContent=recipientCount;$('#totalValue').textContent=money(total);$('#settledCount').textContent=confirmed.length;$('#rewardCount').textContent='—';$('#virtualCount').textContent='—';$('#tokenCount').textContent='—';$('#invoiceCount').textContent='—';
  $('#checkoutAll').disabled=!pending.length;$('#empty').hidden=!!state.batches.length;
  $('#batches').innerHTML=state.batches.map(b=>`<div class="batch-row"><div><strong>${esc(b.name)}</strong><small>${new Date(b.created_at).toLocaleString('en-IN')}</small></div><div><small>Recipients</small><strong>${b.recipient_count}</strong><small>${b.item_count} order lines</small></div><div><small>Estimate</small><strong>${money(b.estimated_total_minor)}</strong><small>${esc(b.payment_route||'')}</small></div><span class="status">${esc(b.status)}</span></div>`).join('');
  $('#tasks').innerHTML=state.tasks.length?`<div class="batch-checkout"><div><span>READY TO PLACE</span><strong>${pending.length}</strong></div><div><span>TOTAL VALUE</span><strong>${money(total)}</strong></div><div><span>CHECKOUT</span><strong>Ready</strong></div><div><span>CONFIRMED</span><strong>${confirmed.length}</strong></div></div>`:'<p class="muted">Approved basket volume will appear here.</p>';
  $('#settlements').innerHTML=confirmed.length?confirmed.map(t=>`<div class="settlement"><div><strong>${esc(t.retailer_order_id)}</strong><small>${esc(t.retailer)} · retailer confirmed</small></div><div><small>Status</small><strong>${esc(t.status)}</strong></div><div><small>Amount</small><strong>${money(t.amount_minor)}</strong></div></div>`).join(''):'<p class="muted">Retailer-confirmed orders will appear here.</p>';
  window.dispatchEvent(new CustomEvent('ordergrid:update',{detail:{tasks:state.tasks}}));
}
function openBatch(){recipientsFile=null;$('#batchForm').reset();$('#recipientPreview').textContent='';$('#formError').textContent='';$('#batchDialog').showModal()}
$('#loginForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);$('#loginError').textContent='';try{await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:f.get('identifier'),password:f.get('password')})});$('#login').classList.add('hidden');await refresh();window.dispatchEvent(new Event('ordergrid:auth-ready'));toast('Signed in')}catch(err){$('#loginError').textContent=err.message}};
$('#showSignup').onclick=()=>{$('#loginForm').hidden=true;$('#signupForm').hidden=false;$('#signupError').textContent=''};
$('#showLogin').onclick=()=>{$('#signupForm').hidden=true;$('#loginForm').hidden=false;$('#loginError').textContent=''};
$('#signupForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.currentTarget),password=String(f.get('password')||''),confirmPassword=String(f.get('confirmPassword')||'');$('#signupError').textContent='';if(password!==confirmPassword){$('#signupError').textContent='Passwords do not match';return}try{await api('/api/signup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:f.get('email'),password,setupCode:f.get('setupCode'),replaceBootstrapOwner:f.get('replaceBootstrapOwner')==='on'})});$('#login').classList.add('hidden');$('#signupForm').hidden=true;$('#loginForm').hidden=false;await refresh();window.dispatchEvent(new Event('ordergrid:auth-ready'));toast('Owner account ready')}catch(err){$('#signupError').textContent=err.message}};
async function finishSignedIn(message){
  $('#login').classList.add('hidden');
  $('#signupForm').hidden=true;
  $('#loginForm').hidden=false;
  await refresh();
  window.dispatchEvent(new Event('ordergrid:auth-ready'));
  toast(message);
}
async function handleGoogleCredential(response){
  $('#googleLoginError').textContent='';
  try{
    await api('/api/login/google',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        credential:response.credential,
        setupCode:$('#googleSetupCode')?.value||undefined,
        replaceBootstrapOwner:Boolean($('#googleReplaceOwner')?.checked)
      })
    });
    await finishSignedIn('Signed in with Google');
  }catch(err){
    $('#googleLoginError').textContent=err.message;
  }
}
async function setupGoogleSignIn(){
  const response=await fetch('/api/auth-config',{headers:{accept:'application/json'}});
  if(!response.ok)return;
  const config=await response.json();
  if(!config.google?.enabled||!config.google.clientId)return;
  $('#googleAuth').hidden=false;
  await new Promise((resolve,reject)=>{
    if(window.google?.accounts?.id)return resolve();
    const script=document.createElement('script');
    script.src='https://accounts.google.com/gsi/client';
    script.async=true;
    script.defer=true;
    script.onload=resolve;
    script.onerror=()=>reject(new Error('Google sign-in could not load'));
    document.head.appendChild(script);
  });
  window.google.accounts.id.initialize({
    client_id:config.google.clientId,
    callback:handleGoogleCredential,
    auto_select:false,
    cancel_on_tap_outside:true
  });
  window.google.accounts.id.renderButton($('#googleSignIn'),{
    theme:'outline',
    size:'large',
    text:'continue_with',
    shape:'rectangular',
    width:320
  });
}
setupGoogleSignIn().catch(err=>{if($('#googleLoginError'))$('#googleLoginError').textContent=err.message});
$('#signOut').onclick=async()=>{try{await api('/api/logout',{method:'POST'})}catch{}$('#login').classList.remove('hidden')};
$('#newBatch').onclick=openBatch;$('#emptyNew').onclick=openBatch;$('#close').onclick=()=>$('#batchDialog').close();$('#cancel').onclick=()=>$('#batchDialog').close();
if($('input[name="file"]'))$('input[name="file"]').onchange=e=>{recipientsFile=e.target.files[0]||null;$('#recipientPreview').textContent=recipientsFile?recipientsFile.name+' ready':''};
if($('#sample'))$('#sample').onclick=()=>{const csv='recipient,phone,flipkart_user_id,line1,line2,city,state,postal_code,max_concurrent_orders\nAarav Sharma,9876543210,9876543210,12 MG Road,,Bengaluru,Karnataka,560001,1\nMeera Iyer,9876543211,9876543211,18 Linking Road,,Mumbai,Maharashtra,400052,1\nKabir Singh,9876543212,9876543212,22 Connaught Place,,New Delhi,Delhi,110001,1\n';recipientsFile=new File([csv],'sample-flipkart-users.csv',{type:'text/csv'});$('#recipientPreview').textContent='3 Flipkart user/address records ready'};
$('#batchForm').onsubmit=async e=>{
  e.preventDefault();
  const form=e.currentTarget,f=new FormData(form),button=form.querySelector('button[type="submit"]');
  const products=[...form.querySelectorAll('.product-entry')].map(row=>{
    let allocationPlan=null;
    try{allocationPlan=row.dataset.allocationPlan?JSON.parse(row.dataset.allocationPlan):null}catch{}
    return {
      productUrl:String(row.querySelector('[name="url"]').value),
      quantity:Number(row.querySelector('[name="quantity"]').value),
      estimatedUnitPriceMinor:Math.round(Number(row.querySelector('[name="price"]').value)*100),
      productCheckId:String(row.querySelector('[name="productCheckId"]')?.value||''),
      retailerAccountId:String(row.querySelector('[name="retailerAccountId"]')?.value||''),
      hsnSac:String(row.querySelector('[name="hsnSac"]')?.value||'8517').trim(),
      gstRate:Number(row.querySelector('[name="gstRate"]')?.value||18),
      cessRate:Number(row.querySelector('[name="cessRate"]')?.value||0),
      priceIncludesGst:Boolean(row.querySelector('[name="priceIncludesGst"]')?.checked??true),
      allocationPlan
    };
  });
  if(!products.length){$('#formError').textContent='Add at least one product.';return}
  const allocatedCount=products.filter(product=>product.allocationPlan?.complete).length;
  if(allocatedCount>0&&allocatedCount!==products.length){$('#formError').textContent='Complete pool allocation for every product in this batch.';return}
  const poolMode=allocatedCount===products.length;
  button.disabled=true;button.textContent='Preparing order…';
  try{
    let items=[],readyMessage='';
    if(poolMode){
      items=products.flatMap(product=>product.allocationPlan.allocations.map(allocation=>({
        productUrl:product.productUrl,
        quantity:Number(allocation.quantity),
        estimatedUnitPriceMinor:Number(allocation.sellingPriceMinor),
        productCheckId:String(allocation.productCheckId),
        retailerAccountId:String(allocation.retailerAccountId),
        addressId:allocation.addressId?String(allocation.addressId):undefined,
        hsnSac:product.hsnSac,
        gstRate:product.gstRate,
        cessRate:product.cessRate,
        priceIncludesGst:product.priceIncludesGst
      })));
      const accountIds=new Set(items.map(item=>item.retailerAccountId));
      const unitCount=items.reduce((sum,item)=>sum+Number(item.quantity||0),0);
      readyMessage=unitCount+' units allocated across '+accountIds.size+' verified Flipkart accounts';
    }else{
      // Single-account mode: bind to saved customer address for the selected account
      const recipientData=await api('/api/recipients').catch(()=>({recipients:[]}));
      const recipients=recipientData.recipients||[];
      const accountData=await api('/api/retailer-accounts?retailer=flipkart&limit=500').catch(()=>({accounts:[]}));
      const accounts=accountData.accounts||[];
      items=products.map(product=>{
        const account=accounts.find(a=>a.id===product.retailerAccountId);
        const recipient=recipients.find(r=>r.retailer_accounts&&r.retailer_accounts.flipkart===account?.account_reference);
        const addressId=account?.address_id||recipient?.id;
        return {
          productUrl:product.productUrl,
          quantity:product.quantity,
          estimatedUnitPriceMinor:product.estimatedUnitPriceMinor,
          productCheckId:product.productCheckId,
          retailerAccountId:product.retailerAccountId||undefined,
          addressId:addressId||undefined,
          hsnSac:product.hsnSac,
          gstRate:product.gstRate,
          cessRate:product.cessRate,
          priceIncludesGst:product.priceIncludesGst
        };
      });
      readyMessage=products.length+' Flipkart order(s) prepared from saved addresses';
    }
    const batch=await api('/api/batches',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:f.get('name'),paymentRoute:f.get('paymentMode'),items})});
    await api(`/api/batches/${batch.id}/approve`,{method:'POST'});
    $('#batchDialog').close();
    await refresh();
    toast(readyMessage);
    document.querySelector('[data-view="bulk"]')?.click();
    window.dispatchEvent(new Event('ordergrid:bulk-refresh'));
  }catch(err){$('#formError').textContent=err.message}
  finally{button.disabled=false;button.textContent='Create & approve'}
};
$('#checkoutAll').onclick=()=>{document.querySelector('[data-view="bulk"]')?.click();setTimeout(()=>{const run=document.querySelector('#bulkRun');if(!run)return toast('Bulk orders are unavailable right now');if(run.disabled)return toast('No new orders are ready. Create and approve a fulfilment batch first.');run.click()},60)};
$('#reset').onclick=()=>refresh().catch(err=>toast(err.message));
window.addEventListener('ordergrid:refresh',()=>refresh().catch(err=>toast(err.message)));refresh().then(()=>$('#login').classList.add('hidden')).catch(()=>$('#login').classList.remove('hidden'));
