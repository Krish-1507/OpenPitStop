import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { safeExec } from "../analyzers/util.js";
import {
  ensureGitRepo,
  resolveSha,
  createWorktree,
  removeWorktree,
  runVerification,
} from "./baseline.js";

/**
 * holdout.ts — FINAL HOLDOUT VERIFICATION (anti-overfitting).
 *
 * An agent that iterates against visible checks learns the EVALUATOR, not the
 * task: it can optimize the exact tests, error messages and acceptance criteria
 * it sees while violating the underlying requirement. The defense is separation:
 *
 *   ITERATIVE  — visible tests + feedback (everything the agent normally sees)
 *   HOLDOUT    — hidden checks, run ONCE, at the final stage, in a fresh
 *                isolated worktree of the candidate commit
 *
 * SECURITY MODEL (honest about its limits):
 *  - Holdout suites live OUTSIDE the candidate's modifiable workspace. A hidden
 *    file INSIDE the repo is NOT a holdout — if the agent can read it, it is
 *    visible. Suites are resolved from an explicit directory or
 *    `$PITSTOP_HOLDOUT_HOME/<id>` (default ~/.openpitstop/holdouts/<id>).
 *  - Every holdout file is hashed before and after execution; any change is
 *    HOLDOUT_INTEGRITY_FAILURE.
 *  - The candidate worktree is fresh from the commit and discarded; injected
 *    holdout files never enter the user's working tree.
 *  - Agent-facing output is REDACTED: check ids and verdicts only. stdout,
 *    stderr, commands and expected values are sealed into full evidence written
 *    OUTSIDE the repo, where an iterating agent does not receive feedback.
 *
 * WHAT THIS PROVES: the candidate satisfies checks it could not see or modify.
 * WHAT THIS DOES NOT PROVE: correctness in general — a holdout suite is a
 * sample, and a suite that only ever returns PASS is worthless (baseline mode
 * exists precisely to prove the suite can fail).
 */

export interface HoldoutCheck {
  id: string;
  /** Shell command run with cwd = fresh candidate worktree. */
  command: string;
  /** Holdout files copied INTO the fresh worktree before execution (discarded after). */
  inject?: { src: string; dest: string }[];
  /** What passing means for the candidate (defaults: exit 0). */
  expected?: { exitCode?: number; stdoutContains?: string; stderrContains?: string };
  severity?: "high" | "medium" | "low";
}

export interface HoldoutSuite {
  id: string;
  version?: number;
  description?: string;
  checks: HoldoutCheck[];
  timeoutMs?: number;
}

export interface HoldoutCheckResult {
  id: string;
  severity: string;
  candidate: { exitCode: number; pass: boolean; timedOut: boolean; durationMs: number };
  baseline?: { exitCode: number; pass: boolean; timedOut: boolean; durationMs: number };
}

export type HoldoutVerdict =
  | "HOLDOUT_PASS"
  | "HOLDOUT_FAIL"
  | "HOLDOUT_UNPROVEN"
  | "HOLDOUT_INTEGRITY_FAILURE";

