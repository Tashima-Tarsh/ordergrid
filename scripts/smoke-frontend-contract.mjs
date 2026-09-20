import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "public/index.html","public/funding.js","public/user-dashboard.js","public/navigation.js","public/sw.js","src/server.ts","src/demo-server.ts","package.json"
].map(async path=>[path,await readFile(path,"utf8")])));

function must(condition,message){
  if(!condition)throw new Error(message);
}
function count(text,needle){return text.split(needle).length-1}

const html=files["public/index.html"];
const funding=files["public/funding.js"];
const dashboard=files["public/user-dashboard.js"];
const navigation=files["public/navigation.js"];
const sw=files["public/sw.js"];
const server=files["src/server.ts"];
const demo=files["src/demo-server.ts"];

for(const id of [
  "connectIssuer","disconnectIssuer","issuerDialog","issuerForm","issuerProvider","issuerBankName",
  "bankApiFields","bankAuthMode","saveIssuer","issuerError","cardProgramForm","cardIssuer","createCards"
]){
  must(count(html,`id="${id}"`)===1,`frontend contract: #${id} must exist exactly once`);
}
must(html.includes('class="issuer-connect-overlay"'),"frontend contract: funding card setup container missing");
must(html.includes('name="fundingCardholderName"'),"frontend contract: funding cardholder field missing");
must(html.includes('name="fundingCardLast4"'),"frontend contract: funding card last-four field missing");
must(html.includes('name="fundingCardExpiryMonth"'),"frontend contract: funding card expiry month missing");
must(html.includes('name="fundingCardExpiryYear"'),"frontend contract: funding card expiry year missing");
must(html.includes('<script src="funding.js"></script>'),"frontend contract: funding.js must be loaded");
must(sw.includes("'./funding.js'"),"frontend contract: service worker must cache funding.js");
must(funding.includes("openIssuerConnector"),"frontend contract: Connect bank open handler missing");
must(funding.includes("closeIssuerConnector"),"frontend contract: funding setup close handler missing");
must(funding.includes("issuer-connect-inline"),"frontend contract: funding setup must mount inline in Cards & Funding");
must(funding.includes("scrollIntoView"),"frontend contract: funding setup must remain visible after opening");
must(funding.includes("await load()"),"frontend contract: connector must refresh bank state before opening");
must(funding.includes("'/api/cards/provider/connect'"),"frontend contract: issuer connect API missing from client");
must(funding.includes("'/api/cards'"),"frontend contract: virtual card create API missing from client");
must(server.includes('app.get("/api/cards/banks"'),"backend contract: bank catalog route missing");
must(server.includes('app.get("/api/issuers"'),"backend contract: issuers route missing");
must(server.includes('app.post("/api/cards/provider/connect"'),"backend contract: issuer connect route missing");
must(server.includes('app.post("/api/cards"'),"backend contract: card creation route missing");
must(dashboard.includes("document.querySelector('.command-dashboard')"),"dashboard contract: user dashboard must mount in the current dashboard");
must(!dashboard.includes(".command-dashboard .overview-shell"),"dashboard contract: stale overview-shell dependency returned");
must(navigation.includes("let view='hidden'"),"navigation contract: unknown sections must not leak into Dashboard");
must(demo.includes("SHOWROOM_REDIRECT_URL"),"showroom contract: production redirect support missing");
must(!sw.includes("overview-premium.css"),"stale cache contract: unused overview-premium.css must not be precached");
must(sw.includes("'./fulfilment.css'"),"asset contract: fulfilment.css must be cached because navigation loads it");
must(sw.includes("'./fulfilment.js'"),"asset contract: fulfilment.js must be cached because navigation loads it");

console.log("Frontend/card connector contract OK");
