import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execa } from "execa";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { safeExec } from "../analyzers/util.js";
import { ensureGitRepo, resolveSha, createWorktree, removeWorktree, runVerification } from "./baseline.js";

/**
 * acceptance.ts — REQUIREMENT / ACCEPTANCE VERIFICATION.
 *
 * "Did the agent actually satisfy the original task requirements?" — not "did
 * some tests pass?". A structured ACCEPTANCE CONTRACT, defined independently
 * of the agent's self-report, is the source of truth for success. The agent
 * cannot redefine it: in-repo contracts are hash-pinned on first
 * authorization, and any later change is INTEGRITY_FAILURE until a human
 * re-authorizes explicitly (--authorize).
 *
 * Criteria are DETERMINISTIC AND OBSERVABLE — never an LLM judge:
 *   command      → exit code / stdout / stderr (sanitized runner)
 *   http         → real request: status + body (boots the app when the
 *                  contract declares a start command)
 *   fileExists   → existence in the candidate tree
 *   fileContains → content assertion in the candidate tree
 *
 * Each criterion produces evidence: what was expected, what was observed
 * (exit codes, status, body excerpts, hashes), duration, timestamp.
 *
 * WHAT THIS PROVES: the candidate satisfies the contract's observable criteria
 * as written. WHAT THIS DOES NOT PROVE: that the contract captures the full
 * requirement, or that unobservable qualities (UX, performance under load,
 * security beyond the asserted properties) hold. The contract is the source of
 * truth — a weak contract is weak verification, which is why baseline mode
 * (the suite must discriminate) and contract pinning exist.
 */

export type AcceptanceCriterion =
  | { id: string; type: "command"; description?: string; command: string; expected?: { exitCode?: number; stdoutContains?: string; stderrContains?: string } }
  | { id: string; type: "http"; description?: string; method?: string; url: string; headers?: Record<string, string>; body?: string; expectStatus?: number; expectBodyContains?: string }
  | { id: string; type: "fileExists"; description?: string; path: string }
  | { id: string; type: "fileContains"; description?: string; path: string; contains: string };

export interface AcceptanceRequirement {
  id: string;
  description?: string;
  criteria: AcceptanceCriterion[];
}

export interface AcceptanceContract {
  id: string;
  version?: number;
  description?: string;
  requirements: AcceptanceRequirement[];
  /** Boot the app inside the candidate worktree for http criteria. */
  start?: { command: string; readyUrl?: string; timeoutMs?: number };
  timeoutMs?: number;
}

export interface CriterionEvidence {
  requirementId: string;
  criterionId: string;
  type: string;
  expected: string;
  observed: string;
  pass: boolean | null; // null = unproven
  baselinePass?: boolean | null;
  durationMs: number;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export type AcceptanceVerdict =
  | "SATISFIED"
  | "NOT_SATISFIED"
  | "UNPROVEN"
  | "INTEGRITY_FAILURE";

export interface AcceptanceResult {
  repo: string;
  contractId: string;
  contractPath: string;
  contractHash: string;
  contractExternal: boolean;
  candidateRef: string;
  candidateSha: string;
  baselineRef: string | null;
  baselineSha: string | null;
  requirements: { id: string; description?: string; satisfied: boolean | null }[];
  evidence: CriterionEvidence[];
  verdict: AcceptanceVerdict;
  reasons: string[];
  notes: string[];
  discriminative: number;
  totalCriteria: number;
  sealedPath?: string;
  sealed?: OpenPitStopEvidence;
}

const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

export const ACCEPTANCE_MANIFEST = "acceptance.json";

function resolveContractPath(spec: string): string | null {
  const direct = path.isAbsolute(spec) ? spec : path.resolve(spec);
  if (fs.existsSync(direct)) {
    return fs.statSync(direct).isDirectory() ? path.join(direct, ACCEPTANCE_MANIFEST) : direct;
  }
  const home = process.env.PITSTOP_ACCEPTANCE_HOME
    ? path.resolve(process.env.PITSTOP_ACCEPTANCE_HOME)
    : path.join(os.homedir(), ".openpitstop", "acceptance");
  const byId = path.join(home, spec, ACCEPTANCE_MANIFEST);
  if (fs.existsSync(byId)) return byId;
  return null;
}

function loadContract(p: string): AcceptanceContract | { error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e: any) {
    return { error: `acceptance contract unreadable: ${e.message}` };
  }
  let c: AcceptanceContract;
  try {
    c = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as AcceptanceContract;
  } catch (e: any) {
    return { error: `acceptance contract is not valid JSON: ${e.message}` };
  }
  if (!c || typeof c.id !== "string" || !c.id.trim()) return { error: "invalid contract: missing id" };
  if (!Array.isArray(c.requirements) || c.requirements.length === 0) {
    return { error: "invalid contract: requirements must be a non-empty array" };
  }
  const types = new Set(["command", "http", "fileExists", "fileContains"]);
  for (const r of c.requirements) {
    if (!r || typeof r.id !== "string" || !r.id.trim()) return { error: "invalid contract: every requirement needs an id" };
    if (!Array.isArray(r.criteria) || r.criteria.length === 0) {
      return { error: `invalid contract: requirement "${r.id}" has no criteria` };
    }
    for (const cr of r.criteria) {
      if (!cr || typeof cr.id !== "string" || !cr.id.trim()) return { error: `invalid contract: criterion in "${r.id}" needs an id` };
      if (!types.has((cr as any).type)) {
        return { error: `invalid contract: criterion "${cr.id}" has unknown type "${(cr as any).type}" (supported: command, http, fileExists, fileContains)` };
      }
      if ((cr as any).type === "command" && !(cr as any).command) {
        return { error: `invalid contract: command criterion "${cr.id}" is missing command` };
      }
      if ((cr as any).type === "http" && !(cr as any).url) {
        return { error: `invalid contract: http criterion "${cr.id}" is missing url` };
      }
      if ((cr as any).type === "fileContains" && typeof (cr as any).contains !== "string") {
        return { error: `invalid contract: fileContains criterion "${cr.id}" is missing contains` };
      }
    }
  }
  return c;
}

function insideRepo(repo: string, p: string): boolean {
  const rp = path.resolve(p);
  const rr = path.resolve(repo);
  return rp === rr || rp.startsWith(rr + path.sep);
}

/** Pin / verify the contract hash for in-repo contracts (source-of-truth protection). */
function contractAuthorization(
  repo: string,
  contractPath: string,
  contractHash: string,
  authorize: boolean,
): { status: "ok" | "reauthorized" | "first-pin" | "TAMPERED"; reason?: string } {
  if (!insideRepo(repo, contractPath)) return { status: "ok" }; // external contract — outside the agent's reach
  const pitstop = path.join(repo, ".pitstop");
  const pinPath = path.join(pitstop, "acceptance-pin.json");
  let pin: { contractHash?: string; evidence?: OpenPitStopEvidence } | null = null;
  try {
    const raw = fs.readFileSync(pinPath, "utf8");
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (checkEvidence(doc).status === "verified") pin = doc;
  } catch {
    pin = null;
  }
  if (!pin || !pin.contractHash) {
    // first authorization — pin silently, but say so in the notes
    fs.mkdirSync(pitstop, { recursive: true });
    fs.writeFileSync(pinPath, JSON.stringify(seal({ contractPath, contractHash, authorizedAt: new Date().toISOString() }, `acceptance contract pin ${repo}`), null, 2));
    return { status: "first-pin" };
  }
  if (pin.contractHash !== contractHash) {
    if (authorize) {
      fs.writeFileSync(pinPath, JSON.stringify(seal({ contractPath, contractHash, authorizedAt: new Date().toISOString(), reauthorized: true }, `acceptance contract pin ${repo}`), null, 2));
      return { status: "reauthorized" };
    }
    return {
      status: "TAMPERED",
      reason:
        "acceptance contract CHANGED after authorization — the agent may have redefined success. " +
        "Diff the contract and re-run with --authorize to accept the new version explicitly.",
    };
  }
  return { status: "ok" };
}

async function bootApp(
  worktree: string,
  start: NonNullable<AcceptanceContract["start"]>,
  timeoutMs: number,
): Promise<{ proc?: any; error?: string }> {
  const child = execa(start.command, [], {
    cwd: worktree,
    shell: true,
    windowsHide: true,
    reject: false,
    detached: process.platform !== "win32",
    timeout: 0,
  }) as any;
  const deadline = Date.now() + (start.timeoutMs ?? 30000);
  const readyUrl = start.readyUrl;
  if (!readyUrl) {
    // no readiness probe — give the app a fixed warm-up
    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode != null && child.exitCode !== 0) {
      await killTree(child, worktree);
      return { error: `start command exited with ${child.exitCode}` };
    }
    return { proc: child };
  }
  while (Date.now() < deadline) {
    if (child.exitCode != null && child.exitCode !== 0) {
      await killTree(child, worktree);
      return { error: `start command exited with ${child.exitCode} before becoming ready` };
    }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(readyUrl, { signal: ctl.signal });
      clearTimeout(t);
      if (res.status < 500) return { proc: child }; // answering
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await killTree(child, worktree);
  return { error: `app did not become ready within ${start.timeoutMs ?? 30000}ms (readyUrl ${readyUrl})` };
}

async function killTree(child: any, _worktree: string): Promise<void> {
  try {
    if (process.platform === "win32" && child.pid) {
      await execa("taskkill", ["/PID", String(child.pid), "/T", "/F"], { reject: false, windowsHide: true });
    } else {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill?.("SIGKILL");
      }
    }
  } catch {
    /* best effort */
  }
}

async function runCriterion(
  criterion: AcceptanceCriterion,
  root: string,
  timeoutMs: number,
): Promise<CriterionEvidence> {
  const timestamp = new Date().toISOString();
  const base = {
    requirementId: "",
    criterionId: criterion.id,
    type: criterion.type,
    durationMs: 0,
    timestamp,
  };
  if (criterion.type === "command") {
    const run = await runVerification(root, { id: criterion.id, command: criterion.command, timeoutMs });
    const expected = `exit ${criterion.expected?.exitCode ?? 0}` +
      (criterion.expected?.stdoutContains ? ` + stdout~"${criterion.expected.stdoutContains}"` : "") +
      (criterion.expected?.stderrContains ? ` + stderr~"${criterion.expected.stderrContains}"` : "");
    if (run.timedOut || run.exitCode < 0) {
      return { ...base, expected, observed: run.timedOut ? "timed out" : `could not execute (exit ${run.exitCode})`, pass: null, durationMs: run.durationMs, detail: { exitCode: run.exitCode, stderr: run.stderr.slice(0, 400) } };
    }
    let pass = run.exitCode === (criterion.expected?.exitCode ?? 0);
    if (criterion.expected?.stdoutContains) pass = pass && run.stdout.includes(criterion.expected.stdoutContains);
    if (criterion.expected?.stderrContains) pass = pass && run.stderr.includes(criterion.expected.stderrContains);
    return {
      ...base, expected,
      observed: `exit ${run.exitCode}${run.stdout ? `, stdout "${run.stdout.slice(0, 200).replace(/\n/g, " ")}"` : ""}`,
      pass, durationMs: run.durationMs,
      detail: { exitCode: run.exitCode, stdout: run.stdout.slice(0, 800), stderr: run.stderr.slice(0, 400) },
    };
  }
  if (criterion.type === "http") {
    const started = Date.now();
    const expected = `${criterion.method ?? "GET"} ${criterion.url} → ${criterion.expectStatus ?? 200}` +
      (criterion.expectBodyContains ? ` + body~"${criterion.expectBodyContains}"` : "");
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetch(criterion.url, {
        method: criterion.method ?? "GET",
        headers: criterion.headers,
        body: criterion.body,
        signal: ctl.signal,
      });
      clearTimeout(t);
      const text = await res.text();
      let pass = res.status === (criterion.expectStatus ?? 200);
      if (criterion.expectBodyContains) pass = pass && text.includes(criterion.expectBodyContains);
      return {
        ...base, expected,
        observed: `status ${res.status}${text ? `, body "${text.slice(0, 200).replace(/\n/g, " ")}"` : ""}`,
        pass, durationMs: Date.now() - started,
        detail: { status: res.status, body: text.slice(0, 800) },
      };
    } catch (e: any) {
      return {
        ...base, expected,
        observed: `request failed: ${e?.cause?.code ?? e?.message ?? String(e)}`,
        pass: null, durationMs: Date.now() - started,
      };
    }
  }
  // fileExists / fileContains
  const abs = path.join(root, criterion.path);
  const exists = fs.existsSync(abs);
  if (criterion.type === "fileExists") {
    return {
      ...base,
      expected: `${criterion.path} exists`,
      observed: exists ? `${criterion.path} exists (${fs.statSync(abs).size} bytes)` : `${criterion.path} is missing`,
      pass: exists, durationMs: 0,
      detail: exists ? { sha256: sha256(fs.readFileSync(abs, "utf8")), size: fs.statSync(abs).size } : {},
    };
  }
  const content = exists ? fs.readFileSync(abs, "utf8") : null;
  const pass = content != null && content.includes(criterion.contains);
  return {
    ...base,
    expected: `${criterion.path} contains "${criterion.contains}"`,
    observed: content == null ? `${criterion.path} is missing` : pass ? "contains the expected content" : "content does not include the expected string",
    pass, durationMs: 0,
    detail: content != null ? { sha256: sha256(content), size: content.length } : {},
  };
}

export async function verifyAcceptance(opts: {
  repo: string;
  contractSpec: string;
  candidateRef?: string;
  baselineRef?: string;
  authorize?: boolean;
  timeoutMs?: number;
}): Promise<AcceptanceResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  const notes: string[] = [];
  const createdWorktrees: string[] = [];
  let appProc: any = null;

  const result: AcceptanceResult = {
    repo,
    contractId: opts.contractSpec,
    contractPath: "",
    contractHash: "",
    contractExternal: false,
    candidateRef: opts.candidateRef ?? "HEAD",
    candidateSha: "",
    baselineRef: opts.baselineRef ?? null,
    baselineSha: null,
    requirements: [],
    evidence: [],
    verdict: "INTEGRITY_FAILURE",
    reasons,
    notes,
    discriminative: 0,
    totalCriteria: 0,
  };

  try {
    if (!ensureGitRepo(repo)) {
      reasons.push(`not a git repository: ${repo}`);
      return result;
    }
    const contractPath = resolveContractPath(opts.contractSpec);
    if (!contractPath) {
      reasons.push(
        `acceptance contract not found: "${opts.contractSpec}" — give a path to acceptance.json (or a dir containing it) or an id under PITSTOP_ACCEPTANCE_HOME`,
      );
      return result;
    }
    result.contractPath = contractPath;
    const contractHash = sha256(fs.readFileSync(contractPath, "utf8"));
    result.contractHash = contractHash;
    result.contractExternal = !insideRepo(repo, contractPath);

    const contract = loadContract(contractPath);
    if ("error" in contract) {
      reasons.push(contract.error);
      return result;
    }
    result.contractId = contract.id;

    // source-of-truth protection
    const auth = contractAuthorization(repo, contractPath, contractHash, opts.authorize === true);
    if (auth.status === "TAMPERED") {
      reasons.push(auth.reason!);
      result.verdict = "INTEGRITY_FAILURE";
      return result;
    }
    if (auth.status === "first-pin") notes.push("in-repo contract pinned for the first time — future changes require --authorize");
    if (auth.status === "reauthorized") notes.push("contract re-authorized explicitly (--authorize) — new version pinned");

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

    const timeoutMs = opts.timeoutMs ?? contract.timeoutMs ?? 60000;
    const needsApp = contract.requirements.some((r) => r.criteria.some((c) => c.type === "http"));

    const runAllCriteria = async (sha: string, side: "candidate" | "baseline"): Promise<CriterionEvidence[]> => {
      const wt = await createWorktree(repo, sha);
      createdWorktrees.push(wt.path);
      let appError: string | null = null;
      if (needsApp && contract.start) {
        const boot = await bootApp(wt.path, contract.start, timeoutMs);
        if (boot.error) appError = boot.error;
        else appProc = boot.proc;
      } else if (needsApp && !contract.start) {
        appError = "contract has http criteria but no start command — the app cannot be booted for verification";
      }
      const out: CriterionEvidence[] = [];
      for (const req of contract.requirements) {
        for (const c of req.criteria) {
          const ev = await runCriterion(c, wt.path, timeoutMs);
          ev.requirementId = req.id;
          if (appError && c.type === "http") {
            ev.pass = null;
            ev.observed = appError;
          }
          out.push(ev);
        }
      }
      if (appProc) {
        await killTree(appProc, wt.path);
        appProc = null;
      }
      return out;
    };

    // ---- candidate
    result.evidence = await runAllCriteria(candidateSha, "candidate");
    result.totalCriteria = result.evidence.length;

    // ---- baseline (discrimination check)
    if (baselineSha) {
      const baselineEv = await runAllCriteria(baselineSha, "baseline");
      for (const ev of result.evidence) {
        const b = baselineEv.find((x) => x.requirementId === ev.requirementId && x.criterionId === ev.criterionId);
        if (b) ev.baselinePass = b.pass;
      }
      result.discriminative = result.evidence.filter((e) => e.baselinePass === false).length;
    }

    // ---- requirement rollup
    result.requirements = contract.requirements.map((r) => {
      const evs = result.evidence.filter((e) => e.requirementId === r.id);
      const satisfied = evs.every((e) => e.pass === true) ? true : evs.some((e) => e.pass === false) ? false : null;
      return { id: r.id, description: r.description, satisfied };
    });

    // ---- verdict
    const failed = result.evidence.filter((e) => e.pass === false);
    const unproven = result.evidence.filter((e) => e.pass === null);
    if (failed.length > 0) {
      result.verdict = "NOT_SATISFIED";
      reasons.push(
        `${failed.length} of ${result.totalCriteria} acceptance criteria FAILED (${failed.map((f) => `${f.requirementId}/${f.criterionId}`).join(", ")}) — the requirement is not satisfied`,
      );
    } else if (unproven.length > 0) {
      result.verdict = "UNPROVEN";
      reasons.push(
        `${unproven.length} of ${result.totalCriteria} acceptance criteria could not be verified (${unproven.map((f) => `${f.requirementId}/${f.criterionId}`).join(", ")}) — no verdict is possible without observable evidence`,
      );
    } else if (result.baselineRef && result.discriminative === 0) {
      result.verdict = "UNPROVEN";
      reasons.push(
        "every acceptance criterion already passed on the BASELINE — the contract does not discriminate this change, so the pass is not evidence of the agent's work",
      );
    } else {
      result.verdict = "SATISFIED";
      reasons.push(
        result.baselineRef
          ? `all ${result.totalCriteria} acceptance criteria pass on the candidate and ${result.discriminative} discriminate against the baseline — the requirements are observably satisfied`
          : `all ${result.totalCriteria} acceptance criteria pass on the candidate (no baseline supplied — pass is not baseline-backed)`,
      );
      if (!result.baselineRef) notes.push("supply --baseline so the contract proves it can discriminate");
    }
    return result;
  } finally {
    if (appProc) await killTree(appProc, repo);
    for (const wt of createdWorktrees) {
      await removeWorktree(repo, wt);
    }
  }
}

/** Seal the acceptance evidence into .pitstop/ (agent-visible; contains full per-criterion evidence). */
export function sealAcceptanceResult(result: AcceptanceResult): AcceptanceResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `acceptance-${ts}.json`);
  const doc = {
    timestamp: new Date().toISOString(),
    repo: result.repo,
    contract: { id: result.contractId, path: result.contractPath, hash: result.contractHash, external: result.contractExternal },
    candidate: { ref: result.candidateRef, sha: result.candidateSha },
    baseline: { ref: result.baselineRef, sha: result.baselineSha },
    requirements: result.requirements,
    evidence: result.evidence,
    verdict: result.verdict,
    reasons: result.reasons,
    notes: result.notes,
    discriminative: result.discriminative,
    totalCriteria: result.totalCriteria,
  };
  const sealed = seal(doc, `acceptance verification for ${result.contractId}`);
  fs.writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  return { ...result, sealedPath, sealed: (sealed as any).evidence };
}

export function checkAcceptanceEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return checkEvidence(JSON.parse(clean));
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}

export function acceptancePinPath(repo: string): string {
  return path.join(repo, ".pitstop", "acceptance-pin.json");
}
