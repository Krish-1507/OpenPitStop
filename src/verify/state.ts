import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execaSync } from "execa";
import { safeExec } from "../analyzers/util.js";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";

/**
 * state.ts — INDEPENDENT EXTERNAL STATE VERIFICATION.
 *
 * Principle: DO NOT TRUST THE AGENT'S CLAIM ABOUT WHAT IT DID.
 *
 * OpenPitStop inspects the actual filesystem + Git state and compares it
 * against structured claims ("created src/foo.ts", "modified src/auth.ts",
 * "deleted src/old.ts"). Nothing here reads the agent's natural-language
 * response; every signal is derived from disk and git porcelain output.
 *
 * WHAT THIS PROVES:  "did the claimed state change actually occur?"
 * WHAT THIS DOES NOT PROVE: "is the resulting code correct?" — that remains
 * the job of verification (tests/repro) and the integrity gate.
 */

export type ClaimOp = "created" | "modified" | "deleted";

export interface StateClaim {
  op: ClaimOp;
  /** Repo-relative path (forward slashes accepted). */
  path: string;
}

/** Targeted snapshot of one path — cheap, no repo-wide scanning. */
export interface FileSnapshot {
  path: string;
  exists: boolean;
  /** sha256 of content; null when missing, empty, or too large to hash. */
  hash: string | null;
  size: number | null;
  lineCount: number | null;
  /** git status --porcelain code, e.g. " M", "??", " D". */
  gitStatus: string | null;
  tracked: boolean;
  /** true when the file was skipped for hashing (size cap). */
  tooLargeToHash?: boolean;
}

/** Files over this size are recorded (size/status) but not hashed. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

export type ClaimResultStatus = "OK" | "MISMATCH" | "UNPROVEN";

export interface StateSignal {
  name: string;
  ok: boolean | null; // null = not applicable
  note?: string;
}

export interface ClaimVerification {
  claim: StateClaim;
  before: FileSnapshot | null;
  after: FileSnapshot;
  /** Was the before-state actually known (disk snapshot or git HEAD), vs guessed? */
  beforeKnown: boolean;
  signals: StateSignal[];
  status: ClaimResultStatus;
  reasons: string[];
  notes: string[];
}

export type StateVerdict = "STATE_VERIFIED" | "STATE_MISMATCH" | "UNPROVEN" | "INTEGRITY_FAILURE";

/** HEAD commit at verification time — pins the evidence to a git state. */
function headSha(repo: string): string | null {
  const r = safeExec("git", ["rev-parse", "HEAD"], repo);
  return r.code === 0 ? r.stdout.trim() : null;
}

export interface StateVerifyResult {
  repo: string;
  /** HEAD commit SHA at verification time (null outside a git repo). */
  commitSha: string | null;
  claims: StateClaim[];
  results: ClaimVerification[];
  verdict: StateVerdict;
  reasons: string[];
  /** Other working-tree changes observed (context for "wrong file changed"). */
  otherChangedFiles: string[];
  sealedPath?: string;
  evidence?: OpenPitStopEvidence;
}

const toGitPath = (p: string) => p.replace(/\\/g, "/");

