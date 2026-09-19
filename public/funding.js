(()=>{
  const $=s=>document.querySelector(s);
  const inrMinor=n=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(n||0)/100);
  let provider={provider:'disabled',configured:false},cards=[];

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.error||body.message||'Request failed').replaceAll('_',' '));
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
    $('#createCards').disabled=!provider.configured||!approved;
    $('#fundingMessage').textContent=!provider.configured
      ?'No production card issuer is connected. Configure the approved issuer credentials on the OrderGrid server.'
      :!approved
        ?'Confirm that this card programme and funding allocation are authorized.'
        :`Issuer will create ${qty} real virtual card(s) and load the requested amount to each card.`;
  }
  function render(){
    const name=provider.provider==='enkash'?'EnKash':'No issuer';
    $('#fundingName').textContent=provider.configured?`${name} production issuer connected`:'No production issuer connected';
    $('#fundingMeta').textContent=provider.configured?'Cards are created by the issuer; OrderGrid stores only issuer IDs and masked metadata.':'Complete issuer onboarding and server credentials before issuing cards.';
    $('#issuerStatus').textContent=provider.configured?'PRODUCTION CONNECTED':'NOT CONNECTED';
    $('#fundingLimit').textContent=provider.configured?'Issuer governed':'—';
    $('#virtualCardInventory').innerHTML=cards.length?cards.map((card,i)=>`
      <div class="virtual-card-row" data-card="${card.id}">
        <strong>${card.label||'Virtual card '+String(i+1).padStart(2,'0')} · ${card.masked_number||card.provider_card_id}</strong>
        <span>${inrMinor(card.balance_minor)} loaded</span>
        <span>${card.merchant_control||'Issuer controls'}</span>
        <span class="card-active">${card.status}</span>
        <button type="button" class="secondary" data-load>Load funds</button>
      </div>`).join(''):'<p class="muted">Real issuer-created virtual cards will appear here after successful issuance.</p>';
    calculate();
  }
  async function load(){
    try{
      const [p,c]=await Promise.all([request('/api/cards/provider'),request('/api/cards')]);
      provider=p;cards=c.cards||[];render();
    }catch(error){console.error(error)}
  }
  ['cardQuantity','cardAmount','merchantControl','fundingApproval'].forEach(id=>$('#'+id)?.addEventListener('input',calculate));

  $('#cardProgramForm').onsubmit=async event=>{
    event.preventDefault();
    if(!provider.configured){alert('Connect an approved production issuer on the OrderGrid server first.');return}
    const button=$('#createCards'),form=new FormData(event.currentTarget);
    const quantity=Number(form.get('quantity')),amountMinor=Math.round(Number(form.get('amount'))*100);
    button.disabled=true;button.textContent='Creating at issuer…';
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
      await load();
      $('#fundingApproval').checked=false;
      calculate();
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
    try{await request(`/api/cards/${card.id}/load`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amountMinor:Math.round(rupees*100)})});await load();toast('Card funded by issuer')}
    catch(error){alert(error.message)}
    finally{button.disabled=false}
  };
  load();
})();