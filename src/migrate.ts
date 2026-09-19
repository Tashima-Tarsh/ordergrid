import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDb } from "./db.js";

const db = createDb(loadConfig());
const here = dirname(fileURLToPath(import.meta.url));
const sql = await readFile(join(here, "migrations", "001_init.sql"), "utf8");
await db.query(sql);
await db.end();
