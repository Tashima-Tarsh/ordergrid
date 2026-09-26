import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const chromeProcesses=new Map();
function processAlive(pid){
  if(!pid)return false;
  try{process.kill(pid,0);return true}catch{return false}
}
async function waitProcessExit(pid,timeoutMs=1200){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(!processAlive(pid))return true;
    await sleep(80);
  }
  return !processAlive(pid);
}
function signalChromeProcess(pid,signal){
  if(!pid)return false;
  try{
    process.kill(process.platform==="win32"?pid:-pid,signal);
    return true;
  }catch{
    try{process.kill(pid,signal);return true}catch{return false}
  }
}

async function focusChromeWindowWindows(directory){
  if(process.platform!=="win32")return false;
  const escaped=String(directory).replace(/'/g,"''");
  const script=[
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class Win32Focus {",
    "  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);",
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    "}",
    "'@",
    "$dir='"+escaped+"'",
    "$pids=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^chrome(.exe)?$' -and $_.CommandLine -like ('*--user-data-dir='+$dir+'*') } | Select-Object -ExpandProperty ProcessId)",
    "$done=$false",
    "[Win32Focus]::EnumWindows({",
    "  param($h,$l)",
    "  if(-not [Win32Focus]::IsWindowVisible($h)){ return $true }",
    "  [uint32]$pid=0",
    "  [Win32Focus]::GetWindowThreadProcessId($h,[ref]$pid) | Out-Null",
    "  if($pids -contains $pid){",
    "    [Win32Focus]::ShowWindowAsync($h,9) | Out-Null",
    "    [Win32Focus]::SetForegroundWindow($h) | Out-Null",
    "    $script:done=$true",
    "    return $false",
    "  }",
    "  return $true",
    "},[IntPtr]::Zero) | Out-Null",
    "if($done){ exit 0 } else { exit 1 }"
  ].join("\n");
  return await new Promise(resolve=>{
    const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",script],{windowsHide:true,stdio:"ignore"});
    const timer=setTimeout(()=>{try{child.kill()}catch{};resolve(false)},5000);
    child.once("exit",code=>{clearTimeout(timer);resolve(code===0)});
    child.once("error",()=>{clearTimeout(timer);resolve(false)});
  });
}

async function fetchWithTimeout(url,options={},timeoutMs=12000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...options,signal:controller.signal})}
  finally{clearTimeout(timer)}
}

export class CdpConnection{
  constructor(url){
    this.nextId=1;this.pending=new Map();this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{
      this.socket.addEventListener("open",resolve,{once:true});
      this.socket.addEventListener("error",()=>reject(new Error("Chrome DevTools connection failed")),{once:true});
    });
    // A socket may fail before the first command awaits readiness. Mark that
    // rejection handled immediately so a transient Chrome restart cannot
    // terminate the entire hosted worker process.
    this.ready.catch(()=>{});
    this.socket.addEventListener("message",event=>{
      let message;try{message=JSON.parse(String(event.data))}catch{return}
      if(!message.id)return;const entry=this.pending.get(message.id);if(!entry)return;
      this.pending.delete(message.id);clearTimeout(entry.timer);
      if(message.error)entry.reject(new Error(message.error.message||"Chrome DevTools command failed"));
      else entry.resolve(message.result||{});
    });
    this.socket.addEventListener("close",()=>{
      for(const [id,entry] of this.pending){
        clearTimeout(entry.timer);entry.reject(new Error("Chrome DevTools connection closed"));this.pending.delete(id);
      }
    });
  }
  async send(method,params={},timeoutMs=12000){
    await Promise.race([
      this.ready,
      new Promise((_,reject)=>setTimeout(()=>reject(new Error("Chrome DevTools connection timeout")),timeoutMs))
    ]);
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      },timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.socket.send(JSON.stringify({id,method,params}))}
      catch(error){clearTimeout(timer);this.pending.delete(id);reject(error)}
    });
  }
  close(){try{this.socket.close()}catch{}}
}

async function devtoolsPort(directory,timeoutMs=15000){
  const file=join(directory,"DevToolsActivePort"),deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{
      const text=await readFile(file,"utf8"),[port]=text.trim().split(/\r?\n/);
      if(port){
        const response=await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`,{},1500).catch(()=>null);
        if(response?.ok)return Number(port);
      }
    }catch{}
    await sleep(150);
  }
  throw new Error("Chrome did not expose a local automation port");
}
export async function ensureChrome(chrome,directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  try{return await devtoolsPort(directory,800)}catch{}
  const args=[`--user-data-dir=${directory}`,"--remote-debugging-address=127.0.0.1","--remote-debugging-port=0","--no-first-run","--no-default-browser-check","--new-window"];
  const isLinux=process.platform==="linux";
  if(process.env.ORDERGRID_HEADLESS==="1"||(isLinux&&!process.env.DISPLAY))args.push(
    "--headless=new","--no-sandbox","--disable-dev-shm-usage","--disable-gpu",
    "--disable-extensions","--disable-background-networking","--disable-sync",
    "--metrics-recording-only","--renderer-process-limit=2"
  );
  if(isLinux&&!args.includes("--no-sandbox"))args.push("--no-sandbox","--disable-dev-shm-usage","--disable-gpu");
  args.push("about:blank");
  const child=spawn(chrome,args,{detached:true,stdio:"ignore"});
  chromeProcesses.set(directory,{pid:child.pid,child});
  child.once("exit",()=>{
    if(chromeProcesses.get(directory)?.pid===child.pid)chromeProcesses.delete(directory);
  });
  child.unref();
  return devtoolsPort(directory);
}
export async function closeProfileBrowser({directory}){
  let graceful=false;
  try{
    const port=await devtoolsPort(directory,1200);
    const response=await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`,{},1500).catch(()=>null);
    if(response?.ok){
      const version=await response.json();
      if(version?.webSocketDebuggerUrl){
        const connection=new CdpConnection(version.webSocketDebuggerUrl);
        try{await connection.send("Browser.close",{},2500);graceful=true}
        finally{connection.close()}
      }
    }
  }catch{}
  const tracked=chromeProcesses.get(directory);
  if(!tracked?.pid)return graceful;
  await waitProcessExit(tracked.pid,700);
  if(processAlive(tracked.pid)){
    signalChromeProcess(tracked.pid,"SIGTERM");
    await waitProcessExit(tracked.pid,700);
  }
  if(processAlive(tracked.pid)){
    signalChromeProcess(tracked.pid,"SIGKILL");
    await waitProcessExit(tracked.pid,500);
  }
  const stopped=!processAlive(tracked.pid);
  if(stopped)chromeProcesses.delete(directory);
  return graceful||stopped;
}

function safeCookie(cookie){
  const result={
    name:String(cookie.name||""),
    value:String(cookie.value||""),
    domain:String(cookie.domain||""),
    path:String(cookie.path||"/"),
    secure:Boolean(cookie.secure),
    httpOnly:Boolean(cookie.httpOnly)
  };
  if(cookie.sameSite==="Strict"||cookie.sameSite==="Lax"||cookie.sameSite==="None")result.sameSite=cookie.sameSite;
  if(Number.isFinite(Number(cookie.expires))&&Number(cookie.expires)>0)result.expires=Number(cookie.expires);
  return result;
}
export async function exportRetailerSessionState({chrome,directory,retailer}){
  const host=retailerHost(retailer);if(!host)return {cookies:[],localStorage:{}};
  const port=await ensureChrome(chrome,directory);
  const target=await createTarget(port,`https://www.${host}/`);
  const connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    await connection.send("Network.enable");
    const result=await connection.send("Network.getAllCookies");
    const cookies=(result.cookies||[])
      .filter(cookie=>String(cookie.domain||"").replace(/^\./,"").endsWith(host))
      .map(safeCookie)
      .filter(cookie=>cookie.name&&cookie.domain);
    const storageResult=await evaluate(connection,`(()=>{
      try{
        const data={};
        for(let i=0;i<localStorage.length;i++){
          const k=localStorage.key(i);
          if(k)data[k]=localStorage.getItem(k);
        }
        return data;
      }catch{return {};}
    })()`).catch(()=>({}));
    const localStorage=(storageResult&&typeof storageResult==="object")?storageResult:{};
    return {cookies,localStorage};
  }finally{connection.close();await closeTarget(port,target)}
}
export async function restoreRetailerSessionState({chrome,directory,retailer,sessionState}){
  const cookies=Array.isArray(sessionState?.cookies)?sessionState.cookies.map(safeCookie).filter(cookie=>cookie.name&&cookie.domain):[];
  const localStorageEntries=(sessionState?.localStorage&&typeof sessionState.localStorage==="object")?sessionState.localStorage:null;
  if(!cookies.length&&!localStorageEntries)return false;
  const host=retailerHost(retailer);if(!host)return false;
  const port=await ensureChrome(chrome,directory);
  const target=await createTarget(port,`https://www.${host}/`);
  const connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    if(cookies.length){
      await connection.send("Network.enable");
      await connection.send("Network.setCookies",{cookies});
    }
    if(localStorageEntries&&Object.keys(localStorageEntries).length){
      await evaluate(connection,`((entries)=>{
        try{
          for(const [k,v] of Object.entries(entries)){
            if(k&&v!==null&&v!==undefined)localStorage.setItem(k,String(v));
          }
        }catch{}
      })(${JSON.stringify(localStorageEntries)})`).catch(()=>{});
    }
    return true;
  }finally{connection.close();await closeTarget(port,target)}
}

