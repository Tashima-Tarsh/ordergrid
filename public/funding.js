(()=>{
  const $=s=>document.querySelector(s);
  const inrMinor=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  let provider={provider:'disabled',configured:false,source:'none'},cards=[],issuers=[],banks=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
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
    const previewOnly=provider.source==='showroom';
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
    $('#fundingMeta').textContent=previewOnly
      ?'Connect an approved card programme to begin.'
      :connected.length
        ?'Choose any connected bank programme below. Parent-card programmes create child virtual cards against the approved bank limit.'
        :'Connect a bank/card programme to continue.';
    $('#issuerStatus').textContent=connected.length?`${connected.length} CONNECTED`:'SETUP REQUIRED';
    $('#fundingLimit').textContent=connected.length?'Bank controlled':'—';
    $('#connectIssuer').hidden=false;
    $('#connectIssuer').disabled=previewOnly;
    $('#connectIssuer').textContent=previewOnly?'Production setup only':connected.length?'Add / replace bank programme':'Connect bank programme';
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
    try{
      const [p,c,i,b]=await Promise.all([request('/api/cards/provider'),request('/api/cards'),request('/api/issuers'),request('/api/cards/banks')]);
      provider=p;cards=c.cards||[];issuers=i.issuers||[];banks=b.banks||[];render();
    }catch(error){
      provider={provider:'disabled',configured:false,source:'showroom'};
      cards=[];issuers=[];banks=[];render();console.error(error);
    }
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

  $('#connectIssuer').onclick=()=>{
    if(provider.source==='showroom'){toast('Card programme connection is available on the production OrderGrid service.');return}
    $('#issuerError').textContent='';
    syncBankConnector();$('#issuerDialog').showModal();
  };
  $('#closeIssuer').onclick=()=>$('#issuerDialog').close();
  $('#cancelIssuer').onclick=()=>$('#issuerDialog').close();
  $('#issuerForm').onsubmit=async event=>{
    event.preventDefault();
    const button=$('#saveIssuer'),form=new FormData(event.currentTarget),providerCode=String(form.get('provider'));
    const optional=name=>{const value=String(form.get(name)||'').trim();return value||undefined};
    button.disabled=true;button.textContent='Saving…';$('#issuerError').textContent='';
    try{
      const common={
        provider:providerCode,
        bankName:String(form.get('bankName')),
        programmeName:String(form.get('programmeName')),
        cardNetwork:String(form.get('cardNetwork'))
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
      event.currentTarget.reset();$('#issuerDialog').close();await load();toast('Bank card programme connected');
    }catch(error){$('#issuerError').textContent=error.message}
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
  load();
})();