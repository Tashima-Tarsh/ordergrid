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

export type IssuerMetadata={
  bankName?:string|null;
  programmeName?:string|null;
  cardNetwork?:string|null;
};

function envIssuer(config:Config):VirtualCardIssuer{
  return createVirtualCardIssuer(config);
}

function tenantIssuer(config:Config,credentials:EnKashTenantCredentials):VirtualCardIssuer{
  return createVirtualCardIssuer({...config,CARD_PROVIDER:"enkash",...credentials});
}

export async function loadTenantIssuer(
  db:Db,
  config:Config,
  tenantId:string,
  issuerConnectionId?:string|null
):Promise<{issuer:VirtualCardIssuer;source:"tenant"|"environment"|"none";connectionId:string|null;metadata:IssuerMetadata}>{
  const params:any[]=[tenantId];
  let sql="select id,provider,ciphertext,iv,auth_tag,status,bank_name,programme_name,card_network from issuer_connections where tenant_id=$1 and provider='enkash' and status='CONNECTED'";
  if(issuerConnectionId){
    params.push(issuerConnectionId);
    sql+=" and id=$2";
  }
  sql+=" order by connected_at desc limit 1";
  const {rows}=await db.query(sql,params);
  if(rows[0]){
    const credentials=decryptJson({ciphertext:rows[0].ciphertext,iv:rows[0].iv,authTag:rows[0].auth_tag},config.DATA_ENCRYPTION_KEY_BASE64) as EnKashTenantCredentials;
    const issuer=tenantIssuer(config,credentials);
    return {
      issuer,
      source:"tenant",
      connectionId:String(rows[0].id),
      metadata:{bankName:rows[0].bank_name,programmeName:rows[0].programme_name,cardNetwork:rows[0].card_network}
    };
  }
  const issuer=envIssuer(config);
  return {issuer,source:issuer.configured()?"environment":"none",connectionId:null,metadata:{}};
}

export async function testAndSaveEnKashConnection(
  db:Db,
  config:Config,
  input:{tenantId:string;userId:string;credentials:EnKashTenantCredentials;metadata?:IssuerMetadata}
){
  const issuer=tenantIssuer(config,input.credentials);
  await issuer.testConnection();
  const encrypted=encryptJson(input.credentials,config.DATA_ENCRYPTION_KEY_BASE64);
  const {rows}=await db.query(
    `insert into issuer_connections(
      tenant_id,provider,ciphertext,iv,auth_tag,status,connected_by,connected_at,updated_at,
      bank_name,programme_name,card_network
    )
     values($1,'enkash',$2,$3,$4,'CONNECTED',$5,now(),now(),$6,$7,$8)
     on conflict(tenant_id,provider) do update set
       ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,status='CONNECTED',
       connected_by=excluded.connected_by,connected_at=now(),updated_at=now(),
       bank_name=excluded.bank_name,programme_name=excluded.programme_name,card_network=excluded.card_network
     returning id`,
    [
      input.tenantId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,input.userId,
      input.metadata?.bankName??null,input.metadata?.programmeName??null,input.metadata?.cardNetwork??null
    ]
  );
  return {issuer,connectionId:String(rows[0].id)};
}

export async function disconnectTenantIssuer(db:Db,tenantId:string,provider="enkash"){
  await db.query("update issuer_connections set status='DISCONNECTED',updated_at=now() where tenant_id=$1 and provider=$2",[tenantId,provider]);
}
