import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateGate, renderGateMatrix, type LiveGateInput } from "../src/verify/gateMatrix.js";
import { seal } from "../src/evidence.js";

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-matrix-"));
  fs.mkdirSync(path.join(dir, ".pitstop"), { recursive: true });
  return dir;
}

function writeDoc(repo: string, name: string, doc: object): void {
  fs.writeFileSync(path.join(repo, ".pitstop", name), JSON.stringify(seal(doc, `matrix ${name}`), null, 2));
}

function live(overrides: Partial<LiveGateInput> = {}): LiveGateInput {
  return {
    missingBaseline: false,
    blocked: false,
    integrityVerdict: "CLEAN",
    evidenceStatus: "verified",
    risk: "Low",
    currentScore: 80,
    currentGrade: "B",
    testsPassed: 42,
    testsFailed: 0,
    stale: false,
    ...overrides,
  };
}

const SHA = "a".repeat(40);

function allPassingEvidence(repo: string): void {
  writeDoc(repo, "baseline-verify-1.json", {
    timestamp: "t", verification: { command: "node check.js" },
    baseline: { commitSha: SHA, exitCode: 1 }, candidate: { commitSha: SHA, exitCode: 0 },
    integrity: { verificationIdentityUnchanged: true }, verdict: "VERIFIED", reasons: [],
  });
  writeDoc(repo, "state-verify-1.json", { timestamp: "t", candidate: { sha: SHA }, verdict: "STATE_VERIFIED", reasons: [] });
  writeDoc(repo, "acceptance-1.json", {
    timestamp: "t", candidate: { sha: SHA }, contract: { id: "c", hash: "h" },
    verdict: "SATISFIED", totalCriteria: 8,
    criteria: Array.from({ length: 8 }, (_, i) => ({ criterionId: `c${i}`, pass: true })),
    reasons: [],
  });
  writeDoc(repo, "regression-1.json", { timestamp: "t", candidate: { sha: SHA }, verdict: "NO_REGRESSION", regressions: [], newFailures: [], reasons: [] });
  writeDoc(repo, "holdout-1.json", { timestamp: "t", candidate: { sha: SHA }, suite: { id: "s", hash: "h" }, verdict: "HOLDOUT_PASS", reasons: [] });
  writeDoc(repo, "verifier-check-1.json", { timestamp: "t", verdict: "VERIFIER_VALID", reasons: [] });
  writeDoc(repo, "pen-latest.json", { timestamp: "t", findings: [], reasons: [] });
}

