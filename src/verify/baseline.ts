import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { seal, digestOf, type OpenPitStopEvidence, type EvidenceCheck, checkEvidence } from "../evidence.js";
import { safeExec } from "../analyzers/util.js";
import { buildIntegrityReport } from "../graph/integrity.js";
import { getDiff } from "../analyzers/integrity/git.js";

/**
 * Baseline-aware verification — the honest REFEREE:
 *   BASELINE FAIL  →  seal evidence
 *   CANDIDATE PASS →  compare same verification
 *   VERIFIED only if baseline indeed failed and candidate passed with
 *   identical verification identity and intact evidence.
 *
 * This is the GENERAL mechanism; it is not tied to MiniShop or any single
 * framework. It works via isolated git worktrees so the user's working tree
 * stays untouched (dirty repo, branches, detached HEAD all handled).
 */

export type VerificationDef = {
  /** Stable id of what is being verified, e.g. "repro:security-abc" or "custom:checkout". */
  id: string;
  /** Shell command to run. Empty allows testFiles-driven runners but is generally required. */
  command: string;
  /** Working directory inside the worktree, relative (defaults to repo root). */
  cwd?: string;
  /** Extra env for the verification run. */
  env?: Record<string, string>;
  /** Files that participate in the verification identity (test files, repros). */
  testFiles?: string[];
  /** Configuration files that participate (jest config, package.json etc). */
  configFiles?: string[];
  /** Expectation of what a real baseline failure looks like. */
  expectedFailure?: {
    /** If set, baseline must exit with this code to count as "demonstrated failure". */
    exitCode?: number;
    /** Substring that must appear in stdout/stderr of the baseline failure. */
    stdoutContains?: string;
    stderrContains?: string;
  };
  timeoutMs?: number;
};

export type VerificationExecution = {
  ref: string;
  commitSha: string;
  verificationId: string;
  verificationHash: string;
  command: string;
  cwd: string;
  envSnapshot: Record<string, string>;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  timestamp: string;
  fileHashes: Record<string, string>; // testFiles
  configHashes: Record<string, string>;
  failureSignature: string;
  evidence: OpenPitStopEvidence;
};

export type BaselineVerdict = "VERIFIED" | "FAILED" | "UNPROVEN" | "INTEGRITY_FAILURE";

export interface BaselineVerifyResult {
  repo: string;
  verification: VerificationDef;
  baseline: VerificationExecution | null;
  candidate: VerificationExecution | null;
  integrity: {
    verificationIdentityUnchanged: boolean;
    baselineHash: string | null;
    candidateHash: string | null;
    changedFiles: string[];
    verificationFilesChanged: boolean;
    report?: ReturnType<typeof buildIntegrityReport>;
  };
  evidence: {
    baseline: EvidenceCheck | null;
    candidate: EvidenceCheck | null;
  };
  verdict: BaselineVerdict;
  reasons: string[];
  sealedPath?: string;
  sealed?: OpenPitStopEvidence;
}

function shaOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hashFileContent(content: string): string {
  return shaOf(content);
}

export function resolveSha(repo: string, ref: string): string | null {
  // --verify is REQUIRED: plain `git rev-parse <sha>` happily echoes a
  // well-formed-but-nonexistent object id with exit 0, which would let a
  // fabricated commit reference slip through as "resolvable".
  const r = safeExec("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repo);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length >= 40 ? sha : null;
}

export function ensureGitRepo(repo: string): boolean {
  return safeExec("git", ["rev-parse", "--is-inside-work-tree"], repo).code === 0;
}

function computeVerificationHash(
  def: VerificationDef,
  fileHashes: Record<string, string>,
  configHashes: Record<string, string>,
): string {
  const canonical = {
    id: def.id,
    command: def.command,
    cwd: def.cwd ?? ".",
    env: def.env ? Object.fromEntries(Object.entries(def.env).sort()) : undefined,
    files: Object.fromEntries(Object.entries(fileHashes).sort()),
    configs: Object.fromEntries(Object.entries(configHashes).sort()),
  };
  return digestOf(canonical);
}

function failureSignatureOf(exitCode: number, stdout: string, stderr: string): string {
  return shaOf(`${exitCode}\n${stdout}\n${stderr}`).slice(0, 16);
}

function readFileAtWorktree(worktree: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.join(worktree, rel), "utf8");
  } catch {
    return null;
  }
}

export async function createWorktree(repo: string, sha: string): Promise<{ path: string; sha: string }> {
  const tmpBase = path.join(os.tmpdir(), `pitstop-baseline-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
  // git worktree add expects the path to NOT exist; mkdtemp created it, so we use a plain join
  const res = await execa("git", ["worktree", "add", "--detach", tmpBase, sha], {
    cwd: repo,
    reject: false,
    windowsHide: true,
    timeout: 30000,
  });
  if (res.exitCode !== 0) {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
    throw new Error(`git worktree add failed for ${sha}: ${res.stderr || res.stdout}`);
  }
  const actualSha = safeExec("git", ["rev-parse", "HEAD"], tmpBase).stdout.trim() || sha;
  return { path: tmpBase, sha: actualSha };
}

export async function removeWorktree(repo: string, worktreePath: string): Promise<void> {
  // Try the git bookkeeping removal first; ignore failures then force rm.
  await execa("git", ["worktree", "remove", "--force", worktreePath], {
    cwd: repo,
    reject: false,
    windowsHide: true,
    timeout: 30000,
  }).catch(() => {});
  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch {}
  // Prune stale metadata
  await execa("git", ["worktree", "prune"], { cwd: repo, reject: false, windowsHide: true }).catch(() => {});
}

export async function runVerification(
  worktree: string,
  def: VerificationDef,
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
  const cwd = def.cwd ? path.join(worktree, def.cwd) : worktree;
  const env = { ...process.env, ...(def.env ?? {}) } as Record<string, string>;
  const timeout = def.timeoutMs ?? 120000;
  const start = Date.now();
  // Use shell via execa with shell:true equivalent: run command through shell
  // Safer to use shell option if command is arbitrary.
  try {
    const res = await execa(def.command, [], {
      cwd,
      env,
      shell: true,
      timeout,
      reject: false,
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
    });
    return {
      exitCode: typeof res.exitCode === "number" ? res.exitCode : -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      timedOut: res.timedOut ?? false,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: err?.message ?? String(err),
      timedOut: false,
      durationMs: Date.now() - start,
    };
  }
}

function buildEnvSnapshot(def: VerificationDef): Record<string, string> {
  return def.env ? { ...def.env } : {};
}

/**
 * Core orchestrator.
 *
 * Steps:
 *  1. validate + resolve SHAs
 *  2. create isolated worktrees (baseline + candidate)
 *  3. hash verification identity in each worktree
 *  4. run verification in both
 *  5. seal evidence
 *  6. compare → verdict
 */
export async function baselineAwareVerify(opts: {
  repo: string;
  baselineRef: string;
  candidateRef?: string;
  verification: VerificationDef;
}): Promise<BaselineVerifyResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  let baselineWt: { path: string; sha: string } | null = null;
  let candidateWt: { path: string; sha: string } | null = null;
  let baselineExec: VerificationExecution | null = null;
  let candidateExec: VerificationExecution | null = null;

  const result: BaselineVerifyResult = {
    repo,
    verification: opts.verification,
    baseline: null,
    candidate: null,
    integrity: {
      verificationIdentityUnchanged: true,
      baselineHash: null,
      candidateHash: null,
      changedFiles: [],
      verificationFilesChanged: false,
    },
    evidence: { baseline: null, candidate: null },
    verdict: "UNPROVEN",
    reasons,
  };

  // 0 — repo check
  if (!ensureGitRepo(repo)) {
    result.verdict = "INTEGRITY_FAILURE";
    reasons.push(`not a git repository: ${repo}`);
    return result;
  }

  // 1 — resolve
  const baselineSha = resolveSha(repo, opts.baselineRef);
  if (!baselineSha) {
    result.verdict = "INTEGRITY_FAILURE";
    reasons.push(`baseline checkout failed: cannot resolve ref '${opts.baselineRef}'`);
    return result;
  }
  const candidateRef = opts.candidateRef ?? "HEAD";
  const candidateSha = resolveSha(repo, candidateRef);
  if (!candidateSha) {
    result.verdict = "INTEGRITY_FAILURE";
    reasons.push(`candidate checkout failed: cannot resolve ref '${candidateRef}'`);
    return result;
  }

  // Collect verification participating files list (for hashing + integrity)
  const allVerificationFiles = [
    ...(opts.verification.testFiles ?? []),
    ...(opts.verification.configFiles ?? []),
  ];

  try {
    // 2 — worktrees
    try {
      baselineWt = await createWorktree(repo, baselineSha);
    } catch (e: any) {
      result.verdict = "INTEGRITY_FAILURE";
      reasons.push(`baseline checkout failed: ${e.message}`);
      return result;
    }

    // Candidate: if same SHA as baseline, reuse baseline worktree path but treat as candidate
    // to avoid double worktree; otherwise create second.
    if (candidateSha === baselineSha) {
      candidateWt = baselineWt;
    } else {
      try {
        candidateWt = await createWorktree(repo, candidateSha);
      } catch (e: any) {
        result.verdict = "INTEGRITY_FAILURE";
        reasons.push(`candidate checkout failed: ${e.message}`);
        return result;
      }
    }

    // Helper to hash files inside a worktree
    const hashFiles = (wt: string, files: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const f of files) {
        const c = readFileAtWorktree(wt, f);
        if (c === null) out[f] = "__missing__";
        else out[f] = hashFileContent(c);
      }
      return out;
    };

    const baselineFileHashes = hashFiles(baselineWt.path, opts.verification.testFiles ?? []);
    const baselineConfigHashes = hashFiles(baselineWt.path, opts.verification.configFiles ?? []);
    const candidateFileHashes = hashFiles(candidateWt.path, opts.verification.testFiles ?? []);
    const candidateConfigHashes = hashFiles(candidateWt.path, opts.verification.configFiles ?? []);

    const baselineVHash = computeVerificationHash(opts.verification, baselineFileHashes, baselineConfigHashes);
    const candidateVHash = computeVerificationHash(opts.verification, candidateFileHashes, candidateConfigHashes);

    result.integrity.baselineHash = baselineVHash;
    result.integrity.candidateHash = candidateVHash;
    result.integrity.verificationIdentityUnchanged = baselineVHash === candidateVHash;

    // Detect any verification file changed (including deletions)
    const allFiles = new Set([...Object.keys(baselineFileHashes), ...Object.keys(candidateFileHashes), ...Object.keys(baselineConfigHashes), ...Object.keys(candidateConfigHashes)]);
    let verificationFilesChanged = false;
    for (const f of allFiles) {
      const bh = baselineFileHashes[f] ?? baselineConfigHashes[f];
      const ch = candidateFileHashes[f] ?? candidateConfigHashes[f];
      if (bh !== ch) verificationFilesChanged = true;
    }
    // Also consider command itself is part of hash — already covered, but if caller changed command string between runs, hashes already differ.

    // Additional: git diff --name-only baseline..candidate to collect changedFiles
    const diff = safeExec("git", ["diff", "--name-only", baselineSha, candidateSha], repo);
    const changedFiles = diff.code === 0 ? diff.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    result.integrity.changedFiles = changedFiles;
    if (changedFiles.some((f) => allVerificationFiles.includes(f))) verificationFilesChanged = true;
    result.integrity.verificationFilesChanged = verificationFilesChanged;

    // Also run the existing diff-scoped integrity detectors between the two SHAs (reuse graph/integrity)
    // to catch deleted tests / hardcoded passes etc that touch verification files.
    try {
      const changes = getDiff(repo, baselineSha, candidateSha);
      const report = buildIntegrityReport(repo, baselineSha, candidateSha, changes);
      result.integrity.report = report;
      if (report.verdict === "CONFIRMED_CHEAT") {
        // we will surface this in verdict as INTEGRITY_FAILURE
      }
    } catch {
      // ignore - not fatal
    }

    // 3 — run verifications
    const baselineRun = await runVerification(baselineWt.path, opts.verification);
    const baselineExecTmp: VerificationExecution = {
      ref: opts.baselineRef,
      commitSha: baselineSha,
      verificationId: opts.verification.id,
      verificationHash: baselineVHash,
      command: opts.verification.command,
      cwd: opts.verification.cwd ?? ".",
      envSnapshot: buildEnvSnapshot(opts.verification),
      exitCode: baselineRun.exitCode,
      stdout: baselineRun.stdout,
      stderr: baselineRun.stderr,
      timedOut: baselineRun.timedOut,
      durationMs: baselineRun.durationMs,
      timestamp: new Date().toISOString(),
      fileHashes: baselineFileHashes,
      configHashes: baselineConfigHashes,
      failureSignature: failureSignatureOf(baselineRun.exitCode, baselineRun.stdout, baselineRun.stderr),
      evidence: { scheme: "pitstop-canonical-sha256-v1", digest: "", of: "", signedAt: "" },
    };
    // seal (produces digest)
    const baselineSealed = seal({ ...baselineExecTmp, evidence: undefined as any }, `baseline verification for ${opts.verification.id} at ${baselineSha}`);
    // copy digest into evidence
    (baselineExecTmp as any).evidence = (baselineSealed as any).evidence;
    baselineExec = baselineExecTmp;
    result.baseline = baselineExec;
    result.evidence.baseline = checkEvidence(baselineSealed as any);

    // If verificationFilesChanged already true, we can still run candidate but will downgrade later
    const candidateRun = await runVerification(candidateWt.path, opts.verification);
    const candidateExecTmp: VerificationExecution = {
      ref: candidateRef,
      commitSha: candidateSha,
      verificationId: opts.verification.id,
      verificationHash: candidateVHash,
      command: opts.verification.command,
      cwd: opts.verification.cwd ?? ".",
      envSnapshot: buildEnvSnapshot(opts.verification),
      exitCode: candidateRun.exitCode,
      stdout: candidateRun.stdout,
      stderr: candidateRun.stderr,
      timedOut: candidateRun.timedOut,
      durationMs: candidateRun.durationMs,
      timestamp: new Date().toISOString(),
      fileHashes: candidateFileHashes,
      configHashes: candidateConfigHashes,
      failureSignature: failureSignatureOf(candidateRun.exitCode, candidateRun.stdout, candidateRun.stderr),
      evidence: { scheme: "pitstop-canonical-sha256-v1", digest: "", of: "", signedAt: "" },
    };
    const candidateSealed = seal({ ...candidateExecTmp, evidence: undefined as any }, `candidate verification for ${opts.verification.id} at ${candidateSha}`);
    (candidateExecTmp as any).evidence = (candidateSealed as any).evidence;
    candidateExec = candidateExecTmp;
    result.candidate = candidateExec;
    result.evidence.candidate = checkEvidence(candidateSealed as any);

    // Persist sealed evidence chain under .pitstop/
    const outDir = path.join(repo, ".pitstop");
    fs.mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const sealedPath = path.join(outDir, `baseline-verify-${ts}.json`);
    const finalDoc: any = {
      repo,
      verification: opts.verification,
      baseline: baselineExec,
      candidate: candidateExec,
      integrity: result.integrity,
      evidence: {
        baseline: (baselineSealed as any).evidence,
        candidate: (candidateSealed as any).evidence,
      },
      timestamp: new Date().toISOString(),
    };
    // The verdict and reasons will be added after computation.
    // Compute verdict now:

    // Integrity failures take precedence
    if (!result.integrity.verificationIdentityUnchanged || verificationFilesChanged) {
      result.verdict = "INTEGRITY_FAILURE";
      if (!result.integrity.verificationIdentityUnchanged) {
        reasons.push(`verification identity changed: baseline hash ${baselineVHash.slice(0, 12)}… vs candidate ${candidateVHash.slice(0, 12)}…`);
      }
      if (verificationFilesChanged) {
        const changed = [...allFiles].filter((f) => (baselineFileHashes[f] ?? baselineConfigHashes[f]) !== (candidateFileHashes[f] ?? candidateConfigHashes[f]));
        reasons.push(`verification files changed: ${changed.join(", ")}`);
      }
      // Check deleted test signal
      const missingInCandidate = [...(opts.verification.testFiles ?? [])].filter((f) => candidateFileHashes[f] === "__missing__");
      if (missingInCandidate.length) {
        reasons.push(`verification test deleted in candidate: ${missingInCandidate.join(", ")}`);
      }
      // Also surface detector CONFIRMED_CHEAT if present
      if (result.integrity.report?.verdict === "CONFIRMED_CHEAT") {
        reasons.push(`integrity detector CONFIRMED_CHEAT: ${result.integrity.report.findings.map((f) => f.evidence).join("; ")}`);
      }
      // Still record evidence etc but verdict is INTEGRITY_FAILURE
    } else if (result.integrity.report?.verdict === "CONFIRMED_CHEAT") {
      result.verdict = "INTEGRITY_FAILURE";
      reasons.push(`integrity detector CONFIRMED_CHEAT between baseline and candidate`);
    } else if (baselineExec.timedOut || candidateExec.timedOut) {
      result.verdict = "INTEGRITY_FAILURE";
      if (baselineExec.timedOut) reasons.push("baseline verification timed out");
      if (candidateExec.timedOut) reasons.push("candidate verification timed out");
    } else {
      // Expected-failure semantics
      const exp = opts.verification.expectedFailure;
      let baselineDemonstratesFailure: boolean;
      if (exp?.exitCode !== undefined) {
        baselineDemonstratesFailure = baselineExec.exitCode === exp.exitCode;
      } else {
        baselineDemonstratesFailure = baselineExec.exitCode !== 0;
      }
      if (exp?.stdoutContains) {
        baselineDemonstratesFailure = baselineDemonstratesFailure && baselineExec.stdout.includes(exp.stdoutContains);
        if (!baselineExec.stdout.includes(exp.stdoutContains))
          reasons.push(`baseline stdout did not contain expected pattern "${exp.stdoutContains}"`);
      }
      if (exp?.stderrContains) {
        baselineDemonstratesFailure = baselineDemonstratesFailure && baselineExec.stderr.includes(exp.stderrContains);
        if (!baselineExec.stderr.includes(exp.stderrContains))
          reasons.push(`baseline stderr did not contain expected pattern "${exp.stderrContains}"`);
      }

      // Heuristic: if baseline failed but output looks like env-broken, warn
      // We treat this as still FAILED, but flag unproven if candidate would have been VERIFIED.
      const baselineLooksEnvBroken =
        /ENOENT|Cannot find module|module not found|command not found|No such file/i.test(
          baselineExec.stdout + "\n" + baselineExec.stderr,
        ) && baselineExec.exitCode !== 0;

      const candidatePassed = candidateExec.exitCode === 0;
      const candidateFailed = !candidatePassed;

      if (!baselineDemonstratesFailure) {
        result.verdict = "UNPROVEN";
        if (baselineExec.exitCode === 0) {
          reasons.push("baseline did not demonstrate the expected failure (baseline passed) — verification is UNPROVEN");
        } else {
          reasons.push("baseline failure did not match expected failure predicate — verification is UNPROVEN");
        }
        if (baselineLooksEnvBroken) {
          reasons.push("baseline failure appears to be an environment/dependency problem, not the intended bug — NOT VERIFIED");
        }
        reasons.push("OpenPitStop cannot distinguish intended-bug failure from unrelated environment failure without an explicit expectedFailure predicate");
      } else if (baselineLooksEnvBroken && candidatePassed) {
        // Baseline failed for env reason, candidate passed — spurious VERIFIED risk → downgrade
        result.verdict = "UNPROVEN";
        reasons.push("baseline failure appears to be an environment problem (not the intended bug) — downgraded to UNPROVEN");
      } else if (candidateFailed) {
        // baseline demonstrated failure, candidate still fails → FAILED (not yet fixed)
        result.verdict = "FAILED";
        reasons.push(`baseline demonstrated failure (exit ${baselineExec.exitCode}) but candidate still fails (exit ${candidateExec.exitCode})`);
        if (baselineLooksEnvBroken) reasons.push("note: baseline failure may be environment-related");
      } else {
        // baseline failed as required, candidate passes
        result.verdict = "VERIFIED";
        reasons.push(`baseline demonstrated failure (exit ${baselineExec.exitCode}) and candidate passed — verification is VERIFIED`);
        if (baselineLooksEnvBroken) {
          reasons.push("warning: baseline failure contained environment-like output; if the verification definition lacks an expectedFailure pattern this VERIFIED may be spurious");
        } else {
          reasons.push("note: OpenPitStop cannot prove the baseline failure was the intended bug vs an environment issue without an expectedFailure predicate — supply one for stronger guarantees");
        }
      }
    }

    // Attach verdict to final sealed doc and write
    finalDoc.verdict = result.verdict;
    finalDoc.reasons = reasons;
    const sealedFinal = seal(finalDoc, `baseline-aware verification for ${opts.verification.id}`);
    fs.writeFileSync(sealedPath, JSON.stringify(sealedFinal, null, 2));
    result.sealedPath = sealedPath;
    result.sealed = (sealedFinal as any).evidence;

    return result;
  } finally {
    if (baselineWt && candidateWt && baselineWt.path === candidateWt.path) {
      // Same worktree reused
      await removeWorktree(repo, baselineWt.path);
    } else {
      if (baselineWt) await removeWorktree(repo, baselineWt.path);
      if (candidateWt) await removeWorktree(repo, candidateWt.path);
    }
  }
}

export function checkBaselineEvidence(filePath: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const doc = JSON.parse(clean);
    return checkEvidence(doc);
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}
