(()=>{
  const section=document.createElement('section');
  section.className='automation-control-center';
  section.innerHTML=`
    <div class="automation-hero">
      <div>
        <p class="eyebrow">ORDERGRID AUTOPILOT</p>
        <h2>Automation & policy control</h2>
        <p>Monitor active workflows, intervention points and dealer-specific policy limits from one control surface.</p>
      </div>
      <div class="automation-state">
        <span class="automation-state-dot"></span>
        <div><small>AUTOPILOT</small><strong id="autoOverall">ACTIVE</strong></div>
      </div>
    </div>

    <div class="automation-kpis">
      <article><span>READY</span><strong id="autoReady">0</strong><small>Orders ready for automation</small></article>
      <article><span>IN PROGRESS</span><strong id="autoProgress">0</strong><small>Orders currently advancing</small></article>
      <article><span>NEEDS ATTENTION</span><strong id="autoAttention">0</strong><small>Orders requiring intervention</small></article>
      <article><span>CONFIRMED</span><strong id="autoConfirmed">0</strong><small>Retailer-confirmed orders</small></article>
    </div>

    <div class="automation-layout">
      <section class="automation-card automation-live">
        <div class="automation-card-head">
          <div><span>LIVE AUTOMATION</span><h3>Workflow state</h3></div>
          <button class="secondary" id="autoRefresh">Refresh</button>
        </div>
        <div id="automationWorkflowList" class="automation-workflow-list"></div>
      </section>

      <section class="automation-card automation-policy">
        <div class="automation-card-head">
          <div><span>POLICY ENGINE</span><h3>Dealer automation policy</h3></div>
          <span class="policy-scope">Current dealer</span>
        </div>
        <form id="automationPolicyForm">
          <label class="policy-toggle">
            <span><b>Autopilot master control</b><small>Enable or pause automated order preparation and continuation.</small></span>
            <input type="checkbox" name="automationEnabled">
          </label>
          <label class="policy-toggle">
            <span><b>Automatic virtual-card assignment</b><small>Assign or provision the order-specific virtual card automatically.</small></span>
            <input type="checkbox" name="autoAssignVirtualCard">
          </label>
          <label class="policy-toggle">
            <span><b>Automatic checkout continuation</b><small>Continue ordinary retailer checkout steps until protected verification is required.</small></span>
            <input type="checkbox" name="autoContinueCheckout">
          </label>
          <div class="policy-grid">
            <label><span>Maximum active orders</span><input type="number" name="maxActiveOrders" min="1" max="50" required><small>Dealer-level automation concurrency limit.</small></label>
            <label><span>Failure pause threshold (%)</span><input type="number" name="failurePausePercent" min="0" max="100" step="0.5" required><small>Pause remaining batch orders when failures reach this percentage.</small></label>
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
  let latest=null;

  async function request(path,options={}){
    const response=await fetch(path,{...options,headers:{accept:'application/json',...(options.headers||{})}});
    const body=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(String(body.message||body.error||'Request failed').replaceAll('_',' '));
    return body;
  }

  function workflowClass(status){
    return String(status||'READY').toLowerCase().replaceAll('_','-');
  }

  function render(data,control){
    latest=data;
    const policy=data.policy||{};
    $('#autoReady').textContent=String(data.summary?.ready||0);
    $('#autoProgress').textContent=String(data.summary?.inProgress||0);
    $('#autoAttention').textContent=String(data.summary?.needsAttention||0);
    $('#autoConfirmed').textContent=String(data.summary?.confirmed||0);
    $('#autoOverall').textContent=policy.automation_enabled?'ACTIVE':'PAUSED';
    section.classList.toggle('automation-paused',!policy.automation_enabled);

    $('#automationWorkflowList').innerHTML=(data.workflows||[]).map((w,index)=>`
      <article class="automation-workflow">
        <div class="automation-flow-index">${String(index+1).padStart(2,'0')}</div>
        <div class="automation-flow-copy"><strong>${esc(w.name)}</strong><small>${esc(w.detail)}</small></div>
        <span class="workflow-status ${workflowClass(w.status)}">${esc(String(w.status).replaceAll('_',' '))}</span>
      </article>
    `).join('');

    const form=$('#automationPolicyForm');
    form.elements.automationEnabled.checked=Boolean(policy.automation_enabled);
    form.elements.autoAssignVirtualCard.checked=Boolean(policy.auto_assign_virtual_card);
    form.elements.autoContinueCheckout.checked=Boolean(policy.auto_continue_checkout);
    form.elements.maxActiveOrders.value=Number(policy.max_active_orders||8);
    form.elements.failurePausePercent.value=Number(policy.failure_pause_percent||5);
    $('#policyLastUpdated').textContent=policy.updated_at?'Last changed '+new Date(policy.updated_at).toLocaleString('en-IN'):'Default dealer policy';
    $('#policyPermission').textContent=data.canEdit?'Owner / Approver policy access':'View-only policy access';
    [...form.elements].forEach(el=>{if(el instanceof HTMLInputElement||el instanceof HTMLButtonElement)el.disabled=!data.canEdit});

    $('#automationMandatoryRules').innerHTML=(data.mandatoryRules||[]).map(rule=>`
      <div><span class="rule-lock">◆</span><div><strong>${esc(rule.name)}</strong><small>System safeguard</small></div><b>${esc(rule.status)}</b></div>
    `).join('');

    const health=[];
    const cardsNeeded=Number(control?.orders?.cards_needed||0);
    const cardProgramme=Boolean(control?.cards?.programme_connected);
    if(policy.auto_assign_virtual_card&&cardsNeeded>0&&!cardProgramme)health.push({state:'ACTION',title:'Card programme required',detail:cardsNeeded+' orders require virtual cards but no card programme is connected.'});
    if(!policy.auto_continue_checkout&&Number(data.summary?.ready||0)>0)health.push({state:'REVIEW',title:'Checkout continuation paused',detail:data.summary.ready+' ready orders will wait for manual continuation.'});
    if(Number(policy.max_active_orders||0)>20)health.push({state:'REVIEW',title:'High concurrency policy',detail:'Maximum active orders is set above 20. Review retailer and card-programme capacity.'});
    if(Number(policy.failure_pause_percent||0)>25)health.push({state:'REVIEW',title:'Loose failure guard',detail:'Batch pause threshold is above 25%, allowing more failures before intervention.'});
    if(!policy.automation_enabled)health.push({state:'PAUSED',title:'Autopilot paused',detail:'Automated order preparation and continuation are disabled for this dealer.'});
    if(!health.length)health.push({state:'HEALTHY',title:'Policy configuration healthy',detail:'Current dealer automation settings are aligned with active order controls.'});
    $('#automationHealthState').textContent=health.some(x=>x.state==='ACTION')?'ACTION REQUIRED':health.some(x=>x.state==='REVIEW')?'REVIEW':'HEALTHY';
    $('#automationHealthList').innerHTML=health.map(h=>`
      <div class="health-row ${h.state.toLowerCase()}"><span></span><div><strong>${esc(h.title)}</strong><small>${esc(h.detail)}</small></div></div>
    `).join('');
  }

  async function load(){
    try{
      const [automation,control]=await Promise.all([
        request('/api/automation'),
        request('/api/control-center').catch(()=>({}))
      ]);
      render(automation,control);
    }catch(error){
      $('#automationHealthState').textContent='UNAVAILABLE';
      $('#automationHealthList').innerHTML='<div class="health-row action"><span></span><div><strong>Automation state unavailable</strong><small>'+esc(error.message)+'</small></div></div>';
    }
  }

  $('#autoRefresh').onclick=load;
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
          automationEnabled:form.elements.automationEnabled.checked,
          autoAssignVirtualCard:form.elements.autoAssignVirtualCard.checked,
          autoContinueCheckout:form.elements.autoContinueCheckout.checked,
          maxActiveOrders:Number(form.elements.maxActiveOrders.value),
          failurePausePercent:Number(form.elements.failurePausePercent.value)
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