test("all checks passing → VERIFIED (exit 0), every layer PASS", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "VERIFIED", JSON.stringify(d.reasons));
  assert.equal(d.exitCode, 0);
  assert.equal(d.summary.notConfigured, 0);
  for (const id of ["state", "baseline", "acceptance", "tests", "regression", "integrity", "holdout"]) {
    assert.equal(d.layers.find((l) => l.id === id)?.status, "PASS", `${id} should be PASS`);
  }
  const acceptance = d.layers.find((l) => l.id === "acceptance")!;
  assert.match(acceptance.detail, /8\/8/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("missing evidence (legacy scan-only pass) → UNPROVEN, exit 0 (backward compatible)", () => {
  const repo = mkRepo();
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "UNPROVEN");
  assert.equal(d.exitCode, 0, "legacy scan-only pass keeps exit 0");
  assert.ok(d.reasons.some((r) => r.includes("insufficient deep evidence")));
  assert.equal(d.summary.notConfigured >= 6, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("baseline FAIL (candidate still fails) → FAILED (exit 1)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "baseline-verify-1.json", {
    timestamp: "t", verification: { command: "node check.js" },
    baseline: { commitSha: SHA, exitCode: 1 }, candidate: { commitSha: SHA, exitCode: 1 },
    verdict: "FAILED", reasons: ["candidate still fails"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.exitCode, 1);
  assert.equal(d.layers.find((l) => l.id === "baseline")?.status, "FAIL");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("baseline INTEGRITY_FAILURE (verification identity changed) → CHEAT (exit 2)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "baseline-verify-1.json", {
    timestamp: "t", verification: { command: "node check.js" },
    verdict: "INTEGRITY_FAILURE",
    reasons: ["verification identity changed"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "CHEAT");
  assert.equal(d.exitCode, 2);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("regression → BLOCKED (exit 1) with the regressed checks named", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "regression-1.json", {
    timestamp: "t", candidate: { sha: SHA }, command: "npm test",
    verdict: "REGRESSION", regressions: ["check B"], newFailures: [],
    reasons: ["previously passing check(s) now failing — check B"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "BLOCKED");
  assert.equal(d.exitCode, 1);
  assert.ok(d.reasons.some((r) => r.includes("check B")));
  const layer = d.layers.find((l) => l.id === "regression")!;
  assert.equal(layer.status, "BLOCKED");
  assert.match(layer.detail, /check B/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("security failure: PROVEN high/critical finding → BLOCKED", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "pen-latest.json", {
    timestamp: "t",
    findings: [{ id: "pen-1", severity: "critical", proofStatus: "proven", title: "auth bypass" }],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "BLOCKED");
  const sec = d.layers.find((l) => l.id === "security")!;
  assert.equal(sec.status, "BLOCKED");
  assert.match(sec.detail, /PROVEN high\/critical/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("security drift: NEW findings since last sealed run → BLOCKED", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "pen-latest.json", {
    timestamp: "t",
    findings: [],
    drift: { new: [{ id: "pen-9" }] },
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "BLOCKED");
  assert.ok(d.reasons.some((r) => r.includes("drift")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("integrity failure: CONFIRMED_CHEAT → CHEAT (exit 2)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live({ blocked: true, integrityVerdict: "CONFIRMED_CHEAT" }), { threshold: 60 });
  assert.equal(d.verdict, "CHEAT");
  assert.equal(d.exitCode, 2);
  assert.equal(d.layers.find((l) => l.id === "integrity")?.status, "CHEAT");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("tampered deep-verification evidence → CHEAT (exit 2), regardless of its verdict", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  // acceptance doc edited after sealing — the seal breaks
  const p = path.join(repo, ".pitstop", "acceptance-1.json");
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "CHEAT");
  assert.equal(d.exitCode, 2);
  assert.equal(d.layers.find((l) => l.id === "acceptance")?.status, "CHEAT");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("state mismatch → FAILED (exit 1)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "state-verify-1.json", {
    timestamp: "t", candidate: { sha: SHA },
    verdict: "STATE_MISMATCH",
    reasons: ["claimed modified but content hash is IDENTICAL"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("acceptance failure → FAILED (exit 1)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "acceptance-1.json", {
    timestamp: "t", candidate: { sha: SHA }, contract: { id: "c", hash: "h" },
    verdict: "NOT_SATISFIED", totalCriteria: 8,
    criteria: Array.from({ length: 8 }, (_, i) => ({ criterionId: `c${i}`, pass: i < 7 })),
    reasons: ["1 of 8 acceptance criteria FAILED"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.exitCode, 1);
  assert.match(d.layers.find((l) => l.id === "acceptance")!.detail, /7\/8/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("holdout fail → FAILED (exit 1)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "holdout-1.json", {
    timestamp: "t", candidate: { sha: SHA }, suite: { id: "s", hash: "h" },
    verdict: "HOLDOUT_FAIL", reasons: ["hidden requirements not satisfied"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("tests failing (risk HIGH) → FAILED even with green deep layers", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live({ risk: "High", testsFailed: 2 }), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.layers.find((l) => l.id === "tests")?.status, "FAIL");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("score below threshold → FAILED", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live({ currentScore: 45, currentGrade: "F" }), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("missing scan baseline → FAILED (exit 1, backward compatible)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live({ missingBaseline: true }), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  assert.equal(d.exitCode, 1);
  assert.ok(d.reasons.some((r) => r.includes("no baseline")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("--require unmet → UNPROVEN with exit 1 (configured requirement has no passing evidence)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  // holdout never configured
  fs.rmSync(path.join(repo, ".pitstop", "holdout-1.json"));
  const d = evaluateGate(repo, live(), { threshold: 60, require: ["holdout"] });
  assert.equal(d.verdict, "UNPROVEN");
  assert.equal(d.exitCode, 1);
  assert.ok(d.reasons.some((r) => r.includes("holdout")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("verifier BROKEN → FAILED (a verifier that rejects correct states is serious)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "verifier-check-1.json", { timestamp: "t", verdict: "VERIFIER_BROKEN", reasons: [] });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "FAILED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("unproven deep layer downgrades VERIFIED → UNPROVEN (exit stays 0)", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "holdout-1.json", {
    timestamp: "t", candidate: { sha: SHA }, suite: { id: "s", hash: "h" },
    verdict: "HOLDOUT_UNPROVEN", reasons: ["cannot discriminate"],
  });
  const d = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d.verdict, "UNPROVEN");
  assert.equal(d.exitCode, 0, "legacy-compatible: scan checks pass");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("decision matrix is deterministic (same evidence → same verdict, twice)", () => {
  const repoA = mkRepo();
  const repoB = mkRepo();
  for (const repo of [repoA, repoB]) {
    allPassingEvidence(repo);
    writeDoc(repo, "regression-1.json", {
      timestamp: "t", candidate: { sha: SHA }, command: "npm test",
      verdict: "REGRESSION", regressions: ["check B"], newFailures: [],
      reasons: ["regression"],
    });
  }
  const a = evaluateGate(repoA, live(), { threshold: 60 });
  const b = evaluateGate(repoB, live(), { threshold: 60 });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.exitCode, b.exitCode);
  assert.deepEqual(a.layers.map((l) => [l.id, l.status]), b.layers.map((l) => [l.id, l.status]));
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

test("matrix precedence: CHEAT beats BLOCKED beats FAILED", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  writeDoc(repo, "regression-1.json", {
    timestamp: "t", candidate: { sha: SHA }, verdict: "REGRESSION", regressions: ["x"], reasons: [],
  });
  const d1 = evaluateGate(repo, live({ blocked: true, integrityVerdict: "CONFIRMED_CHEAT" }), { threshold: 60 });
  assert.equal(d1.verdict, "CHEAT", "CHEAT outranks BLOCKED");
  assert.equal(d1.exitCode, 2);

  writeDoc(repo, "acceptance-1.json", {
    timestamp: "t", candidate: { sha: SHA }, verdict: "NOT_SATISFIED", reasons: [],
  });
  const d2 = evaluateGate(repo, live(), { threshold: 60 });
  assert.equal(d2.verdict, "BLOCKED", "BLOCKED outranks FAILED");
  assert.equal(d2.exitCode, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("render: matrix shows only real layers, NOT_CONFIGURED for never-run, verdict line", () => {
  const repo = mkRepo();
  allPassingEvidence(repo);
  const d = evaluateGate(repo, live(), { threshold: 60 });
  const text = renderGateMatrix(d).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(text, /VERDICT: VERIFIED/);
  assert.match(text, /NONE/);
  assert.match(text, /8\/8/);
  assert.match(text, /INTACT/);
  fs.rmSync(repo, { recursive: true, force: true });
});
