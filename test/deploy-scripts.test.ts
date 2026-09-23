import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("immutable release ref validation pattern accepts tags and 40-char SHAs only", () => {
  const tagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9]+)*$/;
  const shaPattern = /^[0-9a-fA-F]{40}$/;
  const isImmutableRef = (ref: string) => tagPattern.test(ref) || shaPattern.test(ref);

  // Valid tags
  assert.equal(isImmutableRef("v1.0.0"), true);
  assert.equal(isImmutableRef("v2.10.4-rc.1"), true);
  assert.equal(isImmutableRef("v0.1.0-alpha"), true);

  // Valid commit SHAs
  assert.equal(isImmutableRef("e3b0c44298fc1c149afbf4c8996fb92427ae41e4"), true);
  assert.equal(isImmutableRef("A1B2C3D4E5F67890123456789ABCDEF012345678"), true);

  // Invalid branches / refs
  assert.equal(isImmutableRef("main"), false);
  assert.equal(isImmutableRef("master"), false);
  assert.equal(isImmutableRef("HEAD"), false);
  assert.equal(isImmutableRef("fix/some-branch"), false);
  assert.equal(isImmutableRef("v1"), false);
  assert.equal(isImmutableRef("1.0.0"), false);
  assert.equal(isImmutableRef("short-sha"), false);
});

test("deploy scripts contain required immutable ref checks and healthchecks", async () => {
  const userData = await readFile("user-data.sh", "utf8");
  const deploySh = await readFile("scripts/deploy.sh", "utf8");

  assert.ok(userData.includes("ORDERGRID_REF"));
  assert.ok(userData.includes("git checkout --detach"));
  assert.ok(userData.includes("DEPLOYED_REF"));

  assert.ok(deploySh.includes("git checkout --detach"));
  assert.ok(deploySh.includes("DEPLOYED_REF"));
  assert.ok(deploySh.includes("api/health"));
  assert.ok(deploySh.includes("ROLLBACK INSTRUCTIONS"));
});
