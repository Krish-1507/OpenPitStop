import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  runHoldoutSuite,
  sealHoldoutResults,
  checkHoldoutEvidence,
  loadHoldoutSuite,
  hashSuiteFiles,
} from "../src/verify/holdout.js";
import { gateOutcome } from "../src/commands/gate.js";
import { seal } from "../src/evidence.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

const CALC_GOOD = `export function grade(score) {
  return score >= 50 ? "pass" : "fail";
}
`;
// overfit solution: passes the visible test (grade(80)==="pass") but violates the
// boundary the visible suite never checks
const CALC_OVERFIT = `export function grade(score) {
  return true ? "pass" : "fail";
}
`;
const CALC_BROKEN = `export function grade(score) {
  return "fail";
}
`;

const VISIBLE_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { grade } from "./calc.js";
test("visible: 80 passes", () => assert.equal(grade(80), "pass"));
`;

// HOLDOUT test — lives OUTSIDE the repo; injected into a fresh worktree at final
// verification. Checks the boundary the visible suite never exercises.
const HOLDOUT_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
// HOLDOUT MARKER STRING 7f3a — must never appear in agent-facing output
test("holdout boundary", async () => {
  const mod = await import(pathToFileURL(path.join(process.cwd(), "src", "calc.js")));
  assert.equal(mod.grade(50), "pass");
  assert.equal(mod.grade(49), "fail");
});
`;

const MANIFEST = (checkCommand: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      id: "grade-boundary",
      version: 1,
      description: "hidden boundary checks for grade()",
      checks: [
        {
          id: "boundary-50-49",
          severity: "high",
          command: checkCommand,
          inject: [{ src: "calc.holdout.test.mjs", dest: "holdout/calc.holdout.test.mjs" }],
        },
      ],
      timeoutMs: 60000,
      ...extra,
    },
    null,
    2,
  );

