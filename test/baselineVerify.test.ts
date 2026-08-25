import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { baselineAwareVerify, checkBaselineEvidence } from "../src/verify/baseline.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-bv-"));
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

function commit(repo: string, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    if (content === null as unknown as string) {
      try { fs.rmSync(path.join(repo, rel), { force: true }); } catch {}
      execSync(`git rm -q -f -- "${rel}"`, { cwd: repo, stdio: "pipe" });
    } else {
      const p = path.join(repo, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      execSync(`git add -- "${rel}"`, { cwd: repo });
    }
  }
  execSync(`git add -A`, { cwd: repo });
  execSync(`git commit -q -m "${msg}" --allow-empty`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}

function sha(repo: string, ref: string): string {
  return git(repo, `rev-parse ${ref}`);
}

function countWorktrees(repo: string): number {
  try {
    const out = git(repo, "worktree list --porcelain");
    return out.split("\n").filter((l) => l.startsWith("worktree ")).length;
  } catch { return 0; }
}

// Fixture: verification is "node verify.js" that checks data.txt
function verifyJs(): string {
  return `
import fs from "node:fs";
const data = fs.readFileSync("data.txt","utf8").trim();
if (data === "bug") { console.log("FAIL: bug present"); process.exit(1); }
if (data === "env-broken") { console.error("ENOENT: Cannot find module"); process.exit(1); }
console.log("PASS");
process.exit(0);
`;
}

function dataBug(): string { return "bug\n"; }
function dataFixed(): string { return "fixed\n"; }
function dataEnvBroken(): string { return "env-broken\n"; }

test("1 — baseline FAIL + candidate PASS → VERIFIED", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug(), "package.json": "{}" });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "fix");
  const res = await baselineAwareVerify({
    repo,
    baselineRef: baseline,
    candidateRef: candidate,
    verification: { id: "test-1", command: "node verify.js", testFiles: ["verify.js"], configFiles: [] },
  });
  assert.equal(res.verdict, "VERIFIED");
  assert.equal(res.baseline?.exitCode, 1);
  assert.equal(res.candidate?.exitCode, 0);
  assert.ok(res.integrity.verificationIdentityUnchanged);
  assert.ok(fs.existsSync(res.sealedPath!));
  // evidence must verify
  assert.equal(checkBaselineEvidence(res.sealedPath!).status, "verified");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("2 — baseline PASS + candidate PASS → UNPROVEN", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataFixed(), "package.json": "{}" });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "noop");
  const res = await baselineAwareVerify({
    repo,
    baselineRef: baseline,
    candidateRef: candidate,
    verification: { id: "test-2", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "UNPROVEN");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3 — baseline FAIL + candidate FAIL → FAILED", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataBug() }, "still bug");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-3", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "FAILED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4 — verification command changes → INTEGRITY_FAILURE / UNPROVEN", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  commit(repo, { "data.txt": dataFixed() }, "fix");
  const candidate = sha(repo, "HEAD");
  // Run with different command string (even though logic same, identity changes)
  // We simulate by using two different commands in two separate calls? But single call uses one command.
  // Instead we test: verification identity via file hash: but for command change, we pass same verification
  // to both executions; to detect command change we need historical mismatch. Simpler: verify that if
  // verification.command differs from what was hashed at baseline vs candidate (we compute same command both times),
  // it would not detect. So we test that if we *call* with a different command on a second run, hashes differ?
  // For single baselineAwareVerify, command is same. So we need to test file-based command hash? 
  // Instead we test that if we manually change verification definition between baseline and candidate, it is not same call.
  // So we test the lower-level: running with command A then expecting B should be detected via verificationHash comparison
  // by doing two separate baselineAwareVerify calls with different ids - not ideal.
  // Simpler: test that changing config command hash is caught via test file change? We'll pivot to test that
  // if verification command is semantically same but test file hash unchanged, verdict is VERIFIED; 
  // but if we run baseline with "node verify.js" and candidate with "node verify.js --different" (different string) they would be different runs.
  // For this test we instead verify that the mechanism hashes command: so running with "node verify.js" vs "node verify.js --extra" would be different verification ids and thus should not be compared as same verification.
  // We demonstrate by running baselineAwareVerify with one command, then tamper the verificationFiles hash path.
  // Simpler: just assert that two different verification defs produce different hashes.
  const { digestOf } = await import("../src/evidence.js");
  const h1 = digestOf({ command: "node verify.js" });
  const h2 = digestOf({ command: "node verify.js --changed" });
  assert.notEqual(h1, h2);
  // Now run a real baseline/candidate where test file was changed to alter command semantics (e.g., verify.js changed to always pass)
  const repo2 = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const base2 = sha(repo2, "HEAD");
  // Candidate changes verify.js to "process.exit(0)" (weakened)
  commit(repo2, { "verify.js": `process.exit(0);\n` }, "weaken");
  const cand2 = sha(repo2, "HEAD");
  const res2 = await baselineAwareVerify({
    repo: repo2, baselineRef: base2, candidateRef: cand2,
    verification: { id: "test-4b", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res2.verdict, "INTEGRITY_FAILURE");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(repo2, { recursive: true, force: true });
});

test("5 — verification test file changes → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  commit(repo, { "verify.js": `console.log("PASS"); process.exit(0);\n`, "data.txt": dataFixed() }, "change verify");
  const candidate = sha(repo, "HEAD");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-5", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "INTEGRITY_FAILURE");
  assert.ok(res.integrity.verificationFilesChanged);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("6 — verification config changes → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug(), "config.json": '{"threshold":1}' });
  const baseline = sha(repo, "HEAD");
  commit(repo, { "config.json": '{"threshold":99}' }, "config change");
  const candidate = sha(repo, "HEAD");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-6", command: "node verify.js", configFiles: ["config.json"] },
  });
  assert.equal(res.verdict, "INTEGRITY_FAILURE");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7 — test deleted → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  // delete verify.js in candidate (git rm)
  execSync("git rm -q -f verify.js", { cwd: repo });
  execSync(`git commit -q -m "delete verify"`, { cwd: repo });
  const candidate = sha(repo, "HEAD");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-7", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "INTEGRITY_FAILURE");
  assert.ok(res.reasons.some((r) => r.includes("deleted")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8 — evidence modified → integrity failure", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "fix");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-8", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "VERIFIED");
  // tamper
  const doc = JSON.parse(fs.readFileSync(res.sealedPath!, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(res.sealedPath!, JSON.stringify(doc, null, 2));
  const check = checkBaselineEvidence(res.sealedPath!);
  assert.equal(check.status, "tampered");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("9 — baseline fails for unrelated env problem → UNPROVEN not VERIFIED", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataEnvBroken() });
  const baseline = sha(repo, "HEAD");
  // candidate fixes env but also the verification expectedFailure predicate says "FAIL: bug present"
  // baseline's output is "ENOENT: Cannot find module" not the expected bug, so should be UNPROVEN
  commit(repo, { "data.txt": dataFixed() }, "fix env");
  const candidate = sha(repo, "HEAD");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: {
      id: "test-9",
      command: "node verify.js",
      testFiles: ["verify.js"],
      expectedFailure: { stdoutContains: "FAIL: bug present" },
    },
  });
  assert.equal(res.verdict, "UNPROVEN");
  assert.ok(res.reasons.some((r) => r.includes("expected pattern")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("10 — dirty working tree is safe", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "fix");
  // dirty file not committed
  fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty", "utf8");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-10", command: "node verify.js", testFiles: ["verify.js"] },
  });
  assert.equal(res.verdict, "VERIFIED");
  // dirty file should still exist after
  assert.ok(fs.existsSync(path.join(repo, "dirty.txt")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("11 — baseline checkout fails → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "verify.js": verifyJs() });
  const res = await baselineAwareVerify({
    repo, baselineRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", candidateRef: "HEAD",
    verification: { id: "test-11", command: "node verify.js" },
  });
  assert.equal(res.verdict, "INTEGRITY_FAILURE");
  assert.ok(res.reasons.some((r) => r.includes("baseline checkout failed")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("12 — candidate checkout fails → INTEGRITY_FAILURE", async () => {
  const repo = initRepo({ "verify.js": verifyJs() });
  const baseline = sha(repo, "HEAD");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    verification: { id: "test-12", command: "node verify.js" },
  });
  assert.equal(res.verdict, "INTEGRITY_FAILURE");
  assert.ok(res.reasons.some((r) => r.includes("candidate checkout failed")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("13 — verification command fails unexpectedly (timeout / bad command) → handled", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "fix");
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-13", command: "node --nonexistent-flag verify.js", timeoutMs: 3000 },
  });
  // Both will fail with non-zero, but not as expected; should be FAILED or UNPROVEN, not VERIFIED
  assert.notEqual(res.verdict, "VERIFIED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("14 — cleanup after successful verification", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  const candidate = commit(repo, { "data.txt": dataFixed() }, "fix");
  const before = countWorktrees(repo);
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-14", command: "node verify.js" },
  });
  assert.equal(res.verdict, "VERIFIED");
  const after = countWorktrees(repo);
  assert.equal(after, before, "worktree not cleaned after success");
  // NOTE: we deliberately do NOT scan the global temp dir here — `npm test`
  // runs test files concurrently and another file's test may legitimately hold
  // a worktree at this moment. The per-repo `git worktree list` assertion
  // above is the cleanup contract.
  fs.rmSync(repo, { recursive: true, force: true });
});

test("15 — cleanup after failed verification", async () => {
  const repo = initRepo({ "verify.js": verifyJs(), "data.txt": dataBug() });
  const baseline = sha(repo, "HEAD");
  commit(repo, { "data.txt": dataBug() }, "still fail");
  const candidate = sha(repo, "HEAD");
  const before = countWorktrees(repo);
  const res = await baselineAwareVerify({
    repo, baselineRef: baseline, candidateRef: candidate,
    verification: { id: "test-15", command: "node verify.js" },
  });
  assert.equal(res.verdict, "FAILED");
  const after = countWorktrees(repo);
  assert.equal(after, before, "worktree not cleaned after failure");
  fs.rmSync(repo, { recursive: true, force: true });
});
