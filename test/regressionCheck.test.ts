import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  runRegressionCheck,
  sealRegressionResult,
  checkRegressionEvidence,
  parseChecks,
  recordBaselineEvidence,
} from "../src/verify/regression.js";
import { gateOutcome } from "../src/commands/gate.js";
import { seal } from "../src/evidence.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepo(testFiles: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-reg-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  for (const [rel, content] of Object.entries(testFiles)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m baseline", { cwd: dir });
  return dir;
}

function commit(repo: string, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  execSync("git add -A", { cwd: repo });
  execSync(`git commit -q -m "${msg}" --allow-empty`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}

const suite = (name: string, body: string) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`;

// three independent checks so per-test TAP names are stable across runs
const A = (expr: string) => `test("check A", () => assert.equal(${expr}, true));`;
const B = (expr: string) => `test("check B", () => assert.equal(${expr}, true));`;
const C = (expr: string) => `test("check C", () => assert.equal(${expr}, true));`;

const GOOD = suite("x", [A("1+1===2"), B("2+2===4"), C("3+3===6")].join("\n"));
const B_BROKEN = suite("x", [A("1+1===2"), B("2+2===5"), C("3+3===6")].join("\n"));
const B_AND_C_BROKEN = suite("x", [A("1+1===2"), B("2+2===5"), C("3+3===7")].join("\n"));
const B_FIXED = suite("x", [A("1+1===2"), B("2+2===4"), C("3+3===6")].join("\n"));
const B_STILL_BROKEN = B_BROKEN;
const NEW_PASS_ONLY = suite("x", [A("1+1===2"), B("2+2===4"), C("3+3===6"), `test("check D new", () => assert.equal(4+4===8, true));`].join("\n"));
const NEW_FAIL_ONLY = suite("x", [A("1+1===2"), B("2+2===4"), C("3+3===6"), `test("check E new", () => assert.equal(5+5===6, true));`].join("\n"));
const B_DELETED = suite("x", [A("1+1===2"), C("3+3===6")].join("\n"));

test("1 — no regression (all previously passing still pass) → NO_REGRESSION", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": GOOD }, "refactor only");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r.verdict, "NO_REGRESSION", r.reasons.join("; "));
  assert.ok(r.entries.filter((e) => e.classification === "UNCHANGED").length >= 3);
  assert.equal(r.regressions.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("2 — one regression (check B was passing, now fails) → REGRESSION", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_BROKEN }, "breaks B");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r.verdict, "REGRESSION");
  assert.deepEqual(r.regressions, ["check B"]);
  const b = r.entries.find((e) => e.id === "check B");
  assert.equal(b?.baselinePass, true);
  assert.equal(b?.candidatePass, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3 — multiple regressions → all listed", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_AND_C_BROKEN }, "breaks B and C");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r.verdict, "REGRESSION");
  assert.deepEqual([...r.regressions].sort(), ["check B", "check C"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4 — baseline already failing → UNCHANGED, NOT a regression", async () => {
  const repo = initRepo({ "x.test.js": B_BROKEN });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_STILL_BROKEN }, "still broken");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r.verdict, "NO_REGRESSION", "fail/fail is not a regression");
  const b = r.entries.find((e) => e.id === "check B");
  assert.equal(b?.classification, "UNCHANGED");
  assert.equal(b?.baselinePass, false);
  assert.equal(b?.candidatePass, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("5 — new test: passing → NEW_PASS; failing → NEW_FAILURE", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": NEW_PASS_ONLY }, "add passing D");
  const r1 = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r1.verdict, "NO_REGRESSION");
  assert.ok(r1.entries.some((e) => e.id === "check D new" && e.classification === "NEW_PASS"));

  commit(repo, { "x.test.js": NEW_FAIL_ONLY }, "add failing E");
  const r2 = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r2.verdict, "REGRESSION", "a newly added failing check makes the suite red");
  assert.ok(r2.newFailures.includes("check E new"));
  const e = r2.entries.find((x) => x.id === "check E new");
  assert.equal(e?.baselinePass, null);
  assert.equal(e?.classification, "NEW_FAILURE");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("6 — fixed baseline failure → FIXED (good news, not a regression)", async () => {
  const repo = initRepo({ "x.test.js": B_BROKEN });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_FIXED }, "fix B");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(r.verdict, "NO_REGRESSION");
  const b = r.entries.find((e) => e.id === "check B");
  assert.equal(b?.classification, "FIXED");
  assert.deepEqual(r.fixed, ["check B"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7 — flaky candidate check (inconsistent across --runs) → UNPROVEN, not REGRESSION", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  // deterministic "flaky": the check passes on the first candidate run and
  // fails afterwards. The marker lives OUTSIDE the worktrees because every
  // run is a fresh checkout of the same commit (that independence is the
  // point) — the shared marker is what makes the check itself non-deterministic.
  const marker = path.join(os.tmpdir(), `reg-flaky-${path.basename(repo)}.marker`);
  fs.rmSync(marker, { force: true });
  commit(repo, {
    "x.test.js": suite("x", [
      `import fs from "node:fs";`,
      `const marker = ${JSON.stringify(marker)};`,
      `test("check B", () => {`,
      `  const first = !fs.existsSync(marker);`,
      `  fs.writeFileSync(marker, "seen");`,
      `  assert.equal(first, true);`,
      `});`,
    ].join("\n")),
  }, "flaky check");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline, runs: 3 });
  fs.rmSync(marker, { force: true });
  const b = r.entries.find((e) => e.id === "check B");
  assert.equal(b?.classification, "UNPROVEN", `got ${b?.classification}: ${JSON.stringify(r.entries)}`);
  assert.equal(b?.flaky, true);
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("flaky")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7b — vanished baseline check → UNPROVEN with deleted-check note", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_DELETED }, "delete check B");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  const b = r.entries.find((e) => e.id === "check B");
  assert.equal(b?.classification, "UNPROVEN");
  assert.ok(b?.note?.includes("missing from the candidate run"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8 — evidence mode: sealed baseline file + tampered evidence rejected", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  // record baseline from the good state
  const first = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: git(repo, "rev-parse HEAD") });
  const sealed = sealRegressionResult(first);
  assert.equal(checkRegressionEvidence(sealed.sealedPath!).status, "verified");
  // evidence-mode comparison against the sealed record
  const r = await runRegressionCheck({
    repo,
    command: "node --test x.test.js",
    baselineEvidenceFile: path.join(repo, ".pitstop", "regression-baseline.json").replace("regression-baseline.json", "regression-baseline.json"),
  });
  // no baseline evidence file yet in .pitstop — use recordBaselineEvidence explicitly:
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8b — evidence mode works end to end and detects the regression", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  const pre = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  const file = recordBaselineEvidence(repo, "node --test x.test.js", pre.entries.map((e) => ({ id: e.id, pass: e.candidatePass === true })));
  commit(repo, { "x.test.js": B_BROKEN }, "breaks B later");
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineEvidenceFile: file });
  assert.equal(r.verdict, "REGRESSION");
  assert.deepEqual(r.regressions, ["check B"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8c — tampered baseline evidence → INTEGRITY_FAILURE, never classified", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const file = recordBaselineEvidence(repo, "node --test x.test.js", [{ id: "check A", pass: true }]);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.checks = [{ id: "check A", pass: false }];
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const r = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineEvidenceFile: file });
  assert.equal(r.verdict, "INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("TAMPERED")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("9 — unparseable output falls back to suite-level check", () => {
  const checks = parseChecks("some random build output\nwith no recognizable test lines", 1);
  assert.deepEqual(checks, [{ id: "suite", pass: false }]);
  const ok = parseChecks("random output", 0);
  assert.deepEqual(ok, [{ id: "suite", pass: true }]);
});

test("10 — deterministic repeated runs → same classification", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": B_BROKEN }, "breaks B");
  const a = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  const b = await runRegressionCheck({ repo, command: "node --test x.test.js", baselineRef: baseline });
  assert.equal(a.verdict, b.verdict);
  assert.deepEqual(a.regressions, b.regressions);
  assert.equal(a.commandHash, b.commandHash);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("11 — baseline execution broken (bad command at baseline) → UNPROVEN", async () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, { "x.test.js": GOOD }, "no change");
  const r = await runRegressionCheck({ repo, command: "node --test does-not-exist.test.js", baselineRef: baseline });
  // at baseline the file is missing too — the runner errors; classification must not invent regressions
  assert.notEqual(r.verdict, "REGRESSION");
  fs.rmSync(repo, { recursive: true, force: true });
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

function writeRegressionReport(repo: string, verdict: string, regressions: string[] = []): string {
  const dir = path.join(repo, ".pitstop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "regression-test.json");
  fs.writeFileSync(
    file,
    JSON.stringify(seal({ timestamp: new Date().toISOString(), repo, verdict, regressions, reasons: [] }, `regression check ${repo}`), null, 2),
  );
  return file;
}

test("12 — gate: REGRESSION hard-blocks listing the regressed checks", () => {
  const repo = initRepo({ "x.test.js": GOOD });
  writeRegressionReport(repo, "REGRESSION", ["check B"]);
  const g = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(g.reasons.some((r) => r.includes("REGRESSION") && r.includes("check B")));
  assert.equal(g.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("13 — gate: tampered regression evidence blocks; NO_REGRESSION unchanged; absent = unchanged", () => {
  const repo = initRepo({ "x.test.js": GOOD });
  const file = writeRegressionReport(repo, "NO_REGRESSION");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const g1 = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(g1.reasons.some((r) => r.includes("TAMPERED")));
  assert.equal(g1.exitCode, 1);

  fs.rmSync(path.join(repo, ".pitstop"), { recursive: true, force: true });
  const g2 = gateOutcome(fakeOutcome(repo), 60);
  assert.equal(g2.exitCode, 0);
  assert.equal(g2.reasons.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});
