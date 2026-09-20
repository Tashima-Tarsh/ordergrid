(()=>{
  const $=s=>document.querySelector(s);
  const esc=value=>{const node=document.createElement('div');node.textContent=String(value??'');return node.innerHTML};
  const moneyMinor=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)/100);
  let retailer='flipkart',accounts=[],finance={accounts:[],summary:{}};

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  function toast(message){
    const node=$('#toast');if(!node)return;
    node.textContent=message;node.classList.add('show');
    setTimeout(()=>node.classList.remove('show'),2400);
  }
  function retailerName(code){
    return ({flipkart:'Flipkart','amazon-in':'Amazon India',myntra:'Myntra',ajio:'AJIO'})[code]||code;
  }
  function parseCsv(text){
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++){
      const ch=text[i],next=text[i+1];
      if(ch==='"'&&quoted&&next==='"'){cell+='"';i++;continue}
      if(ch==='"'){quoted=!quoted;continue}
      if(ch===','&&!quoted){row.push(cell);cell='';continue}
      if((ch==='\n'||ch==='\r')&&!quoted){
        if(ch==='\r'&&next==='\n')i++;
        row.push(cell);cell='';
        if(row.some(v=>String(v).trim()))rows.push(row);
        row=[];continue;
      }
      cell+=ch;
    }
    row.push(cell);if(row.some(v=>String(v).trim()))rows.push(row);
    if(!rows.length)return [];
    const header=rows.shift().map(v=>String(v).trim().toLowerCase());
    const index=name=>header.indexOf(name);
    const accountIndex=index('account_reference');
    if(accountIndex<0)throw new Error('CSV needs account_reference column');
    const labelIndex=index('label'),passwordIndex=index('password'),concurrencyIndex=index('max_concurrent_orders');
    return rows.map((r,i)=>({
      accountReference:String(r[accountIndex]||'').trim(),
      label:labelIndex>=0?String(r[labelIndex]||'').trim()||undefined:undefined,
      password:passwordIndex>=0?String(r[passwordIndex]||''):undefined,
      maxConcurrentOrders:concurrencyIndex>=0&&String(r[concurrencyIndex]||'').trim()
        ?Math.max(1,Math.min(100,Number(r[concurrencyIndex])))
        :undefined,
      row:i+2
    })).filter(x=>x.accountReference);
  }
  function mergedAccounts(){
    const money=new Map((finance.accounts||[]).map(row=>[row.retailer_account_id,row]));
    return accounts.map(account=>({...account,...(money.get(account.id)||{})}));
  }
  function render(){
    const summary=finance.summary||{},operational=mergedAccounts();
    const active=accounts.filter(a=>a.active).length;
    $('#totalRetailerAccounts').textContent=String(active);
    $('#availableSuperCoins').textContent=String(summary.available_rewards||0);
    $('#pendingRefunds').textContent=moneyMinor(summary.pending_refund_minor||0);
    $('#settledRefunds').textContent=moneyMinor(summary.settled_refund_minor||0);
    $('#accountPoolTitle').textContent=retailerName(retailer)+' users & sessions';
    const bound=accounts.filter(a=>a.customer_id).length;
    $('#accountPoolMeta').textContent=`${accounts.length} accounts · ${bound} user/address profiles · ${active} active`;
    if($('#rewardCount'))$('#rewardCount').textContent=String(summary.available_rewards||0);

    $('#retailerAccountPool').innerHTML=operational.length?operational.map(account=>{
      const status=account.active?(account.auth_status||'AUTH_REQUIRED'):'PAUSED';
      const available=Number(account.available_rewards??account.reward_balance??0);
      const rewardMeta=account.reward_balance_observed_at
        ?'Actual retailer balance · '+new Date(account.reward_balance_observed_at).toLocaleString('en-IN')
        :Number(account.pending_rewards||0)+' pending';
      const refundMeta=(Number(account.observed_refund_orders||0)?Number(account.observed_refund_orders)+' refund status observed · ':'')+moneyMinor(account.pending_refund_minor||0)+' pending';
      const sessionStatus=String(account.session_status||'UNKNOWN');
      const credential=sessionStatus==='READY'?'SESSION AUTHENTICATED':(account.credential_status==='MISSING'?'OTP / MANUAL SIGN-IN':(account.credential_status||'MISSING'));
      const sessionUntil=account.session_target_expires_at?new Date(account.session_target_expires_at).toLocaleString('en-IN'):'—';
      const sessionMeta=sessionStatus==='READY'
        ?'SESSION READY · target until '+sessionUntil
        :sessionStatus==='REAUTH_REQUIRED'
          ?'REAUTH REQUIRED · open preserved session'
          :sessionStatus==='VERIFYING'
            ?'VERIFYING SESSION'
            :'SESSION NOT VERIFIED';
      const sessionAction=account.session_worker_id&&sessionStatus!=='READY'
        ?'<button type="button" class="secondary" data-open-session>Open OTP session</button>'
        :'';
      const verifyAction=sessionStatus!=='READY'
        ?'<button type="button" class="secondary" data-verify-session>Verify login</button>'
        :'';
      const identity=account.customer_id
        ?esc(account.display_name||account.label||account.account_reference)+' · '+esc(account.customer_reference||'BOUND USER')
        :'LOGIN-ONLY POOL ACCOUNT';
      const addressMeta=account.customer_id
        ?[account.address_line1,account.address_line2,account.address_city,account.address_state,account.address_postal_code].filter(Boolean).map(esc).join(' · ')
        :'No delivery user/address bound';
      return `
        <article class="retailer-account-row" data-account-id="${esc(account.id)}">
          <div class="account-main">
            <strong>${identity}</strong>
            <small>Flipkart login: ${esc(account.account_reference)} · ${esc(status)} · ${esc(credential)}</small>
            <small>${addressMeta}</small>
            <small class="session-line ${sessionStatus==='READY'?'ready':sessionStatus==='REAUTH_REQUIRED'?'attention':''}">${esc(sessionMeta)}</small>
          </div>
          <div><span>ORDERS</span><strong>${Number(account.order_count||0)}</strong><small>${Number(account.active_orders||0)} active / ${Number(account.max_concurrent_orders||1)} max</small></div>
          <div><span>REWARDS</span><strong>${available}</strong><small>${esc(rewardMeta)}</small></div>
          <div><span>REFUNDS</span><strong>${moneyMinor(account.settled_refund_minor||0)}</strong><small>${esc(refundMeta)}</small></div>
          <div class="account-actions">${verifyAction}${sessionAction}<button type="button" class="secondary" data-toggle-account>${account.active?'Pause':'Activate'}</button></div>
        </article>`;
    }).join(''):'<div class="account-pool-empty"><strong>No '+esc(retailerName(retailer))+' users yet</strong><span>Use Add Flipkart user to save the first user, delivery address and login.</span></div>';
  }
  async function load(){
    const encoded=encodeURIComponent(retailer);
    const [accountResult,financeResult]=await Promise.allSettled([
      request('/api/retailer-accounts?retailer='+encoded+'&limit=1000'),
      request('/api/retailer-finance?retailer='+encoded+'&limit=1000')
    ]);
    if(accountResult.status==='fulfilled')accounts=accountResult.value.accounts||[];
    else console.error(accountResult.reason);
    if(financeResult.status==='fulfilled')finance=financeResult.value;
    else console.error(financeResult.reason);
    render();
  }
  function openRetailerUser(){
    retailer='flipkart';
    if($('#retailerPoolSelector'))$('#retailerPoolSelector').value='flipkart';
    $('#retailerUserError').textContent='';
    $('#retailerUsersBulkError').textContent='';
    const dialog=$('#retailerUserDialog');
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  }
  function openManager(){
    const dialog=$('#retailerAccountsDialog');
    $('#accountImportRetailer').value=retailer;
    $('#retailerAccountsError').textContent='';
    $('#retailerAccountImportPreview').textContent='CSV can contain 1 account or hundreds. Imports are chunked automatically.';
    if(typeof dialog.showModal==='function')dialog.showModal();else dialog.setAttribute('open','');
  }

  $('#retailerPoolSelector')?.addEventListener('change',event=>{
    retailer=event.target.value;load();
  });
  $('#prepareRetailerAccounts')?.addEventListener('click',async()=>{
    const button=$('#prepareRetailerAccounts');button.disabled=true;const previous=button.textContent;button.textContent='Preparing…';
    try{
      const workerState=await request('/api/execution-workers');
      if(!(workerState.workers||[]).length)throw new Error('Start the OrderGrid secure browser worker first, then click Prepare sessions.');
      const result=await request('/api/retailer-accounts/prepare',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({retailer,targetDays:20})
      });
      toast(result.count+' account session(s) queued. Complete retailer OTP/sign-in in the OrderGrid secure browser window; status updates automatically.');
      await load();
    }catch(error){alert(error.message)}
    finally{button.disabled=false;button.textContent=previous}
  });
  $('#addRetailerUser')?.addEventListener('click',openRetailerUser);
  $('#closeRetailerUser')?.addEventListener('click',()=>$('#retailerUserDialog').close());
  $('#cancelRetailerUser')?.addEventListener('click',()=>$('#retailerUserDialog').close());
  $('#manageRetailerAccounts')?.addEventListener('click',openManager);
  $('#refreshRetailerAccounts')?.addEventListener('click',load);
  $('#closeRetailerAccounts')?.addEventListener('click',()=>$('#retailerAccountsDialog').close());
  $('#cancelRetailerAccounts')?.addEventListener('click',()=>$('#retailerAccountsDialog').close());

  $('#retailerUserForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#saveRetailerUser'),form=new FormData(event.currentTarget);
    button.disabled=true;button.textContent='Saving…';$('#retailerUserError').textContent='';
    try{
      const result=await request('/api/retailer-users',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          retailer:'flipkart',
          reference:String(form.get('reference')||'').trim()||undefined,
          name:String(form.get('name')||'').trim(),
          phone:String(form.get('phone')||'').trim(),
          accountReference:String(form.get('accountReference')||'').trim(),
          line1:String(form.get('line1')||'').trim(),
          line2:String(form.get('line2')||'').trim()||undefined,
          city:String(form.get('city')||'').trim(),
          state:String(form.get('state')||'').trim(),
          postalCode:String(form.get('postalCode')||'').trim(),
          country:'IN',
          password:String(form.get('password')||'')||undefined,
          maxConcurrentOrders:Math.max(1,Math.min(100,Number(form.get('maxConcurrentOrders')||1)))
        })
      });
      let queued=false;
      try{
        const workerState=await request('/api/execution-workers');
        if((workerState.workers||[]).length){
          await request('/api/retailer-accounts/prepare',{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({accountIds:[result.account.id],retailer:'flipkart',targetDays:20})
          });
          queued=true;
        }
      }catch{}
      event.currentTarget.reset();$('#retailerUserDialog').close();
      await load();
      toast(queued?'User saved. OrderGrid is opening the Flipkart login for OTP verification.':'User and address saved. Start the secure browser worker, then click Verify login.');
    }catch(error){$('#retailerUserError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Save user & prepare login'}
  });

  $('#retailerUsersBulkForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#importRetailerUsers'),file=$('#retailerUsersBulkFile')?.files?.[0];
    button.disabled=true;button.textContent='Importing…';$('#retailerUsersBulkError').textContent='';
    try{
      if(!file)throw new Error('Choose a CSV or XLSX file');
      const data=new FormData();data.append('file',file,file.name);
      const result=await request('/api/address-books/import',{method:'POST',body:data});
      event.currentTarget.reset();$('#retailerUserDialog').close();
      await load();
      toast(result.count+' users imported · '+result.retailerAccountsBound+' retailer login(s) bound');
    }catch(error){$('#retailerUsersBulkError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Import users & addresses'}
  });

  $('#retailerAccountsFile')?.addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try{
      const text=await file.text();
      $('#retailerAccountsCsv').value=text;
      const parsed=parseCsv(text);
      $('#retailerAccountImportPreview').textContent=parsed.length+' account row(s) ready to import';
      $('#retailerAccountsError').textContent='';
    }catch(error){$('#retailerAccountsError').textContent=error.message}
  });

  $('#retailerAccountsCsv')?.addEventListener('input',event=>{
    try{
      const parsed=parseCsv(event.target.value);
      $('#retailerAccountImportPreview').textContent=parsed.length+' account row(s) ready to import';
      $('#retailerAccountsError').textContent='';
    }catch(error){$('#retailerAccountsError').textContent=error.message}
  });

  $('#retailerAccountsForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('#saveRetailerAccounts'),form=new FormData(event.currentTarget);
    button.disabled=true;button.textContent='Importing…';$('#retailerAccountsError').textContent='';
    try{
      const selectedRetailer=String(form.get('retailer')||'flipkart');
      const defaultConcurrency=Math.max(1,Math.min(100,Number(form.get('defaultConcurrency')||1)));
      const parsed=parseCsv(String(form.get('csvText')||''));
      if(!parsed.length)throw new Error('Add at least one account row');
      const seen=new Set(),prepared=[];
      for(const item of parsed){
        const key=item.accountReference.toLowerCase();
        if(seen.has(key))continue;seen.add(key);
        prepared.push({
          accountReference:item.accountReference,
          label:item.label,
          password:item.password||undefined,
          maxConcurrentOrders:item.maxConcurrentOrders||defaultConcurrency
        });
      }
      let imported=0;
      for(let i=0;i<prepared.length;i+=500){
        const chunk=prepared.slice(i,i+500);
        const result=await request('/api/retailer-accounts/bulk',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({retailer:selectedRetailer,accounts:chunk})
        });
        imported+=Number(result.count||0);
        $('#retailerAccountImportPreview').textContent=`Imported ${imported} of ${prepared.length} account(s)…`;
      }
      retailer=selectedRetailer;$('#retailerPoolSelector').value=retailer;
      event.currentTarget.reset();$('#retailerAccountsDialog').close();
      await load();toast(imported+' retailer account(s) added to the pool');
    }catch(error){$('#retailerAccountsError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Import accounts'}
  });

  $('#retailerAccountPool')?.addEventListener('click',async event=>{
    const row=event.target.closest('[data-account-id]');if(!row)return;
    const account=accounts.find(x=>x.id===row.dataset.accountId);if(!account)return;
    const verify=event.target.closest('[data-verify-session]');
    if(verify){
      verify.disabled=true;const previous=verify.textContent;verify.textContent='Queuing…';
      try{
        const workerState=await request('/api/execution-workers');
        if(!(workerState.workers||[]).length)throw new Error('Start the OrderGrid secure browser worker first.');
        await request('/api/retailer-accounts/prepare',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({accountIds:[account.id],retailer:account.retailer,targetDays:20})
        });
        await load();toast('Login verification queued. Complete Flipkart OTP/sign-in in the OrderGrid secure browser.');
      }catch(error){alert(error.message)}
      finally{verify.textContent=previous;setTimeout(()=>{verify.disabled=false},1200)}
      return;
    }
    const open=event.target.closest('[data-open-session]');
    if(open){
      open.disabled=true;const previous=open.textContent;open.textContent='Opening…';
      try{
        await request('/api/retailer-accounts/'+encodeURIComponent(account.id)+'/focus-session',{method:'POST'});
        toast('Opening the exact preserved retailer session');
      }catch(error){alert(error.message)}
      finally{open.textContent=previous;setTimeout(()=>{open.disabled=false},1200)}
      return;
    }
    const button=event.target.closest('[data-toggle-account]');if(!button)return;
    button.disabled=true;
    try{
      await request('/api/retailer-accounts/'+encodeURIComponent(account.id),{
        method:'PATCH',headers:{'content-type':'application/json'},
        body:JSON.stringify({active:!account.active})
      });
      await load();toast((account.active?'Paused ':'Activated ')+(account.label||account.account_reference));
    }catch(error){alert(error.message)}
    finally{button.disabled=false}
  });

  window.addEventListener('ordergrid:update',load);
  setInterval(()=>{if(document.visibilityState==='visible')load().catch(()=>{})},10000);
  load();
})();
