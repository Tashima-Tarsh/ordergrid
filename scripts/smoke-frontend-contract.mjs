import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "public/index.html","public/app.js","public/wizard.js","public/funding.js","public/rewards.js","public/styles.css","public/finance.css","public/customer.css","public/user-dashboard.js","public/dashboard.js","public/dashboard.css","public/overview-premium.css","public/automation-center.js","public/automation-center.css","public/navigation.js","public/sw.js","src/server.ts","src/baskets.ts","src/flipkart-allocation.ts","src/migrations/023_flipkart_account_pinned_batch_items.sql","src/demo-server.ts","agent/index.mjs","agent/cdp.mjs","package.json"
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
const baskets=files["src/baskets.ts"];
const allocation=files["src/flipkart-allocation.ts"];
const allocationMigration=files["src/migrations/023_flipkart_account_pinned_batch_items.sql"];
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
must(!funding.includes("classList.add('issuer-connect-inline')"),"frontend contract: funding setup must remain a real modal, not inline");
must(funding.includes("document.body.classList.add('issuer-connect-open')"),"frontend contract: card setup modal must lock page background");
must(funding.includes("ordergrid:cards-open"),"frontend contract: Cards navigation must open card setup");
must(navigation.includes("ordergrid:cards-open"),"navigation contract: Cards click must request setup modal");
must(html.includes('id="fundingSourceCard"'),"frontend contract: clickable funding detail card missing");
must(html.includes('id="fundingBank"'),"frontend contract: funding bank detail missing");
must(html.includes('id="fundingProgramme"'),"frontend contract: funding programme detail missing");
must(html.includes('id="fundingCardIdentity"'),"frontend contract: safe funding card identity detail missing");
must(html.includes('id="issuerModalStatus"'),"frontend contract: setup modal status summary missing");
must(files["public/finance.css"].includes("#issuerDialog.issuer-connect-overlay"),"frontend contract: real card setup overlay styling missing");
must(!files["public/customer.css"].includes("#issuerDialog{display:none!important}"),"frontend contract: customer stylesheet must not permanently hide card setup modal");
must(files["public/finance.css"].includes("#issuerDialog.issuer-connect-overlay:not([hidden]){display:grid!important}"),"frontend contract: visible card setup modal state must override stale hide rules");
must(html.indexOf('href="finance.css"')<html.indexOf('href="customer.css"'),"frontend contract: expected stylesheet order changed; re-audit card modal cascade");
must(funding.includes("timedRequest('/api/cards/provider')"),"frontend contract: Cards refresh must have a timeout");
must(funding.includes("timedRequest('/api/cards/banks')"),"frontend contract: bank catalog refresh must have a timeout");
must(funding.includes("fallbackBanks"),"frontend contract: HDFC/Axis setup must work without waiting for bank catalog API");
must(html.includes('id="openFundingSetupFromCard"'),"frontend contract: funding detail CTA button missing");
must(html.includes('data-bank-shortcut="hdfc"'),"frontend contract: HDFC setup shortcut missing");
must(html.includes('data-bank-shortcut="axis"'),"frontend contract: Axis setup shortcut missing");
must(funding.includes("panel.hidden=false;"),"frontend contract: card setup must open the modal");
must(funding.includes("void load().then("),"frontend contract: Cards API refresh must run in background");
must(funding.indexOf("panel.hidden=false;")<funding.indexOf("void load().then("),"frontend contract: card setup modal must open before background refresh");
must(!funding.includes("button.textContent='Loading details…'"),"frontend contract: card setup must never be trapped in Loading details state");
must(funding.includes("$('#openFundingSetupFromCard')?.addEventListener('click'"),"frontend contract: funding CTA click handler missing");
must(funding.includes("window.addEventListener('ordergrid:cards-open',()=>openIssuerConnector())"),"frontend contract: Cards nav event must call connector without passing Event as provider code");
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
must(wizard.includes("Allocate across ready accounts"),"flipkart allocation contract: multi-account allocation control missing");
must(wizard.includes("/api/products/flipkart/mobile/allocation/plan"),"flipkart allocation contract: allocation planner API missing from wizard");
must(wizard.includes("checkRequired").toString()&&wizard.includes("slice(0,10)"),"flipkart allocation contract: account checks must run in bounded waves");
must(app.includes("allocationPlan.allocations.map"),"flipkart allocation contract: batch submit must expand verified account allocations");
must(app.includes("retailerAccountId:String(allocation.retailerAccountId)"),"flipkart allocation contract: exact verified account must be submitted");
must(server.includes('app.post("/api/products/flipkart/mobile/allocation/plan"'),"flipkart allocation contract: allocation planner route missing");
must(server.includes("flipkart_product_check_account_mismatch"),"flipkart allocation contract: account/check mismatch protection missing");
must(server.includes("flipkart_allocation_account_address_mismatch"),"flipkart allocation contract: account/address mismatch protection missing");
must(server.includes("retailer_account_id,unit_price_minor"),"flipkart allocation contract: batch item must persist pinned retailer account");
must(baskets.includes("bi.retailer_account_id"),"flipkart allocation contract: basket sync must preserve pinned retailer account");
must(baskets.includes("retailer_account_id=coalesce(excluded.retailer_account_id"),"flipkart allocation contract: pinned account must survive basket upsert");
must(allocation.includes("remainingQuantity"),"flipkart allocation contract: allocation engine must expose remaining quantity");
must(allocationMigration.includes("add column if not exists retailer_account_id"),"flipkart allocation contract: batch-item account migration missing");
must(server.includes(`const clauses=["tenant_id=$1","active","retailer in ('amazon-in','flipkart')"];`),"retailer session contract: OTP-only accounts must be eligible for preparation");
must(!server.includes(`credential_status<>'MISSING' and session_check_requested_at is not null`),"retailer session contract: native worker must claim OTP-only accounts");
must(server.includes(`session_check_requested_at=case when $1='REAUTH_REQUIRED' then now() else null end`),"retailer session contract: OTP challenge must stay queued until authenticated");
must(cdp.includes('await connection.send("Page.bringToFront").catch(()=>null);'),"retailer session contract: protected retailer session must be brought to the user");
must(html.includes('id="downloadOrderGridWorker"'),"retailer session contract: OrderGrid must expose its secure browser worker");
must(files["public/rewards.js"].includes("OTP / MANUAL SIGN-IN"),"retailer session contract: account UI must support OTP/manual sign-in");
must(files["public/rewards.js"].includes("Start the OrderGrid secure browser worker first"),"retailer session contract: account UI must explain offline worker prerequisite");
must(html.includes('id="addRetailerUser"'),"retailer user contract: visible Add Flipkart user button missing");
must(html.includes('id="retailerUserDialog"'),"retailer user contract: user/address onboarding dialog missing");
must(files["public/rewards.js"].includes("'/api/retailer-users'"),"retailer user contract: single user save API missing from client");
must(files["public/rewards.js"].includes("'/api/address-books/import'"),"retailer user contract: bulk address import missing from client");
must(!files["public/rewards.js"].includes("poolOnly=true"),"retailer user contract: customer-bound retailer accounts must remain visible");
must(server.includes('app.post("/api/retailer-users"'),"retailer user contract: bound user API missing");
must(server.includes("addr.postal_code address_postal_code"),"retailer user contract: retailer account response must expose bound delivery profile");
must(server.includes("retailer_account_already_bound_to_another_user"),"retailer user contract: account identity collision protection missing");
must(html.includes('class="retailer-user-dialog"'),"retailer user contract: wide onboarding dialog missing");
must(html.includes('Download Excel template'),"retailer user contract: Excel template download missing");
must(html.includes('max_concurrent_orders'),"retailer user contract: bulk import must expose concurrency field");
must(files["public/styles.css"].includes("#retailerUserDialog.retailer-user-dialog{width:min(1280px"),"retailer user contract: desktop dialog must be wide");
must(files["public/styles.css"].includes("max-height:none;overflow:visible"),"retailer user contract: dialog must not use nested scrolling");
must(server.includes('app.get("/api/retailer-users/template.xlsx"'),"retailer user contract: Excel template API missing");
must(server.includes("retailerAccountIds:[...new Set(retailerAccountIds)]"),"retailer user contract: bulk import must return bound account ids");
must(files["public/rewards.js"].includes("Importing & preparing…"),"retailer user contract: bulk import must prepare sessions");
must(files["public/rewards.js"].includes("accountIds:ids,retailer:'flipkart'"),"retailer user contract: imported Flipkart sessions must be queued");
must(html.includes("ordergrid-flip-000001"),"retailer user contract: generated reference format missing from UI");
must(!html.includes('name="reference" placeholder="USER-001"'),"retailer user contract: manual user reference field must not exist");
must(server.includes("nextOrderGridFlipReference"),"retailer user contract: sequential reference generator missing");
must(server.includes("ordergrid-flip-"),"retailer user contract: generated reference prefix missing");
must(!server.includes('{header:"reference",key:"reference"'),"retailer user contract: Excel template must not ask for user reference");
must(!files["public/rewards.js"].includes("form.get('reference')"),"retailer user contract: client must not submit manual user reference");

console.log("Frontend/card connector contract OK");
