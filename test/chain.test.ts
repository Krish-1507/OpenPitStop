import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildEvidenceChain,
  sealEvidenceChain,
  canonicalChain,
  renderExplain,
} from "../src/verify/chain.js";
import { seal, checkEvidence, canonicalize } from "../src/evidence.js";

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-chain-"));
  execGit(dir, "init -q");
  execGit(dir, 'config user.email "t@t.t"');
  execGit(dir, 'config user.name "Test"');
  fs.mkdirSync(path.join(dir, ".pitstop"), { recursive: true });
  return dir;
}

function execGit(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
}
import { execSync } from "node:child_process";

function writeEvidence(repo: string, name: string, doc: object): string {
  const p = path.join(repo, ".pitstop", name);
  fs.writeFileSync(p, JSON.stringify(seal(doc, `test evidence ${name}`), null, 2));
  return p;
}

const SHA = "a".repeat(40);

function baselineDoc(verdict: string, sha = SHA) {
  return {
    timestamp: "2026-08-25T00:00:00.000Z",
    repo: "x",
    verification: { id: "c1", command: "node check.js" },
    baseline: { commitSha: sha, exitCode: 1 },
    candidate: { commitSha: sha, exitCode: 0 },
    integrity: { verificationIdentityUnchanged: true },
    verdict,
    reasons: [verdict === "VERIFIED" ? "baseline demonstrated failure and candidate passed" : verdict],
  };
}