export async function createTarget(port,url){
  const response=await fetchWithTimeout(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,{method:"PUT"});
  if(!response.ok)throw new Error(`Could not open retailer tab (${response.status})`);
  return response.json();
}
export async function closeTarget(port,target){
  const targetId=typeof target==="string"?target:target?.id;
  if(!targetId)return false;
  const response=await fetchWithTimeout(`http://127.0.0.1:${port}/json/close/${targetId}`,{method:"PUT"}).catch(()=>null);
  return Boolean(response?.ok);
}
export async function listTargets(port){
  const response=await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`);
  if(!response.ok)throw new Error("Could not inspect retailer session");
  return response.json();
}
export async function waitReady(connection,timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;await connection.send("Runtime.enable");
  while(Date.now()<deadline){
    const remaining=Math.max(500,Math.min(4000,deadline-Date.now()));
    const result=await connection.send("Runtime.evaluate",{expression:"document.readyState",returnByValue:true},remaining);
    const state=result.result?.value;if(state==="interactive"||state==="complete")return;
    await sleep(250);
  }
  throw new Error("Retailer page readiness timed out");
}
export async function evaluate(connection,expression){
  const result=await connection.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(result.exceptionDetails)throw new Error("Retailer page automation script failed");
  return result.result?.value;
}
function productAvailabilityScript(){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,90000);
    const lower=text.toLowerCase();
    const valueOf=e=>String(e?.value||e?.innerText||e?.textContent||e?.getAttribute?.('aria-label')||'').trim();
    const selectors=['#add-to-cart-button','input[name="submit.add-to-cart"]','button[name="add"]','button[data-testid*="add-to-cart" i]','button[id*="add-to-cart" i]','button[class*="add-to-cart" i]'];
    let add=selectors.map(s=>document.querySelector(s)).find(Boolean);
    if(!add){
      const candidates=[...document.querySelectorAll('button,input[type="button"],input[type="submit"],a')];
      add=candidates.find(x=>/^(add to cart|add to bag|add to basket)$/i.test(valueOf(x)))||candidates.find(x=>/(add to cart|add to bag|add to basket)/i.test(valueOf(x)));
    }
    const explicitOos=/(currently unavailable|out of stock|sold out|temporarily unavailable|not available for purchase|notify me when available|notify me|coming soon)/i.test(lower);
    const disabled=Boolean(add&&(add.disabled||add.getAttribute('aria-disabled')==='true'));
    const priceMatch=text.replace(/,/g,'').match(/(?:₹|rs\\.?|inr)\\s*([0-9]+(?:\\.[0-9]{1,2})?)/i);
    const observedPriceMinor=priceMatch?Math.round(Number(priceMatch[1])*100):null;
    if(explicitOos||(disabled&&/(unavailable|out of stock|sold out|notify me)/i.test(lower)))return {available:false,reason:'OUT_OF_STOCK',observedPriceMinor,href:location.href};
    if(add&&!disabled)return {available:true,reason:'ADD_CONTROL_READY',observedPriceMinor,href:location.href};
    return {available:null,reason:add?'ADD_CONTROL_DISABLED':'AVAILABILITY_UNKNOWN',observedPriceMinor,href:location.href};
  })()`;
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
    if(!credentials?.login)return {acted:false};
    const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,50000);
    const setValue=(el,value)=>{
      if(!el)return;
      try{el.focus();}catch{}
      const tracker=el._valueTracker;
      if(tracker)tracker.setValue('');
      const descriptor=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
      if(descriptor?.set)descriptor.set.call(el,value);
      else el.value=value;
      try{el.dispatchEvent(new InputEvent('input',{bubbles:true,data:value,inputType:'insertText'}));}catch{}
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',keyCode:13}));
      el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter',code:'Enter',keyCode:13}));
    };
    const clickElement=(el)=>{
      if(!el)return;
      try{el.disabled=false;el.removeAttribute('disabled');}catch{}
      try{el.focus();}catch{}
      el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
      try{el.click();}catch{}
    };
    const visible=el=>Boolean(el)&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    
    // Check if OTP input fields are already active on screen (e.g. multi-box or single otp input)
    const digitInputs=inputs.filter(x=>x.maxLength===1||x.getAttribute('maxlength')==='1');
    const singleOtp=inputs.find(x=>x.autocomplete==='one-time-code'||/otp|verification.?code|security.?code/i.test(String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||'')));
    const otpSentText=/(please enter the otp|otp sent to|enter otp sent|resend otp in|enter the 6-digit|enter 6-digit|verification code we)/i.test(text);
    if(digitInputs.length>=4||singleOtp||(otpSentText&&!/enter your (phone|mobile|email)/i.test(text))){
      return {acted:false,challenge:'OTP_REQUIRED'};
    }

    const password=inputs.find(x=>x.type==='password');
    const controls=[...document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a')].filter(visible);
    const label=x=>String(x.innerText||x.value||x.getAttribute('aria-label')||'').trim();
    const fieldMeta=x=>String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||'').trim();
    const nonSearchText=inputs.filter(x=>{
      const type=String(x.type||'text').toLowerCase(),meta=fieldMeta(x),role=String(x.getAttribute('role')||'');
      if(x===password||digitInputs.includes(x)||singleOtp)return false;
      if(x.name==='q'||x.closest('form')?.classList.contains('header-form-search')||/search|find products|products brands and more/i.test(meta)||role==='searchbox')return false;
      if(!['text','email','tel','number'].includes(type))return false;
      return true;
    });
    const isEmail=String(credentials.login||'').includes('@');
    const useEmailBtn=controls.find(x=>/use email/i.test(label(x)))||[...document.querySelectorAll('*')].find(s=>/use email/i.test(s.innerText||'')&&s.children.length===0);
    const usePhoneBtn=controls.find(x=>/use (?:phone|mobile)/i.test(label(x)))||[...document.querySelectorAll('*')].find(s=>/use (?:phone|mobile)/i.test(s.innerText||'')&&s.children.length===0);
    if(isEmail&&useEmailBtn){
      clickElement(useEmailBtn);
      return {acted:true,action:'LOGIN_SURFACE_OPENED'};
    }
    if(!isEmail&&usePhoneBtn){
      clickElement(usePhoneBtn);
      return {acted:true,action:'LOGIN_SURFACE_OPENED'};
    }
    let user=nonSearchText.find(x=>isEmail?x.type==='email':(x.type==='tel'||x.type==='number'))
      ||nonSearchText.find(x=>x.type==='email'||x.autocomplete==='username'||/email|user|login|mobile|phone/i.test(fieldMeta(x)))
      ||nonSearchText[0]||null;
    if(!user){
      user=nonSearchText.find(x=>{
        let node=x;
        for(let depth=0;node&&depth<4;depth++,node=node.parentElement){
          if(/email|mobile|phone|login|sign in|request otp|otp/i.test(String(node.innerText||'')))return true;
        }
        return false;
      })||null;
    }
    if(!user&&password?.form)user=nonSearchText.find(x=>x.form===password.form)||null;
    if(!user&&nonSearchText.length===1)user=nonSearchText[0];
    if(!user){
      const openLogin=controls.find(x=>/^(login|log in|sign in|signin)$/i.test(label(x)));
      if(openLogin){clickElement(openLogin);return {acted:true,action:'LOGIN_SURFACE_OPENED'};}
    }
    if(password&&credentials.password){
      if(user&&!String(user.value||'').trim())setValue(user,credentials.login);
      if(!String(password.value||''))setValue(password,credentials.password);
      const submit=controls.find(x=>/(sign in|signin|log in|login|continue|submit)/i.test(label(x)))||password.form?.querySelector('button[type="submit"],input[type="submit"]');
      if(submit){clickElement(submit);return {acted:true,action:'CREDENTIALS_SUBMITTED'};}
    }
    
    // For Flipkart (OTP-first flow): fill username and trigger Request OTP
    const explicitOtp=controls.find(x=>/(request otp|send otp|get otp|login with otp|log in with otp|use otp|continue with otp)/i.test(label(x)));
    if(!credentials.password&&explicitOtp){
      if(user&&String(user.value||'').trim()!==String(credentials.login).trim()){
        setValue(user,credentials.login);
      }
      clickElement(explicitOtp);
      return {acted:true,action:'OTP_REQUESTED'};
    }
    if(user){
      if(String(user.value||'').trim()!==String(credentials.login).trim()){
        setValue(user,credentials.login);
      }
      const requestOtp=explicitOtp
        ||controls.find(x=>/(request otp|continue|next|sign in|signin|log in|login)/i.test(label(x)))
        ||user.form?.querySelector('button[type="submit"],input[type="submit"],[role="button"]');
      if(requestOtp){
        clickElement(requestOtp);
        return {acted:true,action:'OTP_REQUESTED'};
      }
      return {acted:true,action:'LOGIN_IDENTIFIER_ENTERED'};
    }
    if(password&&!credentials.password){
      return {acted:false,challenge:'LOGIN_REQUIRED'};
    }
    return {acted:false};
  })()`;
}
function pageStateScript(address,paymentRoute,commercialApprovedAmountMinor,retailer){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,120000);
    const lower=text.toLowerCase();
    const route=${JSON.stringify(paymentRoute||'')};
    const address=${JSON.stringify(address||{})};
    const approvedAmount=${commercialApprovedAmountMinor==null?"null":JSON.stringify(commercialApprovedAmountMinor)};
    const isFlipkart=${JSON.stringify(retailer==='flipkart')};
    const valueOf=e=>String(e?.value||e?.getAttribute?.('value')||e?.innerText||e?.textContent||e?.getAttribute?.('aria-label')||'').trim();
    const visible=el=>Boolean(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const setValue=(el,value)=>{if(!el||value==null||value==='')return;const proto=Object.getPrototypeOf(el);const descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor?.set)descriptor.set.call(el,String(value));else el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
    const parseMoney=value=>{const match=String(value||'').replace(/,/g,'').match(/(?:₹|rs\\.?|inr)?\\s*(\\d+(?:\\.\\d{1,2})?)/i);if(!match)return null;const n=Number(match[1]);return Number.isFinite(n)?Math.round(n*100):null;};
    const findPayableAmountMinor=()=>{
      const selectors=[
        '[data-testid*="grand-total" i]','[data-testid*="order-total" i]','[data-testid*="payable" i]',
        '[id*="grandTotal" i]','[id*="orderTotal" i]','[id*="payable" i]',
        '[class*="grand-total" i]','[class*="order-total" i]','[class*="payable" i]',
        '._1Y9Lgu','._35v-b7','.totalAmount','._24vI-G'
      ];
      for(const selector of selectors){for(const el of document.querySelectorAll(selector)){const amount=parseMoney(valueOf(el));if(amount!==null)return amount;}}
      const labelled=text.match(/(?:order total|grand total|amount payable|total payable|total amount|payable amount)[^₹0-9]{0,40}(?:₹|rs\\.?|inr)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)/i);
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

    const extractDeliverySignals=()=>{
      const delMatch=text.match(/(?:delivery by|estimated delivery|get it by|standard delivery)[^.\n]{0,60}/i);
      const deliveryEstimate=delMatch?delMatch[0].trim():null;
      const sellerMatch=text.match(/(?:seller|sold by)[^:\n]{0,20}:\s*([A-Za-z0-9\s._-]+)/i);
      const deliverySeller=sellerMatch?sellerMatch[1].trim().slice(0,80):null;
      const stockState=/out of stock|currently unavailable/i.test(lower)?'OUT_OF_STOCK':'AVAILABLE';
      return {deliveryEstimate,deliverySeller,stockState};
    };

    const postcode=String(address.postalCode||'').trim();
    if(postcode&&/(select.{0,20}address|delivery address|shipping address|choose.{0,20}address|add.{0,20}address)/i.test(lower)){
      const addressBlocks=[...document.querySelectorAll('address,[class*="address" i],[data-testid*="address" i]')];
      const normalizedRecipient=String(address.recipient||'').trim().toLowerCase();
      const recipientTokens=normalizedRecipient.split(/\\s+/).filter(t=>t.length>=2);
      const cleanPhone=String(address.phone||'').replace(/\\D/g,'').slice(-10);

      const matchedBlock=addressBlocks.find(x=>{
        const txt=String(x.innerText||x.textContent||'').toLowerCase();
        const hasPin=new RegExp('\\\\b'+postcode+'\\\\b').test(txt);
        if(!hasPin)return false;
        const hasPhone=cleanPhone&&cleanPhone.length>=10&&txt.includes(cleanPhone);
        const hasRecipient=recipientTokens.length>0&&recipientTokens.some(tok=>txt.includes(tok));
        return hasPhone||hasRecipient||addressBlocks.length===1;
      });

      if(matchedBlock){
        const root=matchedBlock.closest('li,div,section,form')||matchedBlock;
        const btn=[...root.querySelectorAll('button,input[type="submit"],a')].filter(visible).find(x=>/(use this address|deliver to this address|deliver here|select|continue)/i.test(valueOf(x)));
        if(btn){btn.click();return {state:'RUNNING',action:'ADDRESS_SELECTED',href:location.href};}
      }else if(addressBlocks.length>0&&isFlipkart){
        return {
          state:'CHALLENGE',
          code:'ADDRESS_MISMATCH',
          message:'No matching saved delivery address for '+address.recipient+' ('+postcode+') found on Flipkart.',
          href:location.href
        };
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

    const cvvInput=document.querySelector('input[autocomplete="cc-csc"],input[name*="cvv" i],input[id*="cvv" i],input[name*="cvc" i],input[id*="cvc" i],input[name*="securityCode" i],input[id*="securityCode" i]');
    if(cvvInput&&!route.toLowerCase().includes('cash'))return {state:'CHALLENGE',code:'CARD_CVV_REQUIRED',message:'Card security code is required on the retailer payment page. Enter it directly in the live retailer session; OrderGrid does not store CVV.',href:location.href};
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
        const deliverySignals=extractDeliverySignals();
        return {
          state:'READY_TO_SUBMIT',
          action:valueOf(el).slice(0,80),
          amountMinor,
          observedPayableMinor:amountMinor,
          href:location.href,
          deliverySignals
        };
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

async function driveCheckout(port,{address,paymentRoute,accountCredentials,commercialApprovedAmountMinor,retailer="flipkart",onStartFinalSubmit=null}){
  for(let round=0;round<25;round++){
    const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&/^https?:/.test(t.url||""));
    const target=targets.find(t=>/(checkout|cart|order|payment|pay|secure|buy)/i.test(t.url||""))||targets[0];
    if(!target)return {state:"FAILED",code:"NO_RETAILER_PAGE",message:"No retailer checkout page is open"};
    const connection=new CdpConnection(target.webSocketDebuggerUrl);
    try{
      await waitReady(connection);
      if(retailer==="flipkart"){
        const challenge=await evaluate(connection,authChallengeScript());
        if(challenge){
          return {
            state:"CHALLENGE",
            code:challenge.code,
            message:challenge.code==="LOGIN_REQUIRED"
              ?"Flipkart sign-in is required for this account."
              :challenge.code==="OTP_REQUIRED"
                ?"Flipkart OTP is required to continue checkout."
                :challenge.code==="CAPTCHA_REQUIRED"
                  ?"Retailer CAPTCHA requires authorized human completion."
                  :"Retailer verification is required",
            href:target.url||""
          };
        }
      }else if(accountCredentials){
        const auth=await evaluate(connection,retailerAuthScript(accountCredentials));
        if(auth?.acted){await sleep(800);continue;}
      }
      const state=await evaluate(connection,pageStateScript(address,paymentRoute,commercialApprovedAmountMinor,retailer));
      if(!state)return {state:"FAILED",code:"NO_PAGE_STATE",message:"Retailer page did not return an execution state"};
      if(state.state==="CONFIRMED"||state.state==="CHALLENGE"||state.state==="COMMERCIAL_CHECK")return state;

      if(state.state==="READY_TO_SUBMIT"){
        if(typeof onStartFinalSubmit==="function"){
          const submitPermit=await onStartFinalSubmit(state);
          if(!submitPermit?.allowed){
            return {
              state:"CHALLENGE",
              code:submitPermit?.code||"RECONCILIATION_REQUIRED",
              message:submitPermit?.message||"Final submit was already attempted. Please reconcile orders before retrying."
            };
          }
        }
        // Click final submit button ONCE
        const clicked=await evaluate(connection,`(()=>{
          const candidates=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a')].filter(el=>!el.disabled&&getComputedStyle(el).display!=='none');
          const finalPatterns=[/place (your )?order/i,/pay now/i,/confirm (and )?(pay|order)/i,/buy now/i,/submit order/i];
          for(const re of finalPatterns){
            const el=candidates.find(x=>re.test(String(x.innerText||x.value||x.getAttribute('aria-label')||'').trim()));
            if(el){el.click();return {clicked:true,action:String(el.innerText||el.value||'').trim()};}
          }
          return {clicked:false};
        })()`);

        if(!clicked?.clicked){
          return {state:"FAILED",code:"FINAL_SUBMIT_CONTROL_NOT_CLICKED",message:"Could not click final submit button on retailer checkout page"};
        }

        // Wait for confirmation or navigation (bounded wait)
        for(let waitRound=0;waitRound<12;waitRound++){
          await sleep(1200);
          const postSubmitState=await evaluate(connection,pageStateScript(address,paymentRoute,commercialApprovedAmountMinor,retailer));
          if(postSubmitState?.state==="CONFIRMED"&&postSubmitState.orderId){
            return postSubmitState;
          }
          if(postSubmitState?.state==="CHALLENGE"&&postSubmitState.code!=="ORDER_ID_NOT_FOUND"){
            return postSubmitState;
          }
        }

        return {
          state:"CHALLENGE",
          code:"ORDER_ID_NOT_FOUND",
          message:"Final order submission occurred but order ID was not captured. Reconciliation required before marking confirmed.",
          observedPayableMinor:state.amountMinor,
          deliverySignals:state.deliverySignals
        };
      }

      await sleep(600);
    }catch(error){return {state:"FAILED",code:"BROWSER_AUTOMATION_ERROR",message:String(error.message).slice(0,300)}}
    finally{connection.close()}
  }
  return {state:"CHALLENGE",code:"CHECKOUT_TIMEOUT",message:"Retailer checkout needs review before OrderGrid can continue"};
}


function flipkartProductSnapshotScript(){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,180000);
    const lower=text.toLowerCase();
    const clean=v=>String(v??'').replace(/\\s+/g,' ').trim();
    const parseMoney=value=>{const m=clean(value).replace(/,/g,'').match(/(?:₹|rs\\.?|inr)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)/i);if(!m)return null;const n=Number(m[1]);return Number.isFinite(n)?Math.round(n*100):null;};
    const json=[];for(const node of document.querySelectorAll('script[type="application/ld+json"]')){try{const value=JSON.parse(node.textContent||'null');if(Array.isArray(value))json.push(...value);else if(value)json.push(value)}catch{}}
    const flattened=[];const walk=value=>{if(!value||typeof value!=='object')return;flattened.push(value);if(Array.isArray(value['@graph']))for(const x of value['@graph'])walk(x)};for(const value of json)walk(value);
    const product=flattened.find(x=>String(x['@type']||'').toLowerCase()==='product')||null;
    const offers=Array.isArray(product?.offers)?product.offers[0]:product?.offers;
    const selectorText=selectors=>{for(const selector of selectors){const el=document.querySelector(selector);const value=clean(el?.getAttribute?.('content')||el?.textContent||el?.innerText);if(value)return value}return ''};
    const title=clean(product?.name)||selectorText(['h1 span','h1','span.B_NuCI','meta[property="og:title"]'])||clean(document.title);
    let sellingPriceMinor=parseMoney(offers?.price),priceSource=sellingPriceMinor!==null?'STRUCTURED_PRODUCT':'';
    if(sellingPriceMinor===null){
      for(const selector of ['[itemprop="price"]','meta[property="product:price:amount"]','div.Nx9bqj','._30jeq3','[class*="Nx9bqj"]','[class*="hl05eU"]','[class*="price"]']){
        for(const el of document.querySelectorAll(selector)){
          const amount=parseMoney(el.getAttribute?.('content')||el.textContent);
          if(amount&&amount>=10000){sellingPriceMinor=amount;priceSource='VISIBLE_SELLING_PRICE';break}
        }
        if(sellingPriceMinor!==null)break;
      }
    }
    if(sellingPriceMinor===null){
      const allMoneyElements=[...document.querySelectorAll('*')].filter(el=>el.children.length===0&&/₹\s*[0-9]/.test(el.textContent||''));
      for(const el of allMoneyElements){
        const amount=parseMoney(el.textContent);
        if(amount&&amount>=10000){sellingPriceMinor=amount;priceSource='LEAF_ELEMENT_PRICE';break;}
      }
    }
    if(sellingPriceMinor===null){
      const textMatches=[...text.matchAll(/(?:₹|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi)];
      for(const m of textMatches){
        const amount=parseMoney(m[0]);
        if(amount&&amount>=10000){sellingPriceMinor=amount;priceSource='TEXT_PRICE';break;}
      }
    }
    let mrpMinor=null;for(const selector of ['.yRaY8j','._3I9_wc','[class*="yRaY8j"]']){for(const el of document.querySelectorAll(selector)){const amount=parseMoney(el.textContent);if(amount&&(!sellingPriceMinor||amount>=sellingPriceMinor)){mrpMinor=amount;break}}if(mrpMinor!==null)break}
    if(mrpMinor===null){const m=text.match(/(?:M\\.?R\\.?P\\.?|Maximum Retail Price)[^₹0-9]{0,35}(?:₹|Rs\\.?|INR)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)/i);if(m)mrpMinor=Math.round(Number(m[1].replace(/,/g,''))*100)}
    const seller=selectorText(['#sellerName span','#sellerName','a[href*="/sellers"]','[class*="seller"] a'])||null;
    const crumb=[...document.querySelectorAll('a, [class*="breadcrumb"], [class*="_2whKao"]')].filter(a=>/\\/mobiles(?:[/?]|$)|mobile-phones|mobiles-accessories|smartphones/i.test(String(a.getAttribute('href')||'')+' '+clean(a.textContent))).map(a=>clean(a.textContent)).filter(Boolean).join(' > ');
    const structuredCategory=clean(product?.category),categoryText=[crumb,structuredCategory].filter(Boolean).join(' > ');
    const pid=new URL(location.href).searchParams.get('pid')||'';
    const isMobPid=Boolean(/^MOB/i.test(pid));
    const titleMobileSignal=/\\b(mobiles?|smartphones?|phones?|handsets?)\\b/i.test(title)||/\\b(realme|redmi|xiaomi|poco|oneplus|iqoo|vivo|oppo|samsung|motorola|moto|apple|iphone|pixel|infinix|tecno|nothing|cmf|narzo|nord)\\b.*\\b(\\d+\\s*(?:gb|tb)|5g|4g)\\b/i.test(title);
    const categoryMobileSignal=/\\b(mobiles?|smartphones?|handsets?)\\b/i.test(categoryText);
    const specMobileSignal=/\\b(internal storage|ram|battery capacity|primary camera|operating system|network type|sim type)\\b/i.test(text);
    const accessorySignal=/\\b(cases?|covers?|screen guard|tempered glass|charger|charging cable|data cable|usb cable|headset|earphone|neckband|earbuds|airpods|power bank|mobile holder|mobile stand|mobile accessory|skins?|adapter|stylus|replacement display|back cover|back case|pouch|docking station)\\b/i.test(title+' '+categoryText);
    const isMobile=Boolean(categoryMobileSignal||titleMobileSignal||isMobPid||specMobileSignal)&&!accessorySignal;
    let explicitMaxQuantity=null;
    const limitMatch=text.match(/(?:max(?:imum)?\\s+quantity|limit\\s+(?:of\\s+)?(\\d+)|only\\s+(\\d+)\\s+per\\s+customer|allowed\\s+quantity\\s*:?\\s*(\\d+)|maximum\\s+order\\s+quantity\\s*:?\\s*(\\d+))/i);
    if(limitMatch){
      const l=Number(limitMatch[1]||limitMatch[2]||limitMatch[3]||limitMatch[4]);
      if(Number.isInteger(l)&&l>=1&&l<=50)explicitMaxQuantity=l;
    }
    const explicitOos=/(currently unavailable|out of stock|sold out|temporarily unavailable|notify me when available|coming soon)/i.test(lower);
    const offerAvailability=clean(offers?.availability).toLowerCase(),available=explicitOos?false:offerAvailability?(!/outofstock|soldout|discontinued/.test(offerAvailability)):true;
    const canonical=document.querySelector('link[rel="canonical"]')?.href||location.href;
    return {title,category:categoryText||null,isMobile,seller,sellingPriceMinor,mrpMinor,priceSource:priceSource||null,available,canonicalUrl:canonical,pid:pid||null,explicitMaxQuantity,href:location.href};
  })()`;
}

