import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));

class CdpConnection {
  constructor(url){
    this.nextId=1;
    this.pending=new Map();
    this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{
      this.socket.addEventListener("open",resolve,{once:true});
      this.socket.addEventListener("error",()=>reject(new Error("Chrome DevTools connection failed")),{once:true});
    });
    this.socket.addEventListener("message",event=>{
      let message;
      try{message=JSON.parse(String(event.data))}catch{return}
      if(!message.id)return;
      const entry=this.pending.get(message.id);
      if(!entry)return;
      this.pending.delete(message.id);
      if(message.error)entry.reject(new Error(message.error.message||"Chrome DevTools command failed"));
      else entry.resolve(message.result||{});
    });
  }
  async send(method,params={}){
    await this.ready;
    const id=this.nextId++;
    const promise=new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));
    this.socket.send(JSON.stringify({id,method,params}));
    return promise;
  }
  close(){try{this.socket.close()}catch{}}
}

async function devtoolsPort(directory,timeoutMs=15000){
  const file=join(directory,"DevToolsActivePort"),deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{
      const text=await readFile(file,"utf8");
      const [port]=text.trim().split(/\r?\n/);
      if(port)return Number(port);
    }catch{}
    await sleep(150);
  }
  throw new Error("Chrome did not expose a local automation port");
}

async function createTarget(port,url){
  const response=await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,{method:"PUT"});
  if(!response.ok)throw new Error(`Could not open retailer tab (${response.status})`);
  return response.json();
}

async function waitReady(connection,timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;
  await connection.send("Runtime.enable");
  while(Date.now()<deadline){
    const result=await connection.send("Runtime.evaluate",{expression:"document.readyState",returnByValue:true});
    const state=result.result?.value;
    if(state==="interactive"||state==="complete")return;
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
    el.click();return {ok:true,text:String(el.innerText||el.value||el.getAttribute('aria-label')||'').trim()};
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
  const url=new URL(productUrl);
  return `${url.origin}/cart`;
}

export async function prepareBasket({chrome,directory,retailer,items}){
  await mkdir(directory,{recursive:true,mode:0o700});
  const child=spawn(chrome,[
    `--user-data-dir=${directory}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank"
  ],{detached:true,stdio:"ignore"});
  child.unref();
  const port=await devtoolsPort(directory);
  const results=[];
  for(const item of items){
    const target=await createTarget(port,item.actionUrl);
    const connection=new CdpConnection(target.webSocketDebuggerUrl);
    try{
      await waitReady(connection);
      const result=await evaluate(connection,addToCartScript(item.requested_quantity));
      results.push({purchaseOrderId:item.purchase_order_id,url:item.actionUrl,...(result||{ok:false,reason:"NO_RESULT"})});
      await sleep(900);
    }catch(error){
      results.push({purchaseOrderId:item.purchase_order_id,url:item.actionUrl,ok:false,reason:error.message});
    }finally{connection.close()}
  }
  const cartUrl=cartUrlFor(retailer,items[0]?.actionUrl);
  if(cartUrl)await createTarget(port,cartUrl);
  return {cartUrl,results,added:results.filter(x=>x.ok).length,requiresAction:results.filter(x=>!x.ok).length};
}
