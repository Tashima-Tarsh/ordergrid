import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { allowedRetailerUrl, findChrome, profileKey, profileRoot } from "./lib.mjs";
import { closeProfileBrowser, executeBasket, exportRetailerSessionState, focusRetailerSession, inspectFlipkartMobile, prepareRetailerSession, reconcileRetailerAccount, submitRetailerOtp } from "./cdp.mjs";

const baseUrl=(process.env.ORDERGRID_URL||"http://localhost:3000").replace(/\/$/,"");
const rl=createInterface({input,output});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const workerSessionToken=process.env.ORDERGRID_SESSION_TOKEN||"";
let cookie=workerSessionToken?`session=${workerSessionToken}`:"";
const workerToken=process.env.ORDERGRID_WORKER_TOKEN||"";

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
  const response=await fetch(`${baseUrl}${path}`,{...options,headers:{"content-type":"application/json",...(cookie?{cookie}:{}),...(workerToken?{"x-ordergrid-worker-token":workerToken}:{}),...(options.headers||{})}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(`${body.error||response.statusText} (${response.status})`);
  return {body,response};
}
async function login(){
  if(workerSessionToken)return;
  const email=process.env.ORDERGRID_EMAIL||await ask("OrderGrid secure browser email: ");
  let password=process.env.ORDERGRID_PASSWORD||await readSecret("OrderGrid secure browser password: ");
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

function productCheckFriction(result,error){
  const text=`${result?.state||""} ${result?.code||""} ${result?.message||""} ${error?.message||error||""}`;
  return /CAPTCHA|RATE|THROTTL|TOO MANY|429|SECURITY|ACCESS DENIED|TEMPORARILY BLOCKED/i.test(text);
}
async function runAdaptiveProductCheckPool(commands,state,handler){
  let index=0;
  while(index<commands.length){
    const width=Math.max(1,Math.min(state.current,state.max,commands.length-index));
    const wave=commands.slice(index,index+width);
    const outcomes=await Promise.all(wave.map(handler));
    index+=wave.length;
    const friction=outcomes.some(outcome=>outcome.friction);
    const failures=outcomes.filter(outcome=>!outcome.ok).length;
    if(friction||failures>=Math.max(2,Math.ceil(wave.length/2))){
      const previous=state.current;
      state.current=Math.max(1,Math.floor(state.current/2));
      state.cleanWaves=0;
      state.cooldownMs=Math.min(8000,Math.max(1200,state.cooldownMs*2||1200));
      if(state.current!==previous)output.write(`Product-check throttle · reducing parallelism ${previous} → ${state.current}\n`);
      await sleep(state.cooldownMs);
    }else{
      state.cooldownMs=Math.max(0,Math.floor(state.cooldownMs/2));
      state.cleanWaves++;
      if(state.cleanWaves>=2&&state.current<state.max){
        const previous=state.current;
        state.current++;
        state.cleanWaves=0;
        output.write(`Product-check throttle · clean waves, increasing parallelism ${previous} → ${state.current}\n`);
      }
    }
  }
}

async function main(){
  output.write("\nOrderGrid Secure Browser\n");
  output.write("Approved OrderGrid tasks use isolated retailer browser profiles and report genuine authentication/payment challenges.\n");
  output.write("It does not bypass OTP, CAPTCHA, 3DS, passwords or retailer security controls.\n\n");
  const chrome=findChrome();
  if(!chrome)throw new Error("Google Chrome was not found. Install Chrome and run again.");
  if(!workerToken)throw new Error("ORDERGRID_WORKER_TOKEN is required. Configure the machine token issued for this deployment.");
  await login();

  const parallelRequested=Number(process.env.ORDERGRID_PARALLEL||"4");
  const parallel=Number.isInteger(parallelRequested)&&parallelRequested>=1&&parallelRequested<=8?parallelRequested:4;
  const productCheckRequested=Number(process.env.ORDERGRID_PRODUCT_CHECK_PARALLEL||"4");
  const productCheckMax=Number.isInteger(productCheckRequested)&&productCheckRequested>=1&&productCheckRequested<=8?productCheckRequested:4;
  const productCheckState={current:Math.min(4,productCheckMax),max:productCheckMax,cleanWaves:0,cooldownMs:0};
  const claimRequested=Number(process.env.ORDERGRID_BASKETS||"25");
  const claimLimit=Number.isInteger(claimRequested)&&claimRequested>=1&&claimRequested<=25?claimRequested:25;
  const sessionClaimRequested=Number(process.env.ORDERGRID_SESSION_CLAIM||"1");
  const sessionClaimLimit=Number.isInteger(sessionClaimRequested)&&sessionClaimRequested>=1&&sessionClaimRequested<=25?sessionClaimRequested:1;
  const daemon=process.env.ORDERGRID_DAEMON!=="0";
  const workerId=`worker-${profileKey(`${hostname()}:${profileRoot()}`)}`;
  const started=new Set();
  let lastReconcileAt=0;
  let lastSessionCheckAt=0;

  await heartbeat(workerId);
  output.write(`Worker online · ${workerId} · ${parallel} parallel checkout profiles · ${productCheckState.current} parallel Flipkart product checks (adaptive, max ${productCheckState.max})\n`);
  // Keep worker liveness independent from long-running browser automation.
  // Flipkart page loads and security challenges can take longer than the
  // server's 30-second worker-online window.
  const heartbeatTimer=setInterval(()=>{
    void heartbeat(workerId).catch(error=>{
      output.write(`Worker heartbeat failed: ${String(error.message||error).slice(0,180)}\n`);
    });
  },10_000);
  heartbeatTimer.unref?.();

  while(true){
    try{
      await heartbeat(workerId);

      const commandResult=(await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/claim`,{method:"POST",body:JSON.stringify({limit:10})})).body;
      const commands=commandResult.commands||[];
      const productCommands=commands.filter(command=>command.command==="PRODUCT_CHECK");
      const foregroundCommands=commands.filter(command=>command.command!=="PRODUCT_CHECK");

      for(const command of foregroundCommands){
        try{
          if(command.command==="FOCUS_SESSION"){
            const directory=join(profileRoot(),profileKey(command.profileKey||command.retailerAccountId||command.checkoutBasketId));
            const focused=await focusRetailerSession({chrome,directory,retailer:command.retailer});
            if(!focused.ok)throw new Error(focused.reason||"Could not focus retailer session");
            await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/complete`,{method:"POST",body:JSON.stringify({ok:true})});
            continue;
          }
          if(command.command==="SUBMIT_OTP"){
            const directory=join(profileRoot(),profileKey(command.profileKey||command.retailerAccountId||command.checkoutBasketId));
            const result=await submitRetailerOtp({chrome,directory,retailer:command.retailer,otp:String(command.payload?.otp||"")});
            if(!result?.ok)throw new Error(result?.reason||"Retailer OTP submission failed");
            await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/complete`,{method:"POST",body:JSON.stringify({ok:true,result})});
            continue;
          }
          throw new Error("Unsupported worker command");
        }catch(error){
          await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/complete`,{method:"POST",body:JSON.stringify({ok:false,error:String(error.message).slice(0,300)})}).catch(()=>{});
        }
      }

      if(productCommands.length){
        await runAdaptiveProductCheckPool(productCommands,productCheckState,async command=>{
          let result=null,error=null;
          try{
            if(command.retailer!=="flipkart")throw new Error("PRODUCT_CHECK currently supports Flipkart only");
            const directory=join(profileRoot(),profileKey(command.profileKey||command.retailerAccountId));
            result=await inspectFlipkartMobile({chrome,directory,productUrl:String(command.payload?.productUrl||"")});
            await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/complete`,{method:"POST",body:JSON.stringify({ok:true,result})});
            await closeProfileBrowser({directory}).catch(()=>{});
            output.write(`Product check ${command.payload?.accountReference||command.retailerAccountId} · ${result.state} · ${result.title||command.payload?.productUrl||""}\n`);
            return {ok:true,friction:productCheckFriction(result,null)};
          }catch(caught){
            error=caught;
            await api(`/api/execution-worker/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/complete`,{method:"POST",body:JSON.stringify({ok:false,error:String(caught.message).slice(0,300)})}).catch(()=>{});
            output.write(`Product check failed ${command.payload?.accountReference||command.retailerAccountId} · ${String(caught.message).slice(0,180)}\n`);
            return {ok:false,friction:productCheckFriction(result,error)};
          }
        });
      }

      if(Date.now()-lastSessionCheckAt>=3_000){
        lastSessionCheckAt=Date.now();
        try{
          const sessionClaim=(await api(`/api/execution-worker/${encodeURIComponent(workerId)}/session-health/claim`,{method:"POST",body:JSON.stringify({limit:sessionClaimLimit})})).body;
          for(const account of sessionClaim.accounts||[]){
            const directory=join(profileRoot(),profileKey(account.profileKey||account.retailerAccountId));
            let result=null;
            for(let attempt=0;attempt<2;attempt++){
              try{
                result=await prepareRetailerSession({
                  chrome,directory,retailer:account.retailer,accountCredentials:account.credentials||null,sessionState:account.sessionState||null
                });
              }catch(error){
                result={status:"ERROR",code:"SESSION_WORKER_ERROR",message:String(error.message||error).slice(0,300)};
              }
              const transient=result?.status==="ERROR"&&/Chrome DevTools|automation port|readiness timed out|Could not open retailer tab|Could not inspect retailer session/i.test(String(result.message||""));
              if(!transient||attempt===1)break;
              output.write(`Session browser retry ${account.retailerAccountId} · ${String(result.message||"browser error").slice(0,180)}\n`);
              await closeProfileBrowser({directory}).catch(()=>{});
              await sleep(800);
            }
            result=result||{status:"ERROR",code:"SESSION_WORKER_ERROR",message:"Hosted retailer browser did not return a session result."};
            const sessionState=result.status==="READY"
              ?await exportRetailerSessionState({chrome,directory,retailer:account.retailer}).catch(()=>null)
              :null;
            const reported=await api(`/api/execution-worker/${encodeURIComponent(workerId)}/session-health/${encodeURIComponent(account.retailerAccountId)}`,{
              method:"POST",
              body:JSON.stringify({status:result.status,code:result.code,message:result.message,sessionState,screenshot:result.screenshot||null})
            }).then(()=>true).catch(error=>{
              output.write(`Session result report failed ${account.retailerAccountId} · ${String(error.message||error).slice(0,180)}\n`);
              return false;
            });
            if(!reported)await closeProfileBrowser({directory}).catch(()=>{});
            else if(result.status!=="REAUTH_REQUIRED")await closeProfileBrowser({directory}).catch(()=>{});
          }
        }catch(error){output.write(`Session readiness cycle error: ${error.message}\n`)}
      }

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
              const wasWaitingStock=basket.status==="WAITING_STOCK";
              let result=await executeBasket({chrome,directory,retailer:basket.retailer,items:body.items,paymentRoute:body.paymentRoute,address:body.address,accountCredentials:body.credentials||null,resume});
              if(result.state==="OUT_OF_STOCK"){
                await api(`/api/bulk-queue/${basket.id}/stock-wait`,{
                  method:"POST",
                  body:JSON.stringify({
                    workerId,
                    message:result.message||"Retailer item is currently out of stock",
                    observedPriceMinor:result.unavailable?.find(x=>Number.isFinite(Number(x.observedPriceMinor)))?.observedPriceMinor??null
                  })
                });
                started.delete(basket.id);
                await closeProfileBrowser({directory}).catch(()=>{});
                output.write(`Stock watch ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer}\n`);
                continue;
              }
              if(wasWaitingStock){
                await api(`/api/bulk-queue/${basket.id}/stock-available`,{method:"POST",body:JSON.stringify({workerId})}).catch(()=>{});
                output.write(`Back in stock ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer}\n`);
              }
              if(result.state==="COMMERCIAL_CHECK"){
                const decision=(await api(`/api/bulk-queue/${basket.id}/commercial-check`,{
                  method:"POST",
                  body:JSON.stringify({workerId,amountMinor:Number(result.amountMinor),currency:result.currency||"INR"})
                })).body;
                if(!decision.allowed){
                  await postProgress(workerId,basket.id,"CHALLENGE","PRICE_POLICY_REVIEW_REQUIRED","Commercial policy review required before final retailer submission");
                  output.write(`Commercial review ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer} · expected ₹${(Number(decision.expectedAmountMinor||0)/100).toFixed(2)} · observed ₹${(Number(decision.observedAmountMinor||0)/100).toFixed(2)}\n`);
                  continue;
                }
                result=await executeBasket({chrome,directory,retailer:basket.retailer,items:body.items,paymentRoute:body.paymentRoute,address:body.address,accountCredentials:body.credentials||null,commercialApprovedAmountMinor:Number(decision.approvedAmountMinor),resume:true});
              }
              if(result.state==="CONFIRMED"&&result.orderId){
                await api(`/api/bulk-queue/${basket.id}/confirm`,{method:"POST",body:JSON.stringify({workerId,retailerOrderId:result.orderId})});
                started.delete(basket.id);
                await closeProfileBrowser({directory}).catch(()=>{});
                output.write(`Confirmed ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer} · ${result.orderId}\n`);
              }else if(result.state==="CHALLENGE"){
                await postProgress(workerId,basket.id,"CHALLENGE",result.code||"RETAILER_CHALLENGE",result.message||"Retailer action is required");
                output.write(`Challenge ${body.customerReference||basket.customer_reference||basket.recipient} · ${basket.retailer}: ${result.code||"REVIEW_REQUIRED"}\n`);
              }else if(result.state==="FAILED"){
                await postProgress(workerId,basket.id,"FAILED",result.code||"EXECUTION_FAILED",result.message||"Checkout execution failed");
                started.delete(basket.id);
                await closeProfileBrowser({directory}).catch(()=>{});
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

      if(Date.now()-lastReconcileAt>=60_000){
        lastReconcileAt=Date.now();
        try{
          const claim=(await api(`/api/execution-worker/${encodeURIComponent(workerId)}/reconciliation/claim`,{method:"POST",body:JSON.stringify({limit:25})})).body;
          for(const account of claim.accounts||[]){
            const directory=join(profileRoot(),profileKey(account.profileKey||account.retailerAccountId));
            try{
              const observed=await reconcileRetailerAccount({chrome,directory,retailer:account.retailer,orders:account.orders||[]});
              await api(`/api/execution-worker/${encodeURIComponent(workerId)}/reconciliation/${encodeURIComponent(account.retailerAccountId)}`,{
                method:"POST",
                body:JSON.stringify({
                  basketIds:account.basketIds||[],
                  reward:observed.reward||null,
                  observations:observed.observations||[],
                  authChallenge:observed.authChallenge?.code||null,
                  unsupported:Boolean(observed.unsupported),
                  error:[observed.rewardError,observed.orderError].filter(Boolean).join("; ")||null
                })
              });
              if(!observed.authChallenge)await closeProfileBrowser({directory}).catch(()=>{});
            }catch(error){
              await api(`/api/execution-worker/${encodeURIComponent(workerId)}/reconciliation/${encodeURIComponent(account.retailerAccountId)}`,{
                method:"POST",
                body:JSON.stringify({basketIds:account.basketIds||[],reward:null,observations:[],error:String(error.message).slice(0,300)})
              }).catch(()=>{});
            }
          }
        }catch(error){output.write(`Reconciliation cycle error: ${error.message}\n`)}
      }
    }catch(error){output.write(`Worker cycle error: ${error.message}\n`)}
    if(!daemon)break;
    await sleep(3000);
  }
  clearInterval(heartbeatTimer);
}

try{await main()}catch(error){output.write(`\nWorker stopped: ${error.message}\n`);process.exitCode=1}finally{cookie="";rl.close()}
