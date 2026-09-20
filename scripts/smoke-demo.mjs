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

  const usersBefore=await json("/api/users");
  assert(usersBefore.body.users?.length===1,"expected one workspace user initially");
  assert(usersBefore.body.users?.some(u=>u.email===email&&u.current_user===true),"current workspace owner missing");

  const createdUser=await json("/api/users",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      email:"buyer-smoke@example.com",
      role:"BUYER",
      password:"OrderGridBuyerSmoke2026!"
    })
  });
  assert(createdUser.body.user?.id,"workspace user creation did not return id");

  const usersAfter=await json("/api/users");
  assert(usersAfter.body.users?.length===2,"workspace user list did not include the new user");
  assert(usersAfter.body.users?.some(u=>u.email==="buyer-smoke@example.com"&&u.role==="BUYER"),"new buyer user missing");

  const form=new FormData();
  form.append("file",new Blob([
    "reference,recipient,phone,line1,city,state,postal_code,amazon_user_id,amazon_password,retailer,retailer_login,retailer_password\n"+
    "SMOKE-001,Smoke Test,9876543210,1 Test Road,New Delhi,Delhi,110001,smoke-amazon-account,amazon-secret,merchant.example,store-user,store-secret\n"
  ],{type:"text/csv"}),"recipients.csv");
  const imported=await json("/api/address-books/import",{method:"POST",body:form});
  assert(imported.body.count===1,"recipient import count was not 1");
  assert(imported.body.retailerAccountsBound===2,`expected 2 retailer accounts, got ${imported.body.retailerAccountsBound}`);
  assert(imported.body.credentialsStored===2,`expected 2 protected credentials, got ${imported.body.credentialsStored}`);
  const control=await json("/api/control-center");
  assert(control.body.service==="AVAILABLE","control center service was not available");
  assert(control.body.accounts?.total===2,`control center expected 2 accounts, got ${control.body.accounts?.total}`);
  assert(control.body.accounts?.credentials_stored===2,`control center expected 2 protected credentials, got ${control.body.accounts?.credentials_stored}`);
  const addressId=imported.body.addressIds?.[0];
  assert(addressId,"recipient import did not return address id");

  const created=await json("/api/batches",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({
      name:"Amazon smoke batch",
      paymentRoute:"Corporate virtual card",
      items:[
        {
          productUrl:"https://www.amazon.in/dp/B0TEST1234",
          quantity:1,
          addressId,
          estimatedUnitPriceMinor:99900
        },
        {
          productUrl:"https://merchant.example/item/device",
          quantity:2,
          addressId,
          estimatedUnitPriceMinor:49900
        }
      ]
    })
  });
  assert(created.body.id,"batch creation did not return id");
  assert(created.body.status==="AWAITING_APPROVAL","batch did not start in AWAITING_APPROVAL");

  const approved=await json(`/api/batches/${created.body.id}/approve`,{method:"POST"});
  assert(approved.body.ok===true,"batch approval failed");
  assert(approved.body.baskets===2,`approval did not create two baskets: ${approved.body.baskets}`);

  const basketList=await json("/api/bulk-baskets");
  const amazonBasket=basketList.body.baskets?.find(b=>b.batch_id===created.body.id&&b.retailer==="amazon-in");
  const storeBasket=basketList.body.baskets?.find(b=>b.batch_id===created.body.id&&b.retailer==="store:merchant.example");
  assert(amazonBasket,"approved Amazon basket not found");
  assert(storeBasket,"approved generic retailer basket not found");
  assert(amazonBasket.status==="READY",`Amazon basket expected READY, got ${amazonBasket.status}`);
  assert(storeBasket.status==="READY",`store basket expected READY, got ${storeBasket.status}`);

  const queued=await json("/api/bulk-queue/claim",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({limit:10})
  });
  assert(queued.body.claimed===2,`expected claimed=2, got ${queued.body.claimed}`);

  const afterQueue=await json("/api/bulk-baskets");
  assert(afterQueue.body.baskets.find(b=>b.id===amazonBasket.id)?.status==="CLAIMED","Amazon basket was not queued");
  assert(afterQueue.body.baskets.find(b=>b.id===storeBasket.id)?.status==="CLAIMED","generic retailer basket was not queued");

  const redirect=await fetch(base+`/api/bulk-baskets/${amazonBasket.id}/browser-checkout?redirect=1`,{
    headers:{cookie},
    redirect:"manual"
  });
  assert([302,303].includes(redirect.status),`Amazon redirect expected 302/303, got ${redirect.status}`);
  const location=redirect.headers.get("location")||"";
  assert(location.startsWith("https://www.amazon.in/gp/aws/cart/add.html?"),`unexpected Amazon redirect: ${location}`);
  assert(location.includes("ASIN.1=B0TEST1234"),`Amazon redirect missing ASIN: ${location}`);
  assert(location.includes("Quantity.1=1"),`Amazon redirect missing quantity: ${location}`);

  const storeRedirect=await fetch(base+`/api/bulk-baskets/${storeBasket.id}/browser-checkout?redirect=1`,{headers:{cookie},redirect:"manual"});
  assert([302,303].includes(storeRedirect.status),`generic retailer redirect expected 302/303, got ${storeRedirect.status}`);
  assert(storeRedirect.headers.get("location")==="https://merchant.example/item/device","generic retailer redirect URL mismatch");

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
  assert(assigned.body.assigned===2,`expected worker assigned=2, got ${assigned.body.assigned}`);

  const queue=await json(`/api/bulk-queue?workerId=${encodeURIComponent(workerId)}`);
  assert(queue.body.baskets?.some(b=>b.id===amazonBasket.id),"assigned Amazon basket missing from worker queue");
  assert(queue.body.baskets?.some(b=>b.id===storeBasket.id),"assigned generic basket missing from worker queue");

  const opened=await json(`/api/bulk-queue/${amazonBasket.id}/open`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({workerId})
  });
  assert(opened.body.basketId===amazonBasket.id,"worker open returned wrong Amazon basket");
  assert(opened.body.retailer==="amazon-in","worker open did not identify Amazon");
  assert(opened.body.items?.length===1,"worker open did not return one item");
  assert(opened.body.items[0].executionUrl==="https://www.amazon.in/dp/B0TEST1234","worker execution URL mismatch");
  assert(opened.body.credentials?.login==="smoke-amazon-account","Amazon login was not handed to assigned session");
  assert(opened.body.credentials?.password==="amazon-secret","Amazon password was not recovered from protected storage");

  const storeOpened=await json(`/api/bulk-queue/${storeBasket.id}/open`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({workerId})
  });
  assert(storeOpened.body.retailer==="store:merchant.example","generic retailer identity mismatch");
  assert(storeOpened.body.credentials?.login==="store-user","generic retailer login mismatch");
  assert(storeOpened.body.credentials?.password==="store-secret","generic retailer password mismatch");

  console.log("ORDERGRID_SMOKE_OK");
  console.log(JSON.stringify({
    login:200,
    usersOnly:true,
    recipientImport:1,
    batchStatus:"APPROVED",
    basketsCreated:2,
    queueClaimed:2,
    amazonRedirect:true,
    genericRetailerRedirect:true,
    credentialsProtected:2,
    workerAssigned:2,
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
