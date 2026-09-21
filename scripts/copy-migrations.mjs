import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const source=join(process.cwd(),"src","migrations");
const target=join(process.cwd(),"dist","migrations");
await mkdir(target,{recursive:true});
for(const name of await readdir(source)){
  if(!name.endsWith(".sql"))continue;
  await cp(join(source,name),join(target,name));
}
