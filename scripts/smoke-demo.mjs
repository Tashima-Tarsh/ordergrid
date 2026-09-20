import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port=18080;
const base=`http://127.0.0.1:${port}`;
const email="demo@ordergrid.in";
const password="OrderGridDemo2026!";
const workerId="smoke-worker-001";
let child;
let cookie="";

function assert(condition,message){
  if(!condition)throw new Error(message);
}

async function json(path,options={}){
  const headers={accept:"application/json",...(options.headers||{})};
  if(cookie)headers.cookie=cookie;
  const response=await fetch(base+path,{...options,headers,redirect:options.redirect||"follow"});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${options.method||"GET"} ${path} -> ${response.status} ${JSON.stringify(body)}`);
  return {response,body};
}

async function waitForHealth(){
  for(let i=0;i<60;i++){
    try{
      const response=await fetch(base+"/api/health");
      if(response.ok)return;
    }catch{}
    await delay(250);
  }
  throw new Error("demo server did not become healthy");
}

try{
  child=spawn(process.execPath,["dist/demo-server.js"],{
    env:{...process.env,PORT:String(port),NODE_ENV:"test",DEMO_EMAIL:email,DEMO_PASSWORD:password,SESSION_SECRET:"smoke-test-session-secret-32-bytes-minimum"},
    stdio:["ignore","pipe","pipe"]
  });
  let stderr="";
  child.stderr.on("data",chunk=>{stderr+=chunk.toString()});

  await waitForHealth();

  const login=await fetch(base+"/api/login",{
    method:"POST",
    headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify({email,password})
  });
  assert(login.status===200,`login failed: ${login.status}`);
  const setCookie=login.headers.get("set-cookie")||"";
  cookie=setCookie.split(";")[0]||"";
  assert(cookie.startsWith("demo_session="),"login did not set demo_session cookie");

  const form=new FormData();
  form.append("file",new Blob([
    "reference,recipient,phone,line1,city,state,postal_code,amazon_account\n"+
    "SMOKE-001,Smoke Test,9876543210,1 Test Road,New Delhi,Delhi,110001,smoke-amazon-account\n"
  ],{type:"text/csv"}),"recipients.csv");
  const imported=await json("/api/address-books/import",{method:"POST",body:form});
  assert(imported.body.count===1,"recipient import count was not 1");
  const addressId=imported.body.addressIds?.[0];
  assert(addressId,"recipient import did not return address id");

  const created=await json("/api/batches",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      name:"Amazon smoke batch",
      paymentRoute:"Corporate virtual card",
      items:[{
        productUrl:"https://www.amazon.in/dp/B0TEST1234",
        quantity:1,
        addressId,
        estimatedUnitPriceMinor:99900
      }]
    })
  });
  assert(created.body.id,"batch creation did not return id");
  assert(created.body.status==="AWAITING_APPROVAL","batch did not start in AWAITING_APPROVAL");

  const approved=await json(`/api/batches/${created.body.id}/approve`,{method:"POST"});
  assert(approved.body.ok===true,"batch approval failed");
  assert(approved.body.baskets===1,"approval did not create one basket");

  const basketList=await json("/api/bulk-baskets");
  const basket=basketList.body.baskets?.find(b=>b.batch_id===created.body.id);
  assert(basket,"approved batch basket not found");
  assert(basket.status==="READY",`basket expected READY, got ${basket.status}`);

  const queued=await json("/api/bulk-queue/claim",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({limit:10})
  });
  assert(queued.body.claimed===1,`expected claimed=1, got ${queued.body.claimed}`);

  const afterQueue=await json("/api/bulk-baskets");
  const queuedBasket=afterQueue.body.baskets.find(b=>b.id===basket.id);
  assert(queuedBasket?.status==="CLAIMED",`basket expected CLAIMED, got ${queuedBasket?.status}`);

  const redirect=await fetch(base+`/api/bulk-baskets/${basket.id}/browser-checkout?redirect=1`,{
    headers:{cookie},
    redirect:"manual"
  });
  assert([302,303].includes(redirect.status),`Amazon redirect expected 302/303, got ${redirect.status}`);
  const location=redirect.headers.get("location")||"";
  assert(location.startsWith("https://www.amazon.in/gp/aws/cart/add.html?"),`unexpected Amazon redirect: ${location}`);
  assert(location.includes("ASIN.1=B0TEST1234"),`Amazon redirect missing ASIN: ${location}`);
  assert(location.includes("Quantity.1=1"),`Amazon redirect missing quantity: ${location}`);

  await json("/api/execution-worker/heartbeat",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({workerId,hostname:"CI Smoke Worker",mode:"BULK"})
  });
  const assigned=await json(`/api/execution-worker/${workerId}/claim`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({limit:5})
  });
  assert(assigned.body.assigned===1,`expected worker assigned=1, got ${assigned.body.assigned}`);

  const queue=await json(`/api/bulk-queue?workerId=${encodeURIComponent(workerId)}`);
  assert(queue.body.baskets?.some(b=>b.id===basket.id),"assigned basket missing from worker queue");

  const opened=await json(`/api/bulk-queue/${basket.id}/open`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({workerId})
  });
  assert(opened.body.basketId===basket.id,"worker open returned wrong basket");
  assert(opened.body.retailer==="amazon-in","worker open did not identify Amazon");
  assert(opened.body.items?.length===1,"worker open did not return one item");
  assert(opened.body.items[0].executionUrl==="https://www.amazon.in/dp/B0TEST1234","worker execution URL mismatch");

  console.log("ORDERGRID_SMOKE_OK");
  console.log(JSON.stringify({
    login:200,
    recipientImport:1,
    batchStatus:"APPROVED",
    basketsCreated:1,
    queueClaimed:1,
    amazonRedirect:true,
    workerAssigned:1,
    workerOpen:true
  }));
}catch(error){
  console.error("ORDERGRID_SMOKE_FAILED");
  console.error(error);
  process.exitCode=1;
}finally{
  if(child){
    child.kill("SIGTERM");
    await delay(250);
    if(!child.killed)child.kill("SIGKILL");
  }
}
