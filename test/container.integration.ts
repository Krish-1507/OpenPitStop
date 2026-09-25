import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";
import { containerArgs } from "../src/sandbox/container.js";
import { runDynamic } from "../src/pen/dynamic.js";

// Deliberately separate from the portable unit suite. CI provisions Docker and
// the image first; missing infrastructure is a failure, never a skipped pass.
test("Docker contains raw sockets, child processes and filesystem writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-container-proof-"));
  const stage = path.join(root, "stage");
  fs.mkdirSync(stage, { mode: 0o755 });
  fs.chmodSync(root, 0o755);
  fs.writeFileSync(path.join(root, "host-secret"), "must not be visible");
  fs.writeFileSync(path.join(stage, "visible"), "read only");
  const name = `pitstop-test-${randomUUID()}`;
  const probe = `
    const fs = require('node:fs'), assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    assert.equal(process.getuid(), 1000);
    assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /CapEff:\\s+0+\\n/);
    assert.equal(fs.existsSync(${JSON.stringify(path.join(root, "host-secret"))}), false);
    assert.equal(process.env.PITSTOP_TEST_HOST_SECRET, undefined);
    assert.throws(() => fs.writeFileSync('/input/visible', 'changed'));
    assert.throws(() => fs.writeFileSync('/root-write', 'changed'));
    const attack = "const net=require('node:net'); const s=net.connect(443,'1.1.1.1'); s.on('connect',()=>process.exit(9)); s.on('error',()=>process.exit(0)); setTimeout(()=>process.exit(8),3000);";
    execFileSync(process.execPath, ['-e', attack], { timeout: 5000 });
    const udp = "const d=require('node:dgram').createSocket('udp4'); d.on('error',()=>process.exit(0)); d.send('probe',53,'8.8.8.8',e=>process.exit(e?0:9)); setTimeout(()=>process.exit(8),3000);";
    execFileSync(process.execPath, ['-e', udp], { timeout: 5000 });
    console.log('OS isolation proven');
  `;
  try {
    const args = containerArgs(stage, name);
    args.splice(-1, 1, "-e", probe);
    const result = await execa("docker", args, { timeout: 20000, env: { PITSTOP_TEST_HOST_SECRET: "not-forwarded" } });
    assert.match(result.stdout, /OS isolation proven/);
    assert.equal(fs.readFileSync(path.join(stage, "visible"), "utf8"), "read only");
  } finally {
    await execa("docker", ["rm", "-f", name], { reject: false });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real pen engine boots and attacks only the container copy", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-container-app-"));
  try {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { start: "node app.cjs" } }));
    fs.writeFileSync(path.join(repo, ".env"), "PRODUCTION_SECRET=must-not-appear");
    fs.writeFileSync(path.join(repo, "app.cjs"), `
      const fs = require('node:fs');
      if (fs.existsSync('.env')) throw new Error('credential forwarding');
      fs.writeFileSync('booted-in-container', 'yes');
      require('node:http').createServer((req,res)=>{ res.setHeader('X-Powered-By','fixture');res.end('hello'); }).listen(Number(process.env.PORT), '127.0.0.1');
    `);
    const result = await runDynamic(repo, [{ method: "GET", path: "/", file: "app.cjs", line: 1, sensitive: false, loginLike: false }]);
    assert.equal(result.status, "ok", result.note);
    assert.ok(result.attacks > 0);
    assert.equal(fs.existsSync(path.join(repo, "booted-in-container")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
