import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import {
  ensureGitRepo,
  resolveSha,
  createWorktree,
  removeWorktree,
  runVerification,
} from "./baseline.js";
import type { VerificationDef } from "./baseline.js";

/**
 * verifier.ts — VERIFIER SELF-TEST / FALSIFIABILITY.
 *
 * A referee that only produces PASS when something works, but cannot produce
 * FAIL when something is wrong, is not a referee. This module validates the
 * VERIFIER ITSELF with a controlled negative case:
 *
 *   KNOWN-GOOD state → verification must PASS
 *   KNOWN-BAD  state → verification must FAIL
 *
 *   VERIFIER_VALID   good→PASS, bad→FAIL   (falsifiable — trustworthy)
 *   VERIFIER_WEAK    good→PASS, bad→PASS   (cannot detect the seeded fault)
 *   VERIFIER_BROKEN  good→FAIL             (verification fails even when correct)
 *   INTEGRITY_FAILURE                    infra problems (bad ref, invalid fixture)
 *
 * SAFETY: self-testing is explicit, controlled, isolated and reproducible.
 * The known-bad state is either an explicit `--bad-ref` commit OR explicit
 * mutations applied INSIDE A TEMPORARY DETACHED WORKTREE. The user's working
 * tree is never mutated. OpenPitStop never auto-mutates a repository.
 *
 * WHAT THIS PROVES: the verification mechanism can fail — i.e. its PASS
 * carries information. WHAT THIS DOES NOT PROVE: that the verification
 * covers every property that matters; one seeded fault only demonstrates
 * falsifiability for that fault class.
 */

export type Mutation =
  | { op: "write"; path: string; content: string }
  | { op: "delete"; path: string };

export interface VerifierCheckDef {
  /** Verifier identifier, e.g. "repro:security-abc" or "suite:npm-test". */
  id: string;
  /** The verification command being validated. */
  command: string;
  /** Ref whose state the verification should PASS on (default HEAD). */
  goodRef?: string;
  /** Optional explicit known-bad ref (alternative to mutations). */
  badRef?: string;
  /** Controlled mutations applied to a temp worktree for the known-bad case. */
  mutations?: Mutation[];
  /** Verification identity files (hashed into evidence). */
  testFiles?: string[];
  configFiles?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export type VerifierHealth =
  | "VERIFIER_VALID"
  | "VERIFIER_WEAK"
  | "VERIFIER_BROKEN"
  | "INTEGRITY_FAILURE";

export interface VerifierCaseResult {
  label: "known-good" | "known-bad";
  source: string;
  commitSha: string | null;
  expected: "PASS" | "FAIL";
  actual: "PASS" | "FAIL" | "ERROR";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  mutations?: { op: string; path: string; contentHash?: string }[];
}

export interface VerifierCheckResult {
  repo: string;
  commitSha: string | null;
  verifier: { id: string; command: string; verificationHash: string };
  good: VerifierCaseResult | null;
  bad: VerifierCaseResult | null;
  verdict: VerifierHealth;
  reasons: string[];
  notes: string[];
  sealedPath?: string;
  evidence?: OpenPitStopEvidence;
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

function verificationIdentityHash(def: VerifierCheckDef): string {
  return sha256(
    JSON.stringify({
      id: def.id,
      command: def.command,
      cwd: def.cwd ?? ".",
      env: def.env ? Object.fromEntries(Object.entries(def.env).sort()) : undefined,
      files: (def.testFiles ?? []).slice().sort(),
      configs: (def.configFiles ?? []).slice().sort(),
    }),
  );
}

/** Validate mutations before touching any worktree. */
function validateMutations(mutations: Mutation[] | undefined): string | null {
  if (!mutations || mutations.length === 0) return null;
  for (const m of mutations) {
    if (m.op === "write") {
      if (!m.path) return "write mutation is missing a target path";
      if (m.content === undefined) return `write mutation for ${m.path} is missing content`;
    } else if (m.op === "delete") {
      if (!m.path) return "delete mutation is missing a target path";
    } else {
      return `unknown mutation op "${(m as any).op}"`;
    }
  }
  return null;
}

function applyMutations(
  worktree: string,
  mutations: Mutation[],
): { applied: { op: string; path: string; contentHash?: string }[]; errors: string[] } {
  const applied: { op: string; path: string; contentHash?: string }[] = [];
  const errors: string[] = [];
  for (const m of mutations) {
    const abs = path.join(worktree, m.path);
    try {
      if (m.op === "write") {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, m.content, "utf8");
        applied.push({ op: "write", path: m.path, contentHash: sha256(m.content) });
      } else {
        if (!fs.existsSync(abs)) {
          errors.push(`delete mutation target missing: ${m.path}`);
          continue;
        }
        fs.rmSync(abs, { force: true });
        applied.push({ op: "delete", path: m.path });
      }
    } catch (e: any) {
      errors.push(`mutation ${m.op} ${m.path} failed: ${e.message}`);
    }
  }
  return { applied, errors };
}

function hashIdentityFiles(worktree: string, files: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files ?? []) {
    try {
      out[f] = sha256(fs.readFileSync(path.join(worktree, f), "utf8"));
    } catch {
      out[f] = "__missing__";
    }
  }
  return out;
}

