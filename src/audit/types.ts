/**
 * audit/types.ts — the Deep Codebase Intelligence data model.
 *
 * An audit finding is deliberately stricter than a lint message: every field
 * that a reader needs to judge the claim (location, evidence, confirmation,
 * suggestion, trade-off) is required, and every score point must point back
 * to a finding.
 */

export type AuditMode = "quick" | "deep" | "full";

export type AuditCategory =
  | "correctness"
  | "maintainability"
  | "architecture"
  | "performance"
  | "readability"
  | "type-safety"
  | "security"
  | "testing";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingConfidence = "high" | "medium" | "low";
export type Confirmation = "confirmed" | "potential" | "unproven";
export type FindingLifecycle = "new" | "existing" | "resolved" | "suppressed";
export type RiskHorizon = "short" | "medium" | "long";

export interface AuditLocation {
  file: string;
  line: number;
  endLine: number;
}

export interface AuditEvidence {
  /** Where this evidence came from: a rule, an index, a tool or a test run. */
  source: string;
  detail: string;
  /** A short, secret-free excerpt that supports the claim. */
  excerpt?: string;
}

export interface AuditSuggestion {
  /** One sentence: what to do. */
  summary: string;
  /** The concrete change, including the boundary the change should respect. */
  change: string;
  /** Optional illustrative replacement (never applied automatically). */
  example?: string;
  /** What the change could regress or cost. */
  tradeoffs: string;
  effort: "small" | "medium" | "large";
  /** True only when this capability can produce a deterministic, reviewable patch. */
  autoFixable: boolean;
}

export interface AuditPatch {
  file: string;
  startLine: number;
  endLine: number;
  before: string;
  after: string;
}

export interface AuditFinding {
  id: string;
  /** Stable identity: rule + file + symbol, else a hash of the measured text. */
  fingerprint: string;
  rule: string;
  category: AuditCategory;
  subcategory: string;
  title: string;
  explanation: string;
  location: AuditLocation;
  symbol?: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  confirmation: Confirmation;
  impact: string;
  /** Why the observed implementation is a problem in this context. */
  why: string;
  evidence: AuditEvidence[];
  suggestion: AuditSuggestion;
  lifecycle: FindingLifecycle;
  /** Local suppression metadata; present only when lifecycle is "suppressed". */
  suppression?: { reason?: string; expires?: string };
  tags: string[];
  /** Score points this finding deducts (after per-category decay). */
  deduction: number;
  /** Deterministic patch, when this capability can produce one safely. */
  patch?: AuditPatch;
}

export interface RiskPrediction {
  id: string;
  category: AuditCategory;
  title: string;
  explanation: string;
  locations: AuditLocation[];
  evidence: AuditEvidence[];
  /** The assumption that would have to hold for this risk to materialise. */
  assumption: string;
  confidence: FindingConfidence;
  impact: string;
  horizon: RiskHorizon;
  relatedFindings: string[];
}

export interface ScoreDeduction {
  findingId: string;
  rule: string;
  category: AuditCategory;
  severity: FindingSeverity;
  rawPoints: number;
  /** Points after the per-category diminishing-return decay. */
  points: number;
  reason: string;
}

export interface CategoryScore {
  category: AuditCategory;
  label: string;
  weight: number;
  measured: boolean;
  score: number;
  deductionTotal: number;
  findingCount: number;
  note?: string;
}

export interface EngineeringScore {
  overall: number;
  /** 0..100 weight actually measured; unsupported categories are excluded. */
  measuredWeight: number;
  categories: CategoryScore[];
  deductions: ScoreDeduction[];
  confidence: FindingConfidence;
  /** The honest precision band, e.g. "±0 (deterministic)" or "±11". */
  band: string;
  /** A disclosed ceiling when a confirmed severe finding makes a high score misleading. */
  cap?: { value: number; reason: string };
  summary: string;
}

export interface LanguageCoverage {
  language: string;
  displayName: string;
  files: number;
  indexed: number;
  semantic: "call-graph" | "structural" | "lexical" | "none";
  note: string;
}

export interface CoverageReport {
  /** Repository-relative paths requested with --scope; empty means the whole repository. */
  scope: string[];
  /** Effective file budget after mode defaults and --max-files clamping. */
  budget: number;
  /** True only for a whole-repository run that examined every file and finding. */
  wholeRepository: boolean;
  /** Why the run is not a complete whole-repository view, when it is not. */
  wholeRepositoryReason?: string;
  sourceFiles: number;
  indexed: number;
  parsed: number;
  semantic: number;
  skipped: number;
  testsDetected: number;
  /** Files that contain at least one detected test declaration. */
  testFiles: number;
  categoriesMeasured: AuditCategory[];
  categoriesNotMeasured: AuditCategory[];
  languages: LanguageCoverage[];
  tools: { name: string; available: boolean; used: boolean; note: string }[];
  limitations: string[];
}

export interface AuditIndexSummary {
  files: number;
  functions: number;
  imports: number;
  callSites: number;
  resolvedCallSites: number;
  routes: number;
  entryPoints: string[];
  executionPaths: { route: string; depth: number; path: string[] }[];
  cycles: string[][];
  boundaries: number;
}

export interface AuditRecommendation {
  priority: number;
  findingIds: string[];
  title: string;
  action: string;
  rationale: string;
  effort: "small" | "medium" | "large";
}

export interface AuditStrength {
  title: string;
  evidence: string;
}

export interface AuditReport {
  schemaVersion: 1;
  repo: string;
  mode: AuditMode;
  generatedAt: string;
  durationMs: number;
  score: EngineeringScore;
  coverage: CoverageReport;
  findings: AuditFinding[];
  /** Findings from the previous sealed audit that no longer appear. */
  resolved: AuditFinding[];
  risks: RiskPrediction[];
  strengths: AuditStrength[];
  recommendations: AuditRecommendation[];
  index: AuditIndexSummary;
  limits: string[];
  /** Digest over the whole report, including nested finding/risk evidence. */
  contentDigest?: string;
  evidence?: {
    scheme: string;
    digest: string;
    of: string;
    signedAt: string;
  };
}

export interface AuditOptions {
  mode: AuditMode;
  /** Repository-relative directories/files to audit. Empty means the repo. */
  scope: string[];
  /** Restrict scoring/findings to these categories (still indexes everything). */
  categories?: AuditCategory[];
  maxFiles?: number;
  useCache?: boolean;
  /** Persist sealed artifacts under .pitstop/ (default true). */
  persist?: boolean;
  /** Fail the process when a finding at or above this severity exists. */
  failOn?: FindingSeverity;
}

export interface AuditRunResult {
  report: AuditReport;
  /** Paths written, relative to the repo. */
  artifacts: { json?: string; markdown?: string };
  /** Non-fatal problems (skipped files, unavailable measurements). */
  warnings: string[];
}

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  correctness: "Correctness and reliability",
  maintainability: "Maintainability",
  architecture: "Architecture and design",
  performance: "Performance and efficiency",
  readability: "Code quality and readability",
  "type-safety": "Type safety",
  security: "Security practices",
  testing: "Testing and verification",
};

export const CATEGORY_WEIGHTS: Record<AuditCategory, number> = {
  correctness: 22,
  maintainability: 18,
  architecture: 14,
  performance: 12,
  readability: 10,
  "type-safety": 10,
  security: 8,
  testing: 6,
};

export const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
