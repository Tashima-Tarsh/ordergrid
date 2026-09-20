import type { CardholderInput, IssuedCard, VirtualCardIssuer } from "./card-issuer.js";

export const BANK_VIRTUAL_CARD_PROFILES=[
  {code:"hdfc",name:"HDFC Bank",mode:"PARENT_CARD_API",publicApi:true,product:"Credit Card Virtual Card Creation",notes:"Public developer product; production endpoint and credentials require HDFC approval."},
  {code:"axis",name:"Axis Bank",mode:"PARENT_CARD_API",publicApi:true,product:"Purchase Control Virtual Card",notes:"Axis documents ERP/API virtual card generation; production API contract is supplied during corporate onboarding."},
  {code:"icici",name:"ICICI Bank",mode:"CUSTOM_BANK_API",publicApi:true,product:"Corporate API / Cards",notes:"ICICI exposes corporate and card APIs; the exact virtual-card contract depends on approved product access."},
  {code:"sbi",name:"State Bank of India",mode:"CUSTOM_BANK_API",publicApi:false,product:"Corporate Cards",notes:"Use the bank-provided corporate virtual-card API contract when enabled for your programme."},
  {code:"yes",name:"YES BANK",mode:"CUSTOM_BANK_API",publicApi:true,product:"API Banking / Commercial Cards",notes:"API Banking exists; virtual-card endpoints are programme/onboarding specific."},
  {code:"kotak",name:"Kotak Mahindra Bank",mode:"CUSTOM_BANK_API",publicApi:false,product:"Corporate Cards",notes:"Use the API contract issued for your corporate-card programme."},
  {code:"indusind",name:"IndusInd Bank",mode:"CUSTOM_BANK_API",publicApi:false,product:"Corporate Cards",notes:"Use the API contract issued for your corporate-card programme."},
  {code:"idfc",name:"IDFC FIRST Bank",mode:"CUSTOM_BANK_API",publicApi:false,product:"Corporate Cards",notes:"Use the API contract issued for your corporate-card programme."},
  {code:"bob",name:"Bank of Baroda",mode:"CUSTOM_BANK_API",publicApi:false,product:"Corporate Cards",notes:"Use the API contract issued for your corporate-card programme."},
  {code:"custom",name:"Other Bank / Issuer",mode:"CUSTOM_BANK_API",publicApi:false,product:"Bank-provided API",notes:"Works with a bank-provided HTTPS JSON API contract."}
] as const;

export type BankCode=typeof BANK_VIRTUAL_CARD_PROFILES[number]["code"];
export type BankAuthMode="OAUTH2_CLIENT_CREDENTIALS"|"BEARER"|"BASIC"|"API_KEY";
export type GenericBankCredentials={
  bankCode:BankCode;
  baseUrl:string;
  authMode:BankAuthMode;
  tokenUrl?:string;
  clientId?:string;
  clientSecret?:string;
  bearerToken?:string;
  username?:string;
  password?:string;
  apiKey?:string;
  apiKeyHeader?:string;
  parentAccountReference:string;
  healthPath?:string;
  createCardPath:string;
  controlCardPath?:string;
  loadCardPath?:string;
  createCardTemplate:string;
  controlCardTemplate?:string;
  loadCardTemplate?:string;
  responseCardIdPath:string;
  responseAccountIdPath?:string;
  responseMaskedNumberPath?:string;
  responseStatusPath?:string;
  responseBalancePath?:string;
  responseBalanceUnit?:"MINOR"|"RUPEES";
};

type TokenCache={value:string;expiresAt:number}|null;

function pathGet(input:any,path?:string){
  if(!path)return undefined;
  return path.split(".").filter(Boolean).reduce((value,key)=>value?.[key],input);
}
function variableGet(vars:any,path:string){
  return path.split(".").reduce((value,key)=>value?.[key],vars);
}
function renderValue(value:any,vars:any):any{
  if(Array.isArray(value))return value.map(x=>renderValue(x,vars));
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,renderValue(v,vars)]));
  if(typeof value!=="string")return value;
  const exact=value.match(/^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/);
  if(exact)return variableGet(vars,exact[1]!);
  return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,(_,key)=>String(variableGet(vars,key)??""));
}
function parseTemplate(template:string,vars:any){
  let parsed:any;
  try{parsed=JSON.parse(template)}catch{throw new Error("bank_request_template_invalid_json")}
  return renderValue(parsed,vars);
}
function safePath(path:string){
  if(!path.startsWith("/"))throw new Error("bank_api_path_must_be_relative");
  if(path.startsWith("//"))throw new Error("bank_api_path_invalid");
  return path;
}