export interface HoldoutResult {
  repo: string;
  suiteId: string;
  suiteDir: string;
  suiteHash: string;
  baselineRef: string | null;
  baselineSha: string | null;
  candidateRef: string;
  candidateSha: string;
  checks: HoldoutCheckResult[];
  verdict: HoldoutVerdict;
  reasons: string[];
  notes: string[];
  /** true when a baseline was given AND failed >=1 check (the suite can discriminate). */
  baselineDiscriminative: boolean;
  /** Redacted sealed summary written into <repo>/.pitstop (agent-visible, by design). */
  summaryPath?: string;
  summaryEvidence?: OpenPitStopEvidence;
  /** Full sealed evidence (unredacted) written OUTSIDE the repo. */
  fullEvidencePath?: string;
  /** Unredacted per-run execution details — sealed into full evidence, NEVER printed. */
  details: HoldoutExecDetail[];
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

export const HOLDOUT_MANIFEST = "holdout.json";

function resolveSuiteDir(suiteSpec: string): string | null {
  const direct = path.isAbsolute(suiteSpec) ? suiteSpec : path.resolve(suiteSpec);
  if (fs.existsSync(path.join(direct, HOLDOUT_MANIFEST))) return direct;
  const home = process.env.PITSTOP_HOLDOUT_HOME
    ? path.resolve(process.env.PITSTOP_HOLDOUT_HOME)
    : path.join(os.homedir(), ".openpitstop", "holdouts");
  const byId = path.join(home, suiteSpec);
  if (fs.existsSync(path.join(byId, HOLDOUT_MANIFEST))) return byId;
  return null;
}

export function loadHoldoutSuite(suiteSpec: string): { dir: string; suite: HoldoutSuite } | { error: string } {
  const dir = resolveSuiteDir(suiteSpec);
  if (!dir) {
    return {
      error:
        `holdout suite not found: "${suiteSpec}" — give a directory containing ${HOLDOUT_MANIFEST} ` +
        `or an id under PITSTOP_HOLDOUT_HOME (default ~/.openpitstop/holdouts/<id>). ` +
        `A holdout inside the repository is NOT a holdout; keep it outside the repo.`,
    };
  }
  let suite: HoldoutSuite;
  try {
    const raw = fs.readFileSync(path.join(dir, HOLDOUT_MANIFEST), "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    suite = JSON.parse(clean) as HoldoutSuite;
  } catch (e: any) {
    return { error: `invalid holdout manifest: ${e.message}` };
  }
  if (!suite || typeof suite.id !== "string" || !suite.id.trim()) {
    return { error: "invalid holdout manifest: missing suite id" };
  }
  if (!Array.isArray(suite.checks) || suite.checks.length === 0) {
    return { error: "invalid holdout manifest: checks must be a non-empty array" };
  }
  for (const c of suite.checks) {
    if (!c || typeof c.id !== "string" || !c.id.trim() || typeof c.command !== "string" || !c.command.trim()) {
      return { error: `invalid holdout manifest: every check needs an id and a command` };
    }
    if (c.inject) {
      for (const inj of c.inject) {
        if (!inj?.src || !inj?.dest || path.isAbsolute(inj.dest) || inj.dest.split(/[\\/]/).includes("..")) {
          return { error: `invalid holdout manifest: check "${c.id}" inject dest must be a repo-relative path` };
        }
      }
    }
  }
  return { dir, suite };
}

/** Hash every file in the suite (manifest included, evidence/ excluded). */
export function hashSuiteFiles(dir: string): { files: Record<string, string>; hash: string } {
  const files: Record<string, string> = {};
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (e.name === "evidence") continue;
        stack.push(abs);
      } else if (e.isFile()) {
        files[rel] = sha256(fs.readFileSync(abs, "utf8"));
      }
    }
  }
  const hash = sha256(JSON.stringify(Object.fromEntries(Object.entries(files).sort())));
  return { files, hash };
}

function injectHoldoutFiles(
  worktree: string,
  suiteDir: string,
  checks: HoldoutCheck[],
): string[] {
  const errors: string[] = [];
  const root = path.resolve(worktree);
  for (const c of checks) {
    for (const inj of c.inject ?? []) {
      const src = path.join(suiteDir, inj.src);
      const dest = path.resolve(root, inj.dest);
      if (!dest.startsWith(root + path.sep)) {
        errors.push(`inject dest escapes the worktree: ${inj.dest}`);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      } catch (e: any) {
        errors.push(`inject failed for ${inj.src} → ${inj.dest}: ${e.message}`);
      }
    }
  }
  return errors;
}

function checkPasses(
  run: { exitCode: number; stdout: string; stderr: string; timedOut: boolean },
  expected: HoldoutCheck["expected"],
): boolean {
  if (run.timedOut) return false;
  const want = expected?.exitCode ?? 0;
  if (run.exitCode !== want) return false;
  if (expected?.stdoutContains && !run.stdout.includes(expected.stdoutContains)) return false;
  if (expected?.stderrContains && !run.stderr.includes(expected.stderrContains)) return false;
  return true;
}

export interface HoldoutExecDetail {
  checkId: string;
  side: "candidate" | "baseline";
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export async function runHoldoutSuite(opts: {
  repo: string;
  suiteSpec: string;
  baselineRef?: string;
  candidateRef?: string;
  timeoutMs?: number;
}): Promise<HoldoutResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  const notes: string[] = [];
  const createdWorktrees: string[] = [];
  const details: HoldoutExecDetail[] = [];

  const result: HoldoutResult = {
    repo,
    suiteId: opts.suiteSpec,
    suiteDir: "",
    suiteHash: "",
    baselineRef: opts.baselineRef ?? null,
    baselineSha: null,
    candidateRef: opts.candidateRef ?? "HEAD",
    candidateSha: "",
    checks: [],
    verdict: "HOLDOUT_INTEGRITY_FAILURE",
    reasons,
    notes,
    baselineDiscriminative: false,
    details,
  };

