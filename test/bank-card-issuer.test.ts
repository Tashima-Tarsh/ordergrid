import test from "node:test";
import assert from "node:assert/strict";
import { BANK_VIRTUAL_CARD_PROFILES, GenericBankVirtualCardIssuer } from "../src/bank-card-issuer.js";

test("bank catalog includes documented HDFC and Axis parent-card profiles",()=>{
  const hdfc=BANK_VIRTUAL_CARD_PROFILES.find(x=>x.code==="hdfc");
  const axis=BANK_VIRTUAL_CARD_PROFILES.find(x=>x.code==="axis");
  assert.equal(hdfc?.mode,"PARENT_CARD_API");
  assert.equal(hdfc?.publicApi,true);
  assert.equal(axis?.mode,"PARENT_CARD_API");
  assert.equal(axis?.publicApi,true);
});

test("generic bank adapter renders bank contract without card PAN/CVV",async()=>{
  const original=globalThis.fetch;
  let sent:any=null;
  globalThis.fetch=async (input:any,init:any)=>{
    sent={url:String(input),headers:init?.headers,body:JSON.parse(String(init?.body||"{}"))};
    return new Response(JSON.stringify({data:{cardId:"VC-123",accountId:"AAN-77",masked:"**** 1234",status:"ACTIVE",limit:5000}}),{status:200,headers:{"content-type":"application/json"}});
  };
  try{
    const issuer=new GenericBankVirtualCardIssuer({
      bankCode:"hdfc",
      baseUrl:"https://api.example.com/",
      authMode:"API_KEY",
      apiKey:"secret-key",
      apiKeyHeader:"x-api-key",
      parentAccountReference:"AAN-77",
      createCardPath:"/virtual-cards",
      createCardTemplate:'{"relationship":"{{parentAccountReference}}","limit":"{{amountRupees}}","mobile":"{{cardholder.mobile}}"}',
      responseCardIdPath:"data.cardId",
      responseAccountIdPath:"data.accountId",
      responseMaskedNumberPath:"data.masked",
      responseStatusPath:"data.status",
      responseBalancePath:"data.limit",
      responseBalanceUnit:"RUPEES"
    });
    await issuer.testConnection();
    const card=await issuer.createCard({amountMinor:500000,label:"Order 1",cardholder:{mobile:"9999999999"}});
    assert.equal(sent.url,"https://api.example.com/virtual-cards");
    assert.deepEqual(sent.body,{relationship:"AAN-77",limit:"5000.00",mobile:"9999999999"});
    assert.equal(sent.headers["x-api-key"],"secret-key");
    assert.equal(card.provider,"hdfc");
    assert.equal(card.providerCardId,"VC-123");
    assert.equal(card.balanceMinor,500000);
    assert.equal(await issuer.configureCard({providerCardId:"VC-123",providerAccountId:"AAN-77",onlineAllowed:true,posAllowed:false}),"NOT_SUPPORTED");
  }finally{
    globalThis.fetch=original;
  }
});