export function flipkartCartVerificationScript(expectedItems){
  return `(()=>{
    const expected=${JSON.stringify(expectedItems||[])};
    const clean=v=>String(v??'').replace(/\\s+/g,' ').trim();
    const parseMoney=v=>{const m=clean(v).replace(/,/g,'').match(/(?:₹|rs\\.?|inr)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)/i);return m?Math.round(Number(m[1])*100):null;};
    const links=[...document.querySelectorAll('a[href*="/p/"]')];
    const uniqueLinks=[];
    const seenHrefs=new Set();
    for(const a of links){
      const href=a.getAttribute('href')||a.href||'';
      const pMatch=href.match(/\\/p\\/([^/?]+)/i);
      const key=pMatch?pMatch[1]:href;
      if(!seenHrefs.has(key)){seenHrefs.add(key);uniqueLinks.push(a);}
    }

    const cartItems=[];
    for(const link of uniqueLinks){
      let node=link;
      for(let i=0;i<11&&node;i++,node=node.parentElement){
        const txt=clean(node.innerText);
        const controls=[...node.querySelectorAll('button,[role="button"],input')];
        if(/remove|save for later|quantity|delivery/i.test(txt)&&controls.length)break;
      }
      const itemRow=node||link.parentElement;
      const href=link.getAttribute('href')||link.href||'';
      let pid='';
      try{const u=new URL(href,location.href);pid=u.searchParams.get('pid')||'';}catch{}
      const pKeyMatch=href.match(/\\/p\\/([^/?]+)/i);
      const productKey=pKeyMatch?pKeyMatch[1]:'';

      const input=[...(itemRow?.querySelectorAll('input')||[])].find(x=>/^\\d+$/.test(String(x.value||'').trim()));
      let quantity=input?Number(input.value):null;
      if(!Number.isInteger(quantity)||quantity<1){
        const m=clean(itemRow?.innerText).match(/(?:qty|quantity)\\s*:?\\s*(\\d{1,2})/i);
        quantity=m?Number(m[1]):1;
      }
      const priceMinor=parseMoney(itemRow?.innerText);
      const title=clean(link.innerText||link.getAttribute('aria-label')||link.title||'');
      cartItems.push({pid:pid||null,productKey:productKey||null,title,quantity:Number(quantity)||1,priceMinor});
    }

    if(expected.length===0)return {verified:true,code:'CART_VERIFIED',cartItems,message:'Cart inspected'};

    if(cartItems.length>expected.length){
      return {verified:false,code:'CART_CONTAMINATION',cartItems,message:'Cart contains '+(cartItems.length-expected.length)+' unexpected item(s). Paused for operator review.'};
    }

    for(const exp of expected){
      let expPid=exp.pid||'';
      let expKey='';
      if(!expPid&&exp.url){
        try{
          const u=new URL(exp.url);
          expPid=u.searchParams.get('pid')||'';
          const km=u.pathname.match(/\\/p\\/([^/?]+)/i);
          if(km)expKey=km[1];
        }catch{}
      }
      const match=cartItems.find(ci=>(expPid&&ci.pid&&ci.pid.toLowerCase()===expPid.toLowerCase())||(expKey&&ci.productKey&&ci.productKey.toLowerCase()===expKey.toLowerCase()));
      if(!match){
        return {verified:false,code:'CART_ITEM_MISSING',cartItems,message:'Expected item ('+(expPid||exp.title||'PID')+') not found in Flipkart cart.'};
      }
      const expQty=Number(exp.requested_quantity||exp.requestedQuantity||exp.quantity||1);
      if(match.quantity!==expQty){
        return {verified:false,code:'CART_QUANTITY_MISMATCH',cartItems,message:'Cart quantity ('+match.quantity+') does not match expected quantity ('+expQty+').'};
      }
    }

    if(cartItems.length!==expected.length){
      return {verified:false,code:'CART_ITEM_MISSING',cartItems,message:'Cart item count ('+cartItems.length+') does not match expected items ('+expected.length+').'};
    }

    return {verified:true,code:'CART_VERIFIED',cartItems,message:'Flipkart cart verified: exact items and quantities matched with zero contamination.'};
  })()`;
}

