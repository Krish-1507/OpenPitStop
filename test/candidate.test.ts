import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureCandidate, candidateMismatch, candidateRun } from "../src/candidate.js";
import { checkEvidence, seal } from "../src/evidence.js";
import { evaluateGate, type LiveGateInput } from "../src/verify/gateMatrix.js";
import { buildEvidenceChain } from "../src/verify/chain.js";

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-candidate-"));
  fs.mkdirSync(path.join(repo, ".pitstop"));
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;");
  return repo;
}
test("source edits, deleted files and policy changes invalidate sealed passing evidence", async () => {
  const repo = fixture();
  try {
    const binding = captureCandidate(repo);
    const doc = seal({ verdict: "SATISFIED", candidateBinding: binding }, "test");
    assert.equal(candidateMismatch(repo, doc), null);
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 2;");
    assert.match(candidateMismatch(repo, doc)!, /changed/);
    fs.unlinkSync(path.join(repo, "app.js"));
    assert.match(candidateMismatch(repo, doc)!, /changed/);
    fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;");
    fs.writeFileSync(path.join(repo, ".pitstop", "architecture.json"), "{}");
    assert.match(candidateMismatch(repo, doc)!, /changed/);
    assert.equal(checkEvidence(doc).status, "verified", "freshness is distinct from tamper detection");
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("a check which mutates its own inputs cannot bind its pass to the new state", async () => {
  const repo = fixture();
  try {
    const doc = await candidateRun(repo, async () => {
      await Promise.resolve();
      fs.writeFileSync(path.join(repo, "app.js"), "changed during verification");
      return seal({ verdict: "SATISFIED" }, "check");
    });
    assert.match(candidateMismatch(repo, doc)!, /changed/);
    assert.match(candidateMismatch(repo, seal({ verdict: "SATISFIED" }, "legacy"))!, /no candidate binding/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("every historical passing gate layer and explanation refuses a changed candidate", () => {
  const repo = fixture();
  try {
    const candidateBinding = captureCandidate(repo);
    for (const [name, verdict] of Object.entries({ "baseline-verify": "VERIFIED", "state-verify": "STATE_VERIFIED", acceptance: "SATISFIED", regression: "NO_REGRESSION", "verify-stack": "STACK_PASS", architecture: "CONFORMS", holdout: "HOLDOUT_PASS", "verifier-check": "VERIFIER_VALID" })) {
      fs.writeFileSync(path.join(repo, ".pitstop", `${name}-1.json`), JSON.stringify(seal({ verdict, candidateBinding, reasons: [], layers: [], findings: [] }, "fixture")));
    }
    fs.writeFileSync(path.join(repo, ".pitstop", "pen-latest.json"), JSON.stringify(seal({ findings: [], dynamic: { status: "ok" }, candidateBinding }, "fixture")));
    const live: LiveGateInput = { candidateBinding, missingBaseline: false, blocked: false, integrityVerdict: "CLEAN", evidenceStatus: "verified", risk: "Low", currentScore: 100, currentGrade: "A", testsPassed: 1, testsFailed: 0, stale: false };
    fs.appendFileSync(path.join(repo, "app.js"), "\nchanged");
    const gate = evaluateGate(repo, live, { threshold: 0, strict: true });
    assert.equal(gate.exitCode, 1);
    assert.equal(gate.verdict, "UNPROVEN");
    for (const layer of gate.layers.filter(l => l.evidenceRef)) assert.notEqual(layer.status, "PASS", layer.id);
    assert.equal(buildEvidenceChain(repo).summary.passed, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
