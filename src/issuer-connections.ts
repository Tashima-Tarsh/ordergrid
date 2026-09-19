import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { decryptJson, encryptJson } from "./security.js";
import { createVirtualCardIssuer, type VirtualCardIssuer } from "./card-issuer.js";

export type EnKashTenantCredentials={
  ENKASH_BASE_URL:string;
  ENKASH_TOKEN_URL:string;
  ENKASH_PARTNER_ID:string;
  ENKASH_BASIC_AUTH:string;
  ENKASH_USERNAME:string;
  ENKASH_PASSWORD:string;
  ENKASH_CLIENT_ID:string;
  ENKASH_COMPANY_ID:string;
  ENKASH_CARD_ACCOUNT_ID:string;
};

function envIssuer(config:Config):VirtualCardIssuer{
  return createVirtualCardIssuer(config);
}

function tenantIssuer(config:Config,credentials:EnKashTenantCredentials):VirtualCardIssuer{
  return createVirtualCardIssuer({...config,CARD_PROVIDER:"enkash",...credentials});
}

export async function loadTenantIssuer(db:Db,config:Config,tenantId:string):Promise<{issuer:VirtualCardIssuer;source:"tenant"|"environment"|"none"}>{
  const {rows}=await db.query("select provider,ciphertext,iv,auth_tag,status from issuer_connections where tenant_id=$1 and status='CONNECTED'",[tenantId]);
  if(rows[0]){
    const credentials=decryptJson({ciphertext:rows[0].ciphertext,iv:rows[0].iv,authTag:rows[0].auth_tag},config.DATA_ENCRYPTION_KEY_BASE64) as EnKashTenantCredentials;
    const issuer=tenantIssuer(config,credentials);
    return {issuer,source:"tenant"};
  }
  const issuer=envIssuer(config);
  return {issuer,source:issuer.configured()?"environment":"none"};
}

export async function testAndSaveEnKashConnection(db:Db,config:Config,input:{tenantId:string;userId:string;credentials:EnKashTenantCredentials}){
  const issuer=tenantIssuer(config,input.credentials);
  await issuer.testConnection();
  const encrypted=encryptJson(input.credentials,config.DATA_ENCRYPTION_KEY_BASE64);
  await db.query(
    `insert into issuer_connections(tenant_id,provider,ciphertext,iv,auth_tag,status,connected_by,connected_at,updated_at)
     values($1,'enkash',$2,$3,$4,'CONNECTED',$5,now(),now())
     on conflict(tenant_id) do update set provider='enkash',ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,status='CONNECTED',connected_by=excluded.connected_by,connected_at=now(),updated_at=now()`,
    [input.tenantId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,input.userId]
  );
  return issuer;
}

export async function disconnectTenantIssuer(db:Db,tenantId:string){
  await db.query("update issuer_connections set status='DISCONNECTED',updated_at=now() where tenant_id=$1",[tenantId]);
}
