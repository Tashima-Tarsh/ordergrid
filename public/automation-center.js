(()=>{
  const section=document.createElement('section');
  section.className='automation-control-center';
  section.innerHTML=`
    <div class="automation-hero">
      <div>
        <p class="eyebrow">ORDERGRID AUTOPILOT</p>
        <h2>Automation & policy control</h2>
        <p>Control how approved orders move from account readiness to price validation, payment, checkout and confirmation.</p>
      </div>
      <div class="automation-machine">
        <div class="automation-state">
          <span class="automation-state-dot"></span>
          <div><small>AUTOPILOT</small><strong id="autoOverall">ACTIVE</strong></div>
        </div>
        <button id="startAutopilot">Start Autopilot</button>
        <button class="secondary" id="pauseAutopilot">Pause</button>
      </div>
    </div>

    <div class="automation-kpis">
      <article><span>READY</span><strong id="autoReady">0</strong><small>Orders ready for automation</small></article>
      <article><span>IN PROGRESS</span><strong id="autoProgress">0</strong><small>Orders currently advancing</small></article>
      <article><span>NEEDS ATTENTION</span><strong id="autoAttention">0</strong><small>Orders requiring intervention</small></article>
      <article><span>CONFIRMED</span><strong id="autoConfirmed">0</strong><small>Retailer-confirmed orders</small></article>
    </div>

    <section class="automation-card autopilot-preflight">
      <div class="automation-card-head">
        <div><span>PRE-FLIGHT</span><h3>Autopilot readiness</h3></div>
        <button class="secondary" id="refreshPreflight">Run pre-flight</button>
      </div>
      <div class="preflight-grid">
        <div><span>ELIGIBLE ORDERS</span><strong id="pfEligible">0</strong></div>
        <div><span>NEEDS ATTENTION</span><strong id="pfAttention">0</strong></div>
        <div><span>RETAILER ACCOUNTS</span><strong id="pfAccounts">0</strong></div>
        <div><span>AUTHENTICATED</span><strong id="pfAuthenticated">0</strong></div>
        <div><span>PRICED LINES</span><strong id="pfPriced">0</strong></div>
        <div><span>APPROVED EXPOSURE</span><strong id="pfExposure">₹0</strong></div>
      </div>
      <div class="preflight-foot">
        <span id="pfCardProgramme" class="preflight-chip">Card programme checking</span>
        <span id="pfRunMode" class="preflight-chip">Run mode</span>
        <span id="pfPriceRule" class="preflight-chip">Price rule</span>
      </div>
    </section>

    <div class="automation-layout">
      <section class="automation-card automation-live">
        <div class="automation-card-head">
          <div><span>LIVE AUTOMATION</span><h3>Workflow state</h3></div>
          <div class="automation-head-actions"><span class="policy-scope" id="autoWorkflowCount">8 automations</span><button class="secondary" id="autoRefresh">Refresh</button></div>
        </div>
        <div id="automationWorkflowList" class="automation-workflow-list"></div>
      </section>

      <section class="automation-card automation-policy">
        <div class="automation-card-head">
          <div><span>POLICY ENGINE</span><h3>Workspace automation policy</h3></div>
          <span class="policy-scope" id="policyScope">Current workspace</span>
        </div>
        <div id="effectivePolicyBanner" class="effective-policy-banner"></div>
        <form id="automationPolicyForm">
          <div class="policy-grid policy-grid-primary">
            <label><span>Run mode</span><select name="runMode"><option value="MANUAL">Manual start</option><option value="CONTINUOUS">Continuous</option></select><small>Start approved eligible orders manually or continuously.</small></label>
            <label><span>Maximum active orders</span><input type="number" name="maxActiveOrders" min="1" max="50" required><small>Parallel orders Autopilot may advance at once.</small></label>
            <label><span>Failure pause threshold (%)</span><input type="number" name="failurePausePercent" min="0" max="100" step="0.5" required><small>Pause the remaining queue when failures reach this percentage.</small></label>
          </div>

          <div class="commercial-policy-block">
            <div class="policy-section-title"><span>COMMERCIAL GUARDRAILS</span><strong>Final payable value controls</strong></div>
            <div class="policy-grid commercial-grid">
              <label><span>Maximum price increase (%)</span><input type="number" name="maxPriceIncreasePercent" min="0" max="100" step="0.1" required><small>Example: 5% permits ₹10,000 → ₹10,500.</small></label>
              <label><span>Maximum order value (₹)</span><input type="number" name="maxOrderValueRupees" min="0" step="1" required><small>0 means no additional absolute order cap.</small></label>
              <label><span>Maximum batch variance (%)</span><input type="number" name="maxBatchVariancePercent" min="0" max="100" step="0.1" required><small>Final projected batch value versus the approved estimate.</small></label>
              <label><span>If a price rule is breached</span><select name="priceBreachAction"><option value="PAUSE_ORDER">Pause affected order</option><option value="PAUSE_BATCH">Pause entire batch</option></select><small>Human approval is required before that scope continues.</small></label>
            </div>
          </div>

          <div class="policy-toggle-grid">
            <label class="policy-toggle">
              <span><b>Automatic virtual-card assignment</b><small>Provision one order-specific virtual card when required.</small></span>
              <input type="checkbox" name="autoAssignVirtualCard">
            </label>
            <label class="policy-toggle">
              <span><b>Automatic checkout continuation</b><small>Continue ordinary retailer checkout until a protected verification or policy gate.</small></span>
              <input type="checkbox" name="autoContinueCheckout">
            </label>
          </div>

          <div class="policy-save-row">
            <div><span id="policyLastUpdated">Policy not changed in this session</span><small id="policyPermission"></small></div>
            <button type="submit" id="saveAutomationPolicy">Save policy</button>
          </div>
          <p id="automationPolicyError" class="form-error"></p>
        </form>
      </section>

      <section class="automation-card automation-guardrails">
        <div class="automation-card-head">
          <div><span>MANDATORY CONTROLS</span><h3>Non-editable safeguards</h3></div>
          <span class="guardrail-state">ENFORCED</span>
        </div>
        <div id="automationMandatoryRules" class="automation-rule-list"></div>
      </section>

      <section class="automation-card automation-health">
        <div class="automation-card-head">
          <div><span>POLICY HEALTH</span><h3>Configuration check</h3></div>
          <span id="automationHealthState" class="health-state">CHECKING</span>
        </div>
        <div id="automationHealthList" class="automation-health-list"></div>
      </section>
    </div>
  `;

  const main=document.querySelector('main');
  const anchor=document.querySelector('.control-center')||main.firstElementChild;
  anchor.after(section);

  const $=s=>section.querySelector(s);
  const esc=v=>{const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML};
  const moneyMinor=v=>new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(Number(v||0)/100);
  let latest=null,latestControl=null,latestPreflight=null;

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function workflowClass(status){return String(status||'READY').toLowerCase().replaceAll('_','-')}

  function renderPreflight(data){
    latestPreflight=data;
    $('#pfEligible').textContent=String(data.eligibleOrders||0);
    $('#pfAttention').textContent=String(data.needsAttention||0);
    $('#pfAccounts').textContent=String(data.retailerAccounts||0);
    $('#pfAuthenticated').textContent=String(data.authenticatedAccounts||0);
    $('#pfPriced').textContent=String(data.pricedLines||0);
    $('#pfExposure').textContent=moneyMinor(data.approvedExposureMinor||0);
    $('#pfCardProgramme').textContent=data.cardProgrammeConnected?'Card programme connected':'Card programme setup required';
    $('#pfCardProgramme').classList.toggle('attention',!data.cardProgrammeConnected);
    $('#pfRunMode').textContent='Run mode · '+String(data.policy?.run_mode||'MANUAL').replace('_',' ');
    $('#pfPriceRule').textContent='Price increase · +'+Number(data.policy?.max_price_increase_percent||0)+'%';
  }

  function render(data,control){
    latest=data;latestControl=control;
    const policy=data.policy||{},local=data.localPolicy||policy;
    $('#autoReady').textContent=String(data.summary?.ready||0);
    $('#autoProgress').textContent=String(data.summary?.inProgress||0);
    $('#autoAttention').textContent=String(data.summary?.needsAttention||0);
    $('#autoConfirmed').textContent=String(data.summary?.confirmed||0);
    $('#autoOverall').textContent=policy.automation_enabled?'ACTIVE':'PAUSED';
    section.classList.toggle('automation-paused',!policy.automation_enabled);
    $('#startAutopilot').disabled=Boolean(policy.automation_enabled);
    $('#pauseAutopilot').disabled=!policy.automation_enabled;

    const workflows=data.workflows||[];
    $('#autoWorkflowCount').textContent=workflows.length+' automations';
    $('#automationWorkflowList').innerHTML=workflows.map((w,index)=>`
      <article class="automation-workflow">
        <div class="automation-flow-index">${String(index+1).padStart(2,'0')}</div>
        <div class="automation-flow-copy"><strong>${esc(w.name)}</strong><small>${esc(w.detail)}</small></div>
        <span class="workflow-status ${workflowClass(w.status)}">${esc(String(w.status).replaceAll('_',' '))}</span>
      </article>
    `).join('');

    $('#policyScope').textContent='Current workspace';
    $('#effectivePolicyBanner').innerHTML=`
      <strong>Effective policy</strong>
      <span>Price +${Number(policy.max_price_increase_percent||0)}%</span>
      <span>Order cap ${Number(policy.max_order_value_minor||0)>0?moneyMinor(policy.max_order_value_minor):'No cap'}</span>
      <span>Batch +${Number(policy.max_batch_variance_percent||0)}%</span>
      <span>${esc(String(policy.price_breach_action||'PAUSE_ORDER').replaceAll('_',' '))}</span>
    `;

    const form=$('#automationPolicyForm');
    form.elements.autoAssignVirtualCard.checked=Boolean(local.auto_assign_virtual_card);
    form.elements.autoContinueCheckout.checked=Boolean(local.auto_continue_checkout);
    form.elements.maxActiveOrders.value=Number(local.max_active_orders||8);
    form.elements.failurePausePercent.value=Number(local.failure_pause_percent||5);
    form.elements.maxPriceIncreasePercent.value=Number(local.max_price_increase_percent||5);
    form.elements.maxOrderValueRupees.value=Math.round(Number(local.max_order_value_minor||0)/100);
    form.elements.maxBatchVariancePercent.value=Number(local.max_batch_variance_percent||3);
    form.elements.priceBreachAction.value=local.price_breach_action||'PAUSE_ORDER';
    form.elements.runMode.value=local.run_mode||'MANUAL';
    $('#policyLastUpdated').textContent=local.updated_at?'Last changed '+new Date(local.updated_at).toLocaleString('en-IN'):'Default workspace policy';
    $('#policyPermission').textContent=data.canEdit?'Owner / Approver policy access':'View-only policy access';
    [...form.elements].forEach(el=>{if(el instanceof HTMLInputElement||el instanceof HTMLSelectElement||el instanceof HTMLButtonElement)el.disabled=!data.canEdit});

    $('#automationMandatoryRules').innerHTML=(data.mandatoryRules||[]).map(rule=>`
      <div><span class="rule-lock">◆</span><div><strong>${esc(rule.name)}</strong><small>System safeguard</small></div><b>${esc(rule.status)}</b></div>
    `).join('');

    const health=[];
    const cardsNeeded=Number(control?.orders?.cards_needed||0);
    const cardProgramme=Boolean(control?.cards?.programme_connected);
    if(policy.auto_assign_virtual_card&&cardsNeeded>0&&!cardProgramme)health.push({state:'ACTION',title:'Card programme required',detail:cardsNeeded+' orders require virtual cards but no card programme is connected.'});
    if(!policy.auto_continue_checkout&&Number(data.summary?.ready||0)>0)health.push({state:'REVIEW',title:'Checkout continuation paused',detail:data.summary.ready+' ready orders will wait for manual continuation.'});
    if(Number(policy.max_price_increase_percent||0)>10)health.push({state:'REVIEW',title:'Wide price tolerance',detail:'Maximum price increase is above 10%. Review the commercial risk limit.'});
    if(Number(policy.max_batch_variance_percent||0)>10)health.push({state:'REVIEW',title:'Wide batch variance',detail:'Batch variance is above 10% of the approved estimate.'});
    if(Number(policy.max_order_value_minor||0)===0)health.push({state:'REVIEW',title:'No absolute order cap',detail:'Price variance is enforced, but there is no additional maximum order value.'});
    if(Number(policy.max_active_orders||0)>20)health.push({state:'REVIEW',title:'High concurrency policy',detail:'Maximum active orders is above 20. Review retailer and card-programme capacity.'});
    if(Number(policy.failure_pause_percent||0)>25)health.push({state:'REVIEW',title:'Loose failure guard',detail:'Failure pause threshold is above 25%.'});
    if(!policy.automation_enabled)health.push({state:'PAUSED',title:'Autopilot paused',detail:'Automated order preparation and continuation are disabled for this workspace.'});
    if(!health.length)health.push({state:'HEALTHY',title:'Policy configuration healthy',detail:'Current workspace automation settings are aligned with active order controls.'});

    $('#automationHealthState').textContent=health.some(x=>x.state==='ACTION')?'ACTION REQUIRED':health.some(x=>x.state==='REVIEW')?'REVIEW':'HEALTHY';
    $('#automationHealthList').innerHTML=health.map(h=>`
      <div class="health-row ${h.state.toLowerCase()}"><span></span><div><strong>${esc(h.title)}</strong><small>${esc(h.detail)}</small></div></div>
    `).join('');
  }

  async function loadPreflight(){
    try{renderPreflight(await request('/api/automation/preflight'))}
    catch(error){$('#pfCardProgramme').textContent='Pre-flight unavailable';$('#pfCardProgramme').classList.add('attention')}
  }

  async function load(){
    try{
      const [automation,control]=await Promise.all([request('/api/automation'),request('/api/control-center').catch(()=>({}))]);
      render(automation,control);
      await loadPreflight();
    }catch(error){
      if(!latest){
        const names=['Account authentication','Order validation & preparation','Price & commercial validation','Virtual-card assignment','Checkout continuation','Retailer confirmation','Batch protection','Order reconciliation'];
        $('#autoWorkflowCount').textContent='8 automations';
        $('#automationWorkflowList').innerHTML=names.map((name,index)=>'<article class="automation-workflow"><div class="automation-flow-index">'+String(index+1).padStart(2,'0')+'</div><div class="automation-flow-copy"><strong>'+esc(name)+'</strong><small>Waiting for live status</small></div><span class="workflow-status idle">WAITING</span></article>').join('');
      }
      $('#automationHealthState').textContent='RETRYING';
      $('#automationHealthList').innerHTML='<div class="health-row review"><span></span><div><strong>Refreshing automation status</strong><small>'+esc(error.message)+'</small></div></div>';
    }
  }

  $('#autoRefresh').onclick=load;
  $('#refreshPreflight').onclick=loadPreflight;

  $('#startAutopilot').onclick=async()=>{
    const button=$('#startAutopilot');button.disabled=true;button.textContent='Starting…';
    try{
      const pf=await request('/api/automation/preflight');renderPreflight(pf);
      const result=await request('/api/automation/start',{method:'POST'});
      if(window.toast)window.toast('Autopilot started · '+Number(result.claimed||0)+' order(s) prepared');
      await load();
    }catch(error){alert(error.message)}
    finally{button.textContent='Start Autopilot'}
  };

  $('#pauseAutopilot').onclick=async()=>{
    const button=$('#pauseAutopilot');button.disabled=true;button.textContent='Pausing…';
    try{await request('/api/automation/pause',{method:'POST'});if(window.toast)window.toast('Autopilot paused');await load()}
    catch(error){alert(error.message)}
    finally{button.textContent='Pause'}
  };

  $('#automationPolicyForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,button=$('#saveAutomationPolicy');
    $('#automationPolicyError').textContent='';
    button.disabled=true;button.textContent='Saving policy…';
    try{
      await request('/api/automation/policy',{
        method:'PUT',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          automationEnabled:Boolean(latest?.policy?.automation_enabled),
          autoAssignVirtualCard:form.elements.autoAssignVirtualCard.checked,
          autoContinueCheckout:form.elements.autoContinueCheckout.checked,
          maxActiveOrders:Number(form.elements.maxActiveOrders.value),
          failurePausePercent:Number(form.elements.failurePausePercent.value),
          maxPriceIncreasePercent:Number(form.elements.maxPriceIncreasePercent.value),
          maxOrderValueMinor:Math.round(Number(form.elements.maxOrderValueRupees.value||0)*100),
          maxBatchVariancePercent:Number(form.elements.maxBatchVariancePercent.value),
          priceBreachAction:form.elements.priceBreachAction.value,
          runMode:form.elements.runMode.value
        })
      });
      if(window.toast)window.toast('Automation policy updated');
      await load();
    }catch(error){$('#automationPolicyError').textContent=error.message}
    finally{button.disabled=latest?!latest.canEdit:false;button.textContent='Save policy'}
  });

  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,15000);
  load();
})();