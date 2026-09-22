import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const db=createDb(loadConfig()),here=dirname(fileURLToPath(import.meta.url)),dir=join(here,"migrations");
await db.query(`
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    if not exists (select 1 from pg_roles where rolname = 'ordergrid_app') then create role ordergrid_app; end if;
  end $$;
`);
await db.query("create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())");
const legacy=await db.query("select to_regclass('public.tenants') present");
if(legacy.rows[0]?.present)await db.query("insert into schema_migrations(name) values('001_init.sql') on conflict do nothing");
for(const name of (await readdir(dir)).filter(x=>/^\d+.*\.sql$/.test(x)).sort()){
 const applied=await db.query("select 1 from schema_migrations where name=$1",[name]);if(applied.rowCount)continue;
 const sql=await readFile(join(dir,name),"utf8"),client=await db.connect();
 try{await client.query("begin");await client.query(sql);await client.query("insert into schema_migrations(name) values($1)",[name]);await client.query("commit");}
 catch(error){await client.query("rollback");throw error}finally{client.release()}
}
await db.end();
