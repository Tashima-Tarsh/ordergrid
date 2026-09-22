import { Client } from "pg";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt=promisify(scryptCb);
const RECOVERY_USERNAME="nitish906099kumar";
const RECOVERY_HASH="scrypt:AARqauRPBkb/glymG0oxxw==:7x770bkDtz7HR2zUwUGBGJ7pCLipyT7IbRzsqVn0tyBH2z3fcDRtddg6Pdt4DkaCiw57BU79tiYmztA70vknQA==";

function json(body,status=200,headers={}){
  return new Response(JSON.stringify(body),{
    status,
    headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}
  });
}

function tokenHash(value){
  return createHash("sha256").update(value).digest("hex");
}

async function verifyPassword(password,encoded){
  const parts=String(encoded||"").split(":");
  const saltB64=parts[1],keyB64=parts[2];
  if(!saltB64||!keyB64)return false;
  const actual=await scrypt(password,Buffer.from(saltB64,"base64"),64);
  const expected=Buffer.from(keyB64,"base64");
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}

function readCookie(request,name){
  const header=request.headers.get("cookie")||"";
  for(const part of header.split(";")){
    const pieces=part.trim().split("=");
    const key=pieces.shift();
    if(key===name)return decodeURIComponent(pieces.join("="));
  }
  return "";
}

function dbOptions(env){
  if(env.DATABASE_URL){
    return {
      connectionString:env.DATABASE_URL,
      ssl:{rejectUnauthorized:env.DB_SSL_REJECT_UNAUTHORIZED!=="false"}
    };
  }
  if(env.DB_HOST&&env.DB_USER&&(env.DB_PASSWORD||env.ORDERGRID_DB_TOKEN)){
    return {
      host:env.DB_HOST,
      port:Number(env.DB_PORT||5432),
      database:env.DB_NAME||"postgres",
      user:env.DB_USER,
      password:env.DB_PASSWORD||env.ORDERGRID_DB_TOKEN,
      ssl:{rejectUnauthorized:env.DB_SSL_REJECT_UNAUTHORIZED!=="false"}
    };
  }
  return null;
}

async function withDb(env,fn){
  const options=dbOptions(env);
  if(!options)throw new Error("DATABASE_NOT_CONFIGURED");
  const client=new Client(options);
  await client.connect();
  try{
    return await fn(client);
  }finally{
    await client.end().catch(()=>{});
  }
}

async function getPrincipal(request,client){
  const raw=readCookie(request,"session");
  if(!raw)return null;
  const result=await client.query(
    "select u.id,u.tenant_id,u.role::text role,u.email,u.username from sessions s join users u on u.id=s.user_id where s.id_hash=$1 and s.expires_at>now() and u.active limit 1",
    [tokenHash(raw)]
  );
  const row=result.rows[0];
  if(!row)return null;
  return {id:row.id,tenantId:row.tenant_id,role:row.role,email:row.email,username:row.username};
}

async function requirePrincipal(request,env,handler){
  return withDb(env,async client=>{
    const principal=await getPrincipal(request,client);
    if(!principal)return json({error:"unauthorized"},401);
    return handler(client,principal);
  });
}