function flipkartCartStateScript(productUrl){
  return `(()=>{const target=${JSON.stringify(productUrl)};
    const wanted=new URL(target),wantedPid=wanted.searchParams.get('pid'),wantedKey=(wanted.pathname.match(/\\/p\\/([^/?]+)/i)||[])[1]||'';
    const clean=v=>String(v??'').replace(/\\s+/g,' ').trim();
    const locate=()=>{const links=[...document.querySelectorAll('a[href*="/p/"]')],link=links.find(a=>{try{const u=new URL(a.href,location.href),pid=u.searchParams.get('pid'),key=(u.pathname.match(/\\/p\\/([^/?]+)/i)||[])[1]||'';return Boolean((wantedPid&&pid===wantedPid)||(wantedKey&&key===wantedKey))}catch{return false}});if(!link)return null;let node=link;for(let i=0;i<10&&node;i++,node=node.parentElement){const txt=clean(node.innerText),controls=[...node.querySelectorAll('button,[role="button"],input')];if(/remove|save for later|quantity|delivery/i.test(txt)&&controls.length)return node}return link.parentElement};
    const row=locate();if(!row)return {present:false,quantity:0};
    const input=[...row.querySelectorAll('input')].find(x=>/^\\d+$/.test(String(x.value||'').trim()));let quantity=input?Number(input.value):null;if(!Number.isInteger(quantity)||quantity<1){const m=clean(row.innerText).match(/(?:qty|quantity)\\s*:?\\s*(\\d{1,2})/i);quantity=m?Number(m[1]):1}
    return {present:true,quantity:Number(quantity)||1};
  })()`;
}

