import type { Config } from "./config.js";

export type CardholderInput={
  email:string;
  mobile:string;
  firstName:string;
  lastName:string;
  gender:"M"|"F"|"O";
  pan:string;
  specialDate:string;
};

export type IssuedCard={
  provider:"enkash";
  providerCardId:string;
  providerAccountId:string;
  maskedNumber?:string;
  status:string;
  balanceMinor:number;
};

export interface VirtualCardIssuer {
  provider:string;
  configured():boolean;
  testConnection():Promise<void>;
  createCard(input:{cardholder:CardholderInput;label?:string}):Promise<IssuedCard>;
  loadCard(input:{providerCardId:string;providerAccountId:string;amountMinor:number;reference:string}):Promise<void>;
}

export class DisabledVirtualCardIssuer implements VirtualCardIssuer {
  provider="disabled";
  configured(){return false}
  async testConnection(){throw new Error("card_issuer_not_connected")}
  async createCard():Promise<IssuedCard>{throw new Error("card_issuer_not_connected")}
  async loadCard():Promise<void>{throw new Error("card_issuer_not_connected")}
}

type TokenCache={value:string;expiresAt:number}|null;

export class EnKashVirtualCardIssuer implements VirtualCardIssuer {
  provider="enkash";
  private token:TokenCache=null;
  constructor(private config:Config){}
  configured(){
    return Boolean(this.config.ENKASH_BASE_URL&&this.config.ENKASH_TOKEN_URL&&this.config.ENKASH_PARTNER_ID&&this.config.ENKASH_BASIC_AUTH&&this.config.ENKASH_USERNAME&&this.config.ENKASH_PASSWORD&&this.config.ENKASH_CLIENT_ID&&this.config.ENKASH_COMPANY_ID&&this.config.ENKASH_CARD_ACCOUNT_ID);
  }
  async testConnection(){await this.accessToken()}
  private async accessToken(){
    if(this.token&&this.token.expiresAt>Date.now()+60_000)return this.token.value;
    if(!this.config.ENKASH_TOKEN_URL)throw new Error("enkash_token_url_missing");
    const body=new URLSearchParams({
      username:this.config.ENKASH_USERNAME!,
      password:this.config.ENKASH_PASSWORD!,
      grant_type:"password",
      clientId:this.config.ENKASH_CLIENT_ID!
    });
    const response=await fetch(this.config.ENKASH_TOKEN_URL,{
      method:"POST",
      headers:{authorization:`Basic ${this.config.ENKASH_BASIC_AUTH}`,"content-type":"application/x-www-form-urlencoded"},
      body
    });
    const json:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`enkash_auth_failed_${response.status}`);
    const value=json.access_token??json.accessToken??json.token??json.payload?.access_token??json.payload?.accessToken;
    if(!value)throw new Error("enkash_auth_token_missing");
    const expires=Number(json.expires_in??json.expiresIn??3600);
    this.token={value:String(value),expiresAt:Date.now()+Math.max(300,expires)*1000};
    return this.token.value;
  }
  private async request(path:string,body:object){
    if(!this.config.ENKASH_BASE_URL||!this.config.ENKASH_PARTNER_ID)throw new Error("enkash_not_configured");
    const token=await this.accessToken();
    const response=await fetch(new URL(path,this.config.ENKASH_BASE_URL),{
      method:"POST",
      headers:{authorization:`Bearer ${token}`,partnerId:this.config.ENKASH_PARTNER_ID,"content-type":"application/json"},
      body:JSON.stringify(body)
    });
    const json:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`enkash_request_failed_${response.status}`);
    if(json.code!==undefined&&Number(json.code)!==0)throw new Error(String(json.message||"enkash_card_request_failed").slice(0,180));
    if(json.response_code!==undefined&&Number(json.response_code)!==0)throw new Error(String(json.response_message||"enkash_card_request_failed").slice(0,180));
    return json.payload??json;
  }
  async createCard(input:{cardholder:CardholderInput;label?:string}):Promise<IssuedCard>{
    const c=input.cardholder;
    const payload:any=await this.request("/api/v0/partner/enKashCard",{
      companyId:this.config.ENKASH_COMPANY_ID,
      cardAccountId:this.config.ENKASH_CARD_ACCOUNT_ID,
      email:c.email,
      mobile:c.mobile,
      title:"Mr",
      firstName:c.firstName,
      lastName:c.lastName,
      gender:c.gender,
      primaryEnKashCard:false,
      physicalCard:false,
      remarks:input.label||"OrderGrid virtual procurement card",
      physicalDeliveryAddressFlag:false,
      documents:[{docType:"PAN",docNo:c.pan}],
      specialDate:c.specialDate
    });
    const providerCardId=payload.enKashCardId;
    const providerAccountId=payload.cardAccountId??this.config.ENKASH_CARD_ACCOUNT_ID;
    if(!providerCardId||!providerAccountId)throw new Error("enkash_card_id_missing");
    const rawMasked=payload.maskedNumber??payload.maskedCardNumber;
    const maskedNumber=rawMasked?String(rawMasked):undefined;
    return{provider:"enkash",providerCardId:String(providerCardId),providerAccountId:String(providerAccountId),maskedNumber,status:String(payload.cardStatus?.label??payload.cardStatus?.name??"ACTIVE"),balanceMinor:Math.round(Number(payload.otbBalance??0)*100)};
  }
  async loadCard(input:{providerCardId:string;providerAccountId:string;amountMinor:number;reference:string}){
    await this.request("/api/v0/partner/enKashCard/balance",{
      companyId:this.config.ENKASH_COMPANY_ID,
      cardAccountId:input.providerAccountId,
      createdBy:"OrderGrid",
      amount:(input.amountMinor/100).toFixed(2),
      uniqueReferenceNumber:input.reference,
      remarks:"OrderGrid card allocation",
      enKashCardId:input.providerCardId
    });
  }
}

export function createVirtualCardIssuer(config:Config):VirtualCardIssuer{
  if(config.CARD_PROVIDER==="enkash")return new EnKashVirtualCardIssuer(config);
  return new DisabledVirtualCardIssuer();
}