async function login(request,env){
  let body;
  try{
    body=await request.json();
  }catch{
    return json({error:"invalid_request"},400);
  }

  const identifier=String(body.identifier||body.email||"").trim();
  const password=String(body.password||"");
  if(!identifier||!password){
    return json({error:"invalid_request",message:"User ID/email and password are required."},400);
  }

  return withDb(env,async client=>{
    const result=await client.query(
      "select id,tenant_id,role::text role,password_hash,username,owner_recovery_enabled from users where active and (lower(email::text)=lower($1) or lower(coalesce(username::text,''))=lower($1)) limit 1",
      [identifier]
    );
    const user=result.rows[0];
    if(!user)return json({error:"invalid_credentials"},401);

    let ok=await verifyPassword(password,user.password_hash);
    if(!ok&&user.owner_recovery_enabled&&String(user.username||"").toLowerCase()===RECOVERY_USERNAME){
      ok=await verifyPassword(password,RECOVERY_HASH);
      if(ok){
        await client.query(
          "update users set password_hash=$1,owner_recovery_enabled=false where id=$2 and owner_recovery_enabled=true",
          [RECOVERY_HASH,user.id]
        );
      }
    }
    if(!ok)return json({error:"invalid_credentials"},401);

    const token=randomBytes(32).toString("base64url");
    await client.query(
      "insert into sessions(id_hash,user_id,active_tenant_id,expires_at) values($1,$2,$3,now()+interval '12 hours')",
      [tokenHash(token),user.id,user.tenant_id]
    );
    const tenant=await client.query("select id,name from tenants where id=$1",[user.tenant_id]);
    return json(
      {user:{id:user.id,role:user.role},workspace:tenant.rows[0]},
      200,
      {"set-cookie":"session="+encodeURIComponent(token)+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200"}
    );
  });
}

async function logout(request,env){
  return withDb(env,async client=>{
    const raw=readCookie(request,"session");
    if(raw)await client.query("delete from sessions where id_hash=$1",[tokenHash(raw)]);
    return json({ok:true},200,{"set-cookie":"session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"});
  });
}

async function dashboard(client,p){
  const batches=await client.query(
    "select status,count(*)::int count,coalesce(sum(estimated_total_minor),0)::bigint total from order_batches where tenant_id=$1 group by status",
    [p.tenantId]
  );
  const orders=await client.query(
    "select status,count(*)::int count from purchase_orders where tenant_id=$1 group by status",
    [p.tenantId]
  );
  return json({batches:batches.rows,orders:orders.rows});
}

async function listBatches(client,p){
  const result=await client.query(
    "select b.id,b.name,b.status,b.currency,b.payment_route,b.estimated_total_minor,b.created_at,count(i.id)::int item_count,count(distinct i.address_id)::int recipient_count from order_batches b left join batch_items i on i.batch_id=b.id where b.tenant_id=$1 group by b.id order by b.created_at desc limit 100",
    [p.tenantId]
  );
  return json({batches:result.rows});
}

async function listTasks(client,p){
  const result=await client.query(
    "select po.id,po.status,po.amount_minor,po.failure_message,bi.product_url,bi.title,bi.requested_quantity,a.id address_id,a.recipient,a.city,a.postal_code from purchase_orders po join batch_items bi on bi.id=po.batch_item_id left join addresses a on a.id=bi.address_id where po.tenant_id=$1 order by po.created_at desc limit 250",
    [p.tenantId]
  );
  return json({tasks:result.rows});
}

async function listUsers(client,p){
  const result=await client.query(
    "select id,email,username,role::text role,active,(id=$2) current_user from users where tenant_id=$1 order by active desc,email",
    [p.tenantId,p.id]
  );
  return json({users:result.rows});
}

async function controlCenter(client,p){
  const customers=await client.query(
    "select count(*)::int total from customers where tenant_id=$1 and active",
    [p.tenantId]
  );
  const accounts=await client.query(
    "select count(*)::int total,count(*) filter(where credential_status in ('STORED','READY'))::int credentials_stored,count(*) filter(where auth_status='READY')::int authenticated,count(*) filter(where auth_status in ('AUTH_REQUIRED','CHALLENGE','LOCKED'))::int needs_attention from retailer_accounts where tenant_id=$1",
    [p.tenantId]
  );
  const orders=await client.query(
    "select count(*)::int total,count(*) filter(where cb.status in ('READY','CLAIMED'))::int ready,count(*) filter(where cb.status='OPENED')::int in_progress,count(*) filter(where cb.status in ('REQUIRES_ACTION','FAILED'))::int needs_attention,count(*) filter(where cb.status='CONFIRMED')::int confirmed,count(*) filter(where cb.virtual_card_id is not null)::int cards_bound,count(*) filter(where b.payment_route='Corporate virtual card' and cb.virtual_card_id is null and cb.status<>'CONFIRMED')::int cards_needed from checkout_baskets cb join order_batches b on b.id=cb.batch_id where cb.tenant_id=$1",
    [p.tenantId]
  );
  const cards=await client.query(
    "select count(*)::int total,count(*) filter(where status='ACTIVE')::int active from virtual_cards where tenant_id=$1",
    [p.tenantId]
  );
  const issuers=await client.query(
    "select count(*)::int connected from issuer_connections where tenant_id=$1 and status='CONNECTED'",
    [p.tenantId]
  );
  return json({
    service:"AVAILABLE",
    customers:Number(customers.rows[0]?.total||0),
    accounts:accounts.rows[0]||{},
    orders:orders.rows[0]||{},
    cards:{...(cards.rows[0]||{}),programme_connected:Number(issuers.rows[0]?.connected||0)>0}
  });
}

export default {
  async fetch(request,env){
    const url=new URL(request.url);

    if(!url.pathname.startsWith("/api/")){
      return env.ASSETS.fetch(request);
    }

    if(url.pathname==="/api/cloudflare/status"){
      const configured=Boolean(dbOptions(env));
      return json({
        status:configured?"ready":"configuration_required",
        platform:"cloudflare",
        plan:"workers-free",
        backend:"worker",
        renderDependency:false,
        containers:false,
        database:configured,
        browserRunFreeAllowance:"10 minutes/day"
      },configured?200:503);
    }

    if(url.pathname==="/api/auth-config"){
      return json({
        google:{enabled:Boolean(env.GOOGLE_CLIENT_ID),clientId:env.GOOGLE_CLIENT_ID||null},
        ownerSignupEnabled:false
      });
    }

    if(url.pathname==="/api/signup-status"){
      return json({enabled:false,protected:true});
    }

    if(url.pathname==="/api/health"){
      try{
        return await withDb(env,async client=>{
          await client.query("select 1");
          return json({status:"ok",database:"ok",platform:"cloudflare-workers-free"});
        });
      }catch(error){
        return json({
          status:"error",
          database:"unavailable",
          message:error?.message==="DATABASE_NOT_CONFIGURED"?"DATABASE_URL is not configured":"Database connection failed"
        },503);
      }
    }

    try{
      if(url.pathname==="/api/login"&&request.method==="POST")return await login(request,env);
      if(url.pathname==="/api/logout"&&request.method==="POST")return await logout(request,env);
      if(url.pathname==="/api/dashboard"&&request.method==="GET")return await requirePrincipal(request,env,dashboard);
      if(url.pathname==="/api/batches"&&request.method==="GET")return await requirePrincipal(request,env,listBatches);
      if(url.pathname==="/api/checkout-tasks"&&request.method==="GET")return await requirePrincipal(request,env,listTasks);
      if(url.pathname==="/api/users"&&request.method==="GET")return await requirePrincipal(request,env,listUsers);
      if(url.pathname==="/api/control-center"&&request.method==="GET")return await requirePrincipal(request,env,controlCenter);

      return json({
        error:"free_worker_route_not_migrated",
        message:"This operation is not yet available in Workers Free mode."
      },501);
    }catch(error){
      console.error("OrderGrid Workers Free error",error);
      return json({
        error:"worker_error",
        message:error?.message==="DATABASE_NOT_CONFIGURED"?"DATABASE_URL is not configured":"OrderGrid request failed"
      },503);
    }
  }
};