function flipkartCartProbeScript(productUrl,originalQuantity){
  return `(()=>{
    return {maxQuantity:null,maxQuantityVerified:false,reason:'PROBE_DISABLED_SAFE_MODE',restored:true};
  })()`;
}

async function readFlipkartCartState(port,productUrl){
  const target=await createTarget(port,"about:blank"),connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    await connection.send("Page.enable");
    await connection.send("Page.navigate",{url:"https://www.flipkart.com/viewcart"});
    await waitReady(connection);
    await sleep(1500);
    return await evaluate(connection,flipkartCartStateScript(productUrl));
  }
  finally{connection.close();await closeTarget(port,target)}
}

function flipkartPincodeScript(postalCode){
  return `(()=>{const pin=${JSON.stringify(String(postalCode||""))};
    if(!/^\\d{6}$/.test(pin))return {acted:false};
    const inputs=[...document.querySelectorAll('input')];
    const pinInput=inputs.find(x=>x.maxLength===6||/pincode|delivery.?pincode|enter.{0,10}pincode/i.test(String(x.placeholder||x.name||x.id||x.getAttribute('aria-label')||'')));
    if(!pinInput)return {acted:false};
    try{pinInput.focus();}catch{}
    const proto=Object.getPrototypeOf(pinInput);
    const descriptor=Object.getOwnPropertyDescriptor(proto,'value');
    if(descriptor?.set)descriptor.set.call(pinInput,pin);
    else pinInput.value=pin;
    pinInput.dispatchEvent(new InputEvent('input',{bubbles:true,data:pin,inputType:'insertText'}));
    pinInput.dispatchEvent(new Event('input',{bubbles:true}));
    pinInput.dispatchEvent(new Event('change',{bubbles:true}));
    pinInput.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',code:'Enter',keyCode:13}));
    const checkBtn=[...document.querySelectorAll('button,[role="button"],span')].find(x=>/^(check|submit|change)$/i.test(String(x.innerText||'').trim()));
    if(checkBtn)try{checkBtn.click();}catch{}
    return {acted:true};
  })()`;
}

