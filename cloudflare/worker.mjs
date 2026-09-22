import { DurableObject } from "cloudflare:workers";

const BACKEND_NAME="ordergrid-primary";
const BACKEND_PORT=8080;

const forwardedKeys=[
  "DATABASE_URL","DB_HOST","DB_PORT","DB_NAME","DB_USER","DB_PASSWORD","ORDERGRID_DB_TOKEN",
  "REDIS_URL","DATA_ENCRYPTION_KEY_BASE64","GOOGLE_CLIENT_ID","ORDERGRID_SIGNUP_CODE",
  "SHOPIFY_STOREFRONT_TOKEN","CARD_PROVIDER","CARD_PROVIDER_API_KEY","CARD_PROVIDER_WEBHOOK_SECRET",
  "ENKASH_BASE_URL","ENKASH_TOKEN_URL","ENKASH_PARTNER_ID","ENKASH_BASIC_AUTH","ENKASH_USERNAME",
  "ENKASH_PASSWORD","ENKASH_CLIENT_ID","ENKASH_COMPANY_ID","ENKASH_CARD_ACCOUNT_ID",
  "CARDHOLDER_EMAIL","CARDHOLDER_MOBILE","CARDHOLDER_FIRST_NAME","CARDHOLDER_LAST_NAME",
  "CARDHOLDER_GENDER","CARDHOLDER_PAN","CARDHOLDER_SPECIAL_DATE"
];

function databaseConfigured(env){
  if(typeof env.DATABASE_URL==="string"&&env.DATABASE_URL.length)return true;
  return Boolean(
    env.DB_HOST&&env.DB_USER&&(env.DB_PASSWORD||env.ORDERGRID_DB_TOKEN)
  );
}

function missingRequired(env){
  const missing=[];
  if(!databaseConfigured(env))missing.push("DATABASE_URL (or DB_HOST/DB_USER/DB_PASSWORD)");
  if(!env.DATA_ENCRYPTION_KEY_BASE64)missing.push("DATA_ENCRYPTION_KEY_BASE64");
  return missing;
}

function backendEnv(env){
  const result={
    NODE_ENV:"production",
    PORT:String(BACKEND_PORT),
    APP_ORIGIN:env.APP_ORIGIN||"https://ordergrid.nkumar906099.workers.dev",
    DB_POOL_MAX:"5",
    DB_SSL_REJECT_UNAUTHORIZED:"true",
    BOOTSTRAP_ADMIN_EMAIL:env.BOOTSTRAP_ADMIN_EMAIL||"owner@ordergrid.in",
    ORDERGRID_CLOUDFLARE_CONTAINER:"true",
    ORDERGRID_MANAGED_EXECUTION:"true",
    ORDERGRID_MANAGED_PARALLEL:"1",
    ORDERGRID_SESSION_CLAIM:"1",
    ORDERGRID_MANAGED_BASKETS:"10",
    ORDERGRID_CHROME_PATH:"/usr/bin/chromium",
    CARD_PROVIDER:env.CARD_PROVIDER||"disabled"
  };
  for(const key of forwardedKeys){
    const value=env[key];
    if(typeof value==="string"&&value.length)result[key]=value;
  }
  return result;
}

export class OrderGridBackend extends DurableObject{
  constructor(ctx,env){
    super(ctx,env);
    this.env=env;
    this.starting=null;
  }

  async readyPort(){
    const container=this.ctx.container;
    await container.setInactivityTimeout(10*60*1000);
    if(container.running)return container.getTcpPort(BACKEND_PORT);
    if(!this.starting){
      this.starting=(async()=>{
        container.start({enableInternet:true,env:backendEnv(this.env)});
        const port=container.getTcpPort(BACKEND_PORT);
        let lastError;
        for(let attempt=0;attempt<120;attempt++){
          try{
            const response=await port.fetch("http://container/api/health",{headers:{accept:"application/json"}});
            if(response.ok)return port;
            lastError=new Error(`OrderGrid backend health returned ${response.status}`);
          }catch(error){lastError=error}
          await scheduler.wait(250);
        }
        throw lastError||new Error("OrderGrid Cloudflare Container did not become ready");
      })().finally(()=>{this.starting=null});
    }
    return this.starting;
  }

  async fetch(request){
    const port=await this.readyPort();
    return port.fetch(request);
  }

  async warm(){
    const port=await this.readyPort();
    const response=await port.fetch("http://container/api/health",{headers:{accept:"application/json"}});
    if(!response.ok)throw new Error(`OrderGrid container health returned ${response.status}`);
    return {ok:true};
  }
}

function configurationResponse(env){
  const missing=missingRequired(env);
  return Response.json({
    status:missing.length?"configuration_required":"ready",
    platform:"cloudflare",
    backend:"cloudflare-container",
    renderDependency:false,
    browserExecution:"managed-chromium-in-container",
    instanceType:"standard-1",
    missingRequired:missing
  },{
    status:missing.length?503:200,
    headers:{"cache-control":"no-store"}
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==="/api/cloudflare/status")return configurationResponse(env);

    if(url.pathname==="/api"||url.pathname.startsWith("/api/")){
      const missing=missingRequired(env);
      if(missing.length){
        return Response.json({
          error:"cloudflare_configuration_incomplete",
          message:"Cloudflare Container is missing required runtime secrets.",
          missingRequired:missing
        },{status:503,headers:{"cache-control":"no-store"}});
      }
      try{
        return await env.BACKEND.getByName(BACKEND_NAME).fetch(request);
      }catch(error){
        console.error("OrderGrid Cloudflare Container request failed",error);
        return Response.json(
          {error:"cloudflare_container_unavailable",message:"OrderGrid Cloudflare backend is starting or unavailable."},
          {status:503,headers:{"cache-control":"no-store"}}
        );
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller,env){
    if(missingRequired(env).length)return;
    try{await env.BACKEND.getByName(BACKEND_NAME).warm()}
    catch(error){console.error("OrderGrid Cloudflare Container keepalive failed",error)}
  }
};
