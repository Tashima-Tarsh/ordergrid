import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("AWS deployment keeps managed execution enabled and browser profiles persistent", async () => {
  const compose = await readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /ORDERGRID_MANAGED_EXECUTION=\$\{ORDERGRID_MANAGED_EXECUTION:-true\}/);
  assert.match(compose, /ordergrid_profiles:\/app\/\.ordergrid/);
  assert.match(compose, /^  ordergrid_profiles:\s*$/m);
});
