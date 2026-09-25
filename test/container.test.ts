import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { containerArgs, sandboxExcluded, stageSandboxTree, safeEvidenceName } from "../src/sandbox/container.js";

test("OS isolation policy has no egress, host networking, host write mount or privileges", () => {
  const args = containerArgs("/tmp/staging", "test");
  for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--pids-limit=128", "--memory=1g"]) assert.ok(args.includes(flag), flag);
  assert.ok(args.includes("type=bind,source=/tmp/staging,target=/input,readonly"));
  assert.ok(!args.includes("--privileged"));
  assert.throws(() => containerArgs("/tmp/x,readonly=false", "test"));
});
test("staging omits common credentials and git, includes app files; returned artifact names cannot escape", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-stage-"));
  try {
    const source = path.join(root, "source"), dest = path.join(root, "dest");
    fs.mkdirSync(source);
    for (const name of [".env", ".env.production", ".npmrc", "private.pem", "app.js"]) fs.writeFileSync(path.join(source, name), "fixture");
    stageSandboxTree(source, dest);
    assert.deepEqual(fs.readdirSync(dest), ["app.js"]);
    assert.ok(sandboxExcluded(".git"));
    for (const name of ["../escape.json", "pen-../../x.json", "scan-latest.json", "pen-x.json/escape", "C:\\pen-x.json"]) assert.equal(safeEvidenceName(name), false);
    assert.equal(safeEvidenceName("ledger-evidence-2026.json"), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
