(()=>{
  const section=document.createElement('section');
  section.className='automation-control-center';
  section.innerHTML=`
    <section class="automation-command-surface">
      <div class="automation-commandbar">
        <div class="automation-command-copy">
          <p class="eyebrow">ORDERGRID AUTOPILOT</p>
          <h2>Automation command</h2>
          <p>Operate approved orders under live commercial, payment and verification controls.</p>
        </div>
        <div class="automation-machine">
          <div class="automation-state">
            <span class="automation-state-dot"></span>
            <div><small>AUTOPILOT</small><strong id="autoOverall">CHECKING</strong></div>
          </div>
          <button id="startAutopilot">▶ Run now</button>
          <button class="secondary" id="pauseAutopilot">Pause</button>
          <button class="secondary premium-icon-button" id="autoRefresh" title="Refresh automation" aria-label="Refresh automation">↻</button>
        </div>
      </div>

      <div class="automation-kpis">
        <article><span>READY</span><strong id="autoReady">0</strong><small>Eligible / claimed</small></article>
        <article><span>IN PROGRESS</span><strong id="autoProgress">0</strong><small>Worker opened</small></article>
        <article><span>ATTENTION</span><strong id="autoAttention">0</strong><small>Human review</small></article>
        <article><span>CONFIRMED</span><strong id="autoConfirmed">0</strong><small>Retailer-confirmed</small></article>
      </div>

      <div class="autopilot-preflight">
        <div class="preflight-head">
          <div><span>PRE-FLIGHT</span><strong>Readiness</strong></div>
          <button class="secondary premium-quiet-button" id="refreshPreflight">Run check</button>
        </div>
        <div class="preflight-grid">
          <div><span>ELIGIBLE</span><strong id="pfEligible">0</strong></div>
          <div><span>ATTENTION</span><strong id="pfAttention">0</strong></div>
          <div><span>ACCOUNTS</span><strong id="pfAccounts">0</strong></div>
          <div><span>AUTHENTICATED</span><strong id="pfAuthenticated">0</strong></div>
          <div><span>PRICED LINES</span><strong id="pfPriced">0</strong></div>
          <div><span>EXPOSURE</span><strong id="pfExposure">₹0</strong></div>
        </div>
        <div class="preflight-foot">
          <span id="pfCardProgramme" class="preflight-chip">Card programme checking</span>
          <span id="pfRunMode" class="preflight-chip">Run mode</span>
          <span id="pfPriceRule" class="preflight-chip">Price rule</span>
        </div>
      </div>
    </section>

    <div class="automation-layout automation-runtime-layout">
      <div class="automation-column automation-column-left">
        <section class="automation-card automation-runtime">
          <div class="automation-card-head">
            <div><span>LIVE ENGINE</span><h3>What Autopilot is doing</h3></div>
            <span class="policy-scope" id="runtimeMode">CHECKING</span>
          </div>

          <div class="automation-runtime-grid">
            <div><span>TRIGGER</span><strong id="runtimeTrigger">—</strong><small id="runtimeTriggerMeta">Loading policy</small></div>
            <div><span>CHECKOUT</span><strong id="runtimeCheckout">—</strong><small>Ordinary checkout continuation</small></div>
            <div><span>CARDS</span><strong id="runtimeCards">—</strong><small>Order-specific virtual card</small></div>
            <div><span>QUEUE</span><strong id="runtimeQueue">0</strong><small>Ready / claimed orders</small></div>
          </div>

          <div id="runtimeMessage" class="automation-runtime-message">Loading live engine state…</div>
          <div id="automationRuntimeSignals" class="automation-runtime-signals"></div>

          <details class="automation-safeguards">
            <summary><span><b>System safeguards</b><small>Non-editable platform protections</small></span><strong id="safeguardCount">Checking</strong></summary>
            <div id="automationMandatoryRules" class="automation-rule-list compact"></div>
          </details>
        </section>

        <section class="automation-card automation-health">
          <div class="automation-card-head">
            <div><span>POLICY HEALTH</span><h3>Configuration check</h3></div>
            <span id="automationHealthState" class="health-state">CHECKING</span>
          </div>
          <div id="automationHealthList" class="automation-health-list"></div>
        </section>
      </div>

      <div class="automation-column automation-column-right">
        <section class="automation-card automation-policy">
          <div class="automation-card-head">
            <div><span>POLICY ENGINE</span><h3>Workspace automation policy</h3></div>
            <span class="policy-scope" id="policyScope">Current workspace</span>
          </div>

          <div id="effectivePolicyBanner" class="effective-policy-banner"></div>
          <div id="policyTriggerExplainer" class="policy-trigger-explainer"></div>

          <form id="automationPolicyForm">
            <div class="policy-grid policy-grid-primary">
              <label><span>Run mode</span><select name="runMode"><option value="MANUAL">Manual</option><option value="CONTINUOUS">Continuous</option></select><small>Manual = Run now. Continuous = trigger automatically when approved work becomes ready.</small></label>
              <label><span>Maximum active orders</span><input type="number" name="maxActiveOrders" min="1" max="50" required><small>Maximum number Autopilot may advance concurrently.</small></label>
              <label><span>Failure pause threshold (%)</span><input type="number" name="failurePausePercent" min="0" max="100" step="0.5" required><small>Pause remaining eligible work when the failure threshold is reached.</small></label>
            </div>

            <div class="commercial-policy-block">
              <div class="policy-section-title"><span>COMMERCIAL GUARDRAILS</span><strong>Final payable value controls</strong></div>
              <div class="policy-grid commercial-grid">
                <label><span>Maximum price increase (%)</span><input type="number" name="maxPriceIncreasePercent" min="0" max="100" step="0.1" required><small>Maximum allowed increase versus approved expected value.</small></label>
                <label><span>Maximum order value (₹)</span><input type="number" name="maxOrderValueRupees" min="0" step="1" required><small>0 means no additional absolute order cap.</small></label>
                <label><span>Maximum batch variance (%)</span><input type="number" name="maxBatchVariancePercent" min="0" max="100" step="0.1" required><small>Final projected batch value versus approved estimate.</small></label>
                <label><span>Price breach action</span><select name="priceBreachAction"><option value="PAUSE_ORDER">Pause affected order</option><option value="PAUSE_BATCH">Pause entire batch</option></select><small>Defines the scope requiring human approval after a breach.</small></label>
              </div>
            </div>

            <div class="policy-toggle-grid">
              <label class="policy-toggle">
                <span><b>Automatic virtual-card assignment</b><small>Assign or provision an order-specific card when required.</small></span>
                <input type="checkbox" name="autoAssignVirtualCard">
              </label>
              <label class="policy-toggle">
                <span><b>Automatic checkout continuation</b><small>Allow an online native worker to continue ordinary checkout until a protected verification or policy gate.</small></span>
                <input type="checkbox" name="autoContinueCheckout">
              </label>
            </div>

            <div class="policy-save-row">
              <div><span id="policyLastUpdated">Policy not changed in this session</span><small id="policyPermission"></small></div>
              <button type="submit" id="saveAutomationPolicy">Save & apply</button>
            </div>
            <p id="automationPolicyError" class="form-error"></p>
          </form>
        </section>
      </div>
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

  function renderRuntime(data){
    const policy=data.policy||{},summary=data.summary||{},workflows=data.workflows||[];
    const continuous=policy.run_mode==='CONTINUOUS',enabled=Boolean(policy.automation_enabled);
    $('#runtimeMode').textContent=!enabled?'PAUSED':continuous?'CONTINUOUS':'MANUAL';
    $('#runtimeTrigger').textContent=continuous?'AUTO':'RUN NOW';
    $('#runtimeTriggerMeta').textContent=continuous?'Approved work triggers when it becomes ready':'Only runs when you press Run now';
    $('#runtimeCheckout').textContent=policy.auto_continue_checkout?'ON':'OFF';
    $('#runtimeCards').textContent=policy.auto_assign_virtual_card?'AUTO':'MANUAL';
    $('#runtimeQueue').textContent=String(summary.ready||0);

    const active=workflows.filter(w=>['ACTIVE','NEEDS_ATTENTION'].includes(String(w.status)));
    const signalHost=$('#automationRuntimeSignals');
    if(active.length){
      signalHost.innerHTML=active.map(w=>`
        <div class="runtime-signal ${workflowClass(w.status)}">
          <span></span><div><strong>${esc(w.name)}</strong><small>${esc(w.detail)}</small></div>
          <b>${esc(String(w.status).replaceAll('_',' '))}</b>
        </div>
      `).join('');
    }else{
      signalHost.innerHTML='<div class="runtime-empty"><strong>No active automation work</strong><span>Autopilot is waiting for an approved eligible order. READY/IDLE stage cards are intentionally hidden.</span></div>';
    }

    const ready=Number(summary.ready||0),attention=Number(summary.needsAttention||0),progress=Number(summary.inProgress||0);
    $('#runtimeMessage').textContent=!enabled
      ?'Autopilot is paused. Saved guardrails remain configured, but no new orders are claimed automatically.'
      :continuous
        ?(ready||progress?'Continuous mode is active. Eligible orders are being prepared under the saved policy.':'Continuous mode is armed. The next approved eligible batch will trigger automatically.')
        :(ready?'Manual mode has eligible work waiting. Press Run now to claim it.':'Manual mode is ready. Press Run now whenever approved work becomes eligible.');
    if(attention)$('#runtimeMessage').textContent=attention+' order(s) need human review; unaffected eligible work follows the current policy.';

    const rules=data.mandatoryRules||[];
    $('#safeguardCount').textContent=rules.length+' enforced';
    $('#automationMandatoryRules').innerHTML=rules.map(rule=>`
      <div><span class="rule-lock">✓</span><div><strong>${esc(rule.name)}</strong><small>Platform safeguard</small></div></div>
    `).join('');
  }

  function render(data,control){
    latest=data;latestControl=control;
    const policy=data.policy||{},local=data.localPolicy||policy;
    const continuous=policy.run_mode==='CONTINUOUS',enabled=Boolean(policy.automation_enabled);

    $('#autoReady').textContent=String(data.summary?.ready||0);
    $('#autoProgress').textContent=String(data.summary?.inProgress||0);
    $('#autoAttention').textContent=String(data.summary?.needsAttention||0);
    $('#autoConfirmed').textContent=String(data.summary?.confirmed||0);
    $('#autoOverall').textContent=!enabled?'PAUSED':continuous?'CONTINUOUS':'MANUAL';
    section.classList.toggle('automation-paused',!enabled);

    const start=$('#startAutopilot');
    start.disabled=continuous&&enabled;
    start.textContent=continuous?(enabled?'● Running':'▶ Start continuous'):'▶ Run now';
    $('#pauseAutopilot').disabled=!enabled;

    renderRuntime(data);

    $('#policyScope').textContent='Current workspace';
    $('#effectivePolicyBanner').innerHTML=`
      <strong>Effective policy</strong>
      <span>${esc(String(policy.run_mode||'MANUAL'))}</span>
      <span>Price +${Number(policy.max_price_increase_percent||0)}%</span>
      <span>Order cap ${Number(policy.max_order_value_minor||0)>0?moneyMinor(policy.max_order_value_minor):'No cap'}</span>
      <span>Batch +${Number(policy.max_batch_variance_percent||0)}%</span>
      <span>${esc(String(policy.price_breach_action||'PAUSE_ORDER').replaceAll('_',' '))}</span>
    `;

    $('#policyTriggerExplainer').innerHTML=continuous
      ?enabled
        ?'<strong>Continuous trigger is live</strong><span>Save & apply immediately re-evaluates the current READY queue. Newly approved batches trigger automatically when their checkout baskets become ready.</span>'
        :'<strong>Continuous policy is saved but paused</strong><span>Save changes now, then press Start continuous to arm automatic triggering.</span>'
      :'<strong>Manual trigger</strong><span>Saving changes updates guardrails only. Press Run now whenever you want Autopilot to claim the current eligible queue.</span>';

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

    const health=[];
    const cardsNeeded=Number(control?.orders?.cards_needed||0);
    const cardProgramme=Boolean(control?.cards?.programme_connected);
    if(policy.auto_assign_virtual_card&&cardsNeeded>0&&!cardProgramme)health.push({state:'ACTION',title:'Card programme required',detail:cardsNeeded+' orders require virtual cards but no card programme is connected.'});
    if(!policy.auto_continue_checkout&&Number(data.summary?.ready||0)>0)health.push({state:'REVIEW',title:'Checkout continuation is manual',detail:data.summary.ready+' ready/claimed orders will not be handed to the native worker automatically.'});
    if(Number(policy.max_price_increase_percent||0)>10)health.push({state:'REVIEW',title:'Wide price tolerance',detail:'Maximum price increase is above 10%. Review the commercial risk limit.'});
    if(Number(policy.max_batch_variance_percent||0)>10)health.push({state:'REVIEW',title:'Wide batch variance',detail:'Batch variance is above 10% of the approved estimate.'});
    if(Number(policy.max_order_value_minor||0)===0)health.push({state:'REVIEW',title:'No absolute order cap',detail:'Price variance is enforced, but there is no additional maximum order value.'});
    if(Number(policy.max_active_orders||0)>20)health.push({state:'REVIEW',title:'High concurrency policy',detail:'Maximum active orders is above 20. Review retailer and card-programme capacity.'});
    if(Number(policy.failure_pause_percent||0)>25)health.push({state:'REVIEW',title:'Loose failure guard',detail:'Failure pause threshold is above 25%.'});
    if(!enabled)health.push({state:'PAUSED',title:'Autopilot paused',detail:'No new automation work is claimed until you run or start Autopilot.'});
    if(!health.length)health.push({state:'HEALTHY',title:'Policy configuration healthy',detail:'Current workspace automation settings are aligned with active order controls.'});

    $('#automationHealthState').textContent=health.some(x=>x.state==='ACTION')?'ACTION REQUIRED':health.some(x=>x.state==='REVIEW')?'REVIEW':health.some(x=>x.state==='PAUSED')?'PAUSED':'HEALTHY';
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
      $('#autoOverall').textContent='RETRYING';
      $('#runtimeMessage').textContent='Live automation status is refreshing: '+error.message;
      $('#automationHealthState').textContent='RETRYING';
      $('#automationHealthList').innerHTML='<div class="health-row review"><span></span><div><strong>Refreshing automation status</strong><small>'+esc(error.message)+'</small></div></div>';
    }
  }

  $('#autoRefresh').onclick=load;
  $('#refreshPreflight').onclick=loadPreflight;

  $('#startAutopilot').onclick=async()=>{
    const button=$('#startAutopilot'),previous=button.textContent;
    button.disabled=true;button.textContent='Applying…';
    try{
      const pf=await request('/api/automation/preflight');renderPreflight(pf);
      const result=await request('/api/automation/start',{method:'POST'});
      window.toast?.((latest?.policy?.run_mode==='CONTINUOUS'?'Continuous Autopilot started':'Run complete')+' · '+Number(result.claimed||0)+' order(s) prepared');
      await load();
    }catch(error){$('#automationPolicyError').textContent=error.message}
    finally{button.textContent=previous;await load()}
  };

  $('#pauseAutopilot').onclick=async()=>{
    const button=$('#pauseAutopilot');button.disabled=true;button.textContent='Pausing…';
    try{await request('/api/automation/pause',{method:'POST'});window.toast?.('Autopilot paused');await load()}
    catch(error){$('#automationPolicyError').textContent=error.message}
    finally{button.textContent='Pause'}
  };

  $('#automationPolicyForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,button=$('#saveAutomationPolicy');
    $('#automationPolicyError').textContent='';
    button.disabled=true;button.textContent='Saving & applying…';
    try{
      const result=await request('/api/automation/policy',{
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
      const trigger=result.trigger;
      if(trigger?.fired)window.toast?.('Policy applied · '+Number(trigger.claimed||0)+' eligible order(s) prepared now');
      else window.toast?.('Policy saved');
      await load();
    }catch(error){$('#automationPolicyError').textContent=error.message}
    finally{button.disabled=latest?!latest.canEdit:false;button.textContent='Save & apply'}
  });

  window.addEventListener('ordergrid:update',load);
  window.addEventListener('ordergrid:bulk-refresh',load);
  setInterval(load,15000);
  load();
})();