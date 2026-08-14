/**
 * pen/types.ts — shared types for `pitstop pen`.
 *
 * A pen finding carries its proof with it: the exact attack that was fired
 * (or the static pattern that was matched), the observed response, and any
 * sandbox evidence (outbound host / spawn command). Nothing is asserted
 * without a receipt — that is what separates pen from vibes.
 */

export type PenConfidence = "proven" | "indicated" | "heuristic";
export type PenSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface PenAttackRequest {
  method: string;
  /** Path on the app (without origin), e.g. /api/charge/1 */
  path: string;
  payload?: unknown;
}

export interface PenResponseEvidence {
  status?: number;
  /** First ~300 chars of the response body, sanitized. */
  snippet?: string;
  headers?: Record<string, string>;
}

export interface PenFinding {
  id: string;
  source: "pen-static" | "pen-dynamic";
  /** xss, sql-injection, missing-auth, ssrf, command-injection, ... */
  type: string;
  severity: PenSeverity;
  confidence: PenConfidence;
  title: string;
  description: string;
  /** Static findings: the file that matched. */
  file?: string;
  line?: number;
  /** Dynamic findings: the route that was attacked. */
  route?: string;
  method?: string;
  /** The exact attack that was fired (dynamic). */
  attack?: PenAttackRequest;
  response?: PenResponseEvidence;
  /** Sandbox evidence: outbound hosts / spawn commands that matched. */
  outbound?: string[];
  /** How a human (or the agent loop) can reproduce it by hand. */
  repro?: string;
  /** Recommended fix, written for a human or an agent to apply. */
  fix?: string;
  /** Set by `--fix` when a deterministic patch was generated. */
  patchFile?: string;
  /**
   * Live-attack verdict for a STATIC finding, applied by the runtime-proof
   * pass after the dynamic phase: "proven" (a canary-class live attack
   * confirmed it), "indicated" (live probing produced class-level signals
   * but no canary), "unproven" (probed with no signal — pattern may be a
   * false positive), "not-tested" (no live probe exists / app did not boot).
   */
  runtimeProof?: "proven" | "indicated" | "unproven" | "not-tested";
  /** Human note explaining the runtime verdict (and the proof it cites). */
  runtimeNote?: string;
  /** For runtime-proven static findings: the dynamic attack class that proved it (e.g. "reflected-xss"). */
  proofType?: string;
}

export interface PenDynamicSummary {
  status: "ok" | "aborted" | "skipped";
  note?: string;
  routesProbed: number;
  attacks: number;
  bootMs: number;
  durationMs: number;
  outboundEvents: number;
}

export interface PenResult {
  timestamp: string;
  repo: string;
  mode: "pen";
  staticEnabled: boolean;
  dynamicEnabled: boolean;
  dynamic: PenDynamicSummary;
  packages: string[];
  /** Runtime verification of static findings (absent when the dynamic phase was skipped). */
  staticProof?: {
    proven: number;
    indicated: number;
    unproven: number;
    notTested: number;
  };
  findings: PenFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    proven: number;
    indicated: number;
    heuristic: number;
  };
}

export const SEVERITY_ORDER: PenSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

export function summarizeFindings(findings: PenFinding[]): PenResult["summary"] {
  const s = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    proven: 0,
    indicated: 0,
    heuristic: 0,
  };
  for (const f of findings) {
    if (f.severity === "critical") s.critical++;
    else if (f.severity === "high") s.high++;
    else if (f.severity === "medium") s.medium++;
    else if (f.severity === "low") s.low++;
    else s.info++;
    if (f.confidence === "proven") s.proven++;
    else if (f.confidence === "indicated") s.indicated++;
    else s.heuristic++;
  }
  return s;
}

/** Sort findings: severity first, proven above indicated above heuristic. */
export function sortFindings(findings: PenFinding[]): PenFinding[] {
  const sevRank = (s: PenSeverity) => SEVERITY_ORDER.indexOf(s);
  const confRank = (c: PenConfidence) => (c === "proven" ? 0 : c === "indicated" ? 1 : 2);
  return [...findings].sort(
    (a, b) => sevRank(a.severity) - sevRank(b.severity) || confRank(a.confidence) - confRank(b.confidence),
  );
}

/** A route inventory entry for the dynamic phase. */
export interface PenRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  /** True when the path looks sensitive (money/auth/admin). */
  sensitive: boolean;
  /** True when the path is login-ish (rate-limit battery applies). */
  loginLike: boolean;
}
