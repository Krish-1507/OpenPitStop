import fs from "node:fs";
import path from "node:path";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { safeExec } from "../analyzers/util.js";
import { getDiff } from "../analyzers/integrity/git.js";
import { runDetectors } from "../analyzers/integrity/index.js";
import type { FileChange } from "../analyzers/integrity/types.js";
import { buildUnderstanding, globMatches, ownersFor, type ArchitectureConfig } from "../understand/index.js";
import { loadLatestPlan, checkPlanScope } from "./plan.js";

/**
 * architecture.ts — ARCHITECTURE & BOUNDARY VERIFICATION.
 *
 * "Does this change still fit the system?" A change can pass every test and
 * still be wrong for the repo: crossing a module boundary, touching protected
 * paths (auth, deployment, CI), planting shortcuts, or creeping outside the
 * plan. This module checks a candidate change against the repo's DECLARED
 * architecture rules plus its real structure:
 *
 *   boundaries   — declared import rules ("src/core/** must not import src/ui/**")
 *   protected    — paths that require explicit human approval (auth, deploy, CI)
 *   forbidden    — paths that must never be modified (secrets, generated code)
 *   ownership    — CODEOWNERS: who owns the touched paths (review routing)
 *   shortcuts    — the existing AI-agent-cheat detectors (suppressions,
 *                  hardcoded passes, mock overreach, forced exits, ...)
 *   plan scope   — files the agent changed vs files the plan declared (--against-plan)
 *
 * VERDICTS: CONFORMS · APPROVAL_REQUIRED · VIOLATIONS · INTEGRITY_FAILURE.
 * Approval is explicit: `--approved` records that a human accepted the
 * protected-path touches; without it an APPROVAL_REQUIRED change cannot pass
 * the gate.
 */

export type ArchitectureVerdict = "CONFORMS" | "APPROVAL_REQUIRED" | "VIOLATIONS" | "INTEGRITY_FAILURE";

export interface ArchitectureEntry {
  kind: "boundary-violation" | "protected-path" | "forbidden-path" | "shortcut" | "scope-creep" | "review-required";
  file: string;
  detail: string;
  severity: "violation" | "approval" | "info";
  reason?: string;
}

export interface ArchitectureResult {
  repo: string;
  from: string;
  to: string;
  configPath: string | null;
  changedFiles: string[];
  entries: ArchitectureEntry[];
  verdict: ArchitectureVerdict;
  reasons: string[];
  notes: string[];
  planRef?: string;
  approved: boolean;
  sealedPath?: string;
  sealed?: OpenPitStopEvidence;
}

function extractImports(file: string, content: string): string[] {
  const specs: string[] = [];
  const re = /(?:import[^'"]*from\s*['"]([^'"]+)['"])|(?:import\s*['"]([^'"]+)['"])|(?:require\(\s*['"]([^'"]+)['"]\s*\))|(?:from\s+['"]([^'"]+)['"]\s+import)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) specs.push(spec);
  }
  void file;
  return specs;
}

function resolveImport(repo: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // bare package imports are not boundary-relevant
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile.replace(/\\/g, "/")), spec));
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}/index.ts`, `${base}/index.js`, `${base}/index.tsx`, `${base}/index.jsx`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(repo, c))) return c;
  }
  return base; // unresolved — still check the literal path
}

export async function checkArchitecture(opts: {
  repo: string;
  from?: string;
  to?: string;
  againstPlan?: boolean;
  approved?: boolean;
}): Promise<ArchitectureResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  const notes: string[] = [];
  const entries: ArchitectureEntry[] = [];

  const result: ArchitectureResult = {
    repo,
    from: opts.from ?? "HEAD",
    to: opts.to ?? "",
    configPath: null,
    changedFiles: [],
    entries,
    verdict: "INTEGRITY_FAILURE",
    reasons,
    notes,
    approved: opts.approved === true,
  };

  if (safeExec("git", ["rev-parse", "--is-inside-work-tree"], repo).code !== 0) {
    reasons.push(`not a git repository: ${repo}`);
    return result;
  }

  // ---- understanding (architecture config + ownership)
  let config: ArchitectureConfig = { boundaries: [], protected: [], forbidden: [] };
  let ownershipRules: { path: string; owners: string[] }[] = [];
  try {
    const u = buildUnderstanding(repo);
    config = u.architecture;
    result.configPath = u.architectureConfigPath;
    ownershipRules = u.ownership;
    if (!u.architectureConfigPath) {
      notes.push("no architecture config found (openpitstop.architecture.json or .pitstop/architecture.json) — only generic checks ran (shortcuts, plan scope, ownership)");
    }
  } catch (e: any) {
    reasons.push(e.message);
    return result;
  }

  // ---- the change
  const changes: FileChange[] = getDiff(repo, result.from, result.to || undefined);
  const changedFiles = changes.map((c) => c.path);
  result.changedFiles = changedFiles;
  if (changedFiles.length === 0) {
    result.verdict = "CONFORMS";
    reasons.push("no changed files between the given refs — nothing to check");
    return result;
  }

  // ---- forbidden paths (hard violation)
  for (const f of changedFiles) {
    for (const rule of config.forbidden ?? []) {
      if (globMatches(rule.path, f)) {
        entries.push({ kind: "forbidden-path", file: f, detail: `forbidden path touched (${rule.path})`, severity: "violation", reason: rule.reason });
      }
    }
  }

  // ---- protected paths (approval required)
  for (const f of changedFiles) {
    for (const rule of config.protected ?? []) {
      if (globMatches(rule.path, f)) {
        entries.push({
          kind: "protected-path",
          file: f,
          detail: result.approved ? `protected path touched — APPROVED by explicit --approved` : `protected path touched — human approval required`,
          severity: result.approved ? "info" : "approval",
          reason: rule.reason,
        });
      }
    }
  }

  // ---- boundary rules (import graph on changed source files)
  for (const change of changes) {
    const content = change.after;
    if (content == null) continue;
    const lang = change.language;
    if (lang === "unknown") continue;
    for (const spec of extractImports(change.path, content)) {
      const resolved = resolveImport(repo, change.path, spec);
      if (!resolved) continue;
      for (const rule of config.boundaries ?? []) {
        if (!globMatches(rule.from, change.path)) continue;
        for (const target of rule.forbidImportsFrom) {
          if (globMatches(target, resolved)) {
            entries.push({
              kind: "boundary-violation",
              file: change.path,
              detail: `imports ${resolved} (forbidden: ${target})`,
              severity: "violation",
              reason: rule.reason,
            });
          }
        }
      }
    }
  }

  // ---- ownership (review routing — informational)
  try {
    const ownersByFile = new Map<string, string[]>();
    for (const f of changedFiles) {
      const owners = ownersFor(ownershipRules, f);
      if (owners.length > 0) ownersByFile.set(f, owners);
    }
    if (ownersByFile.size > 0) {
      const grouped = new Map<string, string[]>();
      for (const [f, owners] of ownersByFile) {
        const key = owners.join(", ");
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key)!.push(f);
      }
      for (const [owners, files] of grouped) {
        entries.push({ kind: "review-required", file: files.join(", "), detail: `owned by ${owners}`, severity: "info" });
      }
    }
  } catch { /* CODEOWNERS optional */ }

  // ---- shortcuts: existing integrity detectors on the diff
  const detectorFindings = runDetectors(changes);
  for (const f of detectorFindings) {
    entries.push({
      kind: "shortcut",
      file: f.line ? `${f.file}:${f.line}` : f.file,
      detail: `${f.detector}/${f.pattern} — ${f.evidence}`,
      severity: f.confidence === "confirmed" ? "violation" : "approval",
      reason: "a shortcut that will cause problems later (suppressed check, hardcoded pass, mocked module, forced exit)",
    });
  }

  // ---- plan scope
  if (opts.againstPlan) {
    const plan = loadLatestPlan(repo);
    if (!plan) {
      reasons.push("--against-plan given but no plan exists (.pitstop/plan-latest.json) — create one with `pitstop plan`");
      result.verdict = "INTEGRITY_FAILURE";
      return result;
    }
    if (plan.check.status !== "verified") {
      reasons.push(`the plan evidence is ${plan.check.status} — the plan was modified after creation`);
      result.verdict = "INTEGRITY_FAILURE";
      return result;
    }
    result.planRef = plan.file;
    const scope = checkPlanScope(plan.plan, changedFiles);
    for (const f of scope.unplanned) {
      entries.push({
        kind: "scope-creep",
        file: f,
        detail: "changed but not in the plan's expectedPaths",
        severity: "violation",
        reason: `plan "${plan.plan.id}" declared scope: ${plan.plan.expectedPaths.join(", ")}`,
      });
    }
    notes.push(`plan scope: ${scope.planned.length} planned file(s), ${scope.unplanned.length} unplanned`);
  }

  // ---- verdict
  const violations = entries.filter((e) => e.severity === "violation");
  const approvals = entries.filter((e) => e.severity === "approval");
  if (violations.length > 0) {
    result.verdict = "VIOLATIONS";
    for (const v of violations) reasons.push(`${v.kind}: ${v.file} — ${v.detail}${v.reason ? ` (${v.reason})` : ""}`);
  } else if (approvals.length > 0 && !result.approved) {
    result.verdict = "APPROVAL_REQUIRED";
    for (const a of approvals) reasons.push(`${a.kind}: ${a.file} — ${a.detail}${a.reason ? ` (${a.reason})` : ""}`);
    reasons.push("re-run with --approved after a human accepts these changes");
  } else {
    result.verdict = "CONFORMS";
    reasons.push(
      `change conforms to the declared architecture (${changedFiles.length} file(s) checked` +
        `${config.boundaries?.length ? `, ${config.boundaries.length} boundary rule(s)` : ""}` +
        `${approvals.length ? `, ${approvals.length} approved protected-path touch(es)` : ""})`,
    );
  }
  return result;
}

// CODEOWNERS ownership comes from the understanding module (single parser)

/** Seal the architecture result into .pitstop/ (gate-readable). */
export function sealArchitectureResult(result: ArchitectureResult): ArchitectureResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `architecture-${ts}.json`);
  const doc = {
    timestamp: new Date().toISOString(),
    repo: result.repo,
    from: result.from,
    to: result.to,
    configPath: result.configPath,
    changedFiles: result.changedFiles,
    entries: result.entries,
    verdict: result.verdict,
    reasons: result.reasons,
    notes: result.notes,
    planRef: result.planRef,
    approved: result.approved,
  };
  const sealed = seal(doc, `architecture check for ${result.repo}`);
  fs.writeFileSync(sealedPath, JSON.stringify(sealed, null, 2));
  return { ...result, sealedPath, sealed: (sealed as any).evidence };
}

export function checkArchitectureEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const doc = JSON.parse(raw);
    return checkEvidence(doc);
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}
