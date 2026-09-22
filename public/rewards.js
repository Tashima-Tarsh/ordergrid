(()=>{
  const $=s=>document.querySelector(s);
  const esc=value=>{const node=document.createElement('div');node.textContent=String(value??'');return node.innerHTML};
  const moneyMinor=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)/100);
  let retailer='flipkart',accounts=[],finance={accounts:[],summary:{}},secureBrowserReady=false;

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
  function customerError(error){
    const message=String(error?.message||error||'Request failed');
    if(/worker.*offline|execution worker|session worker|managed execution offline/i.test(message))return 'OrderGrid Cloud Secure Browser is starting or temporarily unavailable. Retry shortly; no local worker installation is required.';
    return message;
  }
  function sessionTargetDays(){
    const value=Number($('#sessionTargetDays')?.value||15);
    return value===30?30:15;
  }
  function renderSecureBrowserStatus(){
    const status=$('#secureBrowserStatus');
    if(status){
      status.dataset.ready=secureBrowserReady?'true':'false';
      status.textContent=secureBrowserReady?'CLOUD BROWSER ONLINE':'CLOUD BROWSER STARTING';
    }
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
    $('#accountPoolTitle').textContent=retailerName(retailer)+' users & connections';
    const bound=accounts.filter(a=>a.customer_id).length;
    const connected=accounts.filter(a=>a.active&&String(a.session_status||'')==='READY').length;
    const otpWaiting=accounts.filter(a=>a.active&&String(a.session_status||'')==='REAUTH_REQUIRED'&&String(a.session_challenge_code||'')==='OTP_REQUIRED').length;
    const queued=accounts.filter(a=>a.active&&String(a.session_status||'')==='VERIFYING').length;
    $('#accountPoolMeta').textContent=`${accounts.length} accounts · ${connected} connected · ${otpWaiting} waiting OTP · ${queued} queued · ${bound} bound users`;
    if($('#rewardCount'))$('#rewardCount').textContent=String(summary.available_rewards||0);
    renderSecureBrowserStatus();

    $('#retailerAccountPool').innerHTML=operational.length?operational.map(account=>{
      const available=Number(account.available_rewards??account.reward_balance??0);
      const rewardMeta=account.reward_balance_observed_at
        ?'Actual retailer balance · '+new Date(account.reward_balance_observed_at).toLocaleString('en-IN')
        :Number(account.pending_rewards||0)+' pending';
      const refundMeta=(Number(account.observed_refund_orders||0)?Number(account.observed_refund_orders)+' refund status observed · ':'')+moneyMinor(account.pending_refund_minor||0)+' pending';
      const sessionStatus=String(account.session_status||'UNKNOWN');
      const sessionUntil=account.session_target_expires_at?new Date(account.session_target_expires_at).toLocaleString('en-IN'):'—';
      const connectionStatus=!account.active?'PAUSED'
        :sessionStatus==='READY'?'CONNECTED'
        :sessionStatus==='REAUTH_REQUIRED'?'SIGN-IN REQUIRED'
        :sessionStatus==='VERIFYING'?'CONNECTING'
        :'NOT CONNECTED';
      const challenge=String(account.session_challenge_code||'');
      const sessionMeta=sessionStatus==='READY'
        ?'Connected · verified until '+sessionUntil
        :sessionStatus==='REAUTH_REQUIRED'
          ?(challenge==='OTP_REQUIRED'?'Flipkart sent an OTP. Enter it below to connect this account.':challenge==='CAPTCHA_REQUIRED'?'Retailer CAPTCHA requires authorised manual verification':'Retailer verification required')
          :sessionStatus==='VERIFYING'
            ?(secureBrowserReady?'OrderGrid Cloud Secure Browser is connecting this account…':'Queued — Cloud Secure Browser is starting automatically.')
            :(secureBrowserReady?'Waiting for Cloud Secure Browser':'Cloud Secure Browser will start automatically when this account is connected.');
      const otpAction=sessionStatus==='REAUTH_REQUIRED'&&challenge==='OTP_REQUIRED'
        ?'<div class="managed-otp"><input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="Enter OTP" data-account-otp-input><button type="button" data-submit-account-otp>Verify OTP</button></div>'
        :'';
      const credentialMissing=String(account.credential_status||'MISSING')==='MISSING';
      const otpFirst=String(account.retailer||'')==='flipkart';
      const credentialAction=credentialMissing&&!otpFirst
        ?'<div class="managed-credential"><input type="password" autocomplete="current-password" maxlength="1000" placeholder="Retailer password" data-account-password-input><button type="button" data-save-account-password>Save & connect</button></div>'
        :'';
      const verifyAction=sessionStatus!=='READY'&&(!credentialMissing||otpFirst)
        ?`<button type="button" class="secondary" data-verify-session>${sessionStatus==='VERIFYING'?'Connecting…':'Connect account'}</button>`
        :sessionStatus==='READY'
          ?'<span class="session-connected-chip">✓ Connected</span>'
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
            <small>Flipkart login: ${esc(account.account_reference)} · ${esc(connectionStatus)}</small>
            <small>${addressMeta}</small>
            <small class="session-line ${sessionStatus==='READY'?'ready':sessionStatus==='REAUTH_REQUIRED'?'attention':''}">${esc(sessionMeta)}</small>
          </div>
          <div><span>ORDERS</span><strong>${Number(account.order_count||0)}</strong><small>${Number(account.active_orders||0)} active / ${Number(account.max_concurrent_orders||1)} max</small></div>
          <div><span>REWARDS</span><strong>${available}</strong><small>${esc(rewardMeta)}</small></div>
          <div><span>REFUNDS</span><strong>${moneyMinor(account.settled_refund_minor||0)}</strong><small>${esc(refundMeta)}</small></div>
          <div class="account-actions">${credentialAction}${verifyAction}${otpAction}<button type="button" class="secondary" data-toggle-account>${account.active?'Pause':'Activate'}</button></div>
        </article>`;
    }).join(''):'<div class="account-pool-empty"><strong>No '+esc(retailerName(retailer))+' users yet</strong><span>Use Add Flipkart user to save the first user, delivery address and secure login.</span></div>';
  }
  async function load(){
    const encoded=encodeURIComponent(retailer);
    const [accountResult,financeResult,secureBrowserResult]=await Promise.allSettled([
      request('/api/retailer-accounts?retailer='+encoded+'&limit=1000'),
      request('/api/retailer-finance?retailer='+encoded+'&limit=1000'),
      request('/api/execution-workers')
    ]);
    if(accountResult.status==='fulfilled')accounts=accountResult.value.accounts||[];
    else console.error(accountResult.reason);
    if(financeResult.status==='fulfilled')finance=financeResult.value;
    else console.error(financeResult.reason);
    secureBrowserReady=secureBrowserResult.status==='fulfilled'&&(secureBrowserResult.value.workers||[]).length>0;
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
    const button=$('#prepareRetailerAccounts');
    button.disabled=true;const previous=button.textContent;button.textContent='Connecting…';
    try{
      const result=await request('/api/retailer-accounts/prepare',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({retailer,targetDays:sessionTargetDays()})
      });
      const secureState=await request('/api/execution-workers').catch(()=>({workers:[]}));
      secureBrowserReady=(secureState.workers||[]).length>0;
      renderSecureBrowserStatus();
      toast(secureBrowserReady
        ?result.count+' account(s) queued. Authentication will proceed one account at a time.'
        :result.count+' account(s) queued. Secure Browser is starting and will process them one at a time.');
      await load();
    }catch(error){alert(customerError(error))}
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
    const formElement=event.currentTarget;
    const button=$('#saveRetailerUser'),form=new FormData(formElement);
    button.disabled=true;button.textContent='Saving…';$('#retailerUserError').textContent='';
    try{
      const result=await request('/api/retailer-users',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          retailer:'flipkart',
          name:String(form.get('name')||'').trim(),
          phone:String(form.get('phone')||'').trim(),
          accountReference:String(form.get('accountReference')||'').trim(),
          line1:String(form.get('line1')||'').trim(),
          line2:String(form.get('line2')||'').trim()||undefined,
          city:String(form.get('city')||'').trim(),
          state:String(form.get('state')||'').trim(),
          postalCode:String(form.get('postalCode')||'').trim(),
          country:'IN',
          maxConcurrentOrders:Math.max(1,Math.min(100,Number(form.get('maxConcurrentOrders')||1)))
        })
      });
      let queued=false;
      try{
        const prepared=await request('/api/retailer-accounts/prepare',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({accountIds:[result.account.id],retailer:'flipkart',targetDays:sessionTargetDays()})
        });
        queued=Number(prepared.count||0)>0;
      }catch{}
      const secureState=await request('/api/execution-workers').catch(()=>({workers:[]}));
      secureBrowserReady=(secureState.workers||[]).length>0;
      formElement.reset();$('#retailerUserDialog').close();
      await load();
      if(queued&&secureBrowserReady){
        toast('User saved. Flipkart OTP connection is starting; enter OTP here when requested.');
      }else if(queued){
        toast('User saved. Cloud Secure Browser is starting automatically; Flipkart OTP connection will begin when it is online.');
      }else{
        toast('User saved. Choose Connect account to retry verification.');
      }
    }catch(error){$('#retailerUserError').textContent=customerError(error)}
    finally{button.disabled=false;button.textContent='Save user & connect login'}
  });

  $('#retailerUsersBulkFile')?.addEventListener('change',event=>{
    const file=event.target.files?.[0];
    const meta=$('#retailerUsersBulkFileMeta');
    if(meta)meta.textContent=file?(file.name+' · '+Math.max(1,Math.round(file.size/1024))+' KB'):'No file selected';
    $('#retailerUsersBulkError').textContent='';
  });

  $('#retailerUsersBulkForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    const formElement=event.currentTarget;
    const button=$('#importRetailerUsers'),file=$('#retailerUsersBulkFile')?.files?.[0];
    button.disabled=true;button.textContent='Importing & connecting…';$('#retailerUsersBulkError').textContent='';
    try{
      if(!file)throw new Error('Choose a CSV or XLSX file');
      const data=new FormData();data.append('file',file,file.name);
      const result=await request('/api/address-books/import',{method:'POST',body:data});
      let queued=0;
      const ids=result.retailerAccountIds||[];
      try{
        if(ids.length){
          const prepared=await request('/api/retailer-accounts/prepare',{
            method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({accountIds:ids,retailer:'flipkart',targetDays:sessionTargetDays()})
          });
          queued=Number(prepared.count||0);
        }
      }catch{}
      const secureState=await request('/api/execution-workers').catch(()=>({workers:[]}));
      secureBrowserReady=(secureState.workers||[]).length>0;
      formElement.reset();
      if($('#retailerUsersBulkFileMeta'))$('#retailerUsersBulkFileMeta').textContent='No file selected';
      $('#retailerUserDialog').close();
      await load();
      if(queued&&secureBrowserReady){
        toast(result.count+' users imported · '+queued+' account connection(s) queued.');
      }else if(queued){
        toast(result.count+' users imported. Secure Browser will authenticate the queued accounts one at a time.');
      }else{
        toast(result.count+' users imported · '+result.retailerAccountsBound+' Flipkart login(s) added. Choose Connect all accounts to continue.');
      }
    }catch(error){$('#retailerUsersBulkError').textContent=customerError(error)}
    finally{button.disabled=false;button.textContent='Import users & connect logins'}
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
    const formElement=event.currentTarget;
    const button=$('#saveRetailerAccounts'),form=new FormData(formElement);
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
          password:selectedRetailer==='flipkart'?undefined:(item.password||undefined),
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
      formElement.reset();$('#retailerAccountsDialog').close();
      await load();toast(imported+' retailer account(s) added to the pool');
    }catch(error){$('#retailerAccountsError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Import accounts'}
  });

  $('#retailerAccountPool')?.addEventListener('click',async event=>{
    const row=event.target.closest('[data-account-id]');if(!row)return;
    const account=accounts.find(x=>x.id===row.dataset.accountId);if(!account)return;
    const savePassword=event.target.closest('[data-save-account-password]');
    if(savePassword){
      const input=row.querySelector('[data-account-password-input]');
      const password=String(input?.value||'');
      if(!password){alert('Enter the retailer password.');return}
      savePassword.disabled=true;const previous=savePassword.textContent;savePassword.textContent='Saving…';
      try{
        await request('/api/retailer-accounts/'+encodeURIComponent(account.id)+'/credential',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})
        });
        if(input)input.value='';
        toast('Password encrypted and saved. OrderGrid is connecting this retailer account.');
        await load();
      }catch(error){alert(customerError(error))}
      finally{savePassword.textContent=previous;setTimeout(()=>{savePassword.disabled=false},1200)}
      return;
    }
    const submitOtp=event.target.closest('[data-submit-account-otp]');
    if(submitOtp){
      const input=row.querySelector('[data-account-otp-input]');
      const otp=String(input?.value||'').trim();
      if(!/^\d{4,8}$/.test(otp)){alert('Enter the 4–8 digit retailer OTP.');return}
      submitOtp.disabled=true;const previous=submitOtp.textContent;submitOtp.textContent='Verifying…';
      try{
        await request('/api/retailer-accounts/'+encodeURIComponent(account.id)+'/otp',{
          method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})
        });
        if(input)input.value='';
        toast('OTP sent securely to the managed retailer session. OrderGrid is re-checking the account.');
        setTimeout(()=>load().catch(()=>{}),1800);
      }catch(error){alert(customerError(error))}
      finally{submitOtp.textContent=previous;setTimeout(()=>{submitOtp.disabled=false},1200)}
      return;
    }
    const verify=event.target.closest('[data-verify-session]');
    if(verify){
      verify.disabled=true;const previous=verify.textContent;verify.textContent='Queuing…';
      try{
        await request('/api/retailer-accounts/prepare',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({accountIds:[account.id],retailer:account.retailer,targetDays:sessionTargetDays()})
        });
        const secureState=await request('/api/execution-workers').catch(()=>({workers:[]}));
        secureBrowserReady=(secureState.workers||[]).length>0;
        renderSecureBrowserStatus();
        await load();
        toast(secureBrowserReady
          ?'Account queued. OrderGrid Cloud Secure Browser is verifying the retailer login.'
          :'Account queued. Cloud Secure Browser is starting automatically.');
      }catch(error){alert(customerError(error))}
      finally{verify.textContent=previous;setTimeout(()=>{verify.disabled=false},1200)}
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
