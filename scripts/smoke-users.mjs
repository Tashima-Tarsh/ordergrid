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
  "public/version.json",
  "Dockerfile",
  "docker-compose.yml",
  "package.json"
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
must(server.includes("oneTimeOwnerRecoveryHash"),"login contract: one-time owner recovery hash missing");
must(server.includes("owner_recovery_enabled=false"),"login contract: one-time owner recovery must disable itself");
must(server.includes("user.owner_recovery_consumed"),"login contract: owner recovery audit event missing");
must(files["public/index.html"].includes("User ID or email"),"login contract: username/email label missing");
must(files["public/app.js"].includes("identifier:f.get('identifier')"),"login contract: username identifier not submitted");
const productionSurface=[
  server,
  files["public/version.json"],
  files["Dockerfile"],
  files["docker-compose.yml"],
  files["package.json"]
].join("\n");
must(files["public/version.json"].includes('"deploymentTarget": "aws"'),"AWS production contract: deployment target metadata missing");
must(files["public/version.json"].includes('"platform": "aws-node-fastify-postgres"'),"AWS production contract: runtime platform metadata missing");
must(files["docker-compose.yml"].includes("AWS_REGION=")&&files["docker-compose.yml"].includes("BEDROCK_REGION="),"AWS production contract: AWS runtime configuration missing");
must(files["Dockerfile"].includes("node dist/migrate.js && node dist/server.js"),"AWS production contract: container must migrate and start the Fastify server");
must(server.includes("CODEBUILD_RESOLVED_SOURCE_VERSION"),"AWS production contract: release identity must support CodeBuild source versions");
must(!/supabase|cloudflare|wrangler|workers\.dev|onrender|CF_PAGES|ORDERGRID_CLOUDFLARE/i.test(productionSurface),"AWS production contract: legacy provider wiring must stay removed");
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
must(retailerUi.includes("DESKTOP NEEDED FOR FLIPKART"),"retailer execution contract: managed worker must not claim to support Flipkart interactive sign-in");
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
must(retailerUi.includes("WORKER OFFLINE"),"retailer execution contract: worker offline state missing");
must(!retailerUi.includes("Install / start Secure Browser"),"cloud execution contract: local installer must not be required");
must(!retailerUi.includes("/api/secure-browser/setup.cmd"),"cloud execution contract: local setup download must not be wired into retailer UI");
must(!retailerUi.includes("Install / start worker"),"managed execution contract: worker install jargon remains");
must(!retailerUi.includes("Start the OrderGrid secure browser worker first"),"managed execution contract: developer-only worker error remains");

console.log("User-only workspace contract OK");
