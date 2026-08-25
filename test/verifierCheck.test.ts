import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  checkVerifier,
  sealVerifierResult,
  checkVerifierEvidence,
  parseMutateWrite,
  parseMutateInline,
  type VerifierCheckDef,
} from "../src/verify/verifier.js";
import { gateOutcome } from "../src/commands/gate.js";
import { seal } from "../src/evidence.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-vc-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m baseline", { cwd: dir });
  return dir;
}

function write(repo: string, rel: string, content: string): void {
  const p = path.join(repo, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

function countWorktrees(repo: string): number {
  try {
    return git(repo, "worktree list --porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree ")).length;
  } catch {
    return 0;
  }
}

/**
 * Generic fixture: `node check.js` verifies data.txt === "fixed".
 * KNOWN-GOOD: data.txt = "fixed"  → exit 0
 * KNOWN-BAD:  data.txt = "broken" (seeded fault: required behavior removed) → exit 1
 */
const CHECK_JS = `import fs from "node:fs";
const d = fs.readFileSync("data.txt","utf8").trim();
if (d !== "fixed") { console.log("FAIL: required behavior missing"); process.exit(1); }
console.log("PASS");
process.exit(0);
`;

const GOOD_DEF = (extra: Partial<VerifierCheckDef> = {}): VerifierCheckDef => ({
  id: "check-data",
  command: "node check.js",
  mutations: [{ op: "write", path: "data.txt", content: "broken\n" }],
  ...extra,
});

test("1+2 — known-good PASSES and known-bad FAILS → VERIFIER_VALID", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = await checkVerifier({ repo, def: GOOD_DEF() });
  assert.equal(r.verdict, "VERIFIER_VALID", r.reasons.join("; "));
  assert.equal(r.good?.actual, "PASS");
  assert.equal(r.bad?.actual, "FAIL");
  assert.ok(r.bad?.exitCode !== 0);
  assert.ok(r.bad?.mutations?.some((m) => m.op === "write" && m.path === "data.txt"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3 — known-good unexpectedly FAILS → VERIFIER_BROKEN", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = await checkVerifier({
    repo,
    def: GOOD_DEF({ command: "node broken-check.js", mutations: [{ op: "write", path: "data.txt", content: "broken\n" }] }),
  });
  // broken-check.js doesn't exist in the worktree → good case fails to run
  // use a command that always fails instead:
  const r2 = await checkVerifier({
    repo,
    def: GOOD_DEF({ command: "node -e \"process.exit(1)\"" }),
  });
  assert.equal(r2.verdict, "VERIFIER_BROKEN");
  assert.equal(r2.good?.actual, "FAIL");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4 — known-bad unexpectedly PASSES → VERIFIER_WEAK", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  // a verifier that cannot detect the seeded fault (always passes)
  const r = await checkVerifier({
    repo,
    def: GOOD_DEF({ command: "node -e \"process.exit(0)\"" }),
  });
  assert.equal(r.verdict, "VERIFIER_WEAK");
  assert.equal(r.good?.actual, "PASS");
  assert.equal(r.bad?.actual, "PASS");
  assert.ok(r.reasons.some((x) => x.includes("cannot detect the seeded fault")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4b — explicit --bad-ref works as the known-bad state", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "broken\n" }); // bad commit
  const badSha = git(repo, "rev-parse HEAD");
  write(repo, "data.txt", "fixed\n");
  execSync("git add -A", { cwd: repo });
  execSync('git commit -q -m fix', { cwd: repo });
  const r = await checkVerifier({
    repo,
    def: { id: "by-ref", command: "node check.js", badRef: badSha },
  });
  assert.equal(r.verdict, "VERIFIER_VALID");
  assert.equal(r.bad?.commitSha, badSha);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("5 — mutation cannot be applied (delete target missing) → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = await checkVerifier({
    repo,
    def: GOOD_DEF({ mutations: [{ op: "delete", path: "does-not-exist.txt" }] }),
  });
  assert.equal(r.verdict, "INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("target missing")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("6 — invalid fixtures: no known-bad case, both modes, non-git repo", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const none = await checkVerifier({ repo, def: { id: "x", command: "node check.js" } });
  assert.equal(none.verdict, "INTEGRITY_FAILURE");
  assert.ok(none.reasons.some((x) => x.includes("no known-bad case")));

  const both = await checkVerifier({
    repo,
    def: {
      id: "x",
      command: "node check.js",
      badRef: "HEAD",
      mutations: [{ op: "write", path: "data.txt", content: "broken\n" }],
    },
  });
  assert.equal(both.verdict, "INTEGRITY_FAILURE");
  assert.ok(both.reasons.some((x) => x.includes("EITHER")));

  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-vc-nogit-"));
  const r3 = await checkVerifier({ repo: nogit, def: GOOD_DEF() });
  assert.equal(r3.verdict, "INTEGRITY_FAILURE");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(nogit, { recursive: true, force: true });
});

test("6b — bad ref unresolvable → INTEGRITY_FAILURE with checkout reason", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = await checkVerifier({
    repo,
    def: { id: "x", command: "node check.js", badRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
  });
  assert.equal(r.verdict, "INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("known-bad checkout failed")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7 — evidence: sealed after write, TAMPERED after edit", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = sealVerifierResult(await checkVerifier({ repo, def: GOOD_DEF() }));
  assert.ok(r.sealedPath);
  assert.equal(checkVerifierEvidence(r.sealedPath!).status, "verified");
  const doc = JSON.parse(fs.readFileSync(r.sealedPath!, "utf8"));
  doc.verdict = "VERIFIER_VALID"; // even a same-value rewrite breaks the digest chain? no — same value keeps digest. change it:
  doc.verdict = "FAKE";
  fs.writeFileSync(r.sealedPath!, JSON.stringify(doc, null, 2));
  assert.equal(checkVerifierEvidence(r.sealedPath!).status, "tampered");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8 — isolated execution: user's working tree untouched, mutations never leak", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  write(repo, "untracked-dirt.txt", "mine\n");
  const r = await checkVerifier({ repo, def: GOOD_DEF() });
  assert.equal(r.verdict, "VERIFIER_VALID");
  // the mutation wrote "broken" into a TEMP worktree — the user's file must be untouched
  assert.equal(fs.readFileSync(path.join(repo, "data.txt"), "utf8"), "fixed\n");
  assert.ok(fs.existsSync(path.join(repo, "untracked-dirt.txt")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("9 — cleanup: worktrees removed after VALID, BROKEN and INTEGRITY_FAILURE runs", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const before = countWorktrees(repo);

  const valid = await checkVerifier({ repo, def: GOOD_DEF() });
  assert.equal(valid.verdict, "VERIFIER_VALID");
  assert.equal(countWorktrees(repo), before, "worktree leaked after VALID run");

  const broken = await checkVerifier({ repo, def: GOOD_DEF({ command: "node -e \"process.exit(1)\"" }) });
  assert.equal(broken.verdict, "VERIFIER_BROKEN");
  assert.equal(countWorktrees(repo), before, "worktree leaked after BROKEN run");

  const failed = await checkVerifier({
    repo,
    def: GOOD_DEF({ mutations: [{ op: "delete", path: "missing.txt" }] }),
  });
  assert.equal(failed.verdict, "INTEGRITY_FAILURE");
  assert.equal(countWorktrees(repo), before, "worktree leaked after INTEGRITY_FAILURE run");

  // NOTE: we deliberately do NOT scan the global temp dir here — `npm test`
  // runs test files concurrently and another file's test may legitimately hold
  // a worktree at this moment. The per-repo `git worktree list` assertions
  // above are the cleanup contract.
  fs.rmSync(repo, { recursive: true, force: true });
});

test("10 — deterministic repeated runs → same verdict, same evidence shape", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const a = await checkVerifier({ repo, def: GOOD_DEF() });
  const b = await checkVerifier({ repo, def: GOOD_DEF() });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.verifier.verificationHash, b.verifier.verificationHash);
  assert.equal(a.good?.exitCode, b.good?.exitCode);
  assert.equal(a.bad?.exitCode, b.bad?.exitCode);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("10b — mutation touching the verification's own files is flagged honestly", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const r = await checkVerifier({
    repo,
    def: GOOD_DEF({
      testFiles: ["check.js"],
      mutations: [
        { op: "write", path: "check.js", content: "process.exit(1);\n" },
        { op: "write", path: "data.txt", content: "fixed\n" },
      ],
    }),
  });
  assert.equal(r.verdict, "VERIFIER_VALID");
  assert.ok(r.notes.some((n) => n.includes("mutation touches the verification's own files")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("11 — verifier itself changed between good and bad refs → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "broken\n" });
  const goodSha = git(repo, "rev-parse HEAD");
  // the "agent" commit weakens the verifier AND claims to fix the data
  write(repo, "check.js", "process.exit(0);\n");
  write(repo, "data.txt", "fixed\n");
  execSync("git add -A", { cwd: repo });
  execSync("git commit -q -m weaken-verifier", { cwd: repo });
  const r = await checkVerifier({
    repo,
    def: { id: "x", command: "node check.js", goodRef: goodSha, badRef: "HEAD", testFiles: ["check.js"] },
  });
  assert.equal(r.verdict, "INTEGRITY_FAILURE");
  assert.ok(r.reasons.some((x) => x.includes("not like-for-like")));
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---- CLI arg parsers

test("12 — mutation parsers", () => {
  assert.deepEqual(parseMutateInline("data.txt=broken"), {
    op: "write",
    path: "data.txt",
    content: "broken",
  });
  assert.equal(parseMutateInline("no-equals-sign"), null);
  const fixture = path.join(os.tmpdir(), "pitstop-vc-fixture.txt");
  fs.writeFileSync(fixture, "fixture-content\n");
  const m = parseMutateWrite(`data.txt=${fixture}`, os.tmpdir());
  assert.equal(m?.op, "write");
  assert.equal((m as any).content, "fixture-content\n");
  fs.rmSync(fixture, { force: true });
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

function writeVerifierReport(repo: string, verdict: string): string {
  const dir = path.join(repo, ".pitstop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "verifier-check-test.json");
  fs.writeFileSync(
    file,
    JSON.stringify(seal({ timestamp: new Date().toISOString(), repo, verdict, reasons: [] }, `verifier check ${repo}`), null, 2),
  );
  return file;
}

test("13 — gate surfaces VERIFIER_WEAK without hard-blocking (explicit health check)", () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  writeVerifierReport(repo, "VERIFIER_WEAK");
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("VERIFIER_WEAK")));
  assert.equal(gate.exitCode, 0, "weak verifier surfaces but does not break workflows");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("14 — gate hard-blocks on TAMPERED verifier-check evidence", () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const file = writeVerifierReport(repo, "VERIFIER_VALID");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("TAMPERED")));
  assert.equal(gate.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("15 — gate unaffected when no verifier-check report exists (backward compatible)", () => {
  const repo = initRepo({ "check.js": CHECK_JS, "data.txt": "fixed\n" });
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.equal(gate.exitCode, 0);
  assert.equal(gate.reasons.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});
