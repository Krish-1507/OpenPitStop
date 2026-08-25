import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  verifyStateClaims,
  sealStateResult,
  writeStateSnapshot,
  readStateSnapshot,
  checkStateEvidence,
  snapshotPaths,
  parseClaim,
} from "../src/verify/state.js";
import type { StateClaim } from "../src/verify/state.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-sv-"));
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

const AUTH_V1 = `export function login(u: string, p: string) {\n  return u === "admin" && p === "secret";\n}\n`;
const AUTH_V2 = `export function login(u: string, p: string) {\n  return u === "admin" && p === "s3cret";\n}\n`;

const claim = (op: string, p: string): StateClaim => ({ op: op as any, path: p });

test("1 — genuinely changed tracked file → STATE_VERIFIED", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/auth.ts", AUTH_V2);
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  const sig = Object.fromEntries(r.results[0].signals.map((s) => [s.name, s.ok]));
  assert.equal(sig["file exists"], true);
  assert.equal(sig["content changed (hash)"], true);
  assert.equal(sig["git status observed"], true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("2 — file did NOT change → STATE_MISMATCH", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "STATE_MISMATCH");
  assert.ok(r.reasons.some((x) => x.includes("IDENTICAL")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3 — file created (untracked) → STATE_VERIFIED with note", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/new.ts", "export const x = 1;\n");
  const r = verifyStateClaims(repo, [claim("created", "src/new.ts")]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.ok(r.results[0].notes.some((n) => n.includes("no before-state snapshot")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3b — file created with sealed BEFORE snapshot proving absence → STATE_VERIFIED", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const { snapshot } = writeStateSnapshot(repo, ["src/new.ts"]);
  assert.equal(snapshot["src/new.ts"].exists, false);
  write(repo, "src/new.ts", "export const x = 1;\n");
  const r = verifyStateClaims(repo, [claim("created", "src/new.ts")], { before: snapshot });
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.equal(r.results[0].beforeKnown, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4 — file deleted (tracked) → STATE_VERIFIED", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1, "src/old.ts": "export const old = 1;\n" });
  execSync("git rm -q -f src/old.ts", { cwd: repo });
  const r = verifyStateClaims(repo, [claim("deleted", "src/old.ts")]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.equal(r.results[0].after.exists, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("5 — wrong file changed → STATE_MISMATCH + other-changed context", () => {
  const repo = initRepo({ "src/a.ts": AUTH_V1, "src/b.ts": AUTH_V1 });
  write(repo, "src/b.ts", AUTH_V2); // agent changed b, claimed a
  const r = verifyStateClaims(repo, [claim("modified", "src/a.ts")]);
  assert.equal(r.verdict, "STATE_MISMATCH");
  assert.ok(r.otherChangedFiles.some((f) => f.includes("b.ts")));
  assert.ok(r.reasons.some((x) => x.includes("different file")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("6 — file changed and reverted → STATE_MISMATCH (hash identical to HEAD)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/auth.ts", AUTH_V2);
  write(repo, "src/auth.ts", AUTH_V1); // revert
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "STATE_MISMATCH");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7 — empty file created → UNPROVEN (likely failed write)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/empty.ts", "");
  const r = verifyStateClaims(repo, [claim("created", "src/empty.ts")]);
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("EMPTY")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8 — untracked file + modified claim, no before snapshot → UNPROVEN", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/untracked.ts", "const a = 1;\n");
  const r = verifyStateClaims(repo, [claim("modified", "src/untracked.ts")]);
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("untracked")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8b — untracked file + modified claim WITH before snapshot → STATE_VERIFIED", () => {
  const repo = initRepo({ "src/keep.ts": "const keep = 1;\n" });
  write(repo, "src/u.ts", "const a = 1;\n");
  const { snapshot } = writeStateSnapshot(repo, ["src/u.ts"]);
  write(repo, "src/u.ts", "const a = 2;\n");
  const r = verifyStateClaims(repo, [claim("modified", "src/u.ts")], { before: snapshot });
  assert.equal(r.verdict, "STATE_VERIFIED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("9 — tracked-file before-state derived from git HEAD (no snapshot needed)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const before = snapshotPaths(repo, ["src/auth.ts"]);
  assert.equal(before["src/auth.ts"].tracked, true);
  write(repo, "src/auth.ts", AUTH_V2);
  const after = snapshotPaths(repo, ["src/auth.ts"]);
  assert.notEqual(before["src/auth.ts"].hash, after["src/auth.ts"].hash);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("10 — dirty working tree is safe (unrelated dirt does not break verification)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "scratch.txt", "dirty\n"); // untracked dirt
  write(repo, "src/auth.ts", AUTH_V2);
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.ok(r.otherChangedFiles.some((f) => f.includes("scratch.txt")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("11 — multiple claims verified together", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1, "src/old.ts": "const old = 1;\n" });
  write(repo, "src/auth.ts", AUTH_V2);
  write(repo, "src/new.ts", "const neu = 1;\n");
  execSync("git rm -q -f src/old.ts", { cwd: repo });
  const r = verifyStateClaims(repo, [
    claim("modified", "src/auth.ts"),
    claim("created", "src/new.ts"),
    claim("deleted", "src/old.ts"),
  ]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.equal(r.results.length, 3);
  assert.ok(r.results.every((x) => x.status === "OK"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("12 — hash-only change (same line count) → STATE_VERIFIED", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 }); // 3 lines
  const sameLines = `export function login(u: string, p: string) {\n  return u !== "root";\n}\n`; // still 3 lines
  write(repo, "src/auth.ts", sameLines);
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "STATE_VERIFIED");
  assert.equal(r.results[0].after.lineCount, r.results[0].before!.lineCount);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("13 — whitespace/line-count-only change → UNPROVEN (flagged, not trusted)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/auth.ts", AUTH_V1 + "\n\n"); // only blank lines added
  const r = verifyStateClaims(repo, [claim("modified", "src/auth.ts")]);
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("WHITESPACE")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("14 — untracked creation: git records ?? not a diff (signal reported honestly)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/new.ts", "export const x = 1;\n");
  const r = verifyStateClaims(repo, [claim("created", "src/new.ts")]);
  const sig = r.results[0].signals.find((s) => s.name === "git diff");
  assert.equal(sig!.ok, null);
  assert.ok(sig!.note!.includes("untracked"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("15 — nonexistent path (modified claim) → STATE_MISMATCH", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const r = verifyStateClaims(repo, [claim("modified", "src/does-not-exist.ts")]);
  assert.equal(r.verdict, "STATE_MISMATCH");
  assert.ok(r.reasons.some((x) => x.includes("does not exist on disk")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("16 — not a git repo → INTEGRITY_FAILURE", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-sv-nogit-"));
  write(dir, "a.txt", "hi\n");
  const r = verifyStateClaims(dir, [claim("modified", "a.txt")]);
  assert.equal(r.verdict, "INTEGRITY_FAILURE");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("17 — sealed evidence: verifies after write, TAMPERED after edit", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/auth.ts", AUTH_V2);
  const result = sealStateResult(
    verifyStateClaims(repo, [claim("modified", "src/auth.ts")]),
  );
  assert.equal(result.verdict, "STATE_VERIFIED");
  assert.ok(result.sealedPath);
  assert.equal(checkStateEvidence(result.sealedPath!).status, "verified");

  const doc = JSON.parse(fs.readFileSync(result.sealedPath!, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(result.sealedPath!, JSON.stringify(doc, null, 2));
  assert.equal(checkStateEvidence(result.sealedPath!).status, "tampered");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("17b — tampered BEFORE snapshot is rejected by readStateSnapshot", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const { file } = writeStateSnapshot(repo, ["src/auth.ts"]);
  assert.ok(readStateSnapshot(file), "snapshot should read back");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.snapshot["src/auth.ts"].hash = "deadbeef";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  assert.equal(readStateSnapshot(file), null, "tampered snapshot must be rejected");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("18 — parseClaim accepts the documented forms and rejects junk", () => {
  assert.deepEqual(parseClaim("modified:src/auth.ts"), { op: "modified", path: "src/auth.ts" });
  assert.deepEqual(parseClaim("created: src/new.ts"), { op: "created", path: "src/new.ts" });
  assert.deepEqual(parseClaim("deleted:src/old.ts"), { op: "deleted", path: "src/old.ts" });
  assert.equal(parseClaim("changed:src/x.ts"), null);
  assert.equal(parseClaim("modified"), null);
});

test("19 — deleted claim on a file that never existed → UNPROVEN (cannot prove it was ever there)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const r = verifyStateClaims(repo, [claim("deleted", "src/ghost.ts")]);
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("cannot prove deletion")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("20 — targeted snapshot only touches claimed paths (performance contract)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1, "src/big.ts": "x".repeat(64) });
  const snaps = snapshotPaths(repo, ["src/auth.ts"]);
  assert.deepEqual(Object.keys(snaps), ["src/auth.ts"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("21 — evidence records the commit SHA pinning the git state", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  write(repo, "src/auth.ts", AUTH_V2);
  const r = sealStateResult(verifyStateClaims(repo, [claim("modified", "src/auth.ts")]));
  assert.ok(r.commitSha, "result carries HEAD sha");
  const doc = JSON.parse(fs.readFileSync(r.sealedPath!, "utf8"));
  assert.equal(doc.commitSha, r.commitSha);
  const { file } = writeStateSnapshot(repo, ["src/auth.ts"]);
  const snapDoc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(snapDoc.commitSha, r.commitSha, "snapshot also pins HEAD sha");
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---- gate pipeline integration (real sealed reports + real gateOutcome logic)

import { gateOutcome } from "../src/commands/gate.js";
import { seal } from "../src/evidence.js";

function fakeOutcome(repo: string): any {
  return {
    repo,
    missingBaseline: false,
    stale: false,
    risk: "Low",
    blocked: false,
    integrity: { verdict: "CLEAN", findings: [], summary: { confirmed: 0, suspicious: 0, total: 0 } },
    evidence: { status: "verified", digest: "x" },
    current: {
      tests: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      perf: {},
      securityCount: 0,
      duplicationCount: 0,
    },
    baseline: {
      tests: { total: 1, passed: 1, failed: 0, durationMs: 1 },
      perf: {},
      securityCount: 0,
      duplicationCount: 0,
    },
    deltas: {},
    baselineScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    currentScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    scoreDelta: 0,
    exitCode: 0,
  };
}

function writeStateReport(repo: string, verdict: string, reasons: string[]): string {
  const dir = path.join(repo, ".pitstop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `state-verify-test.json`);
  const doc = seal(
    { timestamp: new Date().toISOString(), repo, verdict, reasons, claims: [], results: [] },
    `state verification for ${repo}`,
  );
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

test("22 — gate surfaces STATE_MISMATCH from the latest state-verify report", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  writeStateReport(repo, "STATE_MISMATCH", ["claimed modified but hash identical"]);
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("STATE_MISMATCH")), JSON.stringify(gate.reasons));
  // a state mismatch is surfaced, but does NOT by itself fail the commit
  assert.equal(gate.exitCode, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("23 — gate hard-blocks on INTEGRITY_FAILURE state report", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  writeStateReport(repo, "INTEGRITY_FAILURE", ["not a git repository"]);
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("INTEGRITY_FAILURE")));
  assert.equal(gate.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("24 — gate hard-blocks on TAMPERED state-verify evidence", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const file = writeStateReport(repo, "STATE_VERIFIED", []);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(gate.reasons.some((r) => r.includes("TAMPERED")));
  assert.equal(gate.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("25 — gate is unaffected when no state report exists (backward compatible)", () => {
  const repo = initRepo({ "src/auth.ts": AUTH_V1 });
  const gate = gateOutcome(fakeOutcome(repo), 60);
  assert.equal(gate.exitCode, 0);
  assert.ok(gate.reasons.length === 0);
  fs.rmSync(repo, { recursive: true, force: true });
});
