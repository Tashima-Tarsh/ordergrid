(()=>{
  const $=s=>document.querySelector(s);
  const inrMinor=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  const fallbackBanks=[
    {code:'hdfc',name:'HDFC Bank',mode:'PARENT_CARD_API',product:'Credit Card Virtual Card Creation',notes:'Production endpoint and credentials require your approved HDFC corporate programme.'},
    {code:'axis',name:'Axis Bank',mode:'PARENT_CARD_API',product:'Purchase Control Virtual Card',notes:'Use the production API contract supplied during Axis corporate onboarding.'}
  ];
  let provider={provider:'disabled',configured:false,source:'none'},cards=[],issuers=[],banks=[...fallbackBanks];
  const issuerSetup=$('#issuerDialog');

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }
  async function timedRequest(path,options={},timeoutMs=4000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{return await request(path,{...options,signal:controller.signal})}
    finally{clearTimeout(timer)}
  }
  function toast(message){
    const node=$('#toast');if(!node)return;node.textContent=message;node.classList.add('show');setTimeout(()=>node.classList.remove('show'),2400);
  }
  function calculate(){
    const qty=Math.max(1,Math.min(100,Number($('#cardQuantity')?.value||1)));
    const amount=Math.max(1,Number($('#cardAmount')?.value||1));
    $('#fundingTotal').textContent=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(qty*amount);
    $('#createCards').textContent=`Create ${qty} virtual ${qty===1?'card':'cards'}`;
    const approved=$('#fundingApproval').checked;
    const previewOnly=false;
    const programmeReady=Boolean($('#cardIssuer')?.value),anyConnected=issuers.some(x=>x.status==='CONNECTED');
    $('#createCards').disabled=!anyConnected||!approved||previewOnly||!programmeReady;
    $('#fundingMessage').textContent=previewOnly
      ?'Card programme setup is required before creating virtual cards.'
      :!anyConnected
        ?'Connect your bank/card programme to create virtual cards.'
        :!programmeReady
          ?'Choose the connected bank/card programme.'
        :!approved
          ?'Confirm that this card programme and funding allocation are authorized.'
          :'The selected bank creates a child virtual card against the approved programme limit; OrderGrid applies available controls and assigns it to the selected merchant scope.';
  }
  function render(){
    const previewOnly=provider.source==='showroom';
    const connected=issuers.filter(x=>x.status==='CONNECTED');
    const name=connected.length===1?(connected[0].programme_name||connected[0].bank_name||connected[0].provider):`${connected.length} bank programmes`;
    $('#fundingName').textContent=connected.length?`${name} connected`:'No card programme connected';
    const cardIdentity=connected.find(x=>x.funding_card_last4);
    $('#fundingMeta').textContent=previewOnly
      ?'Set up an approved funding card and virtual-card programme to begin.'
      :connected.length
        ?(cardIdentity
          ?`${cardIdentity.bank_name||cardIdentity.provider} funding card ending ${cardIdentity.funding_card_last4} · choose the programme below to create virtual cards.`
          :'Choose any connected bank programme below. Parent-card programmes create child virtual cards against the approved bank limit.')
        :'Set up the existing funding card and bank virtual-card programme to continue.';
    $('#issuerStatus').textContent=connected.length?`${connected.length} CONNECTED`:'SETUP REQUIRED';
    $('#fundingLimit').textContent=connected.length?'Bank controlled':'—';
    const current=connected[0]||null;
    $('#fundingBank').textContent=current?(current.bank_name||current.provider||'Connected issuer'):'—';
    $('#fundingProgramme').textContent=current?(current.programme_name||'Connected programme'):'—';
    $('#fundingNetwork').textContent=current?(current.card_network||'—'):'—';
    $('#fundingCardIdentity').textContent=current?.funding_card_last4
      ?`Ending ${current.funding_card_last4}${current.funding_card_expiry_month&&current.funding_card_expiry_year?` · ${String(current.funding_card_expiry_month).padStart(2,'0')}/${current.funding_card_expiry_year}`:''}`
      :'—';
    $('#fundingConnectionMode').textContent=current
      ?String(current.integration_mode||current.provider||'CONNECTED').replaceAll('_',' ')
      :'—';
    $('#fundingConnectionState').textContent=current?'CONNECTED':'SETUP REQUIRED';
    $('#issuerModalStatus').textContent=current?'CONNECTED':'SETUP REQUIRED';
    $('#issuerModalProgramme').textContent=current?(current.programme_name||current.bank_name||current.provider):'Not connected';
    $('#issuerModalCard').textContent=current?.funding_card_last4?`Ending ${current.funding_card_last4}`:'Not connected';
    $('#connectIssuer').hidden=false;
    $('#connectIssuer').disabled=false;
    $('#connectIssuer').textContent=previewOnly?'Production setup only':connected.length?'Edit funding card / programme':'Set up funding card';
    $('#disconnectIssuer').hidden=!connected.length||previewOnly;
    const issuerSelect=$('#cardIssuer');
    if(issuerSelect){
      issuerSelect.innerHTML=connected.length?connected.map(x=>`<option value="${x.id}">${x.programme_name||x.bank_name||x.provider} · ${x.card_network||'card programme'}${x.integration_mode==='PARENT_CARD_API'?' · parent-card limit':''}</option>`).join(''):'<option value="">Connect a programme first</option>';
      syncCardholderRequirements();
    }
    $('#virtualCardInventory').innerHTML=cards.length?cards.map((card,i)=>`
      <div class="virtual-card-row" data-card="${card.id}">
        <strong>${card.label||'Virtual card '+String(i+1).padStart(2,'0')} · ${card.masked_number||card.provider_card_id}</strong>
        <span>${inrMinor(card.balance_minor)} card limit / available allocation</span>
        <span>${card.merchant_control||'Issuer controls'} · ${card.channel_control_status==='APPLIED'?'online-only control applied':'control '+String(card.channel_control_status||'pending').toLowerCase()}</span>
        <span class="card-active">${card.status}</span>
        ${(()=>{const issuer=issuers.find(x=>x.id===card.issuer_connection_id);return issuer?.capabilities?.loadCard===false?'':'<button type="button" class="secondary" data-load>Adjust limit / load</button>'})()}
      </div>`).join(''):'<p class="muted">Created virtual cards will appear here.</p>';
    calculate();
  }
  async function load(){
    const results=await Promise.allSettled([
      timedRequest('/api/cards/provider'),timedRequest('/api/cards'),timedRequest('/api/issuers'),timedRequest('/api/cards/banks')
    ]);
    if(results[0].status==='fulfilled')provider=results[0].value;
    if(results[1].status==='fulfilled')cards=results[1].value.cards||[];
    if(results[2].status==='fulfilled')issuers=results[2].value.issuers||[];
    if(results[3].status==='fulfilled'&&Array.isArray(results[3].value.banks)&&results[3].value.banks.length){
      const byCode=new Map([...fallbackBanks,...results[3].value.banks].map(x=>[x.code,x]));
      banks=[...byCode.values()];
    }
    for(const result of results)if(result.status==='rejected'&&result.reason?.name!=='AbortError')console.error(result.reason);
    render();
  }

  function syncCardholderRequirements(){
    const selected=issuers.find(x=>x.id===$('#cardIssuer')?.value),needsKyc=selected?.provider==='enkash';
    document.querySelectorAll('[data-cardholder-kyc] input,[data-cardholder-kyc] select').forEach(input=>{input.required=Boolean(needsKyc)});
  }
  function syncBankConnector(){
    const form=$('#issuerForm'),code=String(form.elements.provider?.value||'hdfc'),profile=banks.find(x=>x.code===code);
    const isEnKash=code==='enkash';
    $('#bankApiFields').hidden=isEnKash;$('#enkashApiFields').hidden=!isEnKash;
    if(profile){
      $('#issuerBankName').value=profile.name;
      $('#bankProfileNote').innerHTML='<strong>'+profile.name+'</strong> · '+profile.product+'<br>'+profile.notes;
      if(form.elements.integrationMode)form.elements.integrationMode.value=profile.mode==='PARENT_CARD_API'?'PARENT_CARD_API':'CUSTOM_BANK_API';
    }else if(isEnKash){
      $('#issuerBankName').value='EnKash';
      $('#bankProfileNote').textContent='Use your approved EnKash corporate-card programme API credentials.';
    }else{
      const label=form.elements.provider?.selectedOptions?.[0]?.textContent?.trim()||'Selected bank';
      if(code!=='custom'&&!$('#issuerBankName').value)$('#issuerBankName').value=label;
      $('#bankProfileNote').textContent='Enter the API contract and credentials supplied for your approved corporate-card programme.';
    }
    const needsKyc=isEnKash;
    document.querySelectorAll('[data-cardholder-kyc] input,[data-cardholder-kyc] select').forEach(input=>{input.required=needsKyc});
    syncBankAuth();
  }
  function syncBankAuth(){
    const mode=String($('#bankAuthMode')?.value||'OAUTH2_CLIENT_CREDENTIALS'),map={OAUTH2_CLIENT_CREDENTIALS:'oauth',BEARER:'bearer',BASIC:'basic',API_KEY:'apikey'};
    document.querySelectorAll('#bankApiFields [data-auth]').forEach(node=>{node.hidden=node.dataset.auth!==map[mode]});
  }
  $('#issuerProvider')?.addEventListener('change',syncBankConnector);
  $('#cardIssuer')?.addEventListener('change',syncCardholderRequirements);
  $('#bankAuthMode')?.addEventListener('change',syncBankAuth);

  function closeIssuerConnector(){
    const panel=$('#issuerDialog');if(!panel)return;
    panel.hidden=true;
    document.body.classList.remove('issuer-connect-open');
  }
  function prefillFundingCardIdentity(){
    const form=$('#issuerForm'),current=issuers.find(x=>x.status==='CONNECTED');
    if(!form||!current){syncBankConnector();return}
    if(form.elements.provider)form.elements.provider.value=current.provider||current.bank_code||'hdfc';
    syncBankConnector();
    if(form.elements.bankName)form.elements.bankName.value=current.bank_name||form.elements.bankName.value||'';
    if(form.elements.programmeName)form.elements.programmeName.value=current.programme_name||'';
    if(form.elements.cardNetwork)form.elements.cardNetwork.value=current.card_network||'VISA';
    if(form.elements.fundingCardholderName)form.elements.fundingCardholderName.value=current.funding_cardholder_name||'';
    if(form.elements.fundingCardLast4)form.elements.fundingCardLast4.value=current.funding_card_last4||'';
    if(form.elements.fundingCardExpiryMonth)form.elements.fundingCardExpiryMonth.value=current.funding_card_expiry_month||'';
    if(form.elements.fundingCardExpiryYear)form.elements.fundingCardExpiryYear.value=current.funding_card_expiry_year||'';
    if(form.elements.integrationMode&&current.integration_mode)form.elements.integrationMode.value=current.integration_mode;
  }
  function openIssuerConnector(providerCode){
    const panel=$('#issuerDialog');
    if(!panel){toast('Funding card setup is unavailable. Refresh the page.');return}
    const error=$('#issuerError');if(error)error.textContent='';
    panel.hidden=false;
    document.body.classList.add('issuer-connect-open');
    if(providerCode&&providerCode!=='other'&&$('#issuerProvider')){
      $('#issuerProvider').value=providerCode;
      syncBankConnector();
    }else{
      prefillFundingCardIdentity();
    }
    if($('#issuerModalStatus')&&$('#issuerModalStatus').textContent==='SETUP REQUIRED')$('#issuerModalStatus').textContent='READY TO CONFIGURE';
    setTimeout(()=>$('#issuerProvider')?.focus(),0);
    void load().then(()=>{
      if(providerCode&&providerCode!=='other'&&$('#issuerProvider')){
        $('#issuerProvider').value=providerCode;
        syncBankConnector();
      }
    }).catch(error=>console.error(error));
  }
  $('#connectIssuer')?.addEventListener('click',()=>openIssuerConnector());
  $('#openFundingSetupFromCard')?.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openIssuerConnector()});
  $('#fundingSourceCard')?.addEventListener('click',event=>{if(event.target.closest('#openFundingSetupFromCard'))return;openIssuerConnector()});
  $('#fundingSourceCard')?.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openIssuerConnector()}});
  document.querySelectorAll('[data-bank-shortcut]').forEach(button=>button.addEventListener('click',event=>{
    event.preventDefault();
    const code=button.dataset.bankShortcut;
    if(code==='other'){$('#issuerProvider')?.focus();return}
    $('#issuerProvider').value=code;
    syncBankConnector();
    $('#issuerBankName')?.focus();
  }));
  $('#closeIssuer')?.addEventListener('click',closeIssuerConnector);
  $('#cancelIssuer')?.addEventListener('click',closeIssuerConnector);
  issuerSetup?.addEventListener('click',event=>{if(event.target===issuerSetup)closeIssuerConnector()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!issuerSetup?.hidden)closeIssuerConnector()});
  window.addEventListener('ordergrid:cards-open',()=>openIssuerConnector());
  $('#issuerForm').onsubmit=async event=>{
    event.preventDefault();
    const button=$('#saveIssuer'),form=new FormData(event.currentTarget),providerCode=String(form.get('provider'));
    const optional=name=>{const value=String(form.get(name)||'').trim();return value||undefined};
    button.disabled=true;button.textContent='Saving…';$('#issuerError').textContent='';
    try{
      const month=String(form.get('fundingCardExpiryMonth')||'').trim(),year=String(form.get('fundingCardExpiryYear')||'').trim();
      const common={
        provider:providerCode,
        bankName:String(form.get('bankName')),
        programmeName:String(form.get('programmeName')),
        cardNetwork:String(form.get('cardNetwork')),
        fundingCardholderName:optional('fundingCardholderName'),
        fundingCardLast4:optional('fundingCardLast4'),
        fundingCardExpiryMonth:month?Number(month):undefined,
        fundingCardExpiryYear:year?Number(year):undefined
      };
      let payload;
      if(providerCode==='enkash'){
        payload={...common,
          baseUrl:String(form.get('baseUrl')),tokenUrl:String(form.get('tokenUrl')),partnerId:String(form.get('partnerId')),
          basicAuth:String(form.get('basicAuth')),username:String(form.get('username')),password:String(form.get('password')),
          clientId:String(form.get('clientId')),companyId:String(form.get('companyId')),cardAccountId:String(form.get('cardAccountId'))
        };
      }else{
        payload={...common,
          integrationMode:String(form.get('integrationMode')),
          baseUrl:String(form.get('bankBaseUrl')),
          authMode:String(form.get('authMode')),
          tokenUrl:optional('bankTokenUrl'),clientId:optional('bankClientId'),clientSecret:optional('bankClientSecret'),
          bearerToken:optional('bankBearerToken'),username:optional('bankUsername'),password:optional('bankPassword'),
          apiKey:optional('bankApiKey'),apiKeyHeader:optional('bankApiKeyHeader'),
          parentAccountReference:String(form.get('parentAccountReference')),
          healthPath:optional('healthPath'),createCardPath:String(form.get('createCardPath')),
          controlCardPath:optional('controlCardPath'),loadCardPath:optional('loadCardPath'),
          createCardTemplate:String(form.get('createCardTemplate')),
          controlCardTemplate:optional('controlCardTemplate'),loadCardTemplate:optional('loadCardTemplate'),
          responseCardIdPath:String(form.get('responseCardIdPath')),
          responseAccountIdPath:optional('responseAccountIdPath'),responseMaskedNumberPath:optional('responseMaskedNumberPath'),
          responseStatusPath:optional('responseStatusPath'),responseBalancePath:optional('responseBalancePath'),
          responseBalanceUnit:String(form.get('responseBalanceUnit')||'MINOR')
        };
      }
      provider=await request('/api/cards/provider/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      event.currentTarget.reset();closeIssuerConnector();await load();toast('Bank card programme connected');
    }catch(error){
      $('#issuerError').textContent=error.message;
      $('#issuerDialog').hidden=false;
      document.body.classList.add('issuer-connect-open');
      $('#issuerError').scrollIntoView({behavior:'smooth',block:'center'});
    }
    finally{button.disabled=false;button.textContent='Test & connect'}
  };
  $('#disconnectIssuer').onclick=async()=>{
    if(!confirm('Remove this card programme? Existing card records will remain.'))return;
    try{await request('/api/cards/provider',{method:'DELETE'});await load();toast('Card programme removed')}catch(error){alert(error.message)}
  };

  ['cardQuantity','cardAmount','merchantControl','cardIssuer','fundingApproval'].forEach(id=>$('#'+id)?.addEventListener('input',calculate));

  $('#cardProgramForm').onsubmit=async event=>{
    event.preventDefault();
    const selectedIssuer=issuers.find(x=>x.id===String($('#cardIssuer')?.value));if(!selectedIssuer){alert('Connect and select a bank card programme first.');return}
    const button=$('#createCards'),form=new FormData(event.currentTarget);
    const quantity=Number(form.get('quantity')),amountMinor=Math.round(Number(form.get('amount'))*100),merchant=String(form.get('merchantControl')||'all');
    button.disabled=true;button.textContent='Creating cards…';
    try{
      const result=await request('/api/cards',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        quantity,
        amountMinor,
        issuerConnectionId:String(form.get('issuerConnectionId')),
        merchantScope:merchant==='all'?{type:'ALL'}:{type:'RETAILER',value:merchant},
        label:String(form.get('label')||'OrderGrid procurement card'),
        cardholder:Object.fromEntries([
          ['email',String(form.get('email')||'').trim()],
          ['mobile',String(form.get('mobile')||'').replace(/\D/g,'')],
          ['firstName',String(form.get('firstName')||'').trim()],
          ['lastName',String(form.get('lastName')||'').trim()],
          ['gender',String(form.get('gender')||'').trim()],
          ['pan',String(form.get('pan')||'').trim().toUpperCase()],
          ['specialDate',String(form.get('specialDate')||'').trim()]
        ].filter(([,value])=>value))
      })});
      await load();$('#fundingApproval').checked=false;calculate();
      toast(`${result.created} virtual card(s) created from the selected bank programme${result.failed?' · '+result.failed+' failed':''}`);
    }catch(error){alert(error.message)}
    finally{button.disabled=false;calculate()}
  };

  $('#virtualCardInventory').onclick=async event=>{
    const button=event.target.closest('[data-load]');if(!button)return;
    const row=button.closest('[data-card]'),card=cards.find(x=>x.id===row.dataset.card);
    const rupees=Number(prompt(`Additional limit / load amount for ${card.label||card.provider_card_id} (₹):`));
    if(!Number.isFinite(rupees)||rupees<=0)return;
    button.disabled=true;
    try{await request(`/api/cards/${card.id}/load`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountMinor:Math.round(rupees*100)})});await load();toast('Card limit / funding updated')}
    catch(error){alert(error.message)}
    finally{button.disabled=false}
  };
  window.addEventListener('ordergrid:auth-ready',load);
  window.addEventListener('ordergrid:refresh',load);
  load();
})();