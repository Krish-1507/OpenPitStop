import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../installer/targets.js";
import type { CheckMode } from "../checks/report.js";

/**
 * Local onboarding state only. This is UI preference, not verification
 * evidence — it never contributes to a gate or report.
 */
export interface OnboardingState {
  schemaVersion: 1;
  completedAt?: string;
  lastSeenAt?: string;
  lastCheckMode?: CheckMode;
  configuredAgents?: AgentId[];
  skippedAgentSetup?: boolean;
  skippedCheck?: boolean;
}

function statePath(repo: string): string {
  return path.join(path.resolve(repo), ".pitstop", "onboarding.json");
}

export function loadOnboardingState(repo: string): OnboardingState {
  const file = statePath(repo);
  if (!fs.existsSync(file)) return { schemaVersion: 1 };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Partial<OnboardingState>;
    if (parsed.schemaVersion !== 1) return { schemaVersion: 1 };
    return { ...parsed, schemaVersion: 1 };
  } catch {
    return { schemaVersion: 1 };
  }
}

export function saveOnboardingState(repo: string, state: OnboardingState): void {
  const file = statePath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...state, schemaVersion: 1, lastSeenAt: new Date().toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function isOnboardingComplete(repo: string): boolean {
  return Boolean(loadOnboardingState(repo).completedAt);
}
