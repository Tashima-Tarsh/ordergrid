import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

if(process.env.ORDERGRID_MANAGED_EXECUTION!=="true"){
  console.log("Managed execution disabled; skipping managed Chrome install.");
  process.exit(0);
}
if(process.platform!=="linux"){
  console.log("Managed Chrome install is only required on the Linux production runtime.");
  process.exit(0);
}

const root=join(process.cwd(),".ordergrid","chrome");
const executable=join(root,"chrome-linux64","chrome");
if(existsSync(executable)){
  console.log("Managed Chrome already installed.");
  process.exit(0);
}

await mkdir(root,{recursive:true});
const metadataUrl="https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
const metadataResponse=await fetch(metadataUrl);
if(!metadataResponse.ok)throw new Error(`Could not resolve Chrome for Testing metadata (${metadataResponse.status})`);
const metadata=await metadataResponse.json();
const download=metadata?.channels?.Stable?.downloads?.chrome?.find?.(item=>item.platform==="linux64");
if(!download?.url)throw new Error("Stable Linux Chrome for Testing download was not found.");

const zipPath=join(process.cwd(),".ordergrid","chrome-linux64.zip");
const archive=await fetch(download.url);
if(!archive.ok||!archive.body)throw new Error(`Could not download managed Chrome (${archive.status})`);
await pipeline(Readable.fromWeb(archive.body),createWriteStream(zipPath));

const unzip=spawnSync("unzip",["-q","-o",zipPath,"-d",root],{stdio:"inherit"});
if(unzip.status!==0)throw new Error("Could not extract managed Chrome. The production image must provide unzip.");
await rm(zipPath,{force:true});
if(!existsSync(executable))throw new Error("Managed Chrome executable was not found after extraction.");
await chmod(executable,0o755);
console.log(`Managed Chrome installed: ${executable}`);
