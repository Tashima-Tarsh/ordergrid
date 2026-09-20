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
function retailerAuthScript(credentials){
  return `(()=>{const credentials=${JSON.stringify(credentials||null)};
    if(!credentials?.login||!credentials?.password)return {acted:false};
    const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,50000);
    const setValue=(el,value)=>{if(!el)return;const proto=Object.getPrototypeOf(el);const descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor?.set)descriptor.set.call(el,value);else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    const visible=el=>Boolean(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    const password=inputs.find(x=>x.type==='password');
    const user=inputs.find(x=>x.type==='email'||x.autocomplete==='username'||/email|user|login|mobile|phone/i.test(String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||'')))||inputs.find(x=>x.type==='tel');
    const controls=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(visible);
    const label=x=>String(x.innerText||x.value||x.getAttribute('aria-label')||'').trim();
    if(password){
      if(user&&!String(user.value||'').trim())setValue(user,credentials.login);
      if(!String(password.value||''))setValue(password,credentials.password);
      const submit=controls.find(x=>/(sign in|signin|log in|login|continue|submit)/i.test(label(x)))||password.form?.querySelector('button[type="submit"],input[type="submit"]');
      if(submit){submit.click();return {acted:true,action:'CREDENTIALS_SUBMITTED'};}
    }
    if(user&&!String(user.value||'').trim()&&/(sign in|signin|log in|login|email|mobile|account)/i.test(text)){
      setValue(user,credentials.login);
      const next=controls.find(x=>/(continue|next|sign in|signin|log in|login)/i.test(label(x)));
      if(next){next.click();return {acted:true,action:'ACCOUNT_IDENTIFIER_SUBMITTED'};}
    }
    return {acted:false};
  })()`;
}
function pageStateScript(address,paymentRoute,commercialApprovedAmountMinor){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,120000);
    const lower=text.toLowerCase();
    const route=${JSON.stringify(paymentRoute)};
    const address=${JSON.stringify(address||{})};
    const approvedAmount=${commercialApprovedAmountMinor==null?"null":JSON.stringify(commercialApprovedAmountMinor)};
    const valueOf=e=>String(e?.value||e?.getAttribute?.('value')||e?.innerText||e?.textContent||e?.getAttribute?.('aria-label')||'').trim();
    const visible=el=>Boolean(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const setValue=(el,value)=>{if(!el||value==null||value==='')return;const proto=Object.getPrototypeOf(el);const descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor?.set)descriptor.set.call(el,String(value));else el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    const parseMoney=value=>{const match=String(value||'').replace(/,/g,'').match(/(?:₹|rs\\.?|inr)?\\s*(\\d+(?:\\.\\d{1,2})?)/i);if(!match)return null;const n=Number(match[1]);return Number.isFinite(n)?Math.round(n*100):null;};
    const findPayableAmountMinor=()=>{
      const selectors=[
        '[data-testid*="grand-total" i]','[data-testid*="order-total" i]','[data-testid*="payable" i]',
        '[id*="grandTotal" i]','[id*="orderTotal" i]','[id*="payable" i]',
        '[class*="grand-total" i]','[class*="order-total" i]','[class*="payable" i]'
      ];
      for(const selector of selectors){for(const el of document.querySelectorAll(selector)){const amount=parseMoney(valueOf(el));if(amount!==null)return amount;}}
      const labelled=text.match(/(?:order total|grand total|amount payable|total payable|payable amount|total amount)[^₹0-9]{0,40}(?:₹|rs\\.?|inr)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)/i);
      if(labelled){const n=Number(String(labelled[1]).replace(/,/g,''));if(Number.isFinite(n))return Math.round(n*100);}
      return null;
    };
    const orderPatterns=[/\\b\\d{3}-\\d{7}-\\d{7}\\b/,/\\bOD[0-9A-Z]{8,}\\b/i,/\\b(?:order(?:\\s+id|\\s+number|#)?)[\\s:#-]*([A-Z0-9][A-Z0-9._\\/-]{4,79})/i];
    let orderId=null;
    for(const re of orderPatterns){const m=text.match(re);if(m){orderId=m[1]||m[0];break;}}
    const confirmation=Boolean(orderId)||/(order (has been )?(placed|confirmed|successful)|thank you for your order|order received)/i.test(text);
    if(confirmation&&orderId)return {state:'CONFIRMED',orderId,href:location.href};
    if(confirmation)return {state:'CHALLENGE',code:'ORDER_ID_NOT_FOUND',message:'Retailer confirmed the order but the order ID could not be extracted automatically',href:location.href};
    const hasCaptcha=Boolean(document.querySelector('iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]'))||/captcha|i am not a robot/i.test(lower);
    const hasPassword=Boolean(document.querySelector('input[type="password"]'));
    const hasOtp=Boolean(document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i]'))||/(enter|verify).{0,20}(otp|one time password|verification code)/i.test(lower);
    const has3ds=Boolean(document.querySelector('iframe[src*="3ds" i],iframe[src*="acs" i]'))||/(3d secure|3-d secure|authenticate transaction|bank verification)/i.test(lower);
    if(hasCaptcha)return {state:'CHALLENGE',code:'CAPTCHA_REQUIRED',message:'Retailer CAPTCHA requires authorized human completion',href:location.href};
    if(hasPassword)return {state:'CHALLENGE',code:'LOGIN_REQUIRED',message:'Retailer login is required for this customer account',href:location.href};
    if(hasOtp)return {state:'CHALLENGE',code:'OTP_REQUIRED',message:'Retailer OTP or verification code is required',href:location.href};
    if(has3ds)return {state:'CHALLENGE',code:'PAYMENT_AUTH_REQUIRED',message:'Bank/issuer authentication is required',href:location.href};

    const postcode=String(address.postalCode||'').trim();
    if(postcode&&/(select.{0,20}address|delivery address|shipping address|choose.{0,20}address|add.{0,20}address)/i.test(lower)){
      const addressBlocks=[...document.querySelectorAll('address,[class*="address" i],[data-testid*="address" i]')];
      const match=addressBlocks.find(x=>String(x.innerText||x.textContent||'').includes(postcode));
      if(match){
        const root=match.closest('li,div,section,form')||match;
        const btn=[...root.querySelectorAll('button,input[type="submit"],a')].filter(visible).find(x=>/(use this address|deliver to this address|deliver here|select|continue)/i.test(valueOf(x)));
        if(btn){btn.click();return {state:'RUNNING',action:'ADDRESS_SELECTED',href:location.href};}
      }
      const inputs=[...document.querySelectorAll('input,textarea,select')].filter(visible);
      const field=(patterns)=>inputs.find(x=>patterns.some(re=>re.test(String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||x.autocomplete||''))));
      const recipient=field([/full.?name/i,/recipient/i,/name/i]);
      const phone=field([/phone/i,/mobile/i,/tel/i]);
      const line1=field([/address.?line.?1/i,/address1/i,/street/i,/house/i,/building/i]);
      const line2=field([/address.?line.?2/i,/address2/i,/landmark/i]);
      const city=field([/city/i,/town/i]);
      const state=field([/state/i,/province/i,/region/i]);
      const postal=field([/postal/i,/postcode/i,/zip/i,/pincode/i,/pin.?code/i]);
      const looksLikeAddressForm=Boolean(line1&&city&&postal);
      if(looksLikeAddressForm){
        setValue(recipient,address.recipient);setValue(phone,address.phone);setValue(line1,address.line1);setValue(line2,address.line2);setValue(city,address.city);setValue(postal,postcode);
        if(state){
          if(state.tagName==='SELECT'){
            const option=[...state.options].find(o=>String(o.textContent||o.value).trim().toLowerCase()===String(address.state||'').trim().toLowerCase())||[...state.options].find(o=>String(o.textContent||o.value).toLowerCase().includes(String(address.state||'').trim().toLowerCase()));
            if(option){state.value=option.value;state.dispatchEvent(new Event('change',{bubbles:true}));}
          }else setValue(state,address.state);
        }
        const controls=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(visible);
        const save=controls.find(x=>/(use this address|save.*address|deliver to this address|deliver here|add address|continue)/i.test(valueOf(x)));
        if(save){save.click();return {state:'RUNNING',action:'ADDRESS_ADDED',href:location.href};}
      }
    }

    if(route.toLowerCase().includes('cash')){
      const controls=[...document.querySelectorAll('label,button,input[type="radio"],div[role="radio"]')].filter(visible);
      const cod=controls.find(x=>/(cash on delivery|pay on delivery|cod)/i.test(valueOf(x)));
      if(cod){const input=cod.matches?.('input')?cod:cod.querySelector?.('input[type="radio"]');(input||cod).click();return {state:'RUNNING',action:'COD_SELECTED',href:location.href};}
    }else if(/payment method|select payment|choose payment|pay with/i.test(lower)){
      const options=[...document.querySelectorAll('label,[role="radio"],li,div')].filter(visible);
      const saved=options.find(x=>{
        const label=valueOf(x).replace(/\\s+/g,' ');
        return /(ending in|ends in|saved card|card ending|\\*{2,}|x{2,}|•{2,}).{0,30}\\d{2,4}/i.test(label)&&!/(add new|new card)/i.test(label);
      });
      if(saved){
        const radio=saved.matches?.('input[type="radio"]')?saved:saved.querySelector?.('input[type="radio"]');
        (radio||saved).click();
        return {state:'RUNNING',action:'SAVED_PAYMENT_SELECTED',href:location.href};
      }
    }

    const cardInput=document.querySelector('input[autocomplete="cc-number"],input[name*="cardNumber" i],input[id*="cardNumber" i]');
    if(cardInput&&!route.toLowerCase().includes('cash'))return {state:'CHALLENGE',code:'PAYMENT_METHOD_REQUIRED',message:'No tokenized/saved retailer payment method is available. Add the approved payment method in the retailer session; OrderGrid does not collect raw card PAN/CVV.',href:location.href};

    const candidates=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(visible);
    const normalPatterns=[/proceed to (buy|checkout)/i,/proceed to checkout/i,/checkout/i,/use this address/i,/deliver to this address/i,/continue/i];
    for(const re of normalPatterns){const el=candidates.find(x=>re.test(valueOf(x)));if(el){el.click();return {state:'RUNNING',action:valueOf(el).slice(0,80),href:location.href};}}
    const finalPatterns=[/place (your )?order/i,/pay now/i,/confirm (and )?(pay|order)/i,/buy now/i,/submit order/i];
    for(const re of finalPatterns){
      const el=candidates.find(x=>re.test(valueOf(x)));
      if(el){
        const amountMinor=findPayableAmountMinor();
        if(amountMinor===null)return {state:'CHALLENGE',code:'PRICE_NOT_VERIFIED',message:'Final payable amount could not be verified before order submission',href:location.href};
        if(approvedAmount!==amountMinor)return {state:'COMMERCIAL_CHECK',amountMinor,currency:'INR',action:valueOf(el).slice(0,80),href:location.href};
        el.click();return {state:'RUNNING',action:valueOf(el).slice(0,80),amountMinor,href:location.href};
      }
    }
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
async function driveCheckout(port,{address,paymentRoute,accountCredentials,commercialApprovedAmountMinor}){
  for(let round=0;round<12;round++){
    const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&/^https?:/.test(t.url||""));
    const target=targets.find(t=>/(checkout|cart|order|payment|pay|secure|buy)/i.test(t.url||""))||targets[0];
    if(!target)return {state:"FAILED",code:"NO_RETAILER_PAGE",message:"No retailer checkout page is open"};
    const connection=new CdpConnection(target.webSocketDebuggerUrl);
    try{
      await waitReady(connection);
      const auth=await evaluate(connection,retailerAuthScript(accountCredentials));
      if(auth?.acted){await sleep(1400);continue;}
      const state=await evaluate(connection,pageStateScript(address,paymentRoute,commercialApprovedAmountMinor));
      if(!state)return {state:"FAILED",code:"NO_PAGE_STATE",message:"Retailer page did not return an execution state"};
      if(state.state==="CONFIRMED"||state.state==="CHALLENGE")return state;
      await sleep(1200);
    }catch(error){return {state:"FAILED",code:"BROWSER_AUTOMATION_ERROR",message:String(error.message).slice(0,300)}}
    finally{connection.close()}
  }
  return {state:"CHALLENGE",code:"CHECKOUT_TIMEOUT",message:"Retailer checkout needs review before OrderGrid can continue"};
}

export async function executeBasket({chrome,directory,retailer,items,paymentRoute,address,accountCredentials=null,commercialApprovedAmountMinor=null,resume=false}){
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
  const state=await driveCheckout(port,{address,paymentRoute,accountCredentials,commercialApprovedAmountMinor});
  return {...state,results};
}


async function closeTarget(port,target){
  if(!target?.id)return;
  await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`,{method:"PUT"}).catch(()=>null);
}
function retailerHost(retailer){
  return retailer==="flipkart"?"flipkart.com":retailer==="amazon-in"?"amazon.in":null;
}
function authChallengeScript(){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,80000).toLowerCase();
    const otp=Boolean(document.querySelector('input[autocomplete="one-time-code"],input[name*="otp" i],input[id*="otp" i]'))||/(otp|one time password|verification code)/i.test(text);
    const captcha=Boolean(document.querySelector('iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]'))||/captcha|i am not a robot/i.test(text);
    const password=Boolean(document.querySelector('input[type="password"]'));
    const login=/log in|login|sign in|enter email|enter mobile|request otp/i.test(text)&&(password||Boolean(document.querySelector('input[type="email"],input[type="tel"]')));
    if(captcha)return {code:'CAPTCHA_REQUIRED'};
    if(otp)return {code:'OTP_REQUIRED'};
    if(password||login)return {code:'LOGIN_REQUIRED'};
    return null;
  })()`;
}
function rewardSnapshotScript(){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,140000);
    const patterns=[
      /(?:available|total|balance)[^0-9]{0,30}([0-9]{1,7})\\s*SuperCoins?/i,
      /SuperCoins?\\s*(?:balance|available|total)?[^0-9]{0,30}([0-9]{1,7})/i,
      /([0-9]{1,7})\\s*SuperCoins?\\s*(?:available|balance)/i
    ];
    let balance=null;
    for(const re of patterns){const m=text.match(re);if(m){const n=Number(m[1]);if(Number.isInteger(n)&&n>=0){balance=n;break}}}
    const tierMatch=text.match(/(?:Flipkart\\s+)?Plus\\s+(Gold|Silver)/i);
    return {balance,tier:tierMatch?tierMatch[1].toUpperCase():null,url:location.href,excerpt:text.slice(0,1800)};
  })()`;
}
function orderObservationScript(orders){
  return `(()=>{const orders=${JSON.stringify(orders||[])};const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,350000);
    const money=s=>{const m=String(s||'').replace(/,/g,'').match(/(?:₹|Rs\\.?|INR)\\s*([0-9]+(?:\\.[0-9]{1,2})?)/i);return m?Math.round(Number(m[1])*100):null};
    const result=[];
    for(const order of orders){
      const id=String(order.retailerOrderId||'');if(!id)continue;
      const idx=text.toLowerCase().indexOf(id.toLowerCase());if(idx<0)continue;
      const excerpt=text.slice(Math.max(0,idx-450),Math.min(text.length,idx+1400));
      const low=excerpt.toLowerCase();
      let orderStatus=null;
      if(/cancelled|canceled/.test(low))orderStatus='CANCELLED';
      else if(/returned|return complete/.test(low))orderStatus='RETURNED';
      else if(/delivered/.test(low))orderStatus='DELIVERED';
      else if(/out for delivery/.test(low))orderStatus='OUT_FOR_DELIVERY';
      else if(/shipped|dispatched/.test(low))orderStatus='SHIPPED';
      else if(/ordered|confirmed/.test(low))orderStatus='CONFIRMED';
      let refundStatus=null;
      if(/refund(?:ed| complete| completed| successful)|refund.{0,80}(?:credited|processed successfully)|credited.{0,80}refund/.test(low))refundStatus='SETTLED';
      else if(/refund.{0,80}(?:processing|being processed|in process)/.test(low))refundStatus='PROCESSING';
      else if(/refund.{0,80}(?:initiated|issued)/.test(low))refundStatus='INITIATED';
      else if(/refund.{0,80}(?:requested|request received)/.test(low))refundStatus='REQUESTED';
      let refundAmountMinor=null;
      const refundWindow=excerpt.match(/(?:refund(?: amount)?[^₹0-9]{0,50}(?:₹|Rs\\.?|INR)\\s*[0-9][0-9,.]*|(?:₹|Rs\\.?|INR)\\s*[0-9][0-9,.]*[^.]{0,50}refund)/i);
      if(refundWindow)refundAmountMinor=money(refundWindow[0]);
      let rewardUnits=null;
      const reward=excerpt.match(/(?:earned|credited|received)?[^0-9]{0,20}([0-9]{1,5})\\s*SuperCoins?/i);
      if(reward)rewardUnits=Number(reward[1]);
      result.push({retailerOrderId:id,orderStatus,refundStatus,refundAmountMinor,rewardUnits,sourceUrl:location.href,excerpt:excerpt.slice(0,1800)});
    }
    return result;
  })()`;
}

export async function focusRetailerSession({chrome,directory,retailer}){
  const port=await ensureChrome(chrome,directory),host=retailerHost(retailer);
  const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&(!host||String(t.url||"").includes(host)));
  const target=targets.find(t=>/(checkout|payment|pay|secure|order|cart|login|verify|otp)/i.test(t.url||""))||targets[0];
  if(!target)return {ok:false,reason:"SESSION_TAB_NOT_FOUND"};
  const connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    await connection.send("Page.enable");
    await connection.send("Page.bringToFront");
    await connection.send("Runtime.evaluate",{expression:"window.focus(); true",returnByValue:true,userGesture:true}).catch(()=>null);
    return {ok:true,url:target.url||null};
  }finally{connection.close()}
}

export async function reconcileRetailerAccount({chrome,directory,retailer,orders}){
  const port=await ensureChrome(chrome,directory),result={reward:null,observations:[],authChallenge:null};
  if(retailer!=="flipkart"&&retailer!=="amazon-in")return {...result,unsupported:true};

  if(retailer==="flipkart"){
    const rewardsTarget=await createTarget(port,"https://www.flipkart.com/supercoin");
    const connection=new CdpConnection(rewardsTarget.webSocketDebuggerUrl);
    try{
      await waitReady(connection);await sleep(1800);
      const challenge=await evaluate(connection,authChallengeScript());
      if(challenge)result.authChallenge=challenge;
      else result.reward=await evaluate(connection,rewardSnapshotScript());
    }catch(error){
      result.rewardError=String(error.message).slice(0,240);
    }finally{connection.close();await closeTarget(port,rewardsTarget)}
  }

  const ordersUrl=retailer==="flipkart"
    ?"https://www.flipkart.com/account/orders"
    :"https://www.amazon.in/gp/your-account/order-history";
  const ordersTarget=await createTarget(port,ordersUrl);
  const connection=new CdpConnection(ordersTarget.webSocketDebuggerUrl);
  try{
    await waitReady(connection);await sleep(2200);
    const challenge=await evaluate(connection,authChallengeScript());
    if(challenge)result.authChallenge=result.authChallenge||challenge;
    else result.observations=await evaluate(connection,orderObservationScript(orders));
  }catch(error){
    result.orderError=String(error.message).slice(0,240);
  }finally{connection.close();await closeTarget(port,ordersTarget)}
  return result;
}
