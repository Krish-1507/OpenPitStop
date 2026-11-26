import path from "node:path";
import { analyzeSecurityStatic } from "../analyzers/securityStatic.js";
import { discoverLanguages } from "../languages/discovery.js";
import type { KnownLanguage } from "../languages/types.js";
import {
  SECURITY_COVERAGE,
  coverageLabel,
  discoverScenarios,
  type BenchCheck,
  type BenchKind,
  type ExpectedFinding,
  type Scenario,
} from "./scenario.js";

export type ScenarioVerdict =
  | "detected"
  | "partial"
  | "missed"
  | "clean"
  | "noisy"
  | "as-documented"
  | "newly-detected"
  | "not-reproduced"
  | "skipped"
  | "unexpected-coverage"
  | "survived"
  | "crashed";

export interface BenchFinding {
  category: string;
  file?: string;
  line?: number;
  severity?: string;
  title: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  kind: BenchKind;
  stack: string;
  check: BenchCheck;
  pairOf?: string;
  verdict: ScenarioVerdict;
  expected: string[];
  reported: BenchFinding[];
  matched: string[];
  missing: string[];
  falsePositives: string[];
  /** Findings on a fixed or benign fixture outside the forbidden set: shown, not scored. */
  noise: string[];
  skippedReason?: string;
  error?: string;
  durationMs: number;
}

export interface PairResult {
  vulnerable: string;
  fixed: string;
  status: "discriminating" | "vulnerable-missed" | "fixed-noisy" | "both" | "inconclusive";
}

export interface BenchSummary {
  scenarios: number;
  expectedFindings: number;
  detectedFindings: number;
  missedFindings: number;
  falsePositives: number;
  /** detected / (detected + false positives); null when the checks made no claims. */
  precision: number | null;
  /** detected / (detected + missed expected findings); null when nothing could be detected. */
  recall: number | null;
  missedScenarios: string[];
  partialScenarios: string[];
  falsePasses: number;
  noisyScenarios: string[];
  pairs: PairResult[];
  skipped: { id: string; stack: string; reason: string }[];
  knownMisses: string[];
  outdatedKnownMisses: string[];
  knownFalsePositives: string[];
  staleFalsePositives: string[];
  crashes: { id: string; error: string }[];
  noise: number;
  durationMs: number;
}

export interface BenchReport {
  schemaVersion: 1;
  root: string;
  generatedAt: string;
  engine: { check: BenchCheck; description: string }[];
  scenarios: ScenarioResult[];
  summary: BenchSummary;
  coverage: string;
  limits: string[];
}

export const BENCH_LIMITS = [
  "The static security check reads JS/TS, Python, Go, Ruby, PHP, Java and C# sources. Other stacks are reported as skipped coverage, never as clean.",
  "Fixtures are curated near-misses rather than a random sample, so precision here describes this set and is not a general-world estimate.",
  "A match is a finding category at a file with confidence `indicated`: a lead, not an exploit proof. Dynamic pen testing is measured elsewhere.",
  "The benchmark runs the analyzer pipeline in-process. CLI startup, network work, Docker isolation and agent calls are not part of the timing.",
  "A known-miss scenario records a limitation on purpose. `newly-detected` means the fixture is stale, not that the benchmark failed.",
];

