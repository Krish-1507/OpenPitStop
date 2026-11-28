import fs from "node:fs";
import path from "node:path";
import { checkEvidence, seal } from "../evidence.js";
import { safeExec, safeExecAsync } from "../analyzers/util.js";
import { buildUnderstanding } from "../understand/index.js";
import { redact, shortHash } from "./text.js";
import { contentDigestValid } from "./integrity.js";
import { runAudit } from "./run.js";
import type { AuditReport } from "./types.js";

/**
 * audit/fixes.ts — the approval-based improvement workflow.
 *
 * Planning is read-only. Applying requires an explicit --yes, an intact sealed
 * plan, a git repository, and a separate worktree. The original working tree
 * is never edited and nothing is committed. Verification is best-effort and
 * every failure is reported instead of being hidden.
 */

export interface PlannedPatch {
  findingId: string;
  rule: string;
  file: string;
  startLine: number;
  endLine: number;
  before: string;
  after: string;
  summary: string;
}

export interface AuditFixPlan {
  schemaVersion: 1;
  planId: string;
  repo: string;
  auditGeneratedAt: string;
  createdAt: string;
  patches: PlannedPatch[];
  evidence?: { scheme: string; digest: string; of: string; signedAt: string };
}

export interface VerificationStep {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  code: number;
  durationMs: number;
  output: string;
}

export interface FixApplyResult {
  status: "verified" | "applied" | "failed" | "blocked";
  planId: string;
  worktree?: string;
  applied: { findingId: string; file: string }[];
  skipped: { findingId: string; file: string; reason: string }[];
  verification: VerificationStep[];
  beforeScore?: number;
  afterScore?: number;
  resolvedFingerprints: string[];
  regressions: { file: string; title: string; severity: string }[];
  note: string;
}

