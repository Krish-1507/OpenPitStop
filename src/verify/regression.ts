import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { ensureGitRepo, resolveSha, createWorktree, removeWorktree, runVerification } from "./baseline.js";

/**
 * regression.ts — REGRESSION VERIFICATION.
 *
 * A good fix must also avoid breaking previously working behavior. This module
 * compares check-level results (per-test names where the runner exposes them,
 * suite-level otherwise) between a BASELINE and a CANDIDATE and classifies
 * every difference honestly:
 *
 *   REGRESSION    previously PASSING, now failing  (the only true regression)
 *   FIXED         previously failing, now passing
 *   UNCHANGED     same outcome on both sides (pass/pass or fail/fail)
 *   NEW_FAILURE   a check that did not exist at baseline and fails
 *   NEW_PASS      a check that did not exist at baseline and passes
 *   UNPROVEN      flaky across candidate runs, or a baseline check that
 *                 vanished from the candidate run (possibly deleted), or an
 *                 execution that could not be trusted
 *
 * Not every difference is a regression — only behavior that was VERIFIED
 * passing and now fails.
 *
 * FLAKY / NON-DETERMINISTIC LIMITS (stated honestly): with the default
 * `--runs 1` a flaky candidate test is indistinguishable from a regression and
 * WILL be classified REGRESSION. `--runs <n>` executes the candidate n times;
 * a check with both a pass and a fail across runs is classified UNPROVEN
 * (flaky). The baseline is always a single run — a flaky baseline check can
 * therefore still mislabel a check as FIXED or hide a regression.
 */

export interface CheckResult {
  id: string;
  pass: boolean;
}

export type RegressionClass =
  | "REGRESSION"
  | "FIXED"
  | "UNCHANGED"
  | "NEW_FAILURE"
  | "NEW_PASS"
  | "UNPROVEN";

export interface RegressionEntry {
  id: string;
  classification: RegressionClass;
  baselinePass: boolean | null;
  candidatePass: boolean | null;
  flaky?: boolean;
  note?: string;
}

export type RegressionVerdict = "NO_REGRESSION" | "REGRESSION" | "UNPROVEN" | "INTEGRITY_FAILURE";

export interface RegressionResult {
  repo: string;
  command: string;
  commandHash: string;
  baselineRef: string | null;
  baselineSha: string | null;
  candidateRef: string;
  candidateSha: string;
  baselineSuiteExit: number | null;
  candidateSuiteExit: number | null;
  entries: RegressionEntry[];
  regressions: string[];
  newFailures: string[];
  fixed: string[];
  unproven: string[];
  verdict: RegressionVerdict;
  reasons: string[];
  notes: string[];
  runs: number;
  sealedPath?: string;
  sealed?: OpenPitStopEvidence;
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

/** Extract per-check results from runner output at the runner's natural granularity. */
export function parseChecks(output: string, exitCode: number): CheckResult[] {
  const pass = new Map<string, boolean>();
  const add = (id: string, p: boolean) => {
    const key = id.trim();
    if (key) pass.set(key, p);
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let m: RegExpMatchArray | null;
    // TAP: ok N - name / not ok N - name (skip skip-todo markers)
    if ((m = line.match(/^not ok\s+\d+\s+-?\s*(.+)$/))) { add(m[1].replace(/# SKIP.*/i, ""), false); continue; }
    if ((m = line.match(/^ok\s+\d+\s+-?\s*(.+)$/))) {
      if (/# SKIP/i.test(m[1])) continue;
      add(m[1].replace(/# SKIP.*/i, ""), true);
      continue;
    }
    // spec reporters: ✓ / ✕ / ✗ name
    if ((m = line.match(/^[✓✔]\s+(.+)$/))) { add(m[1], true); continue; }
    if ((m = line.match(/^[✕✗×]\s+(.+)$/))) { add(m[1], false); continue; }
    // jest/mocha file granularity: PASS src/a.test.js / FAIL src/b.test.js
    if ((m = line.match(/^PASS\s+(\S+)$/))) { add(`file:${m[1]}`, true); continue; }
    if ((m = line.match(/^FAIL\s+(\S+)$/))) { add(`file:${m[1]}`, false); continue; }
    // pytest -v: path::name PASSED / FAILED
    if ((m = line.match(/^(\S+::\S+)\s+PASSED/))) { add(m[1], true); continue; }
    if ((m = line.match(/^(\S+::\S+)\s+FAILED/))) { add(m[1], false); continue; }
    // go test -v: --- PASS: TestName / --- FAIL: TestName
    if ((m = line.match(/^---\s+PASS:\s+(\S+)/))) { add(m[1], true); continue; }
    if ((m = line.match(/^---\s+FAIL:\s+(\S+)/))) { add(m[1], false); continue; }
  }
  if (pass.size === 0) {
    // unparseable output — the suite itself is the only observable check
    return [{ id: "suite", pass: exitCode === 0 }];
  }
  return [...pass.entries()].map(([id, p]) => ({ id, pass: p }));
}

function classify(
  baseline: Map<string, boolean> | null,
  candidateRuns: CheckResult[][],
): { entries: RegressionEntry[]; regressions: string[]; newFailures: string[]; fixed: string[]; unproven: string[] } {
  const bmap = baseline ?? new Map<string, boolean>();
  const entries: RegressionEntry[] = [];
  const regressions: string[] = [];
  const newFailures: string[] = [];
  const fixed: string[] = [];
  const unproven: string[] = [];

  const ids: string[] = [];
  for (const run of candidateRuns) for (const c of run) if (!ids.includes(c.id)) ids.push(c.id);
  const baselineOnly = [...bmap.keys()].filter((id) => !ids.includes(id));

  for (const id of ids) {
    const outcomes = candidateRuns.map((run) => run.find((c) => c.id === id)?.pass).filter((p): p is boolean => p !== undefined);
    const flaky = outcomes.length > 1 && outcomes.some((p) => p) && outcomes.some((p) => !p);
    const candidatePass = outcomes[outcomes.length - 1];
    const baselinePass = bmap.has(id) ? bmap.get(id)! : null;

    if (flaky) {
      entries.push({ id, classification: "UNPROVEN", baselinePass, candidatePass, flaky: true, note: `inconsistent across ${outcomes.length} candidate runs (${outcomes.filter(Boolean).length} pass / ${outcomes.length - outcomes.filter(Boolean).length} fail) — cannot classify` });
      unproven.push(id);
      continue;
    }
    if (baselinePass === null) {
      // check did not exist at baseline
      if (candidatePass) {
        entries.push({ id, classification: "NEW_PASS", baselinePass: null, candidatePass });
      } else {
        entries.push({ id, classification: "NEW_FAILURE", baselinePass: null, candidatePass, note: "new check failing — was never verified passing" });
        newFailures.push(id);
      }
      continue;
    }
    if (baselinePass && !candidatePass) {
      entries.push({ id, classification: "REGRESSION", baselinePass, candidatePass, note: "previously verified passing, now failing" });
      regressions.push(id);
    } else if (!baselinePass && candidatePass) {
      entries.push({ id, classification: "FIXED", baselinePass, candidatePass });
      fixed.push(id);
    } else {
      entries.push({ id, classification: "UNCHANGED", baselinePass, candidatePass });
    }
  }
  for (const id of baselineOnly) {
    entries.push({ id, classification: "UNPROVEN", baselinePass: bmap.get(id)!, candidatePass: null, note: "check missing from the candidate run — possibly deleted or renamed; the integrity gate flags deleted test files" });
    unproven.push(id);
  }
  return { entries, regressions, newFailures, fixed, unproven };
}

export async function runRegressionCheck(opts: {
  repo: string;
  command: string;
  baselineRef?: string;
  candidateRef?: string;
  /** Sealed baseline evidence file (alternative to --baseline ref). */
  baselineEvidenceFile?: string;
  runs?: number;
  timeoutMs?: number;
}): Promise<RegressionResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  const notes: string[] = [];
  const createdWorktrees: string[] = [];
  const runs = Math.max(1, Math.floor(opts.runs ?? 1));

  const result: RegressionResult = {
    repo,
    command: opts.command,
    commandHash: sha256(opts.command),
    baselineRef: opts.baselineRef ?? null,
    baselineSha: null,
    candidateRef: opts.candidateRef ?? "HEAD",
    candidateSha: "",
    baselineSuiteExit: null,
    candidateSuiteExit: null,
    entries: [],
    regressions: [],
    newFailures: [],
    fixed: [],
    unproven: [],
    verdict: "INTEGRITY_FAILURE",
    reasons,
    notes,
    runs,
  };

  try {
    let baselineChecks: Map<string, boolean> | null = null;

    if (opts.baselineEvidenceFile) {
      // evidence mode: baseline comes from a sealed check-results document
      try {
        const raw = fs.readFileSync(opts.baselineEvidenceFile, "utf8");
        const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
        const check = checkEvidence(doc);
        if (check.status !== "verified") {
          reasons.push(`baseline evidence TAMPERED (${opts.baselineEvidenceFile}): ${check.reason ?? "digest mismatch"} — refusing to classify against untrusted evidence`);
          return result;
        }
        const checks = (doc.checks ?? []) as CheckResult[];
        if (!Array.isArray(checks) || checks.length === 0) {
          reasons.push(`baseline evidence carries no checks — nothing to compare against`);
          return result;
        }
        baselineChecks = new Map(checks.map((c) => [c.id, c.pass]));
        result.baselineRef = `evidence:${path.basename(opts.baselineEvidenceFile)}`;
      } catch (e: any) {
        reasons.push(`baseline evidence unreadable: ${e.message}`);
        return result;
      }
    } else if (!ensureGitRepo(repo)) {
      reasons.push(`not a git repository: ${repo} (use --baseline-evidence for non-git comparison)`);
      return result;
    }

    const candidateSha = resolveSha(repo, result.candidateRef);
    if (!candidateSha) {
      reasons.push(`candidate checkout failed: cannot resolve ref '${result.candidateRef}'`);
      return result;
    }
    result.candidateSha = candidateSha;

    // ---- candidate runs
    const candidateRuns: CheckResult[][] = [];
    let candidateSuiteExit = 0;
    for (let i = 0; i < runs; i++) {
      const wt = await createWorktree(repo, candidateSha);
      createdWorktrees.push(wt.path);
      const run = await runVerification(wt.path, { id: "regression-candidate", command: opts.command, timeoutMs: opts.timeoutMs });
      candidateSuiteExit = run.exitCode;
      if (run.timedOut) {
        reasons.push(`candidate verification timed out on run ${i + 1} — cannot classify`);
        return result;
      }
      candidateRuns.push(parseChecks(run.stdout + "\n" + run.stderr, run.exitCode));
      if (i === 0 && runs > 1) notes.push(`candidate executed ${runs} times for flakiness detection`);
    }
    result.candidateSuiteExit = candidateSuiteExit;

    // ---- baseline
    let baselineSuiteExit: number | null = null;
    if (opts.baselineEvidenceFile) {
      baselineSuiteExit = null; // recorded evidence may predate exit-code capture
    } else {
      const baselineRef = opts.baselineRef;
      if (!baselineRef) {
        reasons.push("no baseline: pass --baseline <ref> or --baseline-evidence <file>");
        return result;
      }
      const baselineSha = resolveSha(repo, baselineRef);
      if (!baselineSha) {
        reasons.push(`baseline checkout failed: cannot resolve ref '${baselineRef}'`);
        return result;
      }
      result.baselineSha = baselineSha;
      const wt = await createWorktree(repo, baselineSha);
      createdWorktrees.push(wt.path);
      const run = await runVerification(wt.path, { id: "regression-baseline", command: opts.command, timeoutMs: opts.timeoutMs });
      if (run.timedOut || run.exitCode < 0) {
        result.verdict = "UNPROVEN";
        reasons.push(`baseline verification could not execute (exit ${run.exitCode}${run.timedOut ? ", timed out" : ""}) — without a trustworthy baseline, differences cannot be classified`);
        return result;
      }
      baselineSuiteExit = run.exitCode;
      baselineChecks = new Map(parseChecks(run.stdout + "\n" + run.stderr, run.exitCode).map((c) => [c.id, c.pass]));
    }
    result.baselineSuiteExit = baselineSuiteExit;

    // ---- classify
    const cls = classify(baselineChecks, candidateRuns);
    result.entries = cls.entries;
    result.regressions = cls.regressions;
    result.newFailures = cls.newFailures;
    result.fixed = cls.fixed;
    result.unproven = cls.unproven;

    if (cls.regressions.length > 0) {
      result.verdict = "REGRESSION";
      reasons.push(
        `${cls.regressions.length} REGRESSION${cls.regressions.length > 1 ? "S" : ""}: previously passing check(s) now failing — ${cls.regressions.join(", ")}`,
      );
    } else if (cls.newFailures.length > 0) {
      result.verdict = "REGRESSION";
      reasons.push(
        `${cls.newFailures.length} NEW FAILURE${cls.newFailures.length > 1 ? "S" : ""}: ${cls.newFailures.join(", ")} — newly added checks fail (not regressions of old behavior, but the suite is red)`,
      );
    } else if (cls.unproven.length > 0) {
      result.verdict = "UNPROVEN";
      reasons.push(`${cls.unproven.length} check(s) unproven (flaky or vanished): ${cls.unproven.join(", ")}`);
    } else {
      result.verdict = "NO_REGRESSION";
      reasons.push(
        `no regressions across ${result.entries.length} check(s)` +
          (cls.fixed.length ? ` · ${cls.fixed.length} fixed` : "") +
          (result.baselineRef && !result.baselineRef.startsWith("evidence:") ? "" : ""),
      );
    }
    return result;
  } finally {
    for (const wt of createdWorktrees) {
      await removeWorktree(repo, wt);
    }
  }
}

/** Seal a regression result into .pitstop/ (also the machine-readable gate input). */
export function sealRegressionResult(result: RegressionResult): RegressionResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `regression-${ts}.json`);
  const doc = {
    timestamp: new Date().toISOString(),
    repo: result.repo,
    command: result.command,
    commandHash: result.commandHash,
    baseline: { ref: result.baselineRef, sha: result.baselineSha, suiteExit: result.baselineSuiteExit },
    candidate: { ref: result.candidateRef, sha: result.candidateSha, suiteExit: result.candidateSuiteExit, runs: result.runs },
    entries: result.entries,
    regressions: result.regressions,
    newFailures: result.newFailures,
    fixed: result.fixed,
    unproven: result.unproven,
    verdict: result.verdict,
    reasons: result.reasons,
    notes: result.notes,
  };
  const sealed = seal(doc, `regression check for ${result.command}`);
  fs.writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  return { ...result, sealedPath, sealed: (sealed as any).evidence };
}

/**
 * Record a check-results baseline for evidence-mode comparison
 * (`pitstop regression-check --record`): runs the command once at the current
 * state and seals the per-check results as the regression baseline.
 */
export function recordBaselineEvidence(repo: string, command: string, checks: CheckResult[], meta: Record<string, unknown> = {}): string {
  const outDir = path.join(repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "regression-baseline.json");
  const sealed = seal({ timestamp: new Date().toISOString(), repo, command, commandHash: sha256(command), checks, ...meta }, `regression baseline for ${repo}`);
  fs.writeFileSync(file, JSON.stringify(sealed, null, 2));
  return file;
}

export function checkRegressionEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return checkEvidence(JSON.parse(clean));
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}
