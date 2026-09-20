import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port=18081;
const base=`http://127.0.0.1:${port}`;
const email="dealer-smoke@ordergrid.test";
const password=randomBytes(24).toString("base64url");
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
  throw new Error("dealer smoke server did not become healthy");
}

try{
  child=spawn(process.execPath,["dist/demo-server.js"],{
    env:{...process.env,PORT:String(port),NODE_ENV:"test",DEMO_EMAIL:email,DEMO_PASSWORD:password,SESSION_SECRET:randomBytes(40).toString("hex")},
    stdio:["ignore","pipe","pipe"]
  });
  await waitForHealth();

  const login=await fetch(base+"/api/login",{
    method:"POST",
    headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify({email,password})
  });
  assert(login.status===200,`login failed: ${login.status}`);
  cookie=(login.headers.get("set-cookie")||"").split(";")[0]||"";
  assert(cookie.startsWith("demo_session="),"dealer smoke login cookie missing");

  const before=await json("/api/dealer-network");
  assert(before.body.dealers?.length===1,"expected only the main dealer initially");
  const mainDealerId=before.body.homeTenantId;

  const created=await json("/api/dealers",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({name:"North Dealer",ownerEmail:"north-owner@ordergrid.test"})
  });
  const childDealerId=created.body.dealer?.id;
  assert(childDealerId,"sub-dealer creation did not return an id");

  const network=await json("/api/dealer-network");
  assert(network.body.dealers?.length===2,"network did not contain main + sub-dealer");

  await json("/api/dealer-context",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({tenantId:childDealerId})
  });

  const childUsers=await json("/api/dealer-users");
  assert(childUsers.body.users?.some(u=>u.email==="north-owner@ordergrid.test"),"sub-dealer owner not present");

  const recipientForm=new FormData();
  recipientForm.append("file",new Blob([
    "reference,recipient,phone,line1,city,state,postal_code,amazon_account\n"+
    "NORTH-001,North Customer,9876543210,1 Dealer Road,New Delhi,Delhi,110001,north-account\n"
  ],{type:"text/csv"}),"north-recipients.csv");
  const imported=await json("/api/address-books/import",{method:"POST",body:recipientForm});
  const addressId=imported.body.addressIds?.[0];
  assert(addressId,"sub-dealer recipient import failed");

  const batch=await json("/api/batches",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      name:"North dealer order",
      paymentRoute:"Cash on Delivery",
      items:[{
        productUrl:"https://www.amazon.in/dp/B0TEST1234",
        quantity:1,
        addressId,
        estimatedUnitPriceMinor:12500
      }]
    })
  });
  await json(`/api/batches/${batch.body.id}/approve`,{method:"POST"});

  const childBatches=await json("/api/batches");
  assert(childBatches.body.batches?.length===1,"sub-dealer batch missing from its workspace");
  const childControl=await json("/api/control-center");
  assert(childControl.body.customers===1,"sub-dealer customer count incorrect");

  await json("/api/dealer-context",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({tenantId:mainDealerId})
  });

  const mainBatches=await json("/api/batches");
  assert(mainBatches.body.batches?.length===0,"main dealer could see sub-dealer batch data");
  const mainControl=await json("/api/control-center");
  assert(mainControl.body.customers===0,"main dealer could see sub-dealer customer data");

  const finalNetwork=await json("/api/dealer-network");
  const childSummary=finalNetwork.body.dealers?.find(d=>d.id===childDealerId);
  assert(childSummary?.customer_count===1,"network customer aggregation incorrect");
  assert(childSummary?.order_count===1,"network order aggregation incorrect");

  console.log("ORDERGRID_DEALER_SMOKE_OK");
  console.log(JSON.stringify({dealerCreated:true,workspaceSwitch:true,isolation:true,networkAggregation:true}));
}catch(error){
  console.error("ORDERGRID_DEALER_SMOKE_FAILED");
  console.error(error);
  process.exitCode=1;
}finally{
  if(child){
    child.kill("SIGTERM");
    await delay(250);
    if(!child.killed)child.kill("SIGKILL");
  }
}
