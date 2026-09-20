import { readFile } from "node:fs/promises";

const files=Object.fromEntries(await Promise.all([
  "src/server.ts",
  "public/control-center.js",
  "public/automation-center.js",
  "public/navigation.js",
  "public/user-dashboard.js"
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

console.log("User-only workspace contract OK");
