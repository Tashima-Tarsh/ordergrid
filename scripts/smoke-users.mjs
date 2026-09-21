import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "src/server.ts",
  "public/control-center.js",
  "public/automation-center.js",
  "public/navigation.js",
  "public/user-dashboard.js",
  "public/index.html",
  "public/rewards.js"
].map(async path=>[path,await readFile(path,"utf8")])));

function must(condition,message){
  if(!condition)throw new Error(message);
}

const server=files["src/server.ts"];
const frontend=[
  files["public/control-center.js"],
  files["public/automation-center.js"],
  files["public/navigation.js"],
  files["public/user-dashboard.js"]
].join("\n");

must(server.includes('app.get("/api/users"'),"user contract: GET /api/users missing");
must(server.includes('app.post("/api/users"'),"user contract: POST /api/users missing");
must(server.includes('app.delete("/api/users/:userId"'),"user contract: DELETE /api/users/:userId missing");
must(!server.includes('app.get("/api/dealer-network"'),"user contract: dealer network route must not be active");
must(!server.includes('app.post("/api/dealer-context"'),"user contract: dealer context switching must not be active");
must(!server.includes('app.post("/api/dealers"'),"user contract: dealer creation route must not be active");
must(!server.includes('app.get("/api/dealer-users"'),"user contract: legacy dealer-user route must not be active");
must(!/\bsub-?dealer\b/i.test(frontend),"user contract: sub-dealer wording remains in active frontend");
must(!/\bmain dealer\b/i.test(frontend),"user contract: main dealer wording remains in active frontend");
must(!/\bdealer network\b/i.test(frontend),"user contract: dealer network wording remains in active frontend");
must(files["public/control-center.js"].includes("USERS & PERMISSIONS"),"user contract: users panel missing");
must(files["public/control-center.js"].includes("'/api/users'"),"user contract: user API not wired");

const retailerUi=files["public/index.html"]+"\n"+files["public/rewards.js"];
must(retailerUi.includes("MANAGED EXECUTION ONLINE"),"managed execution contract: customer status missing");
must(retailerUi.includes("data-submit-account-otp"),"managed execution contract: account OTP control missing");
must(retailerUi.includes("OTP sign-in"),"managed execution contract: Flipkart OTP-first onboarding copy missing");
must(retailerUi.includes("Email or mobile OTP sign-in"),"managed execution contract: Flipkart email/mobile OTP copy missing");
must(server.includes("validFlipkartLogin"),"managed execution contract: Flipkart email/mobile login validation missing");
must(server.includes("flipkart_uses_otp"),"managed execution contract: Flipkart password authentication must be disabled");
must(!server.includes('flipkart:["flipkart_password"]'),"managed execution contract: Flipkart password import mapping must stay removed");
must(!retailerUi.includes("Flipkart password <small>"),"managed execution contract: Flipkart password field must not appear in normal onboarding");
must(files["public/rewards.js"].includes("targetDays:15"),"managed execution contract: Flipkart session target must be 15 days");
must(server.includes("const credentials:{login:string;password?:string}"),"managed execution contract: OTP-only Flipkart login identity missing");
must(!retailerUi.includes("Install Secure Browser"),"managed execution contract: customer installer must be removed");
must(!retailerUi.includes("Install / start worker"),"managed execution contract: worker install jargon remains");
must(!retailerUi.includes("start the secure browser worker"),"managed execution contract: worker startup instruction remains");
must(!retailerUi.includes("Start the OrderGrid secure browser worker first"),"managed execution contract: developer-only worker error remains");

console.log("User-only workspace contract OK");
