import fs from "node:fs";
import path from "node:path";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { globMatches } from "../understand/index.js";

/**
 * plan.ts — PLAN BEFORE PATCHING.
 *
 * A change is planned BEFORE it is made: goal, steps, the paths it is allowed
 * to touch, and the verification commands that will judge it. The plan is a
 * sealed artifact — and it is a CONTRACT, not a diary: `pitstop
 * architecture-check --against-plan` compares the files the agent ACTUALLY
 * changed against `expectedPaths`, so scope creep (touching what was never
 * planned) is detected deterministically.
 *
 * The plan does not make the change safe — it makes the change *accountable*.
 */

export interface ChangePlan {
  id: string;
  goal: string;
  steps: string[];
  /** Paths/globs the change is allowed to touch. Everything else is scope creep. */
  expectedPaths: string[];
  verification: { commands: string[] };
  /** Protected/boundary constraints the plan acknowledges it must respect. */
  boundariesAcknowledged?: string[];
  risks?: string[];
}

export interface PlanScopeResult {
  planned: string[];
  unplanned: string[];
}

export function validatePlan(plan: ChangePlan): string | null {
  if (!plan || typeof plan.id !== "string" || !plan.id.trim()) return "plan needs an id";
  if (!plan.goal || typeof plan.goal !== "string") return "plan needs a goal";
  if (!Array.isArray(plan.expectedPaths) || plan.expectedPaths.length === 0) {
    return "plan needs expectedPaths — a plan that does not declare what it may touch is not a plan";
  }
  for (const p of plan.expectedPaths) {
    if (typeof p !== "string" || !p.trim()) return "expectedPaths entries must be non-empty strings";
    if (path.isAbsolute(p)) return `expectedPaths entries must be repo-relative: ${p}`;
  }
  if (!plan.verification || !Array.isArray(plan.verification.commands) || plan.verification.commands.length === 0) {
    return "plan needs verification.commands — how will the change be proven?";
  }
  return null;
}

export function createPlan(repo: string, plan: ChangePlan): { file: string; latest: string; evidence: OpenPitStopEvidence } | { error: string } {
  const invalid = validatePlan(plan);
  if (invalid) return { error: invalid };
  const outDir = path.join(path.resolve(repo), ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `plan-${ts}.json`);
  const latest = path.join(outDir, "plan-latest.json");
  const doc = seal({ kind: "openpitstop-change-plan", createdAt: new Date().toISOString(), ...plan }, `change plan ${plan.id}`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  fs.writeFileSync(latest, JSON.stringify(doc, null, 2));
  return { file, latest, evidence: (doc as any).evidence };
}

export function loadLatestPlan(repo: string): { plan: ChangePlan; file: string; check: EvidenceCheck } | null {
  const p = path.join(path.resolve(repo), ".pitstop", "plan-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { plan: doc as ChangePlan, file: p, check: checkEvidence(doc) };
  } catch {
    return { plan: {} as ChangePlan, file: p, check: { status: "tampered", digest: "", reason: "unreadable plan" } };
  }
}

/** Which changed files are inside the plan's declared scope, which are scope creep. */
export function checkPlanScope(plan: ChangePlan, changedFiles: string[]): PlanScopeResult {
  const planned: string[] = [];
  const unplanned: string[] = [];
  for (const f of changedFiles) {
    const norm = f.replace(/\\/g, "/");
    if (globMatches(plan.expectedPaths, norm) || norm.startsWith(".pitstop/")) planned.push(norm);
    else unplanned.push(norm);
  }
  return { planned, unplanned };
}

export function planEvidenceRef(repo: string): { file: string; evidence: OpenPitStopEvidence } | null {
  const p = path.join(path.resolve(repo), ".pitstop", "plan-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(p, "utf8"));
    return { file: p, evidence: doc.evidence };
  } catch {
    return null;
  }
}
