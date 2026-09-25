import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { runPen, penExitCode } from "../src/commands/pen.js";
import { applyCurrentPatches, fixExitCode } from "../src/commands/fix.js";
import { insertionPatch, runFixes } from "../src/pen/fix.js";
import { summarizeFindings, type PenFinding } from "../src/pen/types.js";
import { createPlan } from "../src/verify/plan.js";

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-pen-flow-"));
  // Deliberately synthetic credential-shaped fixture, never used on a network.
  fs.writeFileSync(path.join(repo, "config.js"), 'export const key = "AKIA' + '0123456789ABCDEF";');
  return repo;
}

test("static pen works on libraries; no-start dynamic runs retain their findings", async () => {
  const repo = fixture();
  try {
    const result = await runPen(repo, { staticOnly: true, json: true });
    assert.equal(result.dynamicEnabled, false);
    assert.equal(result.dynamic.status, "skipped");
    assert.ok(result.findings.some((f) => f.type === "hardcoded-secret"));
    assert.equal(penExitCode(result), 1);
    const aborted = await runPen(repo, { json: true });
    assert.equal(aborted.dynamic.status, "aborted");
    assert.equal(aborted.findings.length, result.findings.length);
    assert.equal(penExitCode(aborted), 1);
    fs.unlinkSync(path.join(repo, "config.js"));
    assert.equal(penExitCode(await runPen(repo, { json: true })), 2);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("pen --json retains failure exit codes and --fix still produces repro artifacts", () => {
  const repo = fixture();
  try {
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const tsx = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", tsx, cli, "pen", repo, "--static", "--fix", "--json"], { encoding: "utf8", timeout: 60000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(JSON.parse(result.stdout).summary.critical > 0);
    assert.ok(fs.existsSync(path.join(repo, "PITSTOP_PEN_FIXES.md")));
    assert.ok(fs.existsSync(path.join(repo, ".pitstop", "pen-latest.json")));
    assert.ok(fs.readdirSync(repo).some((f) => f.startsWith("pitstop-repro-")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("autopilot applies only current, planned patches and refuses protected paths", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-apply-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const original = ["const app = express();", "app.listen(3000);"];
    fs.writeFileSync(path.join(repo, "app.js"), original.join("\n") + "\n");
    const patchDir = path.join(repo, ".pitstop", "pen-patches");
    fs.mkdirSync(patchDir, { recursive: true });
    fs.writeFileSync(path.join(patchDir, "stale.diff"), "invalid old patch must never run");
    const diffPath = ".pitstop/pen-patches/current.diff";
    fs.writeFileSync(path.join(repo, diffPath), insertionPatch("app.js", original, [{ after: 1, lines: ['app.disable("x-powered-by");'] }]));
    const patch = { findingId: "p1", findingIds: ["p1"], file: "app.js", diffPath, note: "header fix" };
    assert.equal(applyCurrentPatches(repo, [patch]).applied, 0, "no trusted plan");
    createPlan(repo, { id: "fix", goal: "disable disclosure", steps: [], expectedPaths: ["app.js"], verification: { commands: ["pitstop pen"] } });
    fs.writeFileSync(path.join(repo, "openpitstop.architecture.json"), JSON.stringify({ protected: [{ path: "app.js", reason: "entrypoint" }] }));
    assert.equal(applyCurrentPatches(repo, [patch]).applied, 0, "protected entrypoint");
    fs.unlinkSync(path.join(repo, "openpitstop.architecture.json"));
    const result = applyCurrentPatches(repo, [patch]);
    assert.equal(result.applied, 1, JSON.stringify(result));
    assert.match(fs.readFileSync(path.join(repo, "app.js"), "utf8"), /disable/);
    assert.ok(fs.existsSync(path.join(patchDir, "stale.diff")));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("autopilot cannot turn a failed gate, aborted pen or refused patch into success", () => {
  assert.equal(fixExitCode(0, 0, 0), 0);
  assert.equal(fixExitCode(1, 0, 0), 1);
  assert.equal(fixExitCode(2, 0, 0), 2);
  assert.equal(fixExitCode(0, 2, 0), 1);
  assert.equal(fixExitCode(0, 0, 1), 1);
});

test("real generated patches apply to newline-terminated source files", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-generated-patch-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "app.js"), 'const app = express();\napp.listen(3000);\n');
    const finding: PenFinding = { id: "pen-header-abc12345", source: "pen-dynamic", type: "info-leak-header", severity: "low", confidence: "proven", title: "header", description: "disclosure" };
    const fixes = runFixes(repo, { repo, timestamp: new Date().toISOString(), mode: "pen", staticEnabled: true, dynamicEnabled: false, packages: [], findings: [finding], summary: summarizeFindings([finding]), dynamic: { status: "skipped", routesProbed: 0, attacks: 0, bootMs: 0, durationMs: 0, outboundEvents: 0 } }, []);
    assert.equal(fixes.patches.length, 1);
    createPlan(repo, { id: "header", goal: "disable disclosure", steps: [], expectedPaths: ["app.js"], verification: { commands: ["pitstop pen"] } });
    const result = applyCurrentPatches(repo, fixes.patches);
    assert.equal(result.applied, 1, JSON.stringify(result));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