  try {
    if (!ensureGitRepo(repo)) {
      reasons.push(`not a git repository: ${repo}`);
      return result;
    }

    const loaded = loadHoldoutSuite(opts.suiteSpec);
    if ("error" in loaded) {
      reasons.push(loaded.error);
      return result;
    }
    const { dir: suiteDir, suite } = loaded;
    result.suiteDir = suiteDir;
    result.suiteId = suite.id;

    const pre = hashSuiteFiles(suiteDir);
    result.suiteHash = pre.hash;

    const candidateSha = resolveSha(repo, result.candidateRef);
    if (!candidateSha) {
      reasons.push(`candidate checkout failed: cannot resolve ref '${result.candidateRef}'`);
      return result;
    }
    result.candidateSha = candidateSha;

    let baselineSha: string | null = null;
    if (result.baselineRef) {
      baselineSha = resolveSha(repo, result.baselineRef);
      if (!baselineSha) {
        reasons.push(`baseline checkout failed: cannot resolve ref '${result.baselineRef}'`);
        return result;
      }
      result.baselineSha = baselineSha;
    }

    const timeoutMs = opts.timeoutMs ?? suite.timeoutMs ?? 120000;

    const runSide = async (
      sha: string,
      side: "candidate" | "baseline",
    ): Promise<{ errors?: string[]; results: Map<string, { exitCode: number; pass: boolean; timedOut: boolean; durationMs: number }> }> => {
      const wt = await createWorktree(repo, sha);
      createdWorktrees.push(wt.path);
      const injectErrors = injectHoldoutFiles(wt.path, suiteDir, suite.checks);
      if (injectErrors.length > 0) {
        return { errors: injectErrors, results: new Map() };
      }
      const results = new Map<string, { exitCode: number; pass: boolean; timedOut: boolean; durationMs: number }>();
      for (const c of suite.checks) {
        const run = await runVerification(wt.path, {
          id: `holdout:${suite.id}:${c.id}`,
          command: c.command,
          env: { PITSTOP_HOLDOUT_DIR: suiteDir, PITSTOP_HOLDOUT_SUITE: suite.id },
          timeoutMs,
        });
        details.push({
          checkId: c.id, side,
          exitCode: run.exitCode, stdout: run.stdout, stderr: run.stderr,
          timedOut: run.timedOut, durationMs: run.durationMs,
        });
        results.set(c.id, {
          exitCode: run.exitCode,
          pass: checkPasses(run, c.expected),
          timedOut: run.timedOut,
          durationMs: run.durationMs,
        });
      }
      return { results };
    };

    // ---- candidate (fresh isolated worktree of the candidate commit)
    const candRun = await runSide(candidateSha, "candidate");
    if (candRun.errors) {
      reasons.push(...candRun.errors.map((e) => `holdout injection failed: ${e}`));
      return result;
    }
    result.checks = suite.checks.map((c) => {
      const cr = candRun.results.get(c.id)!;
      return {
        id: c.id,
        severity: c.severity ?? "medium",
        candidate: { exitCode: cr.exitCode, pass: cr.pass, timedOut: cr.timedOut, durationMs: cr.durationMs },
      };
    });

    // ---- baseline (same holdout, expected to fail somewhere)
    if (baselineSha) {
      const baseRun = await runSide(baselineSha, "baseline");
      if (baseRun.errors) {
        reasons.push(...baseRun.errors.map((e) => `holdout injection failed: ${e}`));
        return result;
      }
      for (const c of result.checks) {
        const br = baseRun.results.get(c.id);
        if (br) c.baseline = { exitCode: br.exitCode, pass: br.pass, timedOut: br.timedOut, durationMs: br.durationMs };
      }
      result.baselineDiscriminative = result.checks.some((c) => c.baseline && !c.baseline.pass);
    }

    // ---- post-execution tamper check on the holdout suite itself
    const post = hashSuiteFiles(suiteDir);
    if (post.hash !== pre.hash) {
      const changed = Object.keys({ ...pre.files, ...post.files }).filter(
        (f) => pre.files[f] !== post.files[f],
      );
      reasons.push(
        `holdout suite was MODIFIED during verification: ${changed.join(", ")} — the holdout is not trustworthy`,
      );
      result.verdict = "HOLDOUT_INTEGRITY_FAILURE";
      return result;
    }

    // ---- verdict
    const failed = result.checks.filter((c) => !c.candidate.pass);
    if (failed.length > 0) {
      result.verdict = "HOLDOUT_FAIL";
      reasons.push(
        `${failed.length} of ${result.checks.length} holdout checks FAILED on the candidate ` +
          `(${failed.map((f) => f.id).join(", ")}) — the candidate does not satisfy the hidden requirements`,
      );
      if (result.baselineRef && !result.baselineDiscriminative) {
        notes.push("baseline also passed the holdout — this suite does not discriminate; treat the FAIL as real but the suite as weak");
      }
      return result;
    }

    if (result.baselineRef && !result.baselineDiscriminative) {
      result.verdict = "HOLDOUT_UNPROVEN";
      reasons.push(
        "candidate passed every holdout check, but the BASELINE also passed — the suite cannot distinguish fixed from broken, so this PASS is not strong evidence",
      );
      return result;
    }

    result.verdict = "HOLDOUT_PASS";
    reasons.push(
      result.baselineRef
        ? `all ${result.checks.length} holdout checks PASS on the candidate and the baseline FAILED the suite — hidden requirements are genuinely satisfied`
        : `all ${result.checks.length} holdout checks PASS on the candidate (no baseline supplied — pass is not baseline-backed)`,
    );
    if (!result.baselineRef) {
      notes.push("no baseline was verified — supply --baseline so the suite proves it can fail");
    }
    return result;
  } finally {
    for (const wt of createdWorktrees) {
      await removeWorktree(repo, wt);
    }
  }
}

