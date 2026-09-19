import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allowedHandoff, findChrome, profileKey, profileRoot } from "./lib.mjs";
import { prepareBasket } from "./cdp.mjs";

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
  const email=process.env.ORDERGRID_EMAIL||await ask("OrderGrid operator email: ");
  let password=process.env.ORDERGRID_PASSWORD||await readSecret("OrderGrid operator password: ");
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
async function prepareOne(chrome,basket){
  const {body}=await api(`/api/bulk-queue/${basket.id}/open`,{method:"POST",body:"{}"});
  if(!body.items?.length)throw new Error("Basket contains no checkout items");
  for(const item of body.items)if(!allowedHandoff(item.actionUrl))throw new Error("OrderGrid returned an untrusted retailer URL");
  const stableReference=`${body.accountReference||basket.id}:${basket.retailer}`;
  const directory=join(profileRoot(),profileKey(stableReference));
  await mkdir(directory,{recursive:true,mode:0o700});
  output.write(`\nPreparing ${basket.recipient} · ${basket.retailer} · ${body.items.length} item(s)...\n`);
  const result=await prepareBasket({chrome,directory,retailer:basket.retailer,items:body.items});
  output.write(`Basket prepared: ${result.added}/${body.items.length} item(s) added automatically.\n`);
  if(result.requiresAction)output.write(`${result.requiresAction} item(s) need retailer-page review; their tabs remain visible.\n`);
  output.write("The retailer cart is open in the isolated customer profile. Complete only retailer-required login/OTP/CAPTCHA/3DS/payment steps, then record the retailer order ID in OrderGrid Bulk Checkout.\n");
  return result;
}
async function runPool(groups,limit,handler){
  let next=0;
  const workers=Array.from({length:Math.min(limit,groups.length)},async()=>{
    while(next<groups.length){
      const group=groups[next++];
      await handler(group);
    }
  });
  await Promise.all(workers);
}
function groupByProfile(queue){
  const groups=new Map();
  for(const basket of queue){
    const key=`${basket.account_reference||basket.id}:${basket.retailer}`;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(basket);
  }
  return [...groups.values()];
}
async function main(){
  output.write("\nOrderGrid Bulk Execution Worker\n");
  output.write("Keep this worker running once per operator workstation. Bulk runs are started and monitored from the OrderGrid web workspace.\n");
  output.write("The worker prepares grouped retailer baskets in isolated visible Chrome profiles and never bypasses OTP, CAPTCHA, 3DS or retailer authentication.\n\n");
  const chrome=findChrome();
  if(!chrome)throw new Error("Google Chrome was not found. Install Chrome and run again.");
  await login();

  const requested=Number(process.env.ORDERGRID_BASKETS||"10");
  const claimLimit=Number.isInteger(requested)&&requested>=1&&requested<=25?requested:10;
  const parallelRequested=Number(process.env.ORDERGRID_PARALLEL||"4");
  const parallel=Number.isInteger(parallelRequested)&&parallelRequested>=1&&parallelRequested<=8?parallelRequested:4;
  const daemon=process.env.ORDERGRID_DAEMON!=="0";
  const autoClaim=process.env.ORDERGRID_AUTO_CLAIM==="1";
  const workerId=`worker-${profileKey(`${hostname()}:${profileRoot()}`)}`;
  const prepared=new Set();

  await heartbeat(workerId);
  output.write(`Worker online · ${parallel} parallel profile worker(s) · ${autoClaim?"auto-claim enabled":"waiting for OrderGrid Start bulk run"}\n`);

  while(true){
    try{
      await heartbeat(workerId);
      let queue=(await api("/api/bulk-queue")).body.baskets||[];
      const currentIds=new Set(queue.map(x=>x.id));
      for(const id of [...prepared])if(!currentIds.has(id))prepared.delete(id);

      if(!queue.length&&autoClaim){
        await api("/api/bulk-queue/claim",{method:"POST",body:JSON.stringify({limit:claimLimit})});
        queue=(await api("/api/bulk-queue")).body.baskets||[];
      }
      const pending=queue.filter(x=>!prepared.has(x.id));
      if(pending.length){
        output.write(`\nOrderGrid assigned ${pending.length} new basket(s).\n`);
        const groups=groupByProfile(pending);
        await runPool(groups,parallel,async group=>{
          for(const basket of group){
            try{await prepareOne(chrome,basket)}
            catch(error){output.write(`Basket error (${basket.recipient||basket.id}): ${error.message}\n`)}
            finally{prepared.add(basket.id)}
          }
        });
        output.write("\nBasket preparation cycle complete. Confirm retailer order IDs from OrderGrid → Bulk checkout.\n");
      }
    }catch(error){
      output.write(`Worker cycle error: ${error.message}\n`);
    }
    if(!daemon)break;
    await sleep(3000);
  }
}

try{await main()}catch(error){output.write(`\nWorker stopped: ${error.message}\n`);process.exitCode=1}finally{cookie="";rl.close()}
