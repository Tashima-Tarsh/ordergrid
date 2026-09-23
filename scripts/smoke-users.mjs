import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "src/server.ts",
  "public/control-center.js",
  "public/automation-center.js",
  "public/navigation.js",
  "public/user-dashboard.js",
  "public/app.js",
  "public/index.html",
  "public/rewards.js",
  "cloudflare/worker.mjs",
  "wrangler.jsonc"
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
must(server.includes("coalesce(username::text,''))"),"login contract: username lookup missing");
must(!server.includes("ORDERGRID_OWNER_RECOVERY_HASH"),"security contract: owner recovery backdoor must be absent");
must(!server.includes("oneTimeOwnerRecoveryUsername"),"security contract: owner recovery username backdoor must be absent");
must(files["public/index.html"].includes("User ID or email"),"login contract: username/email label missing");
must(files["public/app.js"].includes("identifier:f.get('identifier')"),"login contract: username identifier not submitted");
must(files["cloudflare/worker.mjs"].includes('url.pathname.startsWith("/api/")'),"cloudflare production contract: API route handling missing");
must(files["wrangler.jsonc"].includes('"run_worker_first": ["/api", "/api/*"]'),"cloudflare production contract: API must run Worker before SPA assets");
must(files["wrangler.jsonc"].includes('"directory": "./public"'),"cloudflare production contract: public asset directory missing");
must(files["cloudflare/worker.mjs"].includes("supabase.co/functions/v1/ordergrid-api"),"cloudflare production contract: Supabase Edge API origin missing");
must(files["cloudflare/worker.mjs"].includes('"x-ordergrid-path"'),"cloudflare production contract: original API path forwarding missing");
must(!files["cloudflare/worker.mjs"].includes("onrender.com"),"cloudflare production contract: Render dependency must be absent");
must(!files["wrangler.jsonc"].includes('"containers"'),"cloudflare production contract: paid Containers must be absent");
must(!files["wrangler.jsonc"].includes('"durable_objects"'),"cloudflare production contract: paid container Durable Object binding must be absent");
must(server.includes('app.get("/api/signup-status"'),"owner signup contract: public signup-status route missing");
must(server.includes('app.post("/api/signup"'),"owner signup contract: protected signup route missing");
must(server.includes("ORDERGRID_SIGNUP_CODE"),"owner signup contract: setup code protection missing");
must(server.includes("user.owner_signup")&&server.includes("user.owner_recovered"),"owner signup contract: signup/recovery audit events missing");
must(files["public/index.html"].includes('id="signupForm"'),"owner signup contract: signup form missing");
must(files["public/index.html"].includes("Create / recover owner account"),"owner signup contract: login-to-signup action missing");
must(server.includes('app.get("/api/auth-config"'),"google auth contract: public auth config route missing");
must(server.includes("googleAuth:Boolean(config.GOOGLE_CLIENT_ID)"),"google auth contract: health endpoint must report configuration state");
must(server.includes('app.post("/api/login/google"'),"google auth contract: Google login route missing");
must(server.includes("createRemoteJWKSet")&&server.includes("jwtVerify"),"google auth contract: Google ID tokens must be cryptographically verified");
must(server.includes("private.user_external_identities"),"google auth contract: stable Google subject identity mapping missing");
must(server.includes("google_owner_setup_required"),"google auth contract: unknown Google accounts must require owner setup code");
must(files["public/index.html"].includes('id="googleSignIn"'),"google auth contract: Google sign-in mount missing");
must(files["public/app.js"].includes("https://accounts.google.com/gsi/client"),"google auth contract: Google Identity Services client not loaded");
must(files["public/app.js"].includes("credential:response.credential"),"google auth contract: Google credential not sent to backend");
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
must(retailerUi.includes("CLOUD BROWSER ONLINE"),"cloud execution contract: customer Cloud Browser status missing");
must(retailerUi.includes("waiting OTP"),"local execution contract: multi-account authentication progress missing");
must(retailerUi.includes("data-submit-account-otp"),"managed execution contract: account OTP control missing");
must(retailerUi.includes("OTP sign-in"),"managed execution contract: Flipkart OTP-first onboarding copy missing");
must(retailerUi.includes("Email or mobile OTP sign-in"),"managed execution contract: Flipkart email/mobile OTP copy missing");
must(server.includes("validFlipkartLogin"),"managed execution contract: Flipkart email/mobile login validation missing");
must(server.includes("flipkart_uses_otp"),"managed execution contract: Flipkart password authentication must be disabled");
must(!server.includes('flipkart:["flipkart_password"]'),"managed execution contract: Flipkart password import mapping must stay removed");
must(!retailerUi.includes("Flipkart password <small>"),"managed execution contract: Flipkart password field must not appear in normal onboarding");
must(files["public/rewards.js"].includes("value===30?30:15"),"managed execution contract: Flipkart session target must default to 15 days and allow 30 days");
must(retailerUi.includes('id="sessionTargetDays"'),"managed execution contract: Flipkart session target selector missing");
must(server.includes("const credentials:{login:string;password?:string}"),"managed execution contract: OTP-only Flipkart login identity missing");
must(retailerUi.includes("CLOUD BROWSER STARTING"),"cloud execution contract: hosted browser starting state missing");
must(!retailerUi.includes("Install / start Secure Browser"),"cloud execution contract: local installer must not be required");
must(!retailerUi.includes("/api/secure-browser/setup.cmd"),"cloud execution contract: local setup download must not be wired into retailer UI");
must(!retailerUi.includes("Install / start worker"),"managed execution contract: worker install jargon remains");
must(!retailerUi.includes("Start the OrderGrid secure browser worker first"),"managed execution contract: developer-only worker error remains");

console.log("User-only workspace contract OK");