/**
 * Write the REDACTED sealed summary into <repo>/.pitstop (agent-visible by
 * design — it must not leak holdout contents) and the FULL sealed evidence
 * outside the repo. Returns both paths.
 */
export function sealHoldoutResults(
  result: HoldoutResult,
  opts: { environment?: Record<string, string> } = {},
): { summaryPath: string; fullEvidencePath: string } {
  const details = result.details;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  // ---- full evidence (outside the repo, next to the holdout suite by default)
  const evidenceDir = path.join(result.suiteDir, "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const fullEvidencePath = path.join(evidenceDir, `holdout-full-${ts}.json`);
  const fullDoc = seal(
    {
      timestamp: new Date().toISOString(),
      kind: "openpitstop-holdout-full-evidence",
      repo: result.repo,
      suite: {
        id: result.suiteId,
        dir: result.suiteDir,
        hash: result.suiteHash,
        manifestPath: path.join(result.suiteDir, HOLDOUT_MANIFEST),
      },
      baseline: { ref: result.baselineRef, sha: result.baselineSha, discriminative: result.baselineDiscriminative },
      candidate: { ref: result.candidateRef, sha: result.candidateSha },
      environment: {
        platform: process.platform,
        node: process.version,
        ...(opts.environment ?? {}),
      },
      checks: result.checks,
      verdict: result.verdict,
      reasons: result.reasons,
      notes: result.notes,
      execution: details,
    },
    `holdout full evidence for ${result.suiteId}`,
  );
  fs.writeFileSync(fullEvidencePath, JSON.stringify(fullDoc, null, 2));

  // ---- redacted summary (into the repo; the agent MAY read this — so it must not leak)
  const pitstopDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(pitstopDir, { recursive: true });
  const summaryPath = path.join(pitstopDir, `holdout-${ts}.json`);
  const summaryDoc = seal(
    {
      timestamp: new Date().toISOString(),
      kind: "openpitstop-holdout-summary",
      repo: result.repo,
      suite: { id: result.suiteId, hash: result.suiteHash },
      baseline: {
        ref: result.baselineRef,
        sha: result.baselineSha,
        discriminative: result.baselineDiscriminative,
      },
      candidate: { ref: result.candidateRef, sha: result.candidateSha },
      checks: result.checks.map((c) => ({
        id: c.id,
        severity: c.severity,
        candidatePass: c.candidate.pass,
        baselineFail: c.baseline ? !c.baseline.pass : null,
      })),
      verdict: result.verdict,
      reasons: result.reasons,
      notes: result.notes,
      fullEvidenceDigest: (fullDoc as any).evidence.digest,
    },
    `holdout summary for ${result.suiteId}`,
  );
  fs.writeFileSync(summaryPath, JSON.stringify(summaryDoc, null, 2));

  result.summaryPath = summaryPath;
  result.summaryEvidence = (summaryDoc as any).evidence;
  result.fullEvidencePath = fullEvidencePath;
  return { summaryPath, fullEvidencePath };
}

export function checkHoldoutEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return checkEvidence(JSON.parse(clean));
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}
