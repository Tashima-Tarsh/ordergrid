(()=>{
  const $=s=>document.querySelector(s);
  const inrMinor=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  let provider={provider:'disabled',configured:false,source:'none'},cards=[];

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
    $('#createCards').textContent=`Create & load ${qty} virtual ${qty===1?'card':'cards'}`;
    const approved=$('#fundingApproval').checked;
    const previewOnly=provider.source==='showroom';
    $('#createCards').disabled=!provider.configured||!approved||previewOnly;
    $('#fundingMessage').textContent=previewOnly
      ?'Card programme setup is required before creating virtual cards.'
      :!provider.configured
        ?'Connect an approved card programme to create virtual cards.'
        :!approved
          ?'Confirm that this card programme and funding allocation are authorized.'
          :`Issuer will create ${qty} real virtual card(s) and load the requested amount to each card.`;
  }
  function render(){
    const previewOnly=provider.source==='showroom';
    const name=provider.provider==='enkash'?'EnKash':'No issuer';
    $('#fundingName').textContent=provider.configured?`${name} card programme connected`:'No card programme connected';
    $('#fundingMeta').textContent=previewOnly
      ?'Connect an approved card programme to begin.'
      :provider.configured
        ?'Virtual cards are created and managed through your approved card programme.'
        :'Connect a card programme to continue.';
    $('#issuerStatus').textContent=provider.configured?'CONNECTED':'SETUP REQUIRED';
    $('#fundingLimit').textContent=provider.configured?'Available':'—';
    $('#connectIssuer').hidden=provider.configured&&!previewOnly;
    $('#connectIssuer').disabled=true;
    $('#connectIssuer').textContent=provider.configured?'Connected':'Setup by administrator';
    $('#disconnectIssuer').hidden=!provider.configured||previewOnly;
    $('#virtualCardInventory').innerHTML=cards.length?cards.map((card,i)=>`
      <div class="virtual-card-row" data-card="${card.id}">
        <strong>${card.label||'Virtual card '+String(i+1).padStart(2,'0')} · ${card.masked_number||card.provider_card_id}</strong>
        <span>${inrMinor(card.balance_minor)} loaded</span>
        <span>${card.merchant_control||'Issuer controls'}</span>
        <span class="card-active">${card.status}</span>
        <button type="button" class="secondary" data-load>Load funds</button>
      </div>`).join(''):'<p class="muted">Created virtual cards will appear here.</p>';
    calculate();
  }
  async function load(){
    try{
      const [p,c]=await Promise.all([request('/api/cards/provider'),request('/api/cards')]);
      provider=p;cards=c.cards||[];render();
    }catch(error){
      provider={provider:'disabled',configured:false,source:'showroom'};
      cards=[];render();console.error(error);
    }
  }

  $('#connectIssuer').onclick=()=>{};
  $('#closeIssuer').onclick=()=>$('#issuerDialog').close();
  $('#cancelIssuer').onclick=()=>$('#issuerDialog').close();
  $('#issuerForm').onsubmit=async event=>{
    event.preventDefault();
    const button=$('#saveIssuer'),form=new FormData(event.currentTarget);
    button.disabled=true;button.textContent='Saving…';$('#issuerError').textContent='';
    try{
      provider=await request('/api/cards/provider/connect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        provider:'enkash',
        baseUrl:String(form.get('baseUrl')),
        tokenUrl:String(form.get('tokenUrl')),
        partnerId:String(form.get('partnerId')),
        basicAuth:String(form.get('basicAuth')),
        username:String(form.get('username')),
        password:String(form.get('password')),
        clientId:String(form.get('clientId')),
        companyId:String(form.get('companyId')),
        cardAccountId:String(form.get('cardAccountId'))
      })});
      event.currentTarget.reset();$('#issuerDialog').close();await load();toast('Card programme connected');
    }catch(error){$('#issuerError').textContent=error.message}
    finally{button.disabled=false;button.textContent='Save'}
  };
  $('#disconnectIssuer').onclick=async()=>{
    if(!confirm('Remove this card programme? Existing card records will remain.'))return;
    try{await request('/api/cards/provider',{method:'DELETE'});await load();toast('Card programme removed')}catch(error){alert(error.message)}
  };

  ['cardQuantity','cardAmount','merchantControl','fundingApproval'].forEach(id=>$('#'+id)?.addEventListener('input',calculate));

  $('#cardProgramForm').onsubmit=async event=>{
    event.preventDefault();
    if(!provider.configured){alert('Connect an approved card programme first.');return}
    const button=$('#createCards'),form=new FormData(event.currentTarget);
    const quantity=Number(form.get('quantity')),amountMinor=Math.round(Number(form.get('amount'))*100);
    button.disabled=true;button.textContent='Creating cards…';
    try{
      const result=await request('/api/cards',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
        quantity,
        amountMinor,
        merchantControl:String(form.get('merchantControl')),
        label:String(form.get('label')||'OrderGrid procurement card'),
        cardholder:{
          email:String(form.get('email')),
          mobile:String(form.get('mobile')).replace(/\D/g,''),
          firstName:String(form.get('firstName')),
          lastName:String(form.get('lastName')),
          gender:String(form.get('gender')),
          pan:String(form.get('pan')).trim().toUpperCase(),
          specialDate:String(form.get('specialDate'))
        }
      })});
      await load();$('#fundingApproval').checked=false;calculate();
      toast(`${result.created} real virtual card(s) created and loaded${result.failed?' · '+result.failed+' failed':''}`);
    }catch(error){alert(error.message)}
    finally{button.disabled=false;calculate()}
  };

  $('#virtualCardInventory').onclick=async event=>{
    const button=event.target.closest('[data-load]');if(!button)return;
    const row=button.closest('[data-card]'),card=cards.find(x=>x.id===row.dataset.card);
    const rupees=Number(prompt(`Amount to load to ${card.label||card.provider_card_id} (₹):`));
    if(!Number.isFinite(rupees)||rupees<=0)return;
    button.disabled=true;
    try{await request(`/api/cards/${card.id}/load`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountMinor:Math.round(rupees*100)})});await load();toast('Funds added')}
    catch(error){alert(error.message)}
    finally{button.disabled=false}
  };
  load();
})();