/** Findings the check reported for a fixture, normalized to repo-relative POSIX paths. */
function securityFindings(repo: string): BenchFinding[] {
  return analyzeSecurityStatic(repo).map((issue) => ({
    category: issue.category ?? issue.type,
    file: issue.file ? issue.file.replace(/\\/g, "/").replace(/^\.\//, "") : undefined,
    line: issue.line,
    severity: issue.severity,
    title: (issue.title ?? issue.description ?? "").replace(/^\[indicated\]\s*/, "").slice(0, 120),
  }));
}

function label(finding: ExpectedFinding): string {
  return finding.file ? `${finding.category} @ ${finding.file}` : finding.category;
}

function reported(findings: BenchFinding[], expected: ExpectedFinding): boolean {
  return findings.some((finding) => finding.category === expected.category && (!expected.file || finding.file === expected.file));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * What a clean-intent fixture must not report. A fixed scenario forbids exactly the
 * paired defect (category and file); a benign or documented false positive forbids a
 * whole category, because there is no single line to point at.
 */
function forbiddenFindings(scenario: Scenario, pair?: Scenario): ExpectedFinding[] {
  if (scenario.kind === "fixed") return pair?.expect.findings ?? [];
  // A documented miss forbids the very findings it records as unproven.
  if (scenario.kind === "known-miss") return scenario.expect.findings ?? [];
  return (scenario.expect.forbid ?? []).map((category) => ({ category }));
}

/**
 * Compare one fixture with its recorded expectation. Pure, so the benchmark and its tests
 * share one classification: a change in how a verdict is reached happens in one place.
 */
export function assess(scenario: Scenario, findings: BenchFinding[], pair?: Scenario): ScenarioResult {
  const expected = scenario.expect.findings ?? [];
  const matched = expected.filter((finding) => reported(findings, finding)).map((finding) => label(finding));
  const missing = expected.filter((finding) => !reported(findings, finding)).map((finding) => label(finding));
  const forbidden = forbiddenFindings(scenario, pair);
  const falsePositives = unique(forbidden.filter((entry) => reported(findings, entry)).map((entry) => label(entry)));
  const noise =
    scenario.kind === "fixed" || scenario.kind === "benign"
      ? unique(findings.filter((finding) => !forbidden.some((entry) => reported([finding], entry))).map((finding) => finding.category))
      : [];

  let verdict: ScenarioVerdict = "survived";
  if (scenario.kind === "vulnerable") verdict = missing.length === 0 ? "detected" : matched.length > 0 ? "partial" : "missed";
  else if (scenario.kind === "fixed" || scenario.kind === "benign") verdict = falsePositives.length ? "noisy" : "clean";
  else if (scenario.kind === "known-miss") verdict = falsePositives.length ? "newly-detected" : "as-documented";
  else if (scenario.kind === "known-false-positive") verdict = falsePositives.length ? "as-documented" : "not-reproduced";

  return {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    stack: scenario.stack,
    check: scenario.checks[0] ?? "security",
    pairOf: scenario.pairOf,
    verdict,
    expected: expected.map((finding) => label(finding)),
    reported: findings,
    matched,
    missing,
    falsePositives,
    noise,
    durationMs: 0,
  };
}

function emptyResult(scenario: Scenario, start: number): ScenarioResult {
  return {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    stack: scenario.stack,
    check: scenario.checks[0] ?? "security",
    pairOf: scenario.pairOf,
    verdict: "skipped",
    expected: (scenario.expect.findings ?? []).map((finding) => label(finding)),
    reported: [],
    matched: [],
    missing: [],
    falsePositives: [],
    noise: [],
    durationMs: Math.round(performance.now() - start),
  };
}

/**
 * Run one fixture. A fixture the check cannot read is skipped coverage; a fixture that
 * makes the check throw is a crash and fails `--strict`, because a benchmark that hides
 * analyzer failures would be measuring nothing.
 */
/** The check under measurement. Injectable so the failure path is testable without a mock module. */
export type CheckRunner = (repo: string) => BenchFinding[];

export async function runScenario(scenario: Scenario, pair?: Scenario, run: CheckRunner = securityFindings): Promise<ScenarioResult> {
  const start = performance.now();
  const check = scenario.checks[0] ?? "security";
  try {
    const primary = discoverLanguages(scenario.repo).primary;
    if (scenario.kind === "unsupported" && SECURITY_COVERAGE.includes(primary as KnownLanguage)) {
      return {
        ...emptyResult(scenario, start),
        verdict: "unexpected-coverage",
        skippedReason: `the manifest says the check cannot read ${primary}, but it can`,
      };
    }
    if (!SECURITY_COVERAGE.includes(primary as KnownLanguage)) {
      return {
        ...emptyResult(scenario, start),
        skippedReason: `${check} check does not read ${primary} sources (covers ${coverageLabel(check)})`,
      };
    }
    const result = assess(scenario, run(scenario.repo), pair);
    result.durationMs = Math.round(performance.now() - start);
    return result;
  } catch (error) {
    return { ...emptyResult(scenario, start), verdict: "crashed", error: (error as Error).message.slice(0, 300) };
  }
}

/** Aggregate results into the published numbers. Every ratio names its denominator. */
export function summarize(results: ScenarioResult[]): BenchSummary {
  const scored = results.filter((result) => result.verdict !== "skipped" && result.verdict !== "crashed");
  const vulnerable = scored.filter((result) => result.kind === "vulnerable");
  const cleanIntent = scored.filter((result) => result.kind === "fixed" || result.kind === "benign");
  const detectedFindings = vulnerable.reduce((total, result) => total + result.matched.length, 0);
  const missedFindings = vulnerable.reduce((total, result) => total + result.missing.length, 0);
  const falsePositives = cleanIntent.reduce((total, result) => total + result.falsePositives.length, 0);
  const claims = detectedFindings + falsePositives;

  const byId = new Map(results.map((result) => [result.id, result]));
  const pairs: PairResult[] = results
    .filter((result) => result.kind === "fixed" && result.pairOf)
    .map((fixed) => {
      const twin = byId.get(fixed.pairOf as string);
      const pair = { vulnerable: fixed.pairOf as string, fixed: fixed.id };
      if (!twin || [twin, fixed].some((entry) => entry.verdict === "skipped" || entry.verdict === "crashed")) {
        return { ...pair, status: "inconclusive" as const };
      }
      const missed = twin.verdict === "missed" || twin.verdict === "partial";
      const noisy = fixed.verdict === "noisy";
      return {
        ...pair,
        status: missed && noisy ? ("both" as const) : missed ? ("vulnerable-missed" as const) : noisy ? ("fixed-noisy" as const) : ("discriminating" as const),
      };
    });

  return {
    scenarios: results.length,
    expectedFindings: detectedFindings + missedFindings,
    detectedFindings,
    missedFindings,
    falsePositives,
    precision: claims ? detectedFindings / claims : null,
    recall: detectedFindings + missedFindings ? detectedFindings / (detectedFindings + missedFindings) : null,
    missedScenarios: vulnerable.filter((result) => result.verdict === "missed").map((result) => result.id),
    partialScenarios: vulnerable.filter((result) => result.verdict === "partial").map((result) => result.id),
    falsePasses: vulnerable.filter((result) => result.verdict === "missed").length,
    noisyScenarios: cleanIntent.filter((result) => result.verdict === "noisy").map((result) => result.id),
    pairs,
    skipped: results
      .filter((result) => result.verdict === "skipped")
      .map((result) => ({ id: result.id, stack: result.stack, reason: result.skippedReason ?? "not covered" })),
    knownMisses: results.filter((result) => result.kind === "known-miss" && result.verdict === "as-documented").map((result) => result.id),
    outdatedKnownMisses: results.filter((result) => result.verdict === "newly-detected").map((result) => result.id),
    knownFalsePositives: results
      .filter((result) => result.kind === "known-false-positive" && result.verdict === "as-documented")
      .map((result) => result.id),
    staleFalsePositives: results
      .filter((result) => result.kind === "known-false-positive" && result.verdict === "not-reproduced")
      .map((result) => result.id),
    crashes: results.filter((result) => result.verdict === "crashed").map((result) => ({ id: result.id, error: result.error ?? "unknown error" })),
    noise: cleanIntent.reduce((total, result) => total + result.noise.length, 0),
    durationMs: results.reduce((total, result) => total + result.durationMs, 0),
  };
}

export interface BenchOptions {
  /** Only run scenarios whose id, title, stack or kind contains this text. */
  filter?: string;
}

export async function runBench(root: string, options: BenchOptions = {}): Promise<BenchReport> {
  const all = discoverScenarios(root);
  const byId = new Map(all.map((scenario) => [scenario.id, scenario]));
  const filter = options.filter?.trim().toLowerCase();
  const selected = filter
    ? all.filter((scenario) =>
        [scenario.id, scenario.title, scenario.stack, scenario.kind].some((value) => value.toLowerCase().includes(filter)),
      )
    : all;
  if (!selected.length) throw new Error(`no benchmark scenario matches the filter "${options.filter}"`);

  const start = performance.now();
  const scenarios: ScenarioResult[] = [];
  for (const scenario of selected) {
    scenarios.push(await runScenario(scenario, scenario.pairOf ? byId.get(scenario.pairOf) : undefined));
  }

  const summary = summarize(scenarios);
  summary.durationMs = Math.round(performance.now() - start);

  return {
    schemaVersion: 1,
    root: path.resolve(root),
    generatedAt: new Date().toISOString(),
    engine: [{ check: "security", description: "built-in static security rules (analyzeSecurityStatic)" }],
    scenarios,
    summary,
    coverage: coverageLabel("security"),
    limits: BENCH_LIMITS,
  };
}

/** Verdicts that mean a recorded expectation was not met, for `bench --strict`. */
export function strictFailures(report: BenchReport): string[] {
  return report.scenarios
    .filter((scenario) =>
      ["crashed", "missed", "partial", "noisy", "unexpected-coverage", "newly-detected", "not-reproduced"].includes(scenario.verdict),
    )
    .map((scenario) => `${scenario.id}: ${scenario.verdict}`);
}