function normalizeClaimPath(p: string): string {
  return toGitPath(p.trim()).replace(/^\.\//, "");
}

function hashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function lineCountOf(content: string): number {
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

function readDisk(repo: string, rel: string): { exists: boolean; content: string | null; size: number | null } {
  const abs = path.join(repo, rel);
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { exists: false, content: null, size: null };
    const content = fs.readFileSync(abs, "utf8");
    return { exists: true, content, size: st.size };
  } catch {
    return { exists: false, content: null, size: null };
  }
}

function trackedAtHead(repo: string, rel: string): boolean {
  const r = safeExec("git", ["ls-files", "--error-unmatch", "--", rel], repo);
  return r.code === 0 && r.stdout.trim().length > 0;
}

function porcelainStatus(repo: string, rel: string): string | null {
  const r = safeExec("git", ["status", "--porcelain", "--", rel], repo);
  if (r.code !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line ? line.slice(0, 2) : null;
}

function contentAtHead(repo: string, rel: string): string | null {
  // execa strips the final newline from stdout by default — that single byte
  // would make every HEAD hash differ from the disk hash and break the
  // "did it change" comparison, so read the blob byte-exact instead.
  try {
    const res = execaSync("git", ["show", `HEAD:${toGitPath(rel)}`], {
      cwd: repo,
      encoding: "utf8",
      reject: false,
      windowsHide: true,
      stripFinalNewline: false,
      maxBuffer: 50 * 1024 * 1024,
    });
    return res.exitCode === 0 ? (res.stdout as string) : null;
  } catch {
    return null;
  }
}

/** Targeted snapshot: only the requested paths are touched. */
export function snapshotPaths(repo: string, paths: string[]): Record<string, FileSnapshot> {
  const out: Record<string, FileSnapshot> = {};
  for (const raw of paths) {
    const rel = normalizeClaimPath(raw);
    const { exists, content, size } = readDisk(repo, rel);
    const tracked = exists ? trackedAtHead(repo, rel) : contentAtHead(repo, rel) !== null;
    const snap: FileSnapshot = {
      path: rel,
      exists,
      hash: null,
      size,
      lineCount: null,
      gitStatus: porcelainStatus(repo, rel),
      tracked,
    };
    if (exists && content !== null) {
      snap.lineCount = lineCountOf(content);
      if ((size ?? 0) <= MAX_HASH_BYTES) snap.hash = hashOf(content);
      else snap.tooLargeToHash = true;
    }
    out[rel] = snap;
  }
  return out;
}

function snapshotFromHead(repo: string, rel: string): FileSnapshot | null {
  const content = contentAtHead(repo, rel);
  if (content === null) return null; // not in HEAD → before-state unknown from git
  return {
    path: normalizeClaimPath(rel),
    exists: true,
    hash: hashOf(content),
    size: Buffer.byteLength(content, "utf8"),
    lineCount: lineCountOf(content),
    gitStatus: null,
    tracked: true,
  };
}

function absentSnapshot(rel: string): FileSnapshot {
  return {
    path: normalizeClaimPath(rel),
    exists: false,
    hash: null,
    size: null,
    lineCount: null,
    gitStatus: null,
    tracked: false,
  };
}

function whitespaceOnly(a: string, b: string): boolean {
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "");
}

function listWorkingTreeChanges(repo: string): string[] {
  const r = safeExec("git", ["status", "--porcelain"], repo);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .filter((l) => l.length >= 4)
    .map((l) => {
      // porcelain: 2 status chars + 1 space + path (path may be quoted)
      const p = l.slice(3).trim();
      return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
    })
    .filter(
      (p) =>
        p.length > 0 &&
        !p.startsWith(".pitstop/") && // OpenPitStop's own evidence dir
        !p.startsWith("node_modules/") &&
        !p.startsWith("dist/"),
    )
    .slice(0, 20);
}

/**
 * Verify structured claims against the ACTUAL repo state.
 *
 * Before-state resolution order (strongest first):
 *   1. explicit `before` snapshot (from a previous run / `--before` file)
 *   2. git HEAD content (tracked files only)
 *   3. unknown → claims that require a before-state become UNPROVEN
 */
export function verifyStateClaims(
  repo: string,
  claims: StateClaim[],
  opts: { before?: Record<string, FileSnapshot> } = {},
): StateVerifyResult {
  const repoAbs = path.resolve(repo);
  const reasons: string[] = [];
  const results: ClaimVerification[] = [];

  const isGit =
    safeExec("git", ["rev-parse", "--is-inside-work-tree"], repoAbs).code === 0;
  if (!isGit) {
    return {
      repo: repoAbs,
      commitSha: null,
      claims,
      results: [],
      verdict: "INTEGRITY_FAILURE",
      reasons: [`not a git repository: ${repoAbs} — state cannot be verified against git`],
      otherChangedFiles: [],
    };
  }

  const claimPaths = claims.map((c) => normalizeClaimPath(c.path));
  const afterSnaps = snapshotPaths(repoAbs, claimPaths);
  const claimed = new Set(claimPaths);

  for (const claim of claims) {
    const rel = normalizeClaimPath(claim.path);
    const after = afterSnaps[rel];

    // ---- before-state resolution
    let before: FileSnapshot | null = null;
    let beforeKnown = false;
    if (opts.before && opts.before[rel]) {
      before = opts.before[rel];
      beforeKnown = true;
    } else if (after.tracked || contentAtHead(repoAbs, rel) !== null) {
      const headSnap = snapshotFromHead(repoAbs, rel);
      if (headSnap) {
        before = headSnap;
        beforeKnown = true;
      }
    }
    if (!before) before = absentSnapshot(rel);

    const signals: StateSignal[] = [];
    const claimReasons: string[] = [];
    const notes: string[] = [];
    let status: ClaimResultStatus = "OK";

    const push = (name: string, ok: boolean | null, note?: string) =>
      signals.push({ name, ok, note });

    // ---- universal signals (observed, not assumed)
    push("file exists", after.exists);
    push(
      "persisted on disk",
      claim.op === "deleted" ? !after.exists : after.exists,
      claim.op === "deleted" ? "absent from filesystem" : undefined,
    );
    push(
      "git status observed",
      after.gitStatus !== null,
      after.gitStatus ? `porcelain "${after.gitStatus}"` : "clean / no status entry",
    );

    const contentChanged =
      beforeKnown && after.hash !== null && before.hash !== null
        ? after.hash !== before.hash
        : null;
    if (claim.op !== "deleted") {
      push(
        "content changed (hash)",
        contentChanged,
        contentChanged === false ? "hash identical to before-state" : undefined,
      );
    }

    const gitDiffObserved =
      after.gitStatus !== null && after.gitStatus !== "??" ? true : after.gitStatus === "??" ? null : false;

    // ---- per-op evaluation
    if (claim.op === "created") {
      if (!after.exists) {
        status = "MISMATCH";
        claimReasons.push(`claimed created but ${rel} does not exist on disk`);
      } else if (after.size === 0) {
        status = "UNPROVEN";
        claimReasons.push(`claimed created but ${rel} is EMPTY (0 bytes) — likely a failed write`);
      } else if (beforeKnown && before.exists) {
        status = "MISMATCH";
        claimReasons.push(`claimed created but ${rel} already existed in the before-state`);
      } else {
        if (after.gitStatus === "??") {
          push("git diff", null, "untracked — git records the path as new (??) rather than a diff");
        } else if (after.gitStatus === "A " || after.gitStatus === "A") {
          push("git diff", true, "staged as added");
        } else {
          push("git diff", null, "no git record (path may be ignored)");
        }
        if (!beforeKnown) notes.push("no before-state snapshot — creation proven by current existence, not by absence-before");
      }
    } else if (claim.op === "modified") {
      if (!after.exists) {
        status = "MISMATCH";
        claimReasons.push(`claimed modified but ${rel} does not exist on disk`);
      } else if (!beforeKnown) {
        status = "UNPROVEN";
        claimReasons.push(
          `cannot prove modification: ${rel} is untracked and no before-state snapshot was supplied`,
        );
      } else if (contentChanged === false) {
        status = "MISMATCH";
        claimReasons.push(
          `claimed modified but content hash is IDENTICAL to the before-state (${(before.hash ?? "").slice(0, 12)}…)`,
        );
      } else if (contentChanged === null) {
        status = "UNPROVEN";
        claimReasons.push(`content hash unavailable for ${rel} — cannot prove modification`);
      } else {
        // content genuinely changed
        const headContent = contentAtHead(repoAbs, rel);
        const diskContent = readDisk(repoAbs, rel).content ?? "";
        if (headContent !== null && whitespaceOnly(headContent, diskContent)) {
          status = "UNPROVEN";
          claimReasons.push(`only WHITESPACE changed in ${rel} — no substantive modification observed`);
          notes.push("whitespace-only diff");
        } else if (after.tracked && after.gitStatus === null) {
          status = "UNPROVEN";
          claimReasons.push(`content changed on disk but git reports no diff for tracked file ${rel}`);
        } else {
          push(
            "git diff",
            after.tracked ? true : null,
            after.tracked ? `porcelain "${after.gitStatus}"` : "untracked — filesystem hash change is the evidence",
          );
        }
      }
    } else {
      // deleted
      if (after.exists) {
        status = "MISMATCH";
        claimReasons.push(`claimed deleted but ${rel} still exists on disk`);
      } else if (!beforeKnown) {
        status = "UNPROVEN";
        claimReasons.push(
          `cannot prove deletion: no before-state (snapshot or git HEAD) shows ${rel} ever existed`,
        );
      } else if (!before.exists) {
        status = "MISMATCH";
        claimReasons.push(`claimed deleted but ${rel} did not exist in the before-state either`);
      } else {
        if (before.tracked || after.gitStatus !== null) {
          push("git diff", after.gitStatus !== null, after.gitStatus ? `porcelain "${after.gitStatus}"` : undefined);
        } else {
          push("git diff", null, "untracked file — git does not record its deletion");
          notes.push("untracked deletion proven by filesystem absence only");
        }
      }
    }

    results.push({ claim: { op: claim.op, path: rel }, before, after, beforeKnown, signals, status, reasons: claimReasons, notes });
  }

  // ---- overall verdict: mismatch dominates, then unproven, then verified
  const mismatched = results.filter((r) => r.status === "MISMATCH");
  const unproven = results.filter((r) => r.status === "UNPROVEN");
  let verdict: StateVerdict;
  if (mismatched.length > 0) verdict = "STATE_MISMATCH";
  else if (unproven.length > 0) verdict = "UNPROVEN";
  else verdict = "STATE_VERIFIED";

  for (const r of mismatched) reasons.push(...r.reasons);
  for (const r of unproven) reasons.push(...r.reasons);
  if (verdict === "STATE_VERIFIED") {
    reasons.push("every claimed state change was independently observed on disk and in git");
  }

  const otherChangedFiles = listWorkingTreeChanges(repoAbs).filter(
    (f) => !claimed.has(normalizeClaimPath(f)),
  );
  if (mismatched.length > 0 && otherChangedFiles.length > 0) {
    reasons.push(
      `note: other working-tree changes observed (${otherChangedFiles.slice(0, 5).join(", ")}${otherChangedFiles.length > 5 ? ", …" : ""}) — the agent may have changed a different file than claimed`,
    );
  }

  return {
    repo: repoAbs,
    commitSha: headSha(repoAbs),
    claims,
    results,
    verdict,
    reasons,
    otherChangedFiles,
  };
}

/** Seal a state-verify result into .pitstop/ (tamper-evident, reuses evidence.ts). */
export function sealStateResult(result: StateVerifyResult): StateVerifyResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `state-verify-${ts}.json`);
  const doc = {
    timestamp: new Date().toISOString(),
    repo: result.repo,
    commitSha: result.commitSha,
    claims: result.claims,
    results: result.results,
    verdict: result.verdict,
    reasons: result.reasons,
    otherChangedFiles: result.otherChangedFiles,
  };
  const sealed = seal(doc, `state verification for ${result.repo}`);
  fs.writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  return { ...result, sealedPath, evidence: (sealed as any).evidence };
}

