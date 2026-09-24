(()=>{
  const $=s=>document.querySelector(s);
  const esc=value=>{const node=document.createElement('div');node.textContent=String(value??'');return node.innerHTML};
  const moneyMinor=value=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(value||0)/100);
  let retailer='flipkart',accounts=[],finance={accounts:[],summary:{}},secureBrowserReady=false,desktopBrowserReady=false;

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
    if(/worker.*offline|execution worker|session worker|managed execution offline/i.test(message))return 'A live OrderGrid execution worker is required. For first-time Flipkart sign-in, start the OrderGrid desktop worker so a visible Chrome window can be used.';
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
      status.textContent=desktopBrowserReady?'DESKTOP SIGN-IN ONLINE':secureBrowserReady?'CLOUD CHECKOUT ONLINE · DESKTOP SIGN-IN OFFLINE':'SECURE BROWSER OFFLINE';
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
      const isOtpCooling=Boolean(account.otp_cooldown_until&&new Date(account.otp_cooldown_until)>new Date());
      const otpCooldownTime=isOtpCooling?new Date(account.otp_cooldown_until).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}):'';
      const sessionMeta=sessionStatus==='READY'
        ?'Connected · verified until '+sessionUntil
        :sessionStatus==='REAUTH_REQUIRED'
          ?(challenge==='OTP_REQUIRED'
            ?('Flipkart sent an OTP. Enter it below.'+(isOtpCooling?' A new OTP can be requested after '+otpCooldownTime+'.':''))
            :challenge==='OTP_COOLDOWN'||isOtpCooling
              ?`⏳ OTP cooldown active until ${otpCooldownTime}. Flipkart rate-limited or cooling down.`
              :challenge==='ACCOUNT_NOT_REGISTERED'?'Flipkart login identifier not registered or unverified.'
              :challenge==='OTP_NOT_SENT'?'Flipkart did not send OTP. Use manual browser login to connect.'
              :challenge==='CAPTCHA_REQUIRED'?'Retailer CAPTCHA requires authorised manual verification'
              :'Retailer verification required')
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
        ?(isOtpCooling
          ?(challenge==='OTP_REQUIRED'
            ?''
            :`<span class="session-cooldown-chip" style="font-size:11px;color:#d97706;padding:4px 8px;background:rgba(245,158,11,0.1);border-radius:4px;">⏳ Cooldown until ${otpCooldownTime}</span>`)
          :`<button type="button" class="secondary" data-verify-session>${sessionStatus==='VERIFYING'?'Connecting…':'Connect account'}</button>`)
        :sessionStatus==='READY'
          ?'<span class="session-connected-chip">✓ Connected</span><button type="button" class="secondary" data-reconnect-session style="padding:4px 9px;font-size:11px;margin-left:6px;">Reconnect</button><button type="button" class="secondary" data-disconnect-session style="padding:4px 9px;font-size:11px;margin-left:6px;color:#64748b;border-color:#cbd5e1;">Disconnect</button>'
          :'';
      const identity=account.customer_id
        ?esc(account.display_name||account.label||account.account_reference)+' · '+esc(account.customer_reference||'BOUND USER')
        :'LOGIN-ONLY POOL ACCOUNT';
      const addressMeta=account.customer_id
        ?[account.address_line1,account.address_line2,account.address_city,account.address_state,account.address_postal_code].filter(Boolean).map(esc).join(' · ')
        :'No delivery user/address bound';
      const isCooling=account.cooldown_until&&new Date(account.cooldown_until)>new Date();
      const cooldownMeta=isCooling?` · ⏳ Cooldown until ${new Date(account.cooldown_until).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'})}`:'';
      const healthMeta=account.health_score!==undefined&&account.health_score!==null?` · Health: ${account.health_score}%`:'';
      return `
        <article class="retailer-account-row" data-account-id="${esc(account.id)}">
          <div class="account-main">
            <strong>${identity}</strong>
            <small>Flipkart login: ${esc(account.account_reference)} · ${esc(connectionStatus)}${healthMeta}${cooldownMeta}</small>
            <small>${addressMeta}</small>
            <small class="session-line ${sessionStatus==='READY'?'ready':sessionStatus==='REAUTH_REQUIRED'?'attention':''}">${esc(sessionMeta)}</small>
          </div>
          <div><span>ORDERS</span><strong>${Number(account.order_count||0)}</strong><small>${Number(account.active_orders||0)} active / ${Number(account.max_concurrent_orders||1)} max</small></div>
          <div><span>REWARDS</span><strong>${available}</strong><small>${esc(rewardMeta)}</small></div>
          <div><span>REFUNDS</span><strong>${moneyMinor(account.settled_refund_minor||0)}</strong><small>${esc(refundMeta)}</small></div>
          <div class="account-actions">${credentialAction}${verifyAction}${otpAction}<button type="button" class="secondary" data-toggle-account>${account.active?'Pause':'Activate'}</button><button type="button" class="secondary danger-btn" data-delete-account style="color:#ef4444;border-color:rgba(239,68,68,0.3);">Delete</button></div>
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

  let activeConnectingAccount = null, connectPollTimer = null;

  function closeConnectModal(){
    if(connectPollTimer){clearInterval(connectPollTimer);connectPollTimer=null}
    activeConnectingAccount=null;
    const dialog=$('#retailerConnectDialog');
    if(dialog&&typeof dialog.close==='function')dialog.close();
  }

  async function openConnectModal(account){
    activeConnectingAccount=account;
    if(connectPollTimer){clearInterval(connectPollTimer);connectPollTimer=null}
    const dialog=$('#retailerConnectDialog');
    if(!dialog)return;

    const accName=account.display_name||account.label||account.name||account.account_reference;
    $('#connectAccountName').textContent=accName;
    $('#connectAccountRef').textContent=account.account_reference;
    $('#connectOtpError').textContent='';
    if($('#connectOtpInput'))$('#connectOtpInput').value='';

    const isOtpWaiting=String(account.session_status)==='REAUTH_REQUIRED'&&String(account.session_challenge_code)==='OTP_REQUIRED';
    const isReady=String(account.session_status)==='READY';

    if(isReady){
      $('#connectStatusCard').className='connect-status-card success';
      $('#connectStatusHeading').textContent='✓ Account Connected';
      $('#connectStatusMeta').textContent='Flipkart session is verified and ready for checkout.';
      $('#connectOtpForm').hidden=true;
    }else if(isOtpWaiting){
      $('#connectStatusCard').className='connect-status-card otp-ready';
      $('#connectStatusHeading').textContent='Flipkart OTP required';
      $('#connectStatusMeta').textContent=`Enter the 6-digit verification code sent to ${account.account_reference}.`;
      $('#connectOtpForm').hidden=false;
      setTimeout(()=>$('#connectOtpInput')?.focus(),150);
    }else{
      $('#connectStatusCard').className='connect-status-card connecting';
      $('#connectStatusHeading').textContent='Connecting to Flipkart…';
      $('#connectStatusMeta').textContent=secureBrowserReady
        ?'OrderGrid Cloud Secure Browser is opening Flipkart and requesting your login OTP…'
        :'Cloud Secure Browser is starting and opening Flipkart…';
      $('#connectOtpForm').hidden=true;

      try{
        await request('/api/retailer-accounts/prepare',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({accountIds:[account.id],retailer:account.retailer||'flipkart',targetDays:sessionTargetDays()})
        });
      }catch(err){
        console.error('Prepare error:',err);
      }
    }

    if($('#connectLivePreview'))$('#connectLivePreview').hidden=true;
    if(typeof dialog.showModal==='function')dialog.showModal();
    else dialog.setAttribute('open','');

    let pollCount=0;
    connectPollTimer=setInterval(async()=>{
      pollCount++;
      try{
        const [resp,screenResp]=await Promise.allSettled([
          request('/api/retailer-accounts?retailer='+encodeURIComponent(account.retailer||'flipkart')+'&limit=1000'),
          request('/api/retailer-accounts/'+encodeURIComponent(activeConnectingAccount?.id||account.id)+'/screen')
        ]);
        const updatedAccounts=resp.status==='fulfilled'?(resp.value.accounts||[]):[];
        if(updatedAccounts.length)accounts=updatedAccounts;
        const target=updatedAccounts.find(x=>x.id===(activeConnectingAccount?.id||account.id));
        if(screenResp.status==='fulfilled'&&screenResp.value?.screenshot){
          const img=$('#connectLiveImage'),prev=$('#connectLivePreview');
          if(img&&prev){img.src=screenResp.value.screenshot;prev.hidden=false}
        }
        if(!target)return;
        activeConnectingAccount=target;

        const st=String(target.session_status||'');
        const ch=String(target.session_challenge_code||'');

        if(st==='READY'){
          clearInterval(connectPollTimer);
          connectPollTimer=null;
          $('#connectStatusCard').className='connect-status-card success';
          $('#connectStatusHeading').textContent='✓ Connected to Flipkart!';
          $('#connectStatusMeta').textContent='Session verified and saved. Ready for instant batch purchases.';
          $('#connectOtpForm').hidden=true;
          render();
          toast(`${target.account_reference} connected successfully!`);
          setTimeout(()=>{closeConnectModal()},1400);
        }else if(st==='REAUTH_REQUIRED'&&ch==='OTP_REQUIRED'){
          $('#connectStatusCard').className='connect-status-card otp-ready';
          $('#connectStatusHeading').textContent='Flipkart OTP required';
          $('#connectStatusMeta').textContent=`Enter the 6-digit verification code sent to ${target.account_reference}.`;
          if($('#connectOtpForm').hidden){
            $('#connectOtpForm').hidden=false;
            $('#connectOtpInput').focus();
          }
        }else if(st==='VERIFYING'){
          if($('#connectOtpForm').hidden){
            $('#connectStatusCard').className='connect-status-card connecting';
            $('#connectStatusHeading').textContent='Connecting to Flipkart…';
            $('#connectStatusMeta').textContent='Cloud Secure Browser is communicating with Flipkart…';
          }
        }

        if(pollCount>120){
          clearInterval(connectPollTimer);
          connectPollTimer=null;
          $('#connectStatusCard').className='connect-status-card';
          $('#connectStatusHeading').textContent='Connection timeout';
          $('#connectStatusMeta').textContent='Flipkart did not respond in time. Click Resend OTP or retry.';
        }
      }catch(err){
        console.error('Polling error:',err);
      }
    },700);
  }

  $('#connectOtpForm')?.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!activeConnectingAccount)return;
    const otpInput=$('#connectOtpInput');
    const otp=String(otpInput?.value||'').trim();
    if(!/^\d{4,8}$/.test(otp)){
      $('#connectOtpError').textContent='Enter the 4–8 digit Flipkart OTP.';
      return;
    }
    const btn=$('#connectSubmitOtp');
    btn.disabled=true;const prev=btn.textContent;btn.textContent='Verifying…';
    $('#connectOtpError').textContent='';
    $('#connectStatusCard').className='connect-status-card connecting';
    $('#connectStatusHeading').textContent='Verifying OTP on Flipkart…';
    $('#connectStatusMeta').textContent='Secure Browser is submitting your OTP to Flipkart…';

    try{
      await request('/api/retailer-accounts/'+encodeURIComponent(activeConnectingAccount.id)+'/otp',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({otp})
      });
      toast('OTP submitted to Flipkart session.');
    }catch(error){
      $('#connectOtpError').textContent=customerError(error);
      $('#connectStatusCard').className='connect-status-card otp-ready';
      $('#connectStatusHeading').textContent='Flipkart OTP verification failed';
      $('#connectStatusMeta').textContent=customerError(error);
    }finally{
      btn.disabled=false;btn.textContent=prev;
    }
  });

  $('#connectResendOtp')?.addEventListener('click',async()=>{
    if(!activeConnectingAccount)return;
    const btn=$('#connectResendOtp');
    btn.disabled=true;
    $('#connectOtpError').textContent='';
    $('#connectOtpInput').value='';
    $('#connectStatusCard').className='connect-status-card connecting';
    $('#connectStatusHeading').textContent='Requesting new OTP…';
    $('#connectStatusMeta').textContent='Cloud Secure Browser is asking Flipkart for a new OTP…';
    try{
      await request('/api/retailer-accounts/prepare',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({accountIds:[activeConnectingAccount.id],retailer:activeConnectingAccount.retailer||'flipkart',targetDays:sessionTargetDays()})
      });
      toast('Requested new OTP from Flipkart.');
    }catch(err){
      $('#connectOtpError').textContent=customerError(err);
    }finally{
      setTimeout(()=>{btn.disabled=false},2000);
    }
  });

  $('#closeRetailerConnect')?.addEventListener('click',closeConnectModal);
  $('#retailerConnectDialog')?.addEventListener('close',()=>{
    if(connectPollTimer){clearInterval(connectPollTimer);connectPollTimer=null}
    activeConnectingAccount=null;
  });

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
      formElement.reset();$('#retailerUserDialog').close();
      await load();
      if(result.account){
        openConnectModal(result.account);
      }else{
        toast('User saved. Choose Connect account to verify login.');
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
      openConnectModal(account);
      return;
    }
    const disconnectBtn=event.target.closest('[data-disconnect-session]');
    if(disconnectBtn){
      disconnectBtn.disabled=true;
      try{
        await request('/api/retailer-accounts/'+encodeURIComponent(account.id)+'/session/disconnect',{method:'POST'});
        toast('Account session disconnected.');
        await load();
      }catch(error){alert(error.message)}
      finally{disconnectBtn.disabled=false}
      return;
    }
    const reconnectBtn=event.target.closest('[data-reconnect-session]');
    if(reconnectBtn){
      openConnectModal(account);
      return;
    }
    const verify=event.target.closest('[data-verify-session]');
    if(verify){
      openConnectModal(account);
      return;
    }
    const deleteBtn=event.target.closest('[data-delete-account]');
    if(deleteBtn){
      if(!confirm(`Are you sure you want to remove account "${account.label||account.account_reference}"?`))return;
      deleteBtn.disabled=true;
      try{
        await request('/api/retailer-accounts/'+encodeURIComponent(account.id),{method:'DELETE'});
        toast('Account removed: '+(account.label||account.account_reference));
        await load();
      }catch(error){alert(error.message)}
      finally{deleteBtn.disabled=false}
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
