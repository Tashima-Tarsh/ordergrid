import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port=18082;
const base=`http://127.0.0.1:${port}`;
const email="automation-smoke@ordergrid.test";
const password=randomBytes(24).toString("base64url");
let child;
let cookie="";

function assert(condition,message){if(!condition)throw new Error(message)}

async function json(path,options={}){
  const headers={accept:"application/json",...(options.headers||{})};
  if(cookie)headers.cookie=cookie;
  const response=await fetch(base+path,{...options,headers,redirect:options.redirect||"follow"});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(`${options.method||"GET"} ${path} -> ${response.status} ${JSON.stringify(body)}`),{status:response.status,body});
  return {response,body};
}

async function raw(path,options={}){
  const headers={accept:"application/json",...(options.headers||{})};
  if(cookie)headers.cookie=cookie;
  return fetch(base+path,{...options,headers,redirect:options.redirect||"follow"});
}

async function waitForHealth(){
  for(let i=0;i<60;i++){
    try{const r=await fetch(base+"/api/health");if(r.ok)return}catch{}
    await delay(250);
  }
  throw new Error("automation smoke server did not become healthy");
}

function policy(overrides={}){
  return {
    automationEnabled:true,
    autoAssignVirtualCard:true,
    autoContinueCheckout:true,
    maxActiveOrders:1,
    failurePausePercent:5,
    maxPriceIncreasePercent:5,
    maxOrderValueMinor:0,
    maxBatchVariancePercent:5,
    priceBreachAction:"PAUSE_ORDER",
    runMode:"MANUAL",
    ...overrides
  };
}

try{
  child=spawn(process.execPath,["dist/demo-server.js"],{
    env:{...process.env,PORT:String(port),NODE_ENV:"test",DEMO_EMAIL:email,DEMO_PASSWORD:password,SESSION_SECRET:randomBytes(40).toString("hex")},
    stdio:["ignore","pipe","pipe"]
  });
  await waitForHealth();

  const login=await fetch(base+"/api/login",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({email,password})});
  assert(login.status===200,"automation smoke login failed");
  cookie=(login.headers.get("set-cookie")||"").split(";")[0]||"";

  const form=new FormData();
  form.append("file",new Blob([
    "reference,recipient,phone,line1,city,state,postal_code,amazon_account\n"+
    "AUTO-001,Auto One,9876543210,1 Test Road,Delhi,Delhi,110001,auto-1\n"+
    "AUTO-002,Auto Two,9876543211,2 Test Road,Delhi,Delhi,110002,auto-2\n"+
    "AUTO-003,Auto Three,9876543212,3 Test Road,Delhi,Delhi,110003,auto-3\n"
  ],{type:"text/csv"}),"automation.csv");
  const imported=await json("/api/address-books/import",{method:"POST",body:form});
  assert(imported.body.addressIds?.length===3,"automation smoke recipient import failed");

  const items=imported.body.addressIds.map((addressId,index)=>({
    productUrl:"https://www.amazon.in/dp/B0TEST1234",
    quantity:1,
    addressId,
    estimatedUnitPriceMinor:10000+index
  }));
  const batch=await json("/api/batches",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Automation policy smoke",paymentRoute:"Cash on Delivery",items})});
  await json(`/api/batches/${batch.body.id}/approve`,{method:"POST"});

  const status=await json("/api/automation");
  assert(status.body.policy?.automation_enabled===true,"default Autopilot was not enabled");
  assert(status.body.mandatoryRules?.length===4,"mandatory controls were not returned");
  assert(status.body.workflows?.some(w=>w.id==="commercial"),"commercial validation automation was not returned");
  const preflight=await json("/api/automation/preflight");
  assert(preflight.body.eligibleOrders===3,"preflight eligible order count was incorrect");

  await json("/api/automation/policy",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(policy({automationEnabled:false}))});

  const paused=await raw("/api/bulk-queue/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:10})});
  assert(paused.status===409,"Autopilot pause did not block order preparation");

  await json("/api/automation/policy",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(policy({autoContinueCheckout:false}))});

  const claimed=await json("/api/bulk-queue/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:10})});
  assert(claimed.body.claimed===1,`maxActiveOrders expected 1 claim, got ${claimed.body.claimed}`);

  const workerId="automation-smoke-worker";
  await json("/api/execution-worker/heartbeat",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workerId,hostname:"Automation Smoke",mode:"BULK"})});
  const blockedAssign=await raw(`/api/execution-worker/${workerId}/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:10})});
  assert(blockedAssign.status===409,"checkout continuation pause did not block assignment");

  await json("/api/automation/policy",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify(policy())});
  const assigned=await json(`/api/execution-worker/${workerId}/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({limit:10})});
  assert(assigned.body.assigned===1,`expected one assigned order, got ${assigned.body.assigned}`);

  const queue=await json(`/api/bulk-queue?workerId=${encodeURIComponent(workerId)}`);
  const assignedBasket=queue.body.baskets?.[0];
  assert(assignedBasket?.id,"assigned basket missing for commercial check");
  const allowed=await json(`/api/bulk-queue/${assignedBasket.id}/commercial-check`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workerId,amountMinor:10400,currency:"INR"})});
  assert(allowed.body.allowed===true,"4% price increase should have passed 5% policy");
  const blocked=await json(`/api/bulk-queue/${assignedBasket.id}/commercial-check`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({workerId,amountMinor:10600,currency:"INR"})});
  assert(blocked.body.allowed===false,"6% price increase should have breached 5% policy");
  assert(blocked.body.breaches?.includes("PRICE_VARIANCE"),"price variance breach was not reported");

  console.log("ORDERGRID_AUTOMATION_SMOKE_OK");
  console.log(JSON.stringify({masterPause:true,concurrencyCap:true,checkoutPolicy:true,commercialPriceGate:true,preflight:true,mandatoryControls:true}));
}catch(error){
  console.error("ORDERGRID_AUTOMATION_SMOKE_FAILED");
  console.error(error);
  process.exitCode=1;
}finally{
  if(child){
    child.kill("SIGTERM");
    await delay(250);
    if(!child.killed)child.kill("SIGKILL");
  }
}
