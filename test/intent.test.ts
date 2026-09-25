import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { matchIntent } from "../src/intent.js";

test("plain-English requests resolve to specific engineering stages", () => {
  const cases: [string, string[]][] = [
    ["/pitstop find vulnerabilities in this repo", ["pen", "--static"]],
    ["find and fix vulnerabilities in this repo", ["fix"]],
    ["understand this repo", ["understand"]],
    ["check architecture boundaries", ["architecture-check"]],
    ["check tests types lint and build", ["verify-stack"]],
    ["review my changes", ["flow"]],
    ["did my agent cheat", ["integrity"]],
    ["check the security of this app", ["pen", "--static"]],
    ["can I ship this", ["gate", "--strict"]],
    ["what should I do next", ["next"]],
    ["show my budget", ["budget"]],
    ["why is my score low", ["scan", "--reuse"]],
    ["inspect pen-dyn-abc12345", ["inspect", "pen-dyn-abc12345"]],
  ];
  for (const [phrase, args] of cases) assert.deepEqual(matchIntent(phrase)?.args, args, phrase);
});

test("active attacks, writes and paid agents require explicit execution", () => {
  for (const phrase of ["attack my app", "make this safe", "fix security-abcdef12", "install the slash command"])
    assert.equal(matchIntent(phrase)?.requiresExecution, true, phrase);
  assert.equal(matchIntent("check security")?.requiresExecution, false);
  assert.deepEqual(matchIntent("attack my app")?.args, ["pen"], "attack must not silently patch");
});

test("unsupported constraints and shell-like requests never execute", () => {
  for (const phrase of ["don't fix it", "don’t fix my issues", "make this safe without editing files", "scan; echo bad", "scan && fix", "scan $(whoami)", "scan\nfix", "scan then install", "sing a song"])
    assert.equal(matchIntent(phrase), null, phrase);
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
function invoke(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--import", tsx, cli, "ask", "--repo", repo, ...args], { encoding: "utf8", timeout: 60000, windowsHide: true });
}

test("ask executes internally in the chosen repo and preview does not write", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop ask space-"));
  try {
    fs.writeFileSync(path.join(repo, "package.json"), '{"scripts":{"test":"node --test"}}');
    const preview = invoke(repo, "understand this repo", "--dry-run");
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(fs.existsSync(path.join(repo, ".pitstop")), false);
    const executed = invoke(repo, "understand this repo");
    assert.equal(executed.status, 0, executed.stderr);
    assert.ok(fs.readdirSync(path.join(repo, ".pitstop")).some((f) => f.startsWith("understanding")));
    const decision = invoke(repo, "make this safe", "--json");
    assert.equal(JSON.parse(decision.stdout).executes, false);
    const gated = invoke(repo, "make this safe");
    assert.equal(gated.status, 2);
    assert.match(gated.stdout, /--execute/);
    assert.equal(fs.existsSync(path.join(repo, ".pitstop", "pen-latest.json")), false);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("ask propagates a failing test layer's exit code", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop ask exit-"));
  try {
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ scripts: { "test:unit": "node fail.cjs" } }));
    fs.writeFileSync(path.join(repo, "fail.cjs"), "process.exit(1);");
    const result = invoke(repo, "run all test layers");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /DO NOT SHIP/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