function initRepo(srcCalc: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-ho-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "src", "calc.js"), srcCalc);
  fs.writeFileSync(path.join(dir, "test", "grade.test.js"), VISIBLE_TEST.replace("./calc.js", "../src/calc.js"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m baseline", { cwd: dir });
  return dir;
}

function makeSuite(dir: string, checkCommand = "node --test holdout/calc.holdout.test.mjs"): string {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-ho-suite-"));
  fs.writeFileSync(path.join(suite, "holdout.json"), MANIFEST(checkCommand));
  fs.writeFileSync(path.join(suite, "calc.holdout.test.mjs"), HOLDOUT_TEST);
  return suite;
}

function commit(repo: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  execSync("git add -A", { cwd: repo });
  execSync(`git commit -q -m "${msg}" --allow-empty`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}

test("1 — candidate passes visible tests and holdout (baseline discriminates) → HOLDOUT_PASS", async () => {
  const repo = initRepo(CALC_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "src/calc.js", CALC_GOOD, "fix");
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite, baselineRef: baseline });
  assert.equal(r.verdict, "HOLDOUT_PASS", r.reasons.join("; "));
  assert.equal(r.baselineDiscriminative, true);
  assert.equal(r.checks[0].candidate.pass, true);
  assert.equal(r.checks[0].baseline!.pass, false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("2 — candidate passes visible tests but FAILS holdout → HOLDOUT_FAIL", async () => {
  const repo = initRepo(CALC_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  // the overfit solution: the VISIBLE test passes, the hidden boundary does not
  commit(repo, "src/calc.js", CALC_OVERFIT, "cheat");
  // run the visible suite the way the agent would — with the runner's own env
  // sanitized so `node --test` actually executes instead of deferring to us
  const cleanEnv = { ...process.env } as NodeJS.ProcessEnv;
  delete (cleanEnv as any).NODE_TEST_CONTEXT;
  const visible = execSync("node --test test/grade.test.js", { cwd: repo, encoding: "utf8", stdio: "pipe", env: cleanEnv });
  assert.match(visible, /pass 1/, "overfit must pass the visible test (that is the whole point)");
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite, baselineRef: baseline });
  assert.equal(r.verdict, "HOLDOUT_FAIL");
  assert.equal(r.checks[0].candidate.pass, false);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("3 — holdout modified during verification → HOLDOUT_INTEGRITY_FAILURE", async () => {
  const repo = initRepo(CALC_GOOD);
  // the "check" itself tries to tamper with the holdout suite mid-run
  const suite = makeSuite(
    repo,
    'node -e "require(\'fs\').writeFileSync(process.env.PITSTOP_HOLDOUT_DIR + \'/calc.holdout.test.mjs\', \'tampered\')"',
  );
  const r = await runHoldoutSuite({ repo, suiteSpec: suite });
  assert.equal(r.verdict, "HOLDOUT_INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("MODIFIED during verification")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("4 — holdout unavailable → HOLDOUT_INTEGRITY_FAILURE", async () => {
  const repo = initRepo(CALC_GOOD);
  const r = await runHoldoutSuite({ repo, suiteSpec: "no-such-suite-xyz" });
  assert.equal(r.verdict, "HOLDOUT_INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("holdout suite not found")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4b — invalid manifest (no checks) → HOLDOUT_INTEGRITY_FAILURE", async () => {
  const repo = initRepo(CALC_GOOD);
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-ho-bad-"));
  fs.writeFileSync(path.join(suite, "holdout.json"), JSON.stringify({ id: "x", checks: [] }));
  const r = await runHoldoutSuite({ repo, suiteSpec: suite });
  assert.equal(r.verdict, "HOLDOUT_INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("non-empty array")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("5 — holdout evidence tampered → tampered", async () => {
  const repo = initRepo(CALC_GOOD);
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite });
  const sealed = sealHoldoutResults(r);
  assert.equal(checkHoldoutEvidence(sealed.summaryPath).status, "verified");
  const doc = JSON.parse(fs.readFileSync(sealed.summaryPath, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(sealed.summaryPath, JSON.stringify(doc, null, 2));
  assert.equal(checkHoldoutEvidence(sealed.summaryPath).status, "tampered");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("6 — baseline fails holdout, candidate passes → HOLDOUT_PASS (discriminative)", async () => {
  const repo = initRepo(CALC_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "src/calc.js", CALC_GOOD, "fix");
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite, baselineRef: baseline });
  assert.equal(r.verdict, "HOLDOUT_PASS");
  assert.equal(r.baselineDiscriminative, true);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("7 — baseline unexpectedly PASSES holdout → HOLDOUT_UNPROVEN", async () => {
  const repo = initRepo(CALC_GOOD);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "src/calc.js", CALC_GOOD, "no-op fix");
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite, baselineRef: baseline });
  assert.equal(r.verdict, "HOLDOUT_UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("cannot distinguish")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("8 — fresh checkout integrity: dirty working tree untouched, uncommitted changes NOT verified", async () => {
  const repo = initRepo(CALC_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "src/calc.js", CALC_GOOD, "fix");
  // dirty + uncommitted junk in the user's tree
  fs.writeFileSync(path.join(repo, "scratch-dirty.txt"), "mine\n");
  fs.appendFileSync(path.join(repo, "src", "calc.js"), "\n// uncommitted junk\n");
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite, baselineRef: baseline });
  assert.equal(r.verdict, "HOLDOUT_PASS", "holdout runs against the COMMITTED candidate, not the dirty tree");
  // the user's tree is exactly as they left it
  assert.ok(fs.readFileSync(path.join(repo, "scratch-dirty.txt"), "utf8").includes("mine"));
  assert.ok(fs.readFileSync(path.join(repo, "src", "calc.js"), "utf8").includes("uncommitted junk"));
  assert.ok(!fs.existsSync(path.join(repo, "holdout")), "injected holdout files must not leak into the user's tree");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("9 — repeated deterministic holdout execution → same verdict", async () => {
  const repo = initRepo(CALC_GOOD);
  const suite = makeSuite(repo);
  const a = await runHoldoutSuite({ repo, suiteSpec: suite });
  const b = await runHoldoutSuite({ repo, suiteSpec: suite });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.suiteHash, b.suiteHash);
  assert.deepEqual(a.checks.map((c) => c.candidate.pass), b.checks.map((c) => c.candidate.pass));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("10 — agent cannot access holdout definitions: summary is redacted, suite stays outside", async () => {
  const repo = initRepo(CALC_GOOD);
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite });
  const sealed = sealHoldoutResults(r);
  const summary = fs.readFileSync(sealed.summaryPath, "utf8");
  // no execution output, no commands, no holdout file contents in the agent-visible summary
  assert.ok(!summary.includes('"stdout"'));
  assert.ok(!summary.includes('"stderr"'));
  assert.ok(!summary.includes('"command"'));
  assert.ok(!summary.includes("HOLDOUT MARKER STRING 7f3a"), "holdout test contents must never leak");
  assert.ok(!summary.includes("calc.holdout.test.mjs"), "holdout file names must never leak");
  // the full evidence lives OUTSIDE the repo
  assert.ok(sealed.fullEvidencePath.startsWith(suite));
  assert.ok(!sealed.fullEvidencePath.startsWith(repo));
  // and the repo never received a copy of the holdout
  assert.ok(!fs.existsSync(path.join(repo, "holdout")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("10b — full evidence DOES carry the unredacted detail (auditable, sealed)", async () => {
  const repo = initRepo(CALC_GOOD);
  const suite = makeSuite(repo);
  const r = await runHoldoutSuite({ repo, suiteSpec: suite });
  const sealed = sealHoldoutResults(r);
  const full = JSON.parse(fs.readFileSync(sealed.fullEvidencePath, "utf8"));
  assert.equal(full.kind, "openpitstop-holdout-full-evidence");
  assert.ok(Array.isArray(full.execution) && full.execution.length > 0);
  assert.ok(typeof full.execution[0].stdout === "string");
  assert.ok(full.suite.hash);
  assert.equal(checkHoldoutEvidence(sealed.fullEvidencePath).status, "verified");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(suite, { recursive: true, force: true });
});

test("11 — suite hash covers the manifest and files (version/hash recorded)", async () => {
  const suite = makeSuite(fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-ho-hash-")));
  const h1 = hashSuiteFiles(suite).hash;
  fs.writeFileSync(path.join(suite, "calc.holdout.test.mjs"), HOLDOUT_TEST + "\n// v2\n");
  const h2 = hashSuiteFiles(suite).hash;
  assert.notEqual(h1, h2, "any holdout file change must change the suite hash");
  const loaded = loadHoldoutSuite(suite);
  assert.ok(!("error" in loaded));
  fs.rmSync(suite, { recursive: true, force: true });
});

// ---- gate integration

function fakeOutcome(repo: string): any {
  return {
    repo,
    missingBaseline: false,
    stale: false,
    risk: "Low",
    blocked: false,
    integrity: { verdict: "CLEAN", findings: [], summary: { confirmed: 0, suspicious: 0, total: 0 } },
    evidence: { status: "verified", digest: "x" },
    current: { tests: { total: 1, passed: 1, failed: 0, durationMs: 1 }, perf: {}, securityCount: 0, duplicationCount: 0 },
    baseline: { tests: { total: 1, passed: 1, failed: 0, durationMs: 1 }, perf: {}, securityCount: 0, duplicationCount: 0 },
    deltas: {},
    baselineScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    currentScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    scoreDelta: 0,
    exitCode: 0,
  };
}

function writeHoldoutSummary(repo: string, verdict: string): string {
  const dir = path.join(repo, ".pitstop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "holdout-test.json");
  fs.writeFileSync(
    file,
    JSON.stringify(seal({ timestamp: new Date().toISOString(), repo, verdict, reasons: [] }, `holdout summary ${repo}`), null, 2),
  );
  return file;
}

test("12 — gate: visible PASS + holdout FAIL → hard block (NOT VERIFIED)", () => {
  const repo = initRepo(CALC_GOOD);
  writeHoldoutSummary(repo, "HOLDOUT_FAIL");
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("NOT VERIFIED")));
  assert.equal(gate.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("13 — gate: HOLDOUT_UNPROVEN surfaces without hard block; tampered hard-blocks", () => {
  const repo = initRepo(CALC_GOOD);
  writeHoldoutSummary(repo, "HOLDOUT_UNPROVEN");
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("HOLDOUT_UNPROVEN")));
  assert.equal(gate.exitCode, 0);

  const file = writeHoldoutSummary(repo, "HOLDOUT_PASS");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const gate2 = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate2.reasons.some((r) => r.includes("TAMPERED")));
  assert.equal(gate2.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("14 — gate unaffected when no holdout report exists (backward compatible)", () => {
  const repo = initRepo(CALC_GOOD);
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.reasons.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});