test("1 — all checks pass → VERIFIED with every item PASS", () => {
  const repo = mkRepo();
  writeEvidence(repo, "baseline-verify-1.json", baselineDoc("VERIFIED"));
  writeEvidence(repo, "state-verify-1.json", { timestamp: "t", candidate: { sha: SHA }, verdict: "STATE_VERIFIED", reasons: [] });
  writeEvidence(repo, "acceptance-1.json", { timestamp: "t", candidate: { sha: SHA }, contract: { id: "c", hash: "h" }, verdict: "SATISFIED", reasons: [] });
  writeEvidence(repo, "regression-1.json", { timestamp: "t", candidate: { sha: SHA }, command: "npm test", verdict: "NO_REGRESSION", regressions: [], reasons: [] });
  writeEvidence(repo, "verify-1.json", { timestamp: "t", blocked: false, integrity: { verdict: "CLEAN" }, evidence: { status: "verified", digest: "d" }, reasons: [] });

  const chain = buildEvidenceChain(repo);
  assert.equal(chain.verdict, "VERIFIED", chain.reasons.join("; "));
  assert.equal(chain.summary.tampered, 0);
  assert.equal(chain.summary.failed, 0);
  const baseline = chain.items.find((i) => i.category === "BASELINE")!;
  assert.equal(baseline.status, "PASS");
  assert.equal(baseline.commitSha, SHA);
  assert.match(baseline.reason, /baseline demonstrated failure/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("2 — partial checks: strong pass + never-run components → NOT_CONFIGURED, still VERIFIED", () => {
  const repo = mkRepo();
  writeEvidence(repo, "baseline-verify-1.json", baselineDoc("VERIFIED"));
  // state/acceptance/regression/integrity/verifier/holdout never run
  const chain = buildEvidenceChain(repo);
  assert.equal(chain.verdict, "VERIFIED");
  const notConfigured = chain.items.filter((i) => i.status === "NOT_CONFIGURED");
  assert.ok(notConfigured.length >= 6);
  assert.ok(notConfigured.every((i) => /never run/.test(i.reason)), "missing components are explicitly NOT_CONFIGURED, not passes");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("3 — skipped checks are SKIPPED (scan recorded the category as skipped)", () => {
  const repo = mkRepo();
  writeEvidence(repo, "scan-latest.json", {
    timestamp: "t",
    tests: { status: "ok", total: 3, passed: 3, failed: 0 },
    security: { status: "skipped", issues: [] },
  });
  const chain = buildEvidenceChain(repo);
  const tests = chain.items.find((i) => i.category === "TESTS")!;
  const security = chain.items.find((i) => i.category === "SECURITY")!;
  assert.equal(tests.status, "PASS");
  assert.equal(security.status, "SKIPPED");
  assert.match(security.reason, /skipped/);
  assert.equal(chain.verdict, "UNPROVEN", "scan-only evidence is not a strong verdict");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("4 — failure: regression → BLOCKED with the regressed check named", () => {
  const repo = mkRepo();
  writeEvidence(repo, "regression-1.json", {
    timestamp: "t",
    candidate: { sha: SHA },
    command: "npm test",
    verdict: "REGRESSION",
    regressions: ["check B"],
    reasons: ["1 REGRESSION: previously passing check(s) now failing — check B"],
  });
  const chain = buildEvidenceChain(repo);
  assert.equal(chain.verdict, "BLOCKED");
  const reg = chain.items.find((i) => i.category === "REGRESSION")!;
  assert.equal(reg.status, "FAIL");
  assert.match(reg.reason, /check B/);
  assert.equal(chain.summary.regressions, 1);
  assert.ok(chain.reasons.some((r) => r.includes("check B")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("5 — integrity failure: CONFIRMED_CHEAT → BLOCKED", () => {
  const repo = mkRepo();
  writeEvidence(repo, "verify-1.json", {
    timestamp: "t",
    blocked: true,
    integrity: { verdict: "CONFIRMED_CHEAT" },
    evidence: { status: "verified", digest: "d" },
    reasons: [],
  });
  const chain = buildEvidenceChain(repo);
  assert.equal(chain.verdict, "BLOCKED");
  const integrity = chain.items.find((i) => i.category === "INTEGRITY")!;
  assert.equal(integrity.status, "FAIL");
  assert.equal(chain.summary.integrityViolations, 1);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("6 — missing evidence → NOT_CONFIGURED, never fabricated green", () => {
  const repo = mkRepo();
  const chain = buildEvidenceChain(repo);
  assert.ok(chain.items.every((i) => i.status === "NOT_CONFIGURED"));
  assert.equal(chain.verdict, "UNPROVEN");
  assert.ok(chain.reasons.some((r) => r.includes("no strong verification")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7 — tampered evidence → TAMPERED item and BLOCKED verdict", () => {
  const repo = mkRepo();
  const p = writeEvidence(repo, "acceptance-1.json", {
    timestamp: "t", candidate: { sha: SHA }, verdict: "SATISFIED", reasons: [],
  });
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  const chain = buildEvidenceChain(repo);
  const acceptance = chain.items.find((i) => i.category === "ACCEPTANCE")!;
  assert.equal(acceptance.status, "TAMPERED");
  assert.equal(chain.verdict, "BLOCKED");
  assert.ok(chain.reasons.some((r) => r.includes("tampered")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("7b — malformed (unreadable) evidence → TAMPERED, BLOCKED", () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, ".pitstop", "holdout-1.json"), "{not json at all");
  const chain = buildEvidenceChain(repo);
  const holdout = chain.items.find((i) => i.category === "HOLDOUT")!;
  assert.equal(holdout.status, "TAMPERED");
  assert.match(holdout.reason, /unreadable or malformed/);
  assert.equal(chain.verdict, "BLOCKED");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("8 — explain output: human-readable chain with verdict and why", () => {
  const repo = mkRepo();
  writeEvidence(repo, "regression-1.json", {
    timestamp: "t",
    candidate: { sha: SHA },
    command: "npm test",
    verdict: "REGRESSION",
    regressions: ["check B"],
    reasons: ["previously passing check(s) now failing — check B"],
  });
  writeEvidence(repo, "baseline-verify-1.json", baselineDoc("VERIFIED"));
  const chain = buildEvidenceChain(repo);
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const text = stripAnsi(renderExplain(chain, true));
  assert.match(text, /OPENPITSTOP VERDICT/);
  assert.match(text, /BASELINE/);
  assert.match(text, /REGRESSION/);
  assert.match(text, /NOT_CONFIGURED/);
  assert.match(text, /VERDICT/);
  assert.match(text, /BLOCKED/);
  assert.match(text, /check B/);
  assert.match(text, /Evidence: \d+ items/);
  // sealed chain is citable and tamper-evident
  const sealed = sealEvidenceChain(chain);
  assert.equal(checkEvidence(JSON.parse(fs.readFileSync(sealed.path, "utf8"))).status, "verified");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("9 — deterministic evidence serialization (same inputs → same canonical chain)", () => {
  const repoA = mkRepo();
  const repoB = mkRepo();
  for (const repo of [repoA, repoB]) {
    writeEvidence(repo, "baseline-verify-1.json", baselineDoc("VERIFIED"));
    writeEvidence(repo, "acceptance-1.json", { timestamp: "t", candidate: { sha: SHA }, verdict: "SATISFIED", reasons: [] });
  }
  const a = buildEvidenceChain(repoA);
  const b = buildEvidenceChain(repoB);
  // normalize repo-specific fields, then compare canonical serializations
  for (const c of [a, b]) {
    c.repo = "REPO";
    c.items.forEach((i) => {
      i.evidenceRef = path.basename(i.evidenceRef);
    });
  }
  assert.equal(canonicalChain(a), canonicalChain(b));
  // and canonicalize is stable under key reordering
  assert.equal(canonicalize(JSON.parse(JSON.stringify(a.items))), canonicalize(a.items));
  fs.rmSync(repoA, { recursive: true, force: true });
  fs.rmSync(repoB, { recursive: true, force: true });
});

test("10 — unproven components keep the verdict honest (no VERIFIED with unproven items)", () => {
  const repo = mkRepo();
  writeEvidence(repo, "baseline-verify-1.json", baselineDoc("VERIFIED"));
  writeEvidence(repo, "holdout-1.json", {
    timestamp: "t", candidate: { sha: SHA }, suite: { id: "s", hash: "h" },
    verdict: "HOLDOUT_UNPROVEN",
    reasons: ["baseline also passed the holdout — cannot discriminate"],
  });
  const chain = buildEvidenceChain(repo);
  assert.equal(chain.verdict, "UNPROVEN", "an unproven check must downgrade the verdict");
  const holdout = chain.items.find((i) => i.category === "HOLDOUT")!;
  assert.equal(holdout.status, "UNPROVEN");
  fs.rmSync(repo, { recursive: true, force: true });
});