export async function inspectFlipkartMobile({chrome,directory,productUrl,postalCode=""}){
  const port=await ensureChrome(chrome,directory);
  const target=await createTarget(port,"about:blank"),connection=new CdpConnection(target.webSocketDebuggerUrl);
  let snapshot=null;
  try{
    await connection.send("Page.enable");
    await connection.send("Page.navigate",{url:productUrl});
    await waitReady(connection);
    
    if(postalCode&&/^\d{6}$/.test(postalCode)){
      await evaluate(connection,flipkartPincodeScript(postalCode)).catch(()=>null);
      await sleep(1000);
    }
    
    for(let attempt=0;attempt<7;attempt++){
      await sleep(attempt===0?2000:1000);
      const challenge=await evaluate(connection,authChallengeScript());
      if(challenge)return {state:"REAUTH_REQUIRED",code:challenge.code,message:"Flipkart verification is required before OrderGrid can check this product.",productUrl,checkedAt:new Date().toISOString()};
      snapshot=await evaluate(connection,flipkartProductSnapshotScript());
      if(snapshot?.sellingPriceMinor&&snapshot?.title&&!/Buy Products Online/i.test(snapshot.title)){
        break;
      }
    }
    
    if(!snapshot)snapshot={title:"Flipkart mobile",isMobile:false,available:true,sellingPriceMinor:null};
    if(snapshot.available===false)return {state:"OUT_OF_STOCK",code:"OUT_OF_STOCK",message:"This Flipkart mobile is currently unavailable.",productUrl,maxQuantity:0,maxQuantityVerified:true,checkedAt:new Date().toISOString(),...snapshot};
    if(!Number.isFinite(Number(snapshot.sellingPriceMinor))||Number(snapshot.sellingPriceMinor)<=0)return {state:"REVIEW_REQUIRED",code:"PRICE_NOT_VERIFIED",message:"OrderGrid could not verify the current Flipkart selling price.",productUrl,checkedAt:new Date().toISOString(),...snapshot};
    if(!snapshot.isMobile)return {state:"REVIEW_REQUIRED",code:"PRODUCT_TYPE_NOT_VERIFIED",message:"OrderGrid could not confidently verify that this product is a mobile phone.",isMobile:false,productUrl,checkedAt:new Date().toISOString(),...snapshot};
    
    const hasExplicitLimit=snapshot.explicitMaxQuantity!==null&&snapshot.explicitMaxQuantity!==undefined;
    const maxQuantity=hasExplicitLimit?snapshot.explicitMaxQuantity:null;
    const maxQuantityVerified=hasExplicitLimit;
    return {
      state:"READY",
      code:"PRODUCT_VERIFIED",
      message:maxQuantityVerified?"Flipkart mobile price, availability and quantity limit verified.":"Flipkart mobile price and availability verified.",
      isMobile:true,
      productUrl,
      maxQuantity,
      maxQuantityVerified,
      checkedAt:new Date().toISOString(),
      ...snapshot,
      maxQuantity,
      maxQuantityVerified
    };
  }finally{connection.close();await closeTarget(port,target)}
}

export async function executeBasket({chrome,directory,retailer="flipkart",items,paymentRoute,address,accountCredentials=null,commercialApprovedAmountMinor=null,resume=false,onStartFinalSubmit=null}){
  const port=await ensureChrome(chrome,directory);
  const results=[],availability=[];
  if(!resume){
    if(retailer==="flipkart"){
      const checkTarget=await createTarget(port,"https://www.flipkart.com/account/orders");
      const checkConn=new CdpConnection(checkTarget.webSocketDebuggerUrl);
      try{
        await waitReady(checkConn);
        await sleep(1200);
        const challenge=await evaluate(checkConn,authChallengeScript());
        if(challenge){
          return {
            state:"CHALLENGE",
            code:challenge.code,
            message:challenge.code==="LOGIN_REQUIRED"
              ?"Flipkart sign-in is required before checking out this basket."
              :challenge.code==="OTP_REQUIRED"
                ?"Flipkart OTP verification is required."
                :"Retailer CAPTCHA requires authorized human completion."
          };
        }
      }finally{checkConn.close();await closeTarget(port,checkTarget)}
    }

    for(const item of items){
      const target=await createTarget(port,"about:blank");
      const connection=new CdpConnection(target.webSocketDebuggerUrl);
      try{
        await connection.send("Page.enable");
        await connection.send("Page.navigate",{url:item.executionUrl});
        await waitReady(connection);
        await sleep(500);
        const avail=await evaluate(connection,productAvailabilityScript());
        availability.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,...(avail||{available:null,reason:"NO_RESULT"})});
        if(avail?.available===false&&avail.reason==="OUT_OF_STOCK"){
          results.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,ok:false,reason:"OUT_OF_STOCK"});
          continue;
        }
        const cartResult=await evaluate(connection,addToCartScript(item.requested_quantity));
        results.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,...(cartResult||{ok:false,reason:"NO_RESULT"})});
        await sleep(400);
      }catch(error){
        availability.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,available:null,reason:String(error.message)});
        results.push({purchaseOrderId:item.purchase_order_id,url:item.executionUrl,ok:false,reason:String(error.message)});
      }finally{connection.close();await closeTarget(port,target)}
    }
    const unavailable=availability.filter(x=>x.available===false&&x.reason==="OUT_OF_STOCK");
    if(unavailable.length){
      return {
        state:"OUT_OF_STOCK",
        code:"OUT_OF_STOCK",
        message:`${unavailable.length} item(s) are currently unavailable. OrderGrid can keep the approved order on stock watch.`,
        unavailable,availability,results
      };
    }
    const failures=results.filter(x=>!x.ok);
    if(failures.length)return {state:"CHALLENGE",code:"CART_PREPARATION_REVIEW",message:`${failures.length} item(s) could not be added automatically`,results,availability};

    const cartUrl=cartUrlFor(retailer,items[0]?.executionUrl);
    if(cartUrl){
      const cartTarget=await createTarget(port,"about:blank");
      const cartConnection=new CdpConnection(cartTarget.webSocketDebuggerUrl);
      try{
        await cartConnection.send("Page.enable");
        await cartConnection.send("Page.navigate",{url:cartUrl});
        await waitReady(cartConnection);
        await sleep(1500);
        if(retailer==="flipkart"){
          const cartVerify=await evaluate(cartConnection,flipkartCartVerificationScript(items));
          if(cartVerify&&!cartVerify.verified){
            return {
              state:"CHALLENGE",
              code:cartVerify.code,
              message:cartVerify.message,
              cartItems:cartVerify.cartItems,
              results,
              availability
            };
          }
        }
      }finally{cartConnection.close()}
    }
  }
  const state=await driveCheckout(port,{address,paymentRoute,accountCredentials,commercialApprovedAmountMinor,retailer,onStartFinalSubmit});
  return {...state,results,availability};
}


function retailerHost(retailer){
  return retailer==="flipkart"?"flipkart.com":retailer==="amazon-in"?"amazon.in":null;
}
function authChallengeScript(){
  return `(()=>{const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,80000).toLowerCase();
    const visible=el=>Boolean(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    const nonSearch=inputs.filter(x=>!/search/i.test(x.placeholder||x.name||''));
    const digitInputs=nonSearch.filter(x=>x.maxLength===1||x.getAttribute('maxlength')==='1'||(x.type==='number'&&nonSearch.filter(i=>i.type==='number').length>=4));
    const singleOtp=inputs.find(x=>x.autocomplete==='one-time-code'||/otp|verification.?code|security.?code/i.test(String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||'')));
    const otpSentText=/(please enter the otp|please enter the verification|otp sent to|enter otp sent|resend otp in|enter the 6-digit|enter 6-digit|verification code we)/i.test(text);
    const isOtpActive=digitInputs.length>=4||singleOtp||(otpSentText&&!/enter (email|mobile|your phone)/i.test(text));
    
    const captcha=Boolean(document.querySelector('iframe[src*="captcha" i],[class*="captcha" i],[id*="captcha" i],input[name*="captcha" i]'))||/captcha|i am not a robot/i.test(text);
    const password=Boolean(document.querySelector('input[type="password"]'));
    const login=/log in|login|sign in|enter email|enter mobile/i.test(text)&&(password||Boolean(document.querySelector('input[type="email"],input[type="tel"]')));
    
    if(captcha)return {code:'CAPTCHA_REQUIRED'};
    if(isOtpActive)return {code:'OTP_REQUIRED'};
    if(password||login)return {code:'LOGIN_REQUIRED'};
    return null;
  })()`;
}