/**
 * Run the falsifiability check for one verification definition.
 * Isolated: all execution happens in temporary detached worktrees.
 */
export async function checkVerifier(opts: {
  repo: string;
  def: VerifierCheckDef;
}): Promise<VerifierCheckResult> {
  const repo = path.resolve(opts.repo);
  const def = opts.def;
  const reasons: string[] = [];
  const notes: string[] = [];
  const createdWorktrees: string[] = [];

  const result: VerifierCheckResult = {
    repo,
    commitSha: null,
    verifier: { id: def.id, command: def.command, verificationHash: verificationIdentityHash(def) },
    good: null,
    bad: null,
    verdict: "INTEGRITY_FAILURE",
    reasons,
    notes,
  };

  try {
    if (!ensureGitRepo(repo)) {
      reasons.push(`not a git repository: ${repo}`);
      return result;
    }

    // ---- fixture validation (before any execution)
    const mutationError = validateMutations(def.mutations);
    if (mutationError) {
      reasons.push(`invalid fixture: ${mutationError}`);
      return result;
    }
    if (!def.badRef && (!def.mutations || def.mutations.length === 0)) {
      reasons.push("invalid fixture: no known-bad case — provide --bad-ref or at least one --mutate");
      return result;
    }
    if (def.badRef && def.mutations && def.mutations.length > 0) {
      reasons.push("invalid fixture: provide EITHER --bad-ref OR mutations, not both");
      return result;
    }

    const goodRef = def.goodRef ?? "HEAD";
    const goodSha = resolveSha(repo, goodRef);
    if (!goodSha) {
      reasons.push(`known-good checkout failed: cannot resolve ref '${goodRef}'`);
      return result;
    }
    result.commitSha = goodSha;

    let badSha: string | null;
    let badSource: string;
    if (def.badRef) {
      badSha = resolveSha(repo, def.badRef);
      if (!badSha) {
        reasons.push(`known-bad checkout failed: cannot resolve ref '${def.badRef}'`);
        return result;
      }
      badSource = `ref ${def.badRef}`;
    } else {
      badSha = goodSha;
      badSource = `${goodRef} + ${def.mutations!.length} controlled mutation(s)`;
    }

    const runDef: VerificationDef = {
      id: def.id,
      command: def.command,
      cwd: def.cwd,
      env: def.env,
      timeoutMs: def.timeoutMs,
    };

    // ---- known-good case
    const g = await createWorktree(repo, goodSha);
    createdWorktrees.push(g.path);
    const goodIdentity = hashIdentityFiles(g.path, [...(def.testFiles ?? []), ...(def.configFiles ?? [])]);
    const goodRun = await runVerification(g.path, runDef);
    result.good = {
      label: "known-good",
      source: `ref ${goodRef}`,
      commitSha: g.sha,
      expected: "PASS",
      actual: goodRun.exitCode === 0 ? "PASS" : goodRun.timedOut ? "ERROR" : "FAIL",
      exitCode: goodRun.exitCode,
      stdout: goodRun.stdout,
      stderr: goodRun.stderr,
      durationMs: goodRun.durationMs,
    };

    // ---- known-bad case (fresh worktree — never reuse, mutations must not leak)
    const b = await createWorktree(repo, badSha);
    createdWorktrees.push(b.path);
    let appliedMutations: VerifierCaseResult["mutations"] = undefined;
    if (def.mutations && def.mutations.length > 0) {
      const { applied, errors } = applyMutations(b.path, def.mutations);
      if (errors.length > 0) {
        reasons.push(...errors.map((e) => `mutation could not be applied: ${e}`));
        result.verdict = "INTEGRITY_FAILURE";
        return result;
      }
      appliedMutations = applied;
    }
    const badIdentity = hashIdentityFiles(b.path, [...(def.testFiles ?? []), ...(def.configFiles ?? [])]);
    const badRun = await runVerification(b.path, runDef);
    result.bad = {
      label: "known-bad",
      source: badSource,
      commitSha: b.sha,
      expected: "FAIL",
      actual: badRun.exitCode === 0 ? "PASS" : badRun.timedOut ? "ERROR" : "FAIL",
      exitCode: badRun.exitCode,
      stdout: badRun.stdout,
      stderr: badRun.stderr,
      durationMs: badRun.durationMs,
      mutations: appliedMutations,
    };

    // verification identity drift between the two cases.
    //  - drift explained by DECLARED mutations of identity files → honest note
    //    (the mutation IS the fault; it proves the harness reports FAIL)
    //  - UNEXPECTED drift (e.g. the bad ref commits a weakened verifier) → the
    //    two runs are not like-for-like → INTEGRITY_FAILURE, never a verdict.
    {
      const identityFiles = [...(def.testFiles ?? []), ...(def.configFiles ?? [])];
      const drifted = identityFiles.filter((f) => goodIdentity[f] !== badIdentity[f]);
      if (drifted.length > 0) {
        const mutationTargets = new Set((def.mutations ?? []).map((m) => m.path));
        const unexpected = drifted.filter((f) => !mutationTargets.has(f));
        if (unexpected.length > 0) {
          reasons.push(
            `verification files differ between known-good and known-bad worktrees: ${unexpected.join(", ")} — the comparison is not like-for-like`,
          );
          result.verdict = "INTEGRITY_FAILURE";
          return result;
        }
        notes.push(
          "mutation touches the verification's own files — this validates the harness reports FAIL, not that the verifier detects code faults",
        );
      }
    }

    // ---- verdict matrix
    const goodPass = result.good.actual === "PASS";
    const badFail = result.bad.actual === "FAIL";
    if (goodPass && badFail) {
      result.verdict = "VERIFIER_VALID";
      reasons.push(
        `known-good PASSED (exit 0) and known-bad FAILED (exit ${badRun.exitCode}) — the verification demonstrated it can say NO`,
      );
    } else if (goodPass && !badFail) {
      result.verdict = "VERIFIER_WEAK";
      reasons.push(
        `known-bad state did NOT fail the verification (exit ${badRun.exitCode}) — this verifier cannot detect the seeded fault; its PASS carries no information for this fault class`,
      );
    } else {
      result.verdict = "VERIFIER_BROKEN";
      reasons.push(
        `known-good state FAILED the verification (exit ${goodRun.exitCode}) — the verifier rejects a correct state`,
      );
    }

    if (goodRun.timedOut) notes.push("known-good run timed out — treat as ERROR, not PASS");
    if (badRun.timedOut) notes.push("known-bad run timed out — treated as not-FAIL");

    return result;
  } finally {
    for (const wt of createdWorktrees) {
      await removeWorktree(repo, wt);
    }
  }
}

