import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

class CdpConnection{
  constructor(url){
    this.nextId=1;this.pending=new Map();this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{
      this.socket.addEventListener("open",resolve,{once:true});
      this.socket.addEventListener("error",()=>reject(new Error("Chrome DevTools connection failed")),{once:true});
    });
    this.socket.addEventListener("message",event=>{
      let message;try{message=JSON.parse(String(event.data))}catch{return}
      if(!message.id)return;const entry=this.pending.get(message.id);if(!entry)return;
      this.pending.delete(message.id);
      if(message.error)entry.reject(new Error(message.error.message||"Chrome DevTools command failed"));
      else entry.resolve(message.result||{});
    });
  }
  async send(method,params={}){
    await this.ready;const id=this.nextId++;
    const promise=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));
    this.socket.send(JSON.stringify({id,method,params}));return promise;
  }
  close(){try{this.socket.close()}catch{}}
}

async function devtoolsPort(directory,timeoutMs=15000){
  const file=join(directory,"DevToolsActivePort"),deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{
      const text=await readFile(file,"utf8"),[port]=text.trim().split(/\r?\n/);
      if(port){
        const response=await fetch(`http://127.0.0.1:${port}/json/version`).catch(()=>null);
        if(response?.ok)return Number(port);
      }
    }catch{}
    await sleep(150);
  }
  throw new Error("Chrome did not expose a local automation port");
}
async function ensureChrome(chrome,directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  try{return await devtoolsPort(directory,800)}catch{}
  const child=spawn(chrome,[`--user-data-dir=${directory}`,"--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--no-first-run","--no-default-browser-check","--new-window","about:blank"],{detached:true,stdio:"ignore"});
  child.unref();
  return devtoolsPort(directory);
}
async function createTarget(port,url){
  const response=await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,{method:"PUT"});
  if(!response.ok)throw new Error(`Could not open retailer tab (${response.status})`);
  return response.json();
}
async function listTargets(port){
  const response=await fetch(`http://127.0.0.1:${port}/json/list`);
  if(!response.ok)throw new Error("Could not inspect retailer session");
  return response.json();
}
async function waitReady(connection,timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;await connection.send("Runtime.enable");
  while(Date.now()<deadline){
    const result=await connection.send("Runtime.evaluate",{expression:"document.readyState",returnByValue:true});
    const state=result.result?.value;if(state==="interactive"||state==="complete")return;
    await sleep(250);
  }
}
async function evaluate(connection,expression){
  const result=await connection.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(result.exceptionDetails)throw new Error("Retailer page automation script failed");
  return result.result?.value;
}
function addToCartScript(quantity){
  return `(()=>{const qty=${JSON.stringify(Number(quantity)||1)};
    const select=document.querySelector('#quantity,select[name="quantity"],select[aria-label*="quantity" i]');
    if(select&&[...select.options].some(o=>String(o.value)===String(qty))){select.value=String(qty);select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));}
    const selectors=['#add-to-cart-button','input[name="submit.add-to-cart"]','button[name="add"]','button[data-testid*="add-to-cart" i]','button[id*="add-to-cart" i]','button[class*="add-to-cart" i]'];
    let el=selectors.map(s=>document.querySelector(s)).find(Boolean);
    if(!el){const candidates=[...document.querySelectorAll('button,input[type="button"],input[type="submit"],a')];el=candidates.find(x=>/^(add to cart|add to bag|add to basket)$/i.test(String(x.innerText||x.value||x.getAttribute('aria-label')||'').trim()))||candidates.find(x=>/(add to cart|add to bag|add to basket)/i.test(String(x.innerText||x.value||x.getAttribute('aria-label')||'')));}
    if(!el)return {ok:false,reason:'ADD_CONTROL_NOT_FOUND'};
    if(el.disabled||el.getAttribute('aria-disabled')==='true')return {ok:false,reason:'ADD_CONTROL_DISABLED'};
    el.click();return {ok:true};
  })()`;
}
function pageStateScript(postalCode,paymentRoute){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,120000);
    const lower=text.toLowerCase();
    const valueOf=e=>String(e?.value||e?.getAttribute?.('value')||e?.innerText||e?.textContent||e?.getAttribute?.('aria-label')||'').trim();
    const orderPatterns=[/\\b\\d{3}-\\d{7}-\\d{7}\\b/,/\\bOD[0-9A-Z]{8,}\\b/i,/\\b(?:order(?:\\s+id|\\s+number|#)?)[\\s:#-]*([A-Z0-9][A-Z0-9._\\/-]{4,79})/i];
    let orderId=null;
    for(const re of orderPatterns){const m=text.match(re);if(m){orderId=m[1]||m[0];break;}}
    const confirmation=Boolean(orderId)||/(order (has been )?(placed|confirmed|successful)|thank you for your order|order received)/i.test(text);
    if(confirmation)return {state:'CONFIRMED',orderId,href:location.href};
    const hasCaptcha=Boolean(document.querySelector('iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]'))||/captcha|i am not a robot/i.test(lower);
    const hasPassword=Boolean(document.querySelector('input[type="password"]'));
    const hasOtp=Boolean(document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i]'))||/(enter|verify).{0,20}(otp|one time password|verification code)/i.test(lower);
    const has3ds=Boolean(document.querySelector('iframe[src*="3ds" i],iframe[src*="acs" i]'))||/(3d secure|3-d secure|authenticate transaction|bank verification)/i.test(lower);
    if(hasCaptcha)return {state:'CHALLENGE',code:'CAPTCHA_REQUIRED',message:'Retailer CAPTCHA requires authorized human completion',href:location.href};
    if(hasPassword)return {state:'CHALLENGE',code:'LOGIN_REQUIRED',message:'Retailer login is required for this customer account',href:location.href};
    if(hasOtp)return {state:'CHALLENGE',code:'OTP_REQUIRED',message:'Retailer OTP or verification code is required',href:location.href};
    if(has3ds)return {state:'CHALLENGE',code:'PAYMENT_AUTH_REQUIRED',message:'Bank/issuer authentication is required',href:location.href};
    const cardInput=document.querySelector('input[autocomplete="cc-number"],input[name*="cardNumber" i],input[id*="cardNumber" i]');
    if(cardInput&&!${JSON.stringify(paymentRoute)}.toLowerCase().includes('cash'))return {state:'CHALLENGE',code:'PAYMENT_METHOD_REQUIRED',message:'A card payment method must be supplied through an approved issuer/PCI flow',href:location.href};
    const postcode=${JSON.stringify(postalCode||"")};
    if(postcode&&/select.*address|delivery address|choose.*address/i.test(lower)){
      const addressBlocks=[...document.querySelectorAll('address,[class*="address" i],[data-testid*="address" i]')];
      const match=addressBlocks.find(x=>String(x.innerText||'').includes(postcode));
      if(match){const root=match.closest('li,div,section,form')||match;const btn=[...root.querySelectorAll('button,input[type="submit"],a')].find(x=>/(use this address|deliver to this address|select|continue)/i.test(valueOf(x)));if(btn){btn.click();return {state:'RUNNING',action:'ADDRESS_SELECTED',href:location.href};}}
    }
    if(${JSON.stringify(paymentRoute)}.toLowerCase().includes('cash')){
      const controls=[...document.querySelectorAll('label,button,input[type="radio"],div[role="radio"]')];
      const cod=controls.find(x=>/(cash on delivery|pay on delivery|cod)/i.test(valueOf(x)));
      if(cod){const input=cod.matches?.('input')?cod:cod.querySelector?.('input[type="radio"]');(input||cod).click();return {state:'RUNNING',action:'COD_SELECTED',href:location.href};}
    }
    const candidates=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(x=>!x.disabled&&x.getAttribute('aria-disabled')!=='true');
    const patterns=[
      /proceed to (buy|checkout)/i,/proceed to checkout/i,/checkout/i,
      /use this address/i,/deliver to this address/i,/continue/i,
      /place (your )?order/i,/pay now/i,/confirm (and )?(pay|order)/i,/buy now/i
    ];
    for(const re of patterns){const el=candidates.find(x=>re.test(valueOf(x)));if(el){el.click();return {state:'RUNNING',action:valueOf(el).slice(0,80),href:location.href};}}
    return {state:'CHALLENGE',code:'REVIEW_REQUIRED',message:'OrderGrid reached a retailer step that requires review or a retailer-specific connector update',href:location.href};
  })()`;
}

export function cartUrlFor(retailer,productUrl){
  const known={
    "amazon-in":"https://www.amazon.in/gp/cart/view.html",
    "flipkart":"https://www.flipkart.com/viewcart",
    "myntra":"https://www.myntra.com/checkout/cart",
    "ajio":"https://www.ajio.com/cart",
    "tatacliq":"https://www.tatacliq.com/cart",
    "meesho":"https://www.meesho.com/cart",
    "nykaa":"https://www.nykaa.com/cart",
    "jiomart":"https://www.jiomart.com/cart"
  };
  if(known[retailer])return known[retailer];
  const url=new URL(productUrl);return `${url.origin}/cart`;
}
async function driveCheckout(port,{postalCode,paymentRoute}){
  for(let round=0;round<12;round++){
    const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&/^https?:/.test(t.url||""));
    const target=targets[0];if(!target)return {state:"FAILED",code:"NO_RETAILER_PAGE",message:"No retailer checkout page is open"};
    const connection=new CdpConnection(target.webSocketDebuggerUrl);
    try{
      await waitReady(connection);
      const state=await evaluate(connection,pageStateScript(postalCode,paymentRoute));
      if(!state)return {state:"FAILED",code:"NO_PAGE_STATE",message:"Retailer page did not return an execution state"};
      if(state.state==="CONFIRMED"||state.state==="CHALLENGE")return state;
      await sleep(1200);
    }catch(error){return {state:"FAILED",code:"BROWSER_AUTOMATION_ERROR",message:String(error.message).slice(0,300)}}
    finally{connection.close()}
  }
  return {state:"CHALLENGE",code:"CHECKOUT_TIMEOUT",message:"Retailer checkout needs review before OrderGrid can continue"};
}

export async function executeBasket({chrome,directory,retailer,items,paymentRoute,address,resume=false}){
  const port=await ensureChrome(chrome,directory);
  const results=[];
  if(!resume){
    for(const item of items){
      const target=await createTarget(port,item.executionUrl);
      const connection=new CdpConnection(target.webSocketDebuggerUrl);
      try{
        await waitReady(connection);
        const result=await evaluate(connection,addToCartScript(item.requested_quantity));
        results.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,...(result||{ok:false,reason:"NO_RESULT"})});
        await sleep(700);
      }catch(error){results.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,ok:false,reason:String(error.message)})}
      finally{connection.close()}
    }
    const failures=results.filter(x=>!x.ok);
    if(failures.length)return {state:"CHALLENGE",code:"CART_PREPARATION_REVIEW",message:`${failures.length} item(s) could not be added automatically`,results};
    const cartUrl=cartUrlFor(retailer,items[0]?.executionUrl);
    if(cartUrl)await createTarget(port,cartUrl);
  }
  const state=await driveCheckout(port,{postalCode:address?.postalCode,paymentRoute});
  return {...state,results};
}
