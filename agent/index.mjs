import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allowedHandoff, findChrome, profileKey, profileRoot } from "./lib.mjs";
import { prepareBasket } from "./cdp.mjs";

const baseUrl=(process.env.ORDERGRID_URL||"http://localhost:3000").replace(/\/$/,"");
const rl=createInterface({input,output});
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
async function runPool(items,limit,handler){
  let next=0;
  const workers=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){
      const item=items[next++];
      try{await handler(item)}catch(error){output.write(`Basket error (${item.recipient||item.id}): ${error.message}\n`)}
    }
  });
  await Promise.all(workers);
}
async function main(){
  output.write("\nOrderGrid Bulk Execution Worker\n");
  output.write("OrderGrid groups all products for one customer + retailer into one basket and prepares baskets in isolated visible Chrome profiles.\n");
  output.write("The worker never bypasses retailer authentication, OTP, CAPTCHA or 3DS.\n\n");
  const chrome=findChrome();
  if(!chrome)throw new Error("Google Chrome was not found. Install Chrome and run again.");
  await login();
  const requested=Number(process.env.ORDERGRID_BASKETS||await ask("Baskets to run (1-25, default 10): ")||"10");
  const limit=Number.isInteger(requested)&&requested>=1&&requested<=25?requested:10;
  const parallelRequested=Number(process.env.ORDERGRID_PARALLEL||"4");
  const parallel=Number.isInteger(parallelRequested)&&parallelRequested>=1&&parallelRequested<=8?parallelRequested:4;

  let queue=(await api("/api/bulk-queue")).body.baskets||[];
  if(!queue.length){
    await api("/api/bulk-queue/claim",{method:"POST",body:JSON.stringify({limit})});
    queue=(await api("/api/bulk-queue")).body.baskets||[];
  }
  if(!queue.length){output.write("No eligible bulk baskets are available.\n");return}
  output.write(`Preparing ${queue.length} basket(s) with up to ${parallel} parallel browser workers.\n`);
  await runPool(queue,parallel,basket=>prepareOne(chrome,basket));
  output.write("\nBulk preparation complete. Return to OrderGrid → Bulk checkout to monitor and confirm each retailer order.\n");
}

try{await main()}catch(error){output.write(`\nWorker stopped: ${error.message}\n`);process.exitCode=1}finally{cookie="";rl.close()}