/** Write a targeted BEFORE snapshot (sealed) for later comparison. */
export function writeStateSnapshot(repo: string, paths: string[]): { file: string; snapshot: Record<string, FileSnapshot> } {
  const repoAbs = path.resolve(repo);
  const snapshot = snapshotPaths(repoAbs, paths);
  const outDir = path.join(repoAbs, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `state-snapshot-${ts}.json`);
  const sealed = seal(
    {
      timestamp: new Date().toISOString(),
      repo: repoAbs,
      commitSha: headSha(repoAbs),
      snapshot,
    },
    `state snapshot for ${repoAbs}`,
  );
  fs.writeFileSync(file, JSON.stringify(sealed, null, 2));
  return { file, snapshot };
}

export function readStateSnapshot(file: string): Record<string, FileSnapshot> | null {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const doc = JSON.parse(clean);
    if (checkEvidence(doc).status !== "verified") return null;
    return (doc.snapshot ?? null) as Record<string, FileSnapshot> | null;
  } catch {
    return null;
  }
}

export function checkStateEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return checkEvidence(JSON.parse(clean));
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}

/** Parse CLI claims of the form "modified:src/foo.ts". */
export function parseClaim(s: string): StateClaim | null {
  const m = s.match(/^(created|modified|deleted)\s*:\s*(.+)$/);
  if (!m) return null;
  return { op: m[1] as ClaimOp, path: m[2].trim() };
}
