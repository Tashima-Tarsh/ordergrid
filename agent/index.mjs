import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allowedRetailerUrl, findChrome, profileKey, profileRoot } from "./lib.mjs";
import { executeBasket } from "./cdp.mjs";

const baseUrl=(process.env.ORDERGRID_URL||"http://localhost:3000").replace(/\/$/,"");
const rl=createInterface({input,output});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let cookie="";

async function ask(label){return(await rl.question(label)).trim()}
async function readSecret(label){
  if(!input.isTTY||typeof input.setRawMode!=="function")return ask(label);
  output.write(label);input.setRawMode(true);input.resume();input.setEncoding("utf8");
  return new Promise((resolve,reject)=>{
    let value="";
    const finish=error=>{input.off("data",onData);input.setRawMode(false);input.pause();output.write("\n");error?reject(error):resolve(value)};
    const onData=chunk=>{for(const key of chunk){if(key==="\u0003")return finish(new Error("Cancelled"));if(key==="\r"||key==="\n")return finish();if(key==="\u007f"||key==="\b")value=value.slice(0,-1);else value+=key}};
    input.on("data",onData);
  });
}
async function api(path,options={}){
  const response=await fetch(`${baseUrl}${path}`,{...options,headers:{"content-type":"application/json",...(cookie?{cookie}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${body.error||response.statusText} (${response.status})`);
  return {body,response};
}
async function login(){
  const email=process.env.ORDERGRID_EMAIL||await ask("OrderGrid worker email: ");
  let password=process.env.ORDERGRID_PASSWORD||await readSecret("OrderGrid worker password: ");
  const {response}=await api("/api/login",{method:"POST",body:JSON.stringify({email,password})});
  password="";
  const setCookies=response.headers.getSetCookie?.()||[response.headers.get("set-cookie")];
  const sessionCookie=setCookies.find(Boolean);
  if(!sessionCookie)throw new Error("The server did not return a session cookie.");
  cookie=sessionCookie.split(";")[0];
}
async function heartbeat(workerId){
  await api("/api/execution-worker/heartbeat",{method:"POST",body:JSON.stringify({workerId,hostname:hostname(),mode:"BULK"})});
}
async function postProgress(workerId,basketId,state,code,message){
  await api(`/api/bulk-queue/${basketId}/progress`,{method:"POST",body:JSON.stringify({workerId,state,code,message})});
}
async function runPool(groups,limit,handler){
  let next=0;
  const workers=Array.from({length:Math.min(limit,groups.length)},async()=>{while(next<groups.length)await handler(groups[next++])});
  await Promise.all(workers);
}
function groupByProfile(queue){
  const groups=new Map();
  for(const basket of queue){
    const key=basket.retailer_account_id||`${basket.customer_id||basket.id}:${basket.retailer}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(basket);
  }
  return [...groups.values()];
}

async function main(){
  output.write("\nOrderGrid Native Bulk Ordering Worker\n");
  output.write("Approved baskets are executed from OrderGrid. The worker drives retailer checkout and reports only genuine authentication/payment challenges.\n");
  output.write("It does not bypass OTP, CAPTCHA, 3DS, passwords or retailer security controls.\n\n");
  const chrome=findChrome();
  if(!chrome)throw new Error("Google Chrome was not found. Install Chrome and run again.");
  await login();

  const parallelRequested=Number(process.env.ORDERGRID_PARALLEL||"4");
  const parallel=Number.isInteger(parallelRequested)&&parallelRequested>=1&&parallelRequested<=8?parallelRequested:4;
  const claimRequested=Number(process.env.ORDERGRID_BASKETS||"25");
  const claimLimit=Number.isInteger(claimRequested)&&claimRequested>=1&&claimRequested<=25?claimRequested:25;
  const daemon=process.env.ORDERGRID_DAEMON!=="0";
  const workerId=`worker-${profileKey(`${hostname()}:${profileRoot()}`)}`;
  const started=new Set();

  await heartbeat(workerId);
  output.write(`Worker online · ${workerId} · ${parallel} parallel customer profiles\n`);

  while(true){
    try{
      await heartbeat(workerId);
      await api(`/api/execution-worker/${encodeURIComponent(workerId)}/claim`,{method:"POST",body:JSON.stringify({limit:claimLimit})});
      const queue=(await api(`/api/bulk-queue?workerId=${encodeURIComponent(workerId)}`)).body.baskets||[];
      const currentIds=new Set(queue.map(x=>x.id));
      for(const id of [...started])if(!currentIds.has(id))started.delete(id);

      if(queue.length){
        const groups=groupByProfile(queue);
        await runPool(groups,parallel,async group=>{
          for(const basket of group){
            const resume=started.has(basket.id)||basket.status==="OPENED"||basket.status==="REQUIRES_ACTION";
            try{
              const {body}=await api(`/api/bulk-queue/${basket.id}/open`,{method:"POST",body:JSON.stringify({workerId})});
              for(const item of body.items||[])if(!allowedRetailerUrl(item.executionUrl))throw new Error("OrderGrid returned an untrusted retailer URL");
              const directory=join(profileRoot(),profileKey(body.profileKey||body.retailerAccountId||`${body.customerId||basket.id}:${basket.retailer}`));
              await mkdir(directory,{recursive:true,mode:0o700});
              started.add(basket.id);
              const result=await executeBasket({chrome,directory,retailer:basket.retailer,items:body.items,paymentRoute:body.paymentRoute,address:body.address,accountCredentials:body.credentials||null,resume});
              if(result.state==="CONFIRMED"&&result.orderId){
                await api(`/api/bulk-queue/${basket.id}/confirm`,{method:"POST",body:JSON.stringify({workerId,retailerOrderId:result.orderId})});
                started.delete(basket.id);
                output.write(`Confirmed ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer} · ${result.orderId}\n`);
              }else if(result.state==="CHALLENGE"){
                await postProgress(workerId,basket.id,"CHALLENGE",result.code||"RETAILER_CHALLENGE",result.message||"Retailer action is required");
                output.write(`Challenge ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer}: ${result.code||"REVIEW_REQUIRED"}\n`);
              }else if(result.state==="FAILED"){
                await postProgress(workerId,basket.id,"FAILED",result.code||"EXECUTION_FAILED",result.message||"Checkout execution failed");
                started.delete(basket.id);
                output.write(`Failed ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer}: ${result.message||result.code}\n`);
              }else{
                await postProgress(workerId,basket.id,"RUNNING",result.code,result.message);
              }
            }catch(error){
              await postProgress(workerId,basket.id,"FAILED","WORKER_ERROR",String(error.message).slice(0,400)).catch(()=>{});
              started.delete(basket.id);
              output.write(`Worker error ${basket.recipient||basket.id}: ${error.message}\n`);
            }
          }
        });
      }
    }catch(error){output.write(`Worker cycle error: ${error.message}\n`)}
    if(!daemon)break;
    await sleep(3000);
  }
}

try{await main()}catch(error){output.write(`\nWorker stopped: ${error.message}\n`);process.exitCode=1}finally{cookie="";rl.close()}
