import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDb, type Db } from "./db.js";

export async function runMigrations(db: Db, customMigrationsDir?: string): Promise<{ applied: string[] }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = customMigrationsDir || join(here, "migrations");
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'ordergrid_app') then create role ordergrid_app; end if;
    end $$;
  `);
  await db.query("create table if not exists schema_migrations(name text primary key, applied_at timestamptz not null default now())");
  const legacy = await db.query("select to_regclass('public.tenants') present");
  if (legacy.rows[0]?.present) {
    await db.query("insert into schema_migrations(name) values('001_init.sql') on conflict do nothing");
  }
  const files = (await readdir(dir)).filter(x => /^\d+.*\.sql$/.test(x)).sort();
  const appliedList: string[] = [];
  for (const name of files) {
    const applied = await db.query("select 1 from schema_migrations where name=$1", [name]);
    if (applied.rowCount) continue;
    let sql = await readFile(join(dir, name), "utf8");
    // Strip leading UTF-8 BOM if present
    sql = sql.replace(/^\uFEFF/, "");
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations(name) values($1)", [name]);
      await client.query("commit");
      appliedList.push(name);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { applied: appliedList };
}

const isDirect = process.argv[1] && (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));
if (isDirect) {
  const db = createDb(loadConfig());
  try {
    await runMigrations(db);
  } finally {
    await db.end();
  }
}
