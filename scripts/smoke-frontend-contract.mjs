import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "public/index.html","public/app.js","public/wizard.js","public/funding.js","public/user-dashboard.js","public/dashboard.js","public/dashboard.css","public/overview-premium.css","public/automation-center.js","public/automation-center.css","public/navigation.js","public/sw.js","src/server.ts","src/demo-server.ts","agent/index.mjs","agent/cdp.mjs","package.json"
].map(async path=>[path,await readFile(path,"utf8")])));

function must(condition,message){
  if(!condition)throw new Error(message);
}
function count(text,needle){return text.split(needle).length-1}

const html=files["public/index.html"];
const app=files["public/app.js"];
const wizard=files["public/wizard.js"];
const funding=files["public/funding.js"];
const userDashboard=files["public/user-dashboard.js"];
const dashboard=files["public/dashboard.js"];
const dashboardCss=files["public/dashboard.css"];
const overviewCss=files["public/overview-premium.css"];
const automation=files["public/automation-center.js"];
const automationCss=files["public/automation-center.css"];
const navigation=files["public/navigation.js"];
const sw=files["public/sw.js"];
const server=files["src/server.ts"];
const demo=files["src/demo-server.ts"];
const agent=files["agent/index.mjs"];
const cdp=files["agent/cdp.mjs"];

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
must(userDashboard.includes("document.querySelector('.command-dashboard')"),"dashboard contract: user dashboard must mount in the current dashboard");
must(!userDashboard.includes(".command-dashboard .overview-shell"),"dashboard contract: stale user-dashboard overview-shell dependency returned");
must(html.includes('href="overview-premium.css"'),"dashboard contract: premium overview stylesheet must be linked in head");
must(sw.includes("'./overview-premium.css'"),"dashboard contract: premium overview stylesheet must be precached");
must(overviewCss.includes(".overview-shell"),"dashboard contract: premium overview styles missing");
must(dashboard.includes("WORKSPACE USERS"),"dashboard contract: workspace user scope missing");
must(!dashboard.includes("/api/dealer-network"),"dashboard contract: stale dealer API returned");
must(!/DEALER NETWORK|Main Dealer|Sub-dealer|Current dealer/i.test(dashboard),"dashboard contract: dealer hierarchy wording returned");
must(automation.includes("automation-control-center"),"autopilot contract: premium automation center missing");
must(automationCss.includes(".automation-layout"),"autopilot contract: premium layout styles missing");
must(automationCss.includes(".automation-policy"),"autopilot contract: policy console styles missing");
must(navigation.includes("let view='hidden'"),"navigation contract: unknown sections must not leak into Dashboard");
must(demo.includes("SHOWROOM_REDIRECT_URL"),"showroom contract: production redirect support missing");
must(sw.includes("'./overview-premium.css'"),"dashboard contract: overview-premium.css must be precached");
must(sw.includes("'./fulfilment.css'"),"asset contract: fulfilment.css must be cached because navigation loads it");
must(sw.includes("'./fulfilment.js'"),"asset contract: fulfilment.js must be cached because navigation loads it");
must(wizard.includes("Check product"),"flipkart mobile contract: Check product control missing");
must(wizard.includes("/api/products/flipkart/mobile/check"),"flipkart mobile contract: product check API missing from wizard");
must(wizard.includes("maxQuantityVerified"),"flipkart mobile contract: verified account quantity ceiling missing");
must(app.includes("productCheckId"),"flipkart mobile contract: fulfilment payload must include productCheckId");
must(server.includes('app.post("/api/products/flipkart/mobile/check"'),"flipkart mobile contract: check start route missing");
must(server.includes('app.get("/api/products/flipkart/mobile/check/:commandId"'),"flipkart mobile contract: check status route missing");
must(server.includes("flipkart_product_check_stale"),"flipkart mobile contract: stale price protection missing");
must(server.includes("flipkart_quantity_exceeds_verified_limit"),"flipkart mobile contract: quantity ceiling enforcement missing");
must(agent.includes('command.command==="PRODUCT_CHECK"'),"flipkart mobile contract: native worker command missing");
must(cdp.includes("inspectFlipkartMobile"),"flipkart mobile contract: browser product inspector missing");
must(cdp.includes("flipkartCartProbeScript"),"flipkart mobile contract: account quantity probe missing");
must(!wizard.includes('max="2"'),"flipkart mobile contract: quantity limit must not be hard-coded to two");

console.log("Frontend/card connector contract OK");