export function createFixPlan(repo: string, report: AuditReport): { plan: AuditFixPlan; file: string } {
  if (checkEvidence(report).status !== "verified") {
    throw new Error("Refusing to plan fixes from a report whose evidence seal is not verified.");
  }
  if (report.contentDigest !== undefined && !contentDigestValid(report)) {
    throw new Error("Refusing to plan fixes from a report whose nested content digest is invalid.");
  }
  const patches: PlannedPatch[] = report.findings
    .filter((finding) => finding.patch && finding.lifecycle !== "suppressed" && finding.lifecycle !== "resolved")
    .map((finding) => ({
      findingId: finding.id,
      rule: finding.rule,
      file: finding.patch?.file ?? finding.location.file,
      startLine: finding.patch?.startLine ?? finding.location.line,
      endLine: finding.patch?.endLine ?? finding.location.endLine,
      before: finding.patch?.before ?? "",
      after: finding.patch?.after ?? "",
      summary: finding.suggestion.summary,
    }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.startLine - b.startLine));
  const plan: AuditFixPlan = {
    schemaVersion: 1,
    planId: "plan-" + shortHash(report.repo + "|" + report.generatedAt + "|" + JSON.stringify(patches)),
    repo: report.repo,
    auditGeneratedAt: report.generatedAt,
    createdAt: new Date().toISOString(),
    patches,
  };
  const sealed = seal(plan, "pitstop audit fix plan for " + repo);
  const file = path.join(repo, ".pitstop", "audit-fix-plan.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(sealed, null, 2) + "\n");
  return { plan: sealed, file };
}

export async function applyFixPlan(
  repo: string,
  planFile: string,
  options: { confirmed: boolean; timeoutMs?: number },
): Promise<FixApplyResult> {
  const planPath = path.resolve(repo, planFile);
  const plan = readPlan(planPath);
  if (!options.confirmed) {
    return blocked(plan, "Applying a fix plan changes files. Re-run with --yes after reviewing the plan.");
  }
  if (!samePath(plan.repo, repo)) {
    return blocked(plan, "The plan was produced for " + plan.repo + ", not " + repo + ".");
  }
  if (plan.patches.length === 0) {
    return blocked(plan, "The plan contains no patches.");
  }

  const root = safeExec("git", ["-C", repo, "rev-parse", "--show-toplevel"], repo, 10000);
  if (root.code !== 0) {
    return blocked(plan, "Git could not confirm a repository root (not a repository, or git is unavailable); an isolated worktree cannot be created.");
  }
  const top = root.stdout.trim();
  if (!samePath(top, repo)) {
    return blocked(plan, "Run the fix workflow from the repository root (" + top + ").");
  }

  const verification = verificationPlan(repo);
  const worktree = path.join(repo, ".pitstop", "audit-worktrees", plan.planId.replace(/[^a-z0-9-]/gi, "").slice(0, 24));
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  if (fs.existsSync(worktree)) {
    return blocked(plan, "The worktree for this plan already exists at " + worktree + ". Remove it or regenerate the plan.");
  }
  const add = safeExec("git", ["-C", repo, "worktree", "add", "--detach", worktree, "HEAD"], repo, 60000);
  if (add.code !== 0) {
    return blocked(plan, "git worktree add failed: " + (add.stderr || add.stdout).slice(0, 800));
  }

  const applied: FixApplyResult["applied"] = [];
  const skipped: FixApplyResult["skipped"] = [];
  const byFile = new Map<string, PlannedPatch[]>();
  for (const patch of plan.patches) {
    const list = byFile.get(patch.file) ?? [];
    list.push(patch);
    byFile.set(patch.file, list);
  }

  const realWorktree = fs.realpathSync(worktree);
  for (const [file, patches] of byFile) {
    if (!safeRelative(file)) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "Path escapes the repository." });
      continue;
    }
    const normalized = file.replace(/\\/g, "/");
    const normalizedLower = normalized.toLowerCase();
    if (
      normalizedLower === ".git" ||
      normalizedLower.startsWith(".git/") ||
      normalizedLower === ".pitstop" ||
      normalizedLower.startsWith(".pitstop/")
    ) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "Path targets protected repository state." });
      continue;
    }
    const absolute = path.join(worktree, file);
    if (!fs.existsSync(absolute)) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "File is not present at HEAD." });
      continue;
    }
    if (!fs.statSync(absolute).isFile()) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "Path is not a regular file." });
      continue;
    }
    const realTarget = fs.realpathSync(absolute);
    if (realTarget !== realWorktree && !realTarget.startsWith(realWorktree + path.sep)) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "Path resolves outside the isolated worktree." });
      continue;
    }
    let content = fs.readFileSync(absolute, "utf8");
    if (content.includes("\0")) {
      for (const patch of patches) skipped.push({ findingId: patch.findingId, file, reason: "File appears to be binary." });
      continue;
    }
    let fileApplied = 0;
    const ordered = [...patches].sort((a, b) => b.startLine - a.startLine);
    for (const patch of ordered) {
      const result = applyPatchToContent(content, patch);
      if (!result.ok) {
        skipped.push({ findingId: patch.findingId, file, reason: result.reason });
        continue;
      }
      content = result.content;
      fileApplied += 1;
      applied.push({ findingId: patch.findingId, file });
    }
    if (fileApplied > 0) fs.writeFileSync(absolute, content);
  }

  if (applied.length === 0) {
    const cleanup = safeExec("git", ["-C", repo, "worktree", "remove", "--force", worktree], repo, 30000);
    return {
      status: "blocked",
      planId: plan.planId,
      ...(cleanup.code === 0 ? {} : { worktree }),
      applied,
      skipped,
      verification: [],
      resolvedFingerprints: [],
      regressions: [],
      note:
        "No patch matched the checked-out lines; nothing was applied and verification was not run." +
        (cleanup.code === 0 ? " The empty worktree was removed." : " The empty worktree could not be removed automatically."),
    };
  }

  const steps: VerificationStep[] = [];
  for (const command of verification) {
    steps.push(await runVerification(command, worktree, options.timeoutMs ?? 180000));
  }

  let afterScore: number | undefined;
  let resolvedFingerprints: string[] = [];
  let regressions: FixApplyResult["regressions"] = [];
  let note = "";
  let compared = false;
  let reAuditFailed = false;
  // The isolated worktree has tracked source only. Carry over local audit
  // configuration so the re-audit uses the same suppressions and boundaries,
  // rather than reporting previously suppressed findings as regressions.
  for (const name of ["audit-suppress.json", "architecture.json"]) {
    const from = path.join(repo, ".pitstop", name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(worktree, ".pitstop", name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  const baseline = readBaseline(repo);
  const baselineComplete =
    baseline !== undefined &&
    baseline.schemaVersion === 1 &&
    baseline.mode === "deep" &&
    typeof baseline.repo === "string" &&
    samePath(baseline.repo, repo) &&
    Array.isArray(baseline.findings) &&
    baseline.coverage !== undefined &&
    baseline.coverage.wholeRepository === true &&
    Array.isArray(baseline.coverage.categoriesNotMeasured) &&
    baseline.coverage.categoriesNotMeasured.length === 0;
  try {
    const after = await runAudit(worktree, {
      mode: "deep",
      scope: [],
      useCache: false,
      persist: false,
    });
    afterScore = after.report.score.overall;
    const afterComplete =
      after.report.coverage.wholeRepository === true &&
      Array.isArray(after.report.coverage.categoriesNotMeasured) &&
      after.report.coverage.categoriesNotMeasured.length === 0;
    if (baseline && baselineComplete && afterComplete) {
      compared = true;
      const beforeFingerprints = new Set(
        baseline.findings
          .filter((finding) => finding.lifecycle !== "suppressed")
          .map((finding) => finding.fingerprint),
      );
      const afterActive = after.report.findings.filter((finding) => finding.lifecycle !== "suppressed");
      const afterFingerprints = new Set(afterActive.map((finding) => finding.fingerprint));
      resolvedFingerprints = [...beforeFingerprints].filter((fingerprint) => !afterFingerprints.has(fingerprint));
      // Any new fingerprint is a regression, including low severity: a patch can
      // shift structure and introduce a new finding even when the headline score
      // rises. The list is capped for display, but its non-emptiness still fails
      // verification.
      regressions = afterActive
        .filter((finding) => !beforeFingerprints.has(finding.fingerprint))
        .slice(0, 20)
        .map((finding) => ({ file: finding.location.file, title: finding.title, severity: finding.severity }));
      note = "Re-audit completed on the worktree and compared with the complete sealed baseline.";
    } else if (!afterComplete) {
      note =
        "Re-audit completed on the worktree, but the re-audit was not a complete all-category view " +
        "(file budget, finding budget or an unavailable analyzer); resolved/regression comparison was skipped.";
    } else {
      note =
        "Re-audit completed on the worktree, but no comparable complete sealed all-category baseline " +
        "(same deep mode) was available; resolved/regression comparison was skipped rather than inferred " +
        "from an incomplete or differently scoped run.";
    }
  } catch (error) {
    reAuditFailed = true;
    note = "Patches were applied but the re-audit failed: " + (error as Error).message;
  }

  const failedVerification = steps.some((step) => step.status === "failed");
  const status: FixApplyResult["status"] =
    applied.length === 0
      ? "blocked"
      : failedVerification || reAuditFailed || regressions.length > 0
        ? "failed"
        : steps.some((step) => step.status === "passed")
          ? "verified"
          : "applied";
  return {
    status,
    planId: plan.planId,
    worktree,
    applied,
    skipped,
    verification: steps,
    ...(afterScore !== undefined ? { afterScore } : {}),
    ...(compared && baseline ? { beforeScore: baseline.score.overall } : {}),
    resolvedFingerprints,
    regressions,
    note: note || "No verification command ran; review the diff manually.",
  };
}

function readPlan(file: string): AuditFixPlan {
  if (!fs.existsSync(file)) throw new Error("Fix plan not found: " + file);
  let parsed: AuditFixPlan;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AuditFixPlan;
  } catch {
    throw new Error("Fix plan is not valid JSON; refusing to apply.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.patches) ||
    typeof parsed.planId !== "string" ||
    typeof parsed.repo !== "string"
  ) {
    throw new Error("Unsupported fix plan format.");
  }
  const validPatch = (patch: unknown): boolean => {
    if (!patch || typeof patch !== "object") return false;
    const candidate = patch as Partial<AuditFixPlan["patches"][number]>;
    return (
      typeof candidate.findingId === "string" &&
      typeof candidate.file === "string" &&
      Number.isInteger(candidate.startLine) &&
      Number.isInteger(candidate.endLine) &&
      typeof candidate.before === "string" &&
      typeof candidate.after === "string"
    );
  };
  if (!parsed.patches.every(validPatch)) {
    throw new Error("Unsupported fix plan format: a patch entry is invalid.");
  }
  const check = checkEvidence(parsed);
  if (check.status !== "verified") {
    throw new Error("Fix plan failed its evidence check (" + check.status + "); refusing to apply.");
  }
  return parsed;
}

function readBaseline(repo: string): AuditReport | undefined {
  const file = path.join(repo, ".pitstop", "audit-latest.json");
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AuditReport;
    if (checkEvidence(parsed).status !== "verified") return undefined;
    if (parsed.contentDigest !== undefined && !contentDigestValid(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function verificationPlan(repo: string): string[] {
  try {
    const understanding = buildUnderstanding(repo);
    const commands = [
      understanding.verificationCommands.test,
      understanding.verificationCommands.typecheck,
      understanding.verificationCommands.lint,
      understanding.verificationCommands.build,
    ].filter((command): command is string => Boolean(command));
    const allowed = /^(npm|npx|pnpm|yarn|bun|node|pytest|python|python3|make|cargo|go|dotnet|mvn|gradle)\b/;
    return [...new Set(commands.filter((command) => allowed.test(command)))].slice(0, 4);
  } catch {
    return [];
  }
}

async function runVerification(command: string, cwd: string, timeoutMs: number): Promise<VerificationStep> {
  const started = Date.now();
  const parts = command.trim().split(/\s+/);
  const executable = parts[0];
  if (!executable) {
    return { name: command, command, status: "skipped", code: -1, durationMs: 0, output: "Empty command." };
  }
  const result = await safeExecAsync(executable, parts.slice(1), cwd, timeoutMs);
  const output = redact((result.stdout + "\n" + result.stderr).trim().slice(-4000));
  return {
    name: command,
    command,
    status: result.code === 0 ? "passed" : "failed",
    code: result.code,
    durationMs: Date.now() - started,
    output,
  };
}

/** Apply one line-checked patch. Exported for the regression test only. */
export function applyPatchToContent(content: string, patch: PlannedPatch): { ok: true; content: string } | { ok: false; reason: string } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  if (patch.startLine < 1 || patch.endLine < patch.startLine || patch.endLine > lines.length) {
    return { ok: false, reason: "Patch range is outside the file (" + lines.length + " lines)." };
  }
  const current = lines.slice(patch.startLine - 1, patch.endLine).join("\n");
  if (current !== patch.before) {
    return { ok: false, reason: "Line content changed since the audit; patch not applied." };
  }
  const replacement = patch.after === "" ? [] : patch.after.split(/\r?\n/);
  lines.splice(patch.startLine - 1, patch.endLine - patch.startLine + 1, ...replacement);
  return { ok: true, content: lines.join(eol) };
}

function samePath(left: string, right: string): boolean {
  try {
    const a = fs.realpathSync.native(left);
    const b = fs.realpathSync.native(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    const a = path.resolve(left);
    const b = path.resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  }
}

function safeRelative(file: string): boolean {
  if (!file || file.includes("\0") || path.isAbsolute(file)) return false;
  const normalized = file.replace(/\\/g, "/");
  return !normalized.split("/").includes("..");
}

function blocked(plan: AuditFixPlan, note: string): FixApplyResult {
  return {
    status: "blocked",
    planId: plan.planId,
    applied: [],
    skipped: plan.patches.map((patch) => ({ findingId: patch.findingId, file: patch.file, reason: note })),
    verification: [],
    resolvedFingerprints: [],
    regressions: [],
    note,
  };
}
