import type { Language } from "./util.js";

export interface ScanIssue {
  type: string;
  severity: string;
  file?: string;
  line?: number;
  description: string;
  /** Stable, deterministic finding id (used by `pitstop repro`). */
  id?: string;
}

export interface DependencyGraphResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  engine?: string;
  files: number;
  circular: string[][];
  mostDependedOn: { file: string; count: number }[];
  orphans: string[];
}

export interface SecurityResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  issues: ScanIssue[];
}

export interface DuplicationResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  cloneCount: number;
  clones: { files: string[]; lines: number }[];
}

export interface TestsResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  framework?: string;
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  coverage?: number;
}

export interface PerfResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  buildTimeMs?: number;
  bundleSizeBytes?: number;
  /** Captured when the build script fails, to aid diagnosis. */
  stderr?: string;
  /** Stable id for the perf baseline finding (used by `pitstop repro`). */
  id?: string;
}

export interface AccessibilityResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  /** Which detector produced the findings. */
  engine?: "pa11y" | "axe" | "static-jsx";
  checked?: { type: "html" | "jsx"; count: number };
  issues: ScanIssue[];
}

export interface FlakyTest {
  name: string;
  file?: string;
  /** Outcome per sequential run (length === runs). */
  statuses: ("passed" | "failed")[];
  /** Stable, deterministic finding id. */
  id?: string;
}

export interface ReliabilityResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  /** How many sequential suite runs were executed (1 if skipped after timing). */
  runs: number;
  /** Wall-clock total across all runs. */
  durationMs: number;
  /** Duration of the first (timing) run. */
  suiteDurationMs?: number;
  flakyTests: FlakyTest[];
  /** Timer/state race-condition heuristics — never certain, always labeled. */
  raceSmells: ScanIssue[];
}

export interface DuplicateFunction {
  /** Function name when identical, else "<unnamed>". */
  name: string;
  files: { file: string; line: number }[];
  /** Source lines of the body. */
  lines: number;
  /** Dice similarity of normalized token streams, 0..1. */
  similarity: number;
}

export interface DevexResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  unusedExports: ScanIssue[];
  duplicateFunctions: DuplicateFunction[];
}

export interface ClusterFinding {
  source:
    | "security"
    | "duplication"
    | "graph"
    | "a11y"
    | "reliability"
    | "devex"
    | "ledger";
  severity: string;
  type: string;
  description: string;
  files: string[];
  /** Stable finding id — links a cluster back to scan-latest.json and `pitstop repro`. */
  id?: string;
}

/* ------------------------------------------------------------------ */
/* Ledger mode (`pitstop scan --ledger`)                               */
/* ------------------------------------------------------------------ */

/** A money-moving endpoint discovered by the static scan. */
export interface LedgerEndpoint {
  method: string;
  path: string;
  file?: string;
  line?: number;
  framework?: string;
  /** Keyword that flagged the route (charge/capture/payment/transfer/refund/webhook). */
  matchedKeyword: string;
  /** Payment SDK imports seen in the same file. */
  sdkImports: string[];
  /** Heuristic expectation of the payload shape. */
  expectedPayload: {
    idempotencyKeyHeader?: string;
    amountField?: string;
    currencyField?: string;
    orderIdField?: string;
  };
  /** True when this is a webhook-delivery endpoint (duplicate-webhook scenario). */
  webhook: boolean;
}

/** One request/response pair that the mocked gateway actually received. */
export interface LedgerChargeCall {
  at: string;
  host: string;
  method: string;
  path: string;
  key: string | null;
  orderId: string | null;
  requestId: string;
  requestHeaders: Record<string, string>;
  requestBody: unknown;
  charge: boolean;
  responseStatus: number;
  responseBody: unknown;
}

export type LedgerScenario =
  | "duplicate-webhook"
  | "concurrent-double-submit"
  | "delayed-retry";

/** A proven double-charge (one idempotency key saw >1 gateway charge call). */
export interface LedgerEvidence {
  orderId: string;
  idempotencyKey: string;
  scenario: LedgerScenario;
  endpoint: string;
  endpointFile?: string;
  doubleCharged: boolean;
  chargeCalls: LedgerChargeCall[];
  /** One-line human summary, e.g. "order ord_test_1 charged twice via webhook replay, 340ms apart". */
  summary: string;
  evidenceFile?: string;
  /** Stable finding id (used by `pitstop repro`). */
  id?: string;
}

export interface LedgerResult {
  status: "ok" | "skipped" | "aborted" | "error";
  note?: string;
  /** Endpoints discovered statically. */
  endpoints: LedgerEndpoint[];
  /** Proven double-charges observed from the mocked gateway's receipt log. */
  evidence: LedgerEvidence[];
  /** Where the mocked gateway recorded what it received. */
  gatewayLogPath?: string;
  /** Absolute path of the written evidence file (`.pitstop/ledger-evidence-<ts>.json`). */
  evidenceFile?: string;
}

export interface Cluster {
  rootCause: ClusterFinding;
  symptoms: ClusterFinding[];
  sharedFiles: string[];
  size: number;
}

export interface ScanResult {
  timestamp: string;
  repo: string;
  /** `try` was produced by the quick `pitstop try` pass (tests/perf/reliability intentionally skipped). */
  mode?: "full" | "try";
  language: Language;
  dependencyGraph: DependencyGraphResult;
  security: SecurityResult;
  duplication: DuplicationResult;
  tests: TestsResult;
  perf: PerfResult;
  accessibility: AccessibilityResult;
  reliability: ReliabilityResult;
  devex: DevexResult;
  /** Present only when the scan ran with `--ledger`. */
  ledger?: LedgerResult;
  clusters: Cluster[];
}