function otpSubmitScript(otp){
  return `(()=>{const otp=${JSON.stringify(String(otp||""))};
    if(!/^\\d{4,8}$/.test(otp))return {ok:false,reason:'INVALID_OTP'};
    const visible=el=>Boolean(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true'&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none';
    const setValue=(el,value)=>{
      if(!el)return;
      try{el.focus();}catch{}
      const tracker=el._valueTracker;
      if(tracker)tracker.setValue('');
      const descriptor=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
      if(descriptor?.set)descriptor.set.call(el,value);
      else el.value=value;
      try{el.dispatchEvent(new InputEvent('input',{bubbles:true,data:value,inputType:'insertText'}));}catch{}
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:value,code:'Digit'+value}));
      el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:value,code:'Digit'+value}));
    };
    const clickElement=(el)=>{
      if(!el)return;
      try{el.disabled=false;el.removeAttribute('disabled');}catch{}
      try{el.focus();}catch{}
      el.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));
      el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));
      try{el.click();}catch{}
    };
    const inputs=[...document.querySelectorAll('input')].filter(visible);
    const nonSearch=inputs.filter(x=>!/search/i.test(x.placeholder||x.name||''));
    const digitInputs=nonSearch.filter(x=>x.maxLength===1||x.getAttribute('maxlength')==='1'||(x.type==='number'&&nonSearch.filter(i=>i.type==='number').length>=4));
    const field=inputs.find(x=>x.autocomplete==='one-time-code'||/otp|one.?time|verification.?code|security.?code/i.test(String(x.name||x.id||x.placeholder||x.getAttribute('aria-label')||'')));
    
    if(digitInputs.length>=4){
      digitInputs.slice(0,otp.length).forEach((input,i)=>setValue(input,otp[i]));
    }else if(field){
      setValue(field,otp);
    }else{
      return {ok:false,reason:'OTP_FIELD_NOT_FOUND'};
    }
    
    const controls=[...document.querySelectorAll('button,input[type="submit"],input[type="button"],a,[role="button"]')].filter(visible);
    const label=x=>String(x.innerText||x.value||x.getAttribute('aria-label')||'').trim();
    const submit=controls.find(x=>/(verify|continue|submit|confirm|proceed|sign in|login)/i.test(label(x)))||document.querySelector('button[type="submit"],input[type="submit"]');
    if(submit){clickElement(submit);return {ok:true,submitted:true};}
    return {ok:true,submitted:false};
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

export async function submitRetailerOtp({chrome,directory,retailer,otp}){
  const port=await ensureChrome(chrome,directory),host=retailerHost(retailer);
  const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&(!host||String(t.url||"").includes(host)));
  const target=targets.find(t=>/(checkout|payment|pay|secure|order|cart|login|verify|otp)/i.test(String(t.url||"")))||targets[0];
  if(!target)return {ok:false,reason:"SESSION_TAB_NOT_FOUND"};
  const connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    await connection.send("Page.enable");
    await connection.send("Page.bringToFront").catch(()=>null);
    const result=await evaluate(connection,otpSubmitScript(otp));
    if(!result?.ok)return result||{ok:false,reason:"OTP_SUBMIT_FAILED"};
    
    // Wait for Flipkart to process the OTP and transition
    for(let w=0;w<8;w++){
      await sleep(1000);
      const curUrl=await evaluate(connection,`location.href`).catch(()=>"");
      const curText=await evaluate(connection,`document.body?.innerText||''`).catch(()=>"");
      const isInvalidOtp=/(incorrect otp|invalid otp|wrong otp|please enter a valid|verification failed)/i.test(curText);
      if(isInvalidOtp)return {ok:false,reason:"INVALID_OTP_ENTERED"};
      const isVerified=!String(curUrl).includes('/login/verify')||/(my account|orders|logout|cart)/i.test(curText);
      if(isVerified)return {ok:true,submitted:true};
    }
    return {ok:true,submitted:true};
  }finally{connection.close()}
}

export async function focusRetailerSession({chrome,directory,retailer}){
  const port=await ensureChrome(chrome,directory),host=retailerHost(retailer);
  const targets=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&(!host||String(t.url||"").includes(host)));
  let target=targets.find(t=>/(checkout|payment|pay|secure|order|cart|login|verify|otp)/i.test(t.url||""))||targets[0];
  if(!target){
    const defaultUrl=retailer==="flipkart"?"https://www.flipkart.com/account/login?ret=/":"https://www.amazon.in/";
    target=await createTarget(port,defaultUrl);
  }
  if(!target)return {ok:false,reason:"SESSION_TAB_NOT_FOUND"};
  const connection=new CdpConnection(target.webSocketDebuggerUrl);
  try{
    await connection.send("Page.enable");
    await connection.send("Page.bringToFront");
    await connection.send("Runtime.evaluate",{expression:"window.focus(); true",returnByValue:true,userGesture:true}).catch(()=>null);
    const osFocused=await focusChromeWindowWindows(directory).catch(()=>false);
    return {ok:true,url:target.url||null,osFocused};
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


export function classifyLoginOutcome({text='', digitsCount=0, hasOtpInput=false, isRateLimited=false, isNewUser=false, excerpt=''}={}){
  const normalizedText = String(text||'').replace(/\s+/g,' ');
  const isOtpSent = /(?:please enter the verification code|please enter the otp|enter otp|verification code we've sent|resend otp in|enter 6-digit|enter the 6-digit)/i.test(normalizedText)
    || digitsCount >= 4
    || Boolean(hasOtpInput);

  if (isOtpSent) {
    return { outcome: "OTP_SENT", code: "OTP_SENT", message: "Flipkart verification OTP has been sent. Enter the 6-digit code below to connect." };
  }
  if (isRateLimited || /(?:try again later|too many attempts|something went wrong|unable to send|maximum attempts reached)/i.test(normalizedText)) {
    const m = normalizedText.match(/(?:try again later|too many attempts|something went wrong|unable to send|maximum attempts reached)[^.!?]{0,100}/i);
    const msg = excerpt || (m ? m[0] : "Flipkart rate limit reached. Please try again later.");
    return { outcome: "RATE_LIMITED", code: "RATE_LIMITED", message: msg };
  }
  if (isNewUser || /looks like you're new here|sign up with your/i.test(normalizedText)) {
    return { outcome: "ACCOUNT_NOT_REGISTERED", code: "ACCOUNT_NOT_REGISTERED", message: "Login identifier is not registered on Flipkart. Please register or verify the email/mobile." };
  }
  return { outcome: "UNKNOWN", code: "OTP_NOT_SENT", message: "Flipkart did not send an OTP after login submission. Please try manual browser login." };
}

export function decideSessionReady({url='', evalOk=false, hasAccountContent=false, isLoginUrl=false, hasLoginBtn=false, cookieNames=[]}={}){
  if (!evalOk) return false;
  const href = String(url||'');
  if (isLoginUrl || /\/login|\/signin|\/ap\/signin/i.test(href)) return false;
  if (hasLoginBtn && !hasAccountContent) return false;
  if (!hasAccountContent) return false;
  return true;
}

export async function prepareRetailerSession({chrome,directory,retailer,accountCredentials,sessionState=null,verifyOnly=false}){
  if(sessionState)await restoreRetailerSessionState({chrome,directory,retailer,sessionState}).catch(()=>false);
  const isLinux=process.platform==="linux";
  const isHeadless=process.env.ORDERGRID_HEADLESS==="1"||(isLinux&&!process.env.DISPLAY);
  if(retailer==="flipkart"&&!verifyOnly&&isHeadless){
    return {status:"ERROR",code:"HEADED_BROWSER_REQUIRED",message:"Headed browser required for retailer login / OTP request"};
  }
  const port=await ensureChrome(chrome,directory);
  const flipkartLoginUrl="https://www.flipkart.com/";
  const url=retailer==="flipkart"
    ?(verifyOnly?"https://www.flipkart.com/account/orders":"https://www.flipkart.com/account/login?ret=/")
    :retailer==="amazon-in"
      ?"https://www.amazon.in/gp/your-account/order-history"
      :null;
  if(!url)return {status:"ERROR",code:"SESSION_CHECK_UNSUPPORTED",message:"Session preparation is currently available for Amazon India and Flipkart."};
  const host=retailerHost(retailer);
  const existing=(await listTargets(port)).filter(t=>t.type==="page"&&t.webSocketDebuggerUrl&&(!host||String(t.url||"").includes(host)));
  let target=existing.find(t=>/(account\/login|login|signin|account\/orders|order-history|verify|otp)/i.test(String(t.url||"")))||await createTarget(port,url);
  let connection=new CdpConnection(target.webSocketDebuggerUrl);
  const primeConnection=async()=>{
    await connection.send("Page.enable");
    await connection.send("Network.enable").catch(()=>null);
    await connection.send("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false}).catch(()=>null);
    await connection.send("Page.bringToFront").catch(()=>null);
    await connection.send("Runtime.evaluate",{expression:"window.focus(); true",returnByValue:true,userGesture:true}).catch(()=>null);
  };
  const captureScreen=async()=>{
    try{
      await sleep(250);
      const shot=await connection.send("Page.captureScreenshot",{format:"jpeg",quality:45});
      if(!shot?.data)return null;
      const data=`data:image/jpeg;base64,${shot.data}`;
      return data.length<=800_000?data:null;
    }catch{return null}
  };
  try{
    await primeConnection();
    await waitReady(connection).catch(()=>null);
    await sleep(1500);

    const cookieRes=await connection.send("Network.getAllCookies").catch(()=>({cookies:[]}));
    const cookies=cookieRes.cookies||[];
    const retailerCookies=cookies.filter(c=>String(c.domain||"").replace(/^\./,"").endsWith(host));

    const activeCheck=await evaluate(connection,`(()=>{
      const text=(document.body?.innerText||'');
      const isLogin=/(?:account\\/login|\\/login|\\/signin)/i.test(location.href);
      const hasAccount=Boolean(document.querySelector('a[href*="/account"], div[class*="header"] a[href*="/account"]'))||/(?:my account|supercoins|my orders|order history|logout)/i.test(text);
      const hasLoginBtn=Boolean(document.querySelector('a[href*="/login"], button[class*="login"]'));
      return {url:location.href,hasAccount,isLogin,hasLoginBtn};
    })()`).catch(()=>null);

    const isReady=decideSessionReady({
      url:activeCheck?.url||target.url||url,
      evalOk:Boolean(activeCheck),
      hasAccountContent:Boolean(activeCheck?.hasAccount),
      isLoginUrl:Boolean(activeCheck?.isLogin),
      hasLoginBtn:Boolean(activeCheck?.hasLoginBtn),
      cookieNames:retailerCookies.map(c=>c.name)
    });

    if(isReady){
      return {status:"READY",code:"SESSION_READY",message:"Retailer session is authenticated and ready.",url:activeCheck?.url||url};
    }

    if(verifyOnly){
      const screenshot=await captureScreen();
      return {status:"REAUTH_REQUIRED",code:"LOGIN_REQUIRED",message:"Retailer sign-in is required.",url:activeCheck?.url||url,screenshot};
    }

    const resetFlipkartToStorefront=async()=>{
      await connection.send("Page.navigate",{url:flipkartLoginUrl});
      await sleep(800);
    };

    for(let round=0;round<5;round++){
      await waitReady(connection);
      await sleep(round?400:600);
      if(retailer==="amazon-in"||retailer==="flipkart"){
        const acted=await evaluate(connection,retailerAuthScript(accountCredentials));
        if(acted?.acted){
          if(acted.action==='LOGIN_SURFACE_OPENED'||acted.action==='LOGIN_IDENTIFIER_ENTERED'){
            await sleep(800);
            continue;
          }
          if(acted.action==='OTP_REQUESTED'||acted.challenge==='OTP_REQUIRED'){
            let otpOutcome={outcome:"UNKNOWN",code:"OTP_NOT_SENT",message:"Flipkart has not confirmed that an OTP was sent yet."};
            for(let attempt=0;attempt<8;attempt++){
              await sleep(attempt===0?1200:700);
              const observed=await evaluate(connection,`(()=>{
                const text=(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,12000);
                const otpInputs=[...document.querySelectorAll('input')].filter(el=>{
                  const meta=[el.name,el.id,el.placeholder,el.autocomplete,el.getAttribute('aria-label')].filter(Boolean).join(' ');
                  return /otp|one.?time|verification.?code/i.test(meta);
                });
                const digits=[...document.querySelectorAll('input')].filter(el=>/^[0-9]$/.test(String(el.value||''))||/digit|otp/i.test(String(el.getAttribute('aria-label')||'')));
                const isRateLimited=/(try again later|too many attempts|maximum attempts|unable to send|something went wrong)/i.test(text);
                const isNewUser=/(looks like you're new here|sign up with your)/i.test(text);
                return {text,digitsCount:digits.length,hasOtpInput:otpInputs.length>0,isRateLimited,isNewUser,excerpt:text.slice(0,1200),url:location.href};
              })()`).catch(()=>null);
              if(observed){
                otpOutcome=classifyLoginOutcome(observed);
                if(otpOutcome.outcome!=="UNKNOWN")break;
              }
            }
            const screenshot=await captureScreen();
            if(otpOutcome.outcome==="OTP_SENT"){
              return {status:"REAUTH_REQUIRED",code:"OTP_SENT",message:otpOutcome.message,url:target.url||url,screenshot};
            }
            if(otpOutcome.outcome==="RATE_LIMITED"){
              return {status:"REAUTH_REQUIRED",code:"RATE_LIMITED",message:otpOutcome.message,url:target.url||url,screenshot};
            }
            if(otpOutcome.outcome==="ACCOUNT_NOT_REGISTERED"){
              return {status:"REAUTH_REQUIRED",code:"LOGIN_REQUIRED",message:otpOutcome.message,url:target.url||url,screenshot};
            }
            return {status:"REAUTH_REQUIRED",code:"LOGIN_REQUIRED",message:"Flipkart did not confirm that an OTP was sent. Retry the connection; manual browser fallback is only needed if Flipkart presents an unexpected challenge.",url:target.url||url,screenshot};
          }
          await sleep(600);
          continue;
        }
        if(acted?.challenge){
          const screenshot=await captureScreen();
          return {status:"REAUTH_REQUIRED",code:acted.challenge,message:acted.challenge==="OTP_REQUIRED"?"Retailer OTP is required to finish sign-in.":"Retailer sign-in is required.",url:target.url||url,screenshot};
        }
      }
      const challenge=await evaluate(connection,authChallengeScript());
      if(challenge){
        if(challenge.code==="LOGIN_REQUIRED"&&retailer==="flipkart"&&round<5){
          await resetFlipkartToStorefront();
          continue;
        }
        const screenshot=await captureScreen();
        return {status:"REAUTH_REQUIRED",code:challenge.code,message:challenge.code==="OTP_REQUIRED"?"Flipkart OTP is required to finish sign-in.":"Retailer verification is required in the preserved account session.",url:target.url||url,screenshot};
      }
      const state=await evaluate(connection,`(()=>({url:location.href,text:(document.body?.innerText||'').replace(/\\s+/g,' ').slice(0,5000)}))()`);
      const href=String(state?.url||"");
      if(/\/signin|\/login|\/ap\/signin/i.test(href)){
        if(retailer==="flipkart"&&round<5){
          await resetFlipkartToStorefront();
          continue;
        }
        if(round<4){
          await sleep(1000);
          continue;
        }
        const screenshot=await captureScreen();
        return {status:"REAUTH_REQUIRED",code:"LOGIN_REQUIRED",message:"Retailer sign-in is required.",url:href,screenshot};
      }
      return {status:"READY",code:"SESSION_READY",message:"Retailer session is authenticated and ready.",url:href||url};
    }

    const screenshot=await captureScreen();
    return {status:"REAUTH_REQUIRED",code:"LOGIN_REQUIRED",message:"Retailer sign-in is required.",url:target.url||url,screenshot};
  }catch(error){
    return {status:"ERROR",code:"SESSION_CHECK_ERROR",message:String(error.message).slice(0,300),url};
  }finally{connection.close()}
}
