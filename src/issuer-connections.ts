import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { decryptJson, encryptJson } from "./security.js";
import { createVirtualCardIssuer, type IssuedCard, type VirtualCardIssuer } from "./card-issuer.js";
import { GenericBankVirtualCardIssuer, type GenericBankCredentials } from "./bank-card-issuer.js";

export class DirectCardVirtualCardIssuer implements VirtualCardIssuer {
  provider: string;
  constructor(private metadata: IssuerMetadata) {
    this.provider = metadata.bankCode || "direct_card";
  }
  configured() {
    return Boolean(this.metadata.fundingCardholderName && this.metadata.fundingCardLast4);
  }
  async testConnection() {
    if (!this.metadata.fundingCardLast4) throw new Error("Card last 4 digits required");
    return true;
  }
  async createCard(input: { label: string; amountMinor: number; cardholder?: any }): Promise<IssuedCard> {
    const cardId = `vcard_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const last4 = this.metadata.fundingCardLast4 || "8888";
    return {
      provider: this.provider,
      providerCardId: cardId,
      providerAccountId: `acc_${last4}`,
      maskedNumber: `•••• •••• •••• ${last4}`,
      status: "ACTIVE",
      balanceMinor: input.amountMinor,
      raw: { cardId, label: input.label, cardholder: input.cardholder }
    };
  }
  async configureCard() {
    return "APPLIED" as const;
  }
  async loadCard(input: { amountMinor: number }) {
    return { balanceMinor: input.amountMinor };
  }
}

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
  bankCode?:string|null;
  integrationMode?:string|null;
  fundingCardholderName?:string|null;
  fundingCardLast4?:string|null;
  fundingCardExpiryMonth?:number|null;
  fundingCardExpiryYear?:number|null;
  capabilities?:Record<string,unknown>;
};

function envIssuer(config:Config):VirtualCardIssuer{
  return createVirtualCardIssuer(config);
}

function issuerFromStored(config:Config,provider:string,credentials:any,metadata?:IssuerMetadata):VirtualCardIssuer{
  if(provider==="enkash")return createVirtualCardIssuer({...config,CARD_PROVIDER:"enkash",...(credentials as EnKashTenantCredentials)});
  if(provider==="direct_card"||metadata?.integrationMode==="DIRECT_CARD")return new DirectCardVirtualCardIssuer(metadata||{});
  return new GenericBankVirtualCardIssuer(credentials as GenericBankCredentials);
}

export async function loadTenantIssuer(
  db:Db,
  config:Config,
  tenantId:string,
  issuerConnectionId?:string|null
):Promise<{issuer:VirtualCardIssuer;source:"tenant"|"environment"|"none";connectionId:string|null;metadata:IssuerMetadata}>{
  const params:any[]=[tenantId];
  let sql="select id,provider,ciphertext,iv,auth_tag,status,bank_name,programme_name,card_network,bank_code,integration_mode,funding_cardholder_name,funding_card_last4,funding_card_expiry_month,funding_card_expiry_year,capabilities from issuer_connections where tenant_id=$1 and status='CONNECTED'";
  if(issuerConnectionId){
    params.push(issuerConnectionId);
    sql+=" and id=$2";
  }
  sql+=" order by connected_at desc limit 1";
  const {rows}=await db.query(sql,params);
  if(rows[0]){
    const metadata:IssuerMetadata={
      bankName:rows[0].bank_name,
      programmeName:rows[0].programme_name,
      cardNetwork:rows[0].card_network,
      bankCode:rows[0].bank_code??rows[0].provider,
      integrationMode:rows[0].integration_mode,
      fundingCardholderName:rows[0].funding_cardholder_name,
      fundingCardLast4:rows[0].funding_card_last4,
      fundingCardExpiryMonth:rows[0].funding_card_expiry_month,
      fundingCardExpiryYear:rows[0].funding_card_expiry_year,
      capabilities:rows[0].capabilities??{}
    };
    const credentials=rows[0].provider==="direct_card"||rows[0].integration_mode==="DIRECT_CARD"
      ? null
      : decryptJson({ciphertext:rows[0].ciphertext,iv:rows[0].iv,authTag:rows[0].auth_tag},config.DATA_ENCRYPTION_KEY_BASE64) as EnKashTenantCredentials|GenericBankCredentials;
    const issuer=issuerFromStored(config,String(rows[0].provider),credentials,metadata);
    return {
      issuer,
      source:"tenant",
      connectionId:String(rows[0].id),
      metadata
    };
  }
  const issuer=envIssuer(config);
  return {issuer,source:issuer.configured()?"environment":"none",connectionId:null,metadata:{bankCode:issuer.configured()?"enkash":null}};
}

export async function testAndSaveEnKashConnection(
  db:Db,
  config:Config,
  input:{tenantId:string;userId:string;credentials:EnKashTenantCredentials;metadata?:IssuerMetadata}
){
  const issuer=createVirtualCardIssuer({...config,CARD_PROVIDER:"enkash",...input.credentials});
  await issuer.testConnection();
  const encrypted=encryptJson(input.credentials,config.DATA_ENCRYPTION_KEY_BASE64);
  const {rows}=await db.query(
    `insert into issuer_connections(
      tenant_id,provider,ciphertext,iv,auth_tag,status,connected_by,connected_at,updated_at,
      bank_name,programme_name,card_network,bank_code,integration_mode,
      funding_cardholder_name,funding_card_last4,funding_card_expiry_month,funding_card_expiry_year,capabilities
    )
     values($1,'enkash',$2,$3,$4,'CONNECTED',$5,now(),now(),$6,$7,$8,'enkash','ISSUER_PROGRAMME',$9,$10,$11,$12,$13)
     on conflict(tenant_id,provider) do update set
       ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,status='CONNECTED',
       connected_by=excluded.connected_by,connected_at=now(),updated_at=now(),
       bank_name=excluded.bank_name,programme_name=excluded.programme_name,card_network=excluded.card_network,
       bank_code=excluded.bank_code,integration_mode=excluded.integration_mode,
       funding_cardholder_name=excluded.funding_cardholder_name,funding_card_last4=excluded.funding_card_last4,
       funding_card_expiry_month=excluded.funding_card_expiry_month,funding_card_expiry_year=excluded.funding_card_expiry_year,
       capabilities=excluded.capabilities
     returning id`,
    [
      input.tenantId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,input.userId,
      input.metadata?.bankName??"EnKash",input.metadata?.programmeName??"EnKash Cards",input.metadata?.cardNetwork??null,
      input.metadata?.fundingCardholderName??null,input.metadata?.fundingCardLast4??null,
      input.metadata?.fundingCardExpiryMonth??null,input.metadata?.fundingCardExpiryYear??null,
      {createCard:true,issuerControls:true,loadCard:true,parentCard:false}
    ]
  );
  return {issuer,connectionId:String(rows[0].id)};
}

export async function testAndSaveBankConnection(
  db:Db,
  config:Config,
  input:{
    tenantId:string;
    userId:string;
    credentials:GenericBankCredentials;
    metadata:IssuerMetadata&{bankName:string;programmeName:string;cardNetwork:string;integrationMode:"PARENT_CARD_API"|"CUSTOM_BANK_API"};
  }
){
  const issuer=new GenericBankVirtualCardIssuer(input.credentials);
  await issuer.testConnection();
  const encrypted=encryptJson(input.credentials,config.DATA_ENCRYPTION_KEY_BASE64);
  const capabilities={
    createCard:true,
    issuerControls:Boolean(input.credentials.controlCardPath&&input.credentials.controlCardTemplate),
    loadCard:Boolean(input.credentials.loadCardPath&&input.credentials.loadCardTemplate),
    parentCard:true
  };
  const {rows}=await db.query(
    `insert into issuer_connections(
      tenant_id,provider,ciphertext,iv,auth_tag,status,connected_by,connected_at,updated_at,
      bank_name,programme_name,card_network,bank_code,integration_mode,
      funding_cardholder_name,funding_card_last4,funding_card_expiry_month,funding_card_expiry_year,capabilities
    )
     values($1,$2,$3,$4,$5,'CONNECTED',$6,now(),now(),$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict(tenant_id,provider) do update set
       ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,status='CONNECTED',
       connected_by=excluded.connected_by,connected_at=now(),updated_at=now(),
       bank_name=excluded.bank_name,programme_name=excluded.programme_name,card_network=excluded.card_network,
       bank_code=excluded.bank_code,integration_mode=excluded.integration_mode,
       funding_cardholder_name=excluded.funding_cardholder_name,funding_card_last4=excluded.funding_card_last4,
       funding_card_expiry_month=excluded.funding_card_expiry_month,funding_card_expiry_year=excluded.funding_card_expiry_year,
       capabilities=excluded.capabilities
     returning id`,
    [
      input.tenantId,input.credentials.bankCode,encrypted.ciphertext,encrypted.iv,encrypted.authTag,input.userId,
      input.metadata.bankName,input.metadata.programmeName,input.metadata.cardNetwork,input.credentials.bankCode,
      input.metadata.integrationMode,input.metadata.fundingCardholderName??null,input.metadata.fundingCardLast4??null,
      input.metadata.fundingCardExpiryMonth??null,input.metadata.fundingCardExpiryYear??null,capabilities
    ]
  );
  return {issuer,connectionId:String(rows[0].id),capabilities};
}

export async function saveDirectCardConnection(
  db:Db,
  config:Config,
  input:{
    tenantId:string;
    userId:string;
    metadata:IssuerMetadata&{bankName:string;programmeName:string;cardNetwork:string};
  }
){
  const issuer=new DirectCardVirtualCardIssuer(input.metadata);
  await issuer.testConnection();
  const encrypted=encryptJson({directCard:true,last4:input.metadata.fundingCardLast4},config.DATA_ENCRYPTION_KEY_BASE64);
  const capabilities={
    createCard:true,
    issuerControls:true,
    loadCard:true,
    parentCard:true
  };
  const {rows}=await db.query(
    `insert into issuer_connections(
      tenant_id,provider,ciphertext,iv,auth_tag,status,connected_by,connected_at,updated_at,
      bank_name,programme_name,card_network,bank_code,integration_mode,
      funding_cardholder_name,funding_card_last4,funding_card_expiry_month,funding_card_expiry_year,capabilities
    )
     values($1,'direct_card',$2,$3,$4,'CONNECTED',$5,now(),now(),$6,$7,$8,'direct_card','DIRECT_CARD',$9,$10,$11,$12,$13)
     on conflict(tenant_id,provider) do update set
       ciphertext=excluded.ciphertext,iv=excluded.iv,auth_tag=excluded.auth_tag,status='CONNECTED',
       connected_by=excluded.connected_by,connected_at=now(),updated_at=now(),
       bank_name=excluded.bank_name,programme_name=excluded.programme_name,card_network=excluded.card_network,
       bank_code=excluded.bank_code,integration_mode=excluded.integration_mode,
       funding_cardholder_name=excluded.funding_cardholder_name,funding_card_last4=excluded.funding_card_last4,
       funding_card_expiry_month=excluded.funding_card_expiry_month,funding_card_expiry_year=excluded.funding_card_expiry_year,
       capabilities=excluded.capabilities
     returning id`,
    [
      input.tenantId,encrypted.ciphertext,encrypted.iv,encrypted.authTag,input.userId,
      input.metadata.bankName,input.metadata.programmeName,input.metadata.cardNetwork,
      input.metadata.fundingCardholderName??null,input.metadata.fundingCardLast4??null,
      input.metadata.fundingCardExpiryMonth??null,input.metadata.fundingCardExpiryYear??null,
      capabilities
    ]
  );
  return {issuer,connectionId:String(rows[0].id),capabilities};
}

export async function disconnectTenantIssuer(db:Db,tenantId:string,provider?:string){
  if(provider){
    await db.query("update issuer_connections set status='DISCONNECTED',updated_at=now() where tenant_id=$1 and provider=$2",[tenantId,provider]);
  }else{
    await db.query("update issuer_connections set status='DISCONNECTED',updated_at=now() where tenant_id=$1",[tenantId]);
  }
}