/** Seal a verifier-check result into .pitstop/ (tamper-evident). */
export function sealVerifierResult(result: VerifierCheckResult): VerifierCheckResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `verifier-check-${ts}.json`);
  const doc = {
    timestamp: new Date().toISOString(),
    repo: result.repo,
    commitSha: result.commitSha,
    verifier: result.verifier,
    good: result.good,
    bad: result.bad,
    verdict: result.verdict,
    reasons: result.reasons,
    notes: result.notes,
  };
  const sealed = seal(doc, `verifier falsifiability check for ${result.verifier.id}`);
  fs.writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  return { ...result, sealedPath, evidence: (sealed as any).evidence };
}

export function checkVerifierEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return checkEvidence(JSON.parse(clean));
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}

/** Parse "--mutate-write path=fixtureFile" style CLI args into Mutations. */
export function parseMutateWrite(spec: string, repoDir: string): Mutation | null {
  const idx = spec.indexOf("=");
  if (idx <= 0) return null;
  const target = spec.slice(0, idx).trim();
  const source = spec.slice(idx + 1).trim();
  try {
    const content = fs.readFileSync(path.isAbsolute(source) ? source : path.join(repoDir, source), "utf8");
    return { op: "write", path: target, content };
  } catch {
    return null;
  }
}

export function parseMutateInline(spec: string): Mutation | null {
  const idx = spec.indexOf("=");
  if (idx <= 0) return null;
  const target = spec.slice(0, idx).trim();
  const content = spec.slice(idx + 1);
  return { op: "write", path: target, content };
}

export function parseMutateDelete(p: string): Mutation {
  return { op: "delete", path: p.trim() };
}