export class GenericBankVirtualCardIssuer implements VirtualCardIssuer{
  provider:string;
  private token:TokenCache=null;
  constructor(private credentials:GenericBankCredentials){
    this.provider=credentials.bankCode;
  }
  configured(){
    const c=this.credentials;
    if(!c.baseUrl||!c.parentAccountReference||!c.createCardPath||!c.createCardTemplate||!c.responseCardIdPath)return false;
    if(c.authMode==="OAUTH2_CLIENT_CREDENTIALS")return Boolean(c.tokenUrl&&c.clientId&&c.clientSecret);
    if(c.authMode==="BEARER")return Boolean(c.bearerToken);
    if(c.authMode==="BASIC")return Boolean(c.username&&c.password);
    if(c.authMode==="API_KEY")return Boolean(c.apiKey);
    return false;
  }
  private async accessToken(){
    const c=this.credentials;
    if(c.authMode!=="OAUTH2_CLIENT_CREDENTIALS")return null;
    if(this.token&&this.token.expiresAt>Date.now()+60_000)return this.token.value;
    const response=await fetch(c.tokenUrl!,{
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"client_credentials",client_id:c.clientId!,client_secret:c.clientSecret!})
    });
    const json:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`bank_auth_failed_${response.status}`);
    const value=json.access_token??json.accessToken??json.token;
    if(!value)throw new Error("bank_auth_token_missing");
    this.token={value:String(value),expiresAt:Date.now()+Math.max(300,Number(json.expires_in??json.expiresIn??3600))*1000};
    return this.token.value;
  }
  private async headers(){
    const c=this.credentials;
    const headers:Record<string,string>={"content-type":"application/json","accept":"application/json"};
    if(c.authMode==="OAUTH2_CLIENT_CREDENTIALS")headers.authorization=`Bearer ${await this.accessToken()}`;
    if(c.authMode==="BEARER")headers.authorization=`Bearer ${c.bearerToken}`;
    if(c.authMode==="BASIC")headers.authorization=`Basic ${Buffer.from(`${c.username}:${c.password}`).toString("base64")}`;
    if(c.authMode==="API_KEY")headers[c.apiKeyHeader||"x-api-key"]=c.apiKey!;
    return headers;
  }
  private async request(path:string,body?:object,method:"GET"|"POST"="POST"){
    const response=await fetch(new URL(safePath(path),this.credentials.baseUrl),{
      method,headers:await this.headers(),body:method==="POST"?JSON.stringify(body??{}):undefined
    });
    const json:any=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`bank_api_failed_${response.status}`);
    return json;
  }
  async testConnection(){
    if(!this.configured())throw new Error("bank_api_not_configured");
    if(this.credentials.authMode==="OAUTH2_CLIENT_CREDENTIALS")await this.accessToken();
    if(this.credentials.healthPath)await this.request(this.credentials.healthPath,undefined,"GET");
  }
  private vars(input:{cardholder:CardholderInput;label?:string;amountMinor?:number;providerCardId?:string;providerAccountId?:string;reference?:string;onlineAllowed?:boolean;posAllowed?:boolean}){
    return {
      bankCode:this.credentials.bankCode,
      parentAccountReference:this.credentials.parentAccountReference,
      label:input.label??"OrderGrid virtual procurement card",
      amountMinor:input.amountMinor??0,
      amountRupees:((input.amountMinor??0)/100).toFixed(2),
      currency:"INR",
      providerCardId:input.providerCardId??"",
      providerAccountId:input.providerAccountId??this.credentials.parentAccountReference,
      reference:input.reference??"",
      onlineAllowed:input.onlineAllowed??true,
      posAllowed:input.posAllowed??false,
      cardholder:input.cardholder
    };
  }
  async createCard(input:{cardholder:CardholderInput;label?:string;amountMinor?:number}):Promise<IssuedCard>{
    const json:any=await this.request(this.credentials.createCardPath,parseTemplate(this.credentials.createCardTemplate,this.vars(input)));
    const providerCardId=pathGet(json,this.credentials.responseCardIdPath);
    if(!providerCardId)throw new Error("bank_card_id_missing");
    const providerAccountId=pathGet(json,this.credentials.responseAccountIdPath)??this.credentials.parentAccountReference;
    const rawBalance=pathGet(json,this.credentials.responseBalancePath)??0;
    const balanceMinor=this.credentials.responseBalanceUnit==="RUPEES"?Math.round(Number(rawBalance)*100):Math.round(Number(rawBalance));
    return {
      provider:this.credentials.bankCode,
      providerCardId:String(providerCardId),
      providerAccountId:String(providerAccountId),
      maskedNumber:pathGet(json,this.credentials.responseMaskedNumberPath)?String(pathGet(json,this.credentials.responseMaskedNumberPath)):undefined,
      status:String(pathGet(json,this.credentials.responseStatusPath)??"ACTIVE"),
      balanceMinor:Number.isFinite(balanceMinor)?balanceMinor:0
    };
  }
  async configureCard(input:{providerCardId:string;providerAccountId:string;onlineAllowed:boolean;posAllowed:boolean}){
    if(!this.credentials.controlCardPath||!this.credentials.controlCardTemplate)return "NOT_SUPPORTED" as const;
    await this.request(this.credentials.controlCardPath,parseTemplate(this.credentials.controlCardTemplate,this.vars({...input,cardholder:{} as CardholderInput})));
    return "APPLIED" as const;
  }
  async loadCard(input:{providerCardId:string;providerAccountId:string;amountMinor:number;reference:string}){
    if(!this.credentials.loadCardPath||!this.credentials.loadCardTemplate)return;
    await this.request(this.credentials.loadCardPath,parseTemplate(this.credentials.loadCardTemplate,this.vars({...input,cardholder:{} as CardholderInput})));
  }
}
