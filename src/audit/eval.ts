import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "./run.js";
import { renderMarkdown } from "./report.js";
import { scoreFindings } from "./score.js";
import type { AuditFinding, AuditMode, AuditReport } from "./types.js";

/**
 * audit/eval.ts — a dedicated, local evaluation suite for the audit.
 *
 * The suite is deliberately small and adversarial: every scenario has positive
 * expectations, most have negative controls, and clean repositories must stay
 * clean. It measures recall on seeded defects, precision against negative
 * controls, report integrity, deduplication and run-to-run determinism. It is
 * not a claim of general accuracy: the fixtures are written by the same people
 * as the rules and are disclosed as such.
 */

export interface EvalExpectation {
  rule: string;
  file: string;
  symbol?: string;
}

export interface EvalScenarioConfig {
  name: string;
  description: string;
  mode: AuditMode;
  positive: EvalExpectation[];
  negative: EvalExpectation[];
  maxFindings?: number;
  score?: { min: number; max: number };
  disclose?: { language: string; semantic: "call-graph" | "structural" | "lexical" | "none" }[];
  notes?: string;
}

export interface EvalScenarioResult {
  name: string;
  description: string;
  mode: AuditMode;
  passed: boolean;
  positive: { total: number; matched: number; missing: EvalExpectation[] };
  negative: { total: number; triggered: EvalExpectation[] };
  findingCount: number;
  unexpected: number;
  score: { value: number; min?: number; max?: number; passed: boolean };
  disclosure: { expected: string; passed: boolean }[];
  checks: {
    reportStructure: boolean;
    evidenceComplete: boolean;
    deduplicated: boolean;
    scoreTraceable: boolean;
    deterministic: boolean;
    findingsWithinBudget: boolean;
  };
  determinism: string;
  runtimeMs: number;
  warnings: string[];
  notes?: string;
  findings: { rule: string; file: string; line: number; severity: string; confirmation: string }[];
}

export interface AuditEvalReport {
  schemaVersion: 1;
  suite: string;
  generatedAt: string;
  durationMs: number;
  pass: boolean;
  scenarios: EvalScenarioResult[];
  totals: {
    scenarios: number;
    passed: number;
    failed: number;
    truePositives: number;
    falseNegatives: number;
    falsePositives: number;
    precision: number;
    recall: number;
  };
  warnings: string[];
  limits: string[];
}

export interface AuditEvalOptions {
  suiteDir?: string;
  /** Run only scenarios whose names contain one of these strings. */
  filter?: string[];
}

export interface AuditEvalResult {
  report: AuditEvalReport;
  markdown: string;
}

export async function runAuditEval(repoRoot: string, options: AuditEvalOptions = {}): Promise<AuditEvalResult> {
  const started = Date.now();
  const suite = resolveSuite(repoRoot, options.suiteDir);
  const entries = fs
    .readdirSync(suite, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const warnings: string[] = [];
  const scenarios: EvalScenarioResult[] = [];

  for (const entry of entries) {
    if (options.filter && options.filter.length > 0 && !options.filter.some((needle) => entry.includes(needle))) continue;
    const dir = path.join(suite, entry);
    const configFile = path.join(dir, "scenario.json");
    if (!fs.existsSync(configFile)) {
      warnings.push("Skipped " + entry + ": no scenario.json.");
      continue;
    }
    const config = readConfig(configFile, entry);
    const repo = path.join(dir, "repo");
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
      warnings.push("Skipped " + entry + ": missing repo directory.");
      continue;
    }
    scenarios.push(await evaluateScenario(config, repo));
  }

  const truePositives = scenarios.reduce((sum, scenario) => sum + scenario.positive.matched, 0);
  const falseNegatives = scenarios.reduce((sum, scenario) => sum + scenario.positive.missing.length, 0);
  const falsePositives = scenarios.reduce((sum, scenario) => sum + scenario.negative.triggered.length, 0);
  const totals = {
    scenarios: scenarios.length,
    passed: scenarios.filter((scenario) => scenario.passed).length,
    failed: scenarios.filter((scenario) => !scenario.passed).length,
    truePositives,
    falseNegatives,
    falsePositives,
    precision: truePositives + falsePositives === 0 ? 1 : round(truePositives / (truePositives + falsePositives)),
    recall: truePositives + falseNegatives === 0 ? 1 : round(truePositives / (truePositives + falseNegatives)),
  };
  const report: AuditEvalReport = {
    schemaVersion: 1,
    suite: path.relative(repoRoot, suite) || ".",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    pass: scenarios.length > 0 && totals.failed === 0,
    scenarios,
    totals,
    warnings,
    limits: [
      "Fixtures are authored alongside the rules; a pass measures intended behaviour, not independent accuracy.",
      "Precision counts only matched negative controls. Other unexpected findings are shown but not called false positives.",
      "Runtime and scores describe these small repositories and must not be extrapolated to large codebases.",
      "Scoring determinism is checked twice in this process; it does not prove stability across machines or Node versions.",
    ],
  };
  return { report, markdown: renderEvalMarkdown(report) };
}

async function evaluateScenario(config: EvalScenarioConfig, repo: string): Promise<EvalScenarioResult> {
  const started = Date.now();
  const options = { mode: config.mode, scope: [], useCache: false, persist: false };
  let first;
  let second;
  let fatal: string | undefined;
  try {
    first = await runAudit(repo, options);
    second = await runAudit(repo, options);
  } catch (error) {
    fatal = (error as Error).message;
  }

  if (!first || !second) {
    return {
      name: config.name,
      description: config.description,
      mode: config.mode,
      passed: false,
      positive: { total: config.positive.length, matched: 0, missing: config.positive },
      negative: { total: config.negative.length, triggered: [] },
      findingCount: 0,
      unexpected: 0,
      score: { value: 0, passed: false },
      disclosure: [],
      checks: {
        reportStructure: false,
        evidenceComplete: false,
        deduplicated: false,
        scoreTraceable: false,
        deterministic: false,
        findingsWithinBudget: false,
      },
      determinism: "not run: " + (fatal ?? "audit failed"),
      runtimeMs: Date.now() - started,
      warnings: [fatal ?? "audit failed"],
      ...(config.notes ? { notes: config.notes } : {}),
      findings: [],
    };
  }

  const report = first.report;
  const active = report.findings.filter((finding) => finding.lifecycle !== "suppressed" && finding.lifecycle !== "resolved");
  const matchedPositive = new Set<number>();
  const missing: EvalExpectation[] = [];
  for (const expected of config.positive) {
    const index = active.findIndex((finding) => matches(finding, expected));
    if (index === -1) missing.push(expected);
    else matchedPositive.add(index);
  }
  const triggered: EvalExpectation[] = [];
  for (const expected of config.negative) {
    if (active.some((finding) => matches(finding, expected))) triggered.push(expected);
  }
  const expectedKeys = new Set([...config.positive, ...config.negative].map(keyOf));
  const unexpected = active.filter((finding) => !expectedKeys.has(keyOf(finding))).length;

  const structure = checkStructure(report);
  const deduplicated = checkDedup(active);
  const scoreTraceable = checkScoreTrace(report, config.mode);
  const deterministic = compareRuns(first.report, second.report);
  const withinBudget = config.maxFindings === undefined || active.length <= config.maxFindings;
  const scorePassed =
    (!config.score || report.score.overall >= config.score.min) &&
    (!config.score || report.score.overall <= config.score.max);
  const disclosure = (config.disclose ?? []).map((expected) => {
    const language = report.coverage.languages.find(
      (entry) => entry.displayName.toLowerCase() === expected.language.toLowerCase() || entry.language.toLowerCase() === expected.language.toLowerCase(),
    );
    return {
      expected: expected.language + ":" + expected.semantic,
      passed: Boolean(language && language.semantic === expected.semantic),
    };
  });

  const passed =
    missing.length === 0 &&
    triggered.length === 0 &&
    structure.ok &&
    deduplicated &&
    scoreTraceable &&
    deterministic &&
    withinBudget &&
    scorePassed &&
    disclosure.every((entry) => entry.passed);

  return {
    name: config.name,
    description: config.description,
    mode: config.mode,
    passed,
    positive: {
      total: config.positive.length,
      matched: matchedPositive.size,
      missing,
    },
    negative: { total: config.negative.length, triggered },
    findingCount: active.length,
    unexpected,
    score: {
      value: report.score.overall,
      ...(config.score ? { min: config.score.min, max: config.score.max } : {}),
      passed: scorePassed,
    },
    disclosure,
    checks: {
      reportStructure: structure.ok,
      evidenceComplete: structure.evidenceOk,
      deduplicated,
      scoreTraceable,
      deterministic,
      findingsWithinBudget: withinBudget,
    },
    determinism: deterministic ? "identical findings, score and risks across two runs" : "run-to-run output changed",
    runtimeMs: Date.now() - started,
    warnings: [...first.warnings, ...structure.problems],
    ...(config.notes ? { notes: config.notes } : {}),
    findings: active.map((finding) => ({
      rule: finding.rule,
      file: finding.location.file,
      line: finding.location.line,
      severity: finding.severity,
      confirmation: finding.confirmation,
    })),
  };
}

function checkStructure(report: AuditReport): { ok: boolean; evidenceOk: boolean; problems: string[] } {
  const problems: string[] = [];
  const markdown = renderMarkdown(report);
  const sections = (markdown.match(/^## \d+\. /gm) ?? []).length;
  if (sections !== 15) problems.push("Expected 15 report sections, found " + sections + ".");
  if (!report.score.summary || report.score.deductions.length !== report.findings.filter((f) => f.lifecycle !== "resolved" && f.lifecycle !== "suppressed").length) {
    problems.push("Score deductions do not cover every active finding.");
  }
  if (!report.evidence || !report.evidence.digest || !report.evidence.of) problems.push("Report has no evidence seal.");
  if (report.findings.some((finding) => finding.evidence.length === 0)) problems.push("A finding has no evidence.");
  if (report.findings.some((finding) => finding.confirmation === "confirmed" && finding.evidence.length < 1)) {
    problems.push("A confirmed finding has no evidence.");
  }
  if (report.findings.some((finding) => !finding.suggestion.summary || !finding.suggestion.change || !finding.suggestion.tradeoffs)) {
    problems.push("A finding has an incomplete suggestion.");
  }
  if (report.findings.some((finding) => finding.location.line < 1)) problems.push("A finding has an invalid line.");
  if (report.findings.some((finding) => finding.deduction < 0)) problems.push("A finding has a negative deduction.");

  const evidenceOk = !problems.some((problem) => problem.toLowerCase().includes("evidence"));
  return { ok: problems.length === 0, evidenceOk, problems };
}

function checkDedup(findings: AuditFinding[]): boolean {
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = finding.rule + "|" + finding.location.file + "|" + finding.location.line + "|" + (finding.symbol ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function checkScoreTrace(report: AuditReport, mode: AuditMode): boolean {
  const recomputed = scoreFindings({
    findings: report.findings,
    measured: report.coverage.categoriesMeasured,
    mode,
    categoryNotes: Object.fromEntries(report.score.categories.map((category) => [category.category, category.note ?? ""])),
  });
  if (recomputed.overall !== report.score.overall) return false;
  const deductionIds = new Set(report.score.deductions.map((entry) => entry.findingId));
  for (const finding of report.findings.filter((entry) => entry.lifecycle !== "resolved" && entry.lifecycle !== "suppressed")) {
    if (!deductionIds.has(finding.id)) return false;
    const record = report.score.deductions.find((entry) => entry.findingId === finding.id);
    if (!record || record.points !== finding.deduction) return false;
  }
  return true;
}

function compareRuns(a: AuditReport, b: AuditReport): boolean {
  const keys = (report: AuditReport): string[] =>
    report.findings
      .map((finding) => [finding.id, finding.rule, finding.location.file, finding.location.line, finding.severity].join(":"))
      .sort();
  return (
    a.score.overall === b.score.overall &&
    JSON.stringify(keys(a)) === JSON.stringify(keys(b)) &&
    JSON.stringify(a.risks.map((risk) => risk.id).sort()) === JSON.stringify(b.risks.map((risk) => risk.id).sort())
  );
}

function matches(finding: AuditFinding, expected: EvalExpectation): boolean {
  return (
    finding.rule === expected.rule &&
    normalize(finding.location.file) === normalize(expected.file) &&
    (expected.symbol === undefined || finding.symbol === expected.symbol)
  );
}

function keyOf(expectation: EvalExpectation | AuditFinding): string {
  if ("location" in expectation) {
    return expectation.rule + "|" + normalize(expectation.location.file) + "|" + (expectation.symbol ?? "");
  }
  return expectation.rule + "|" + normalize(expectation.file) + "|" + (expectation.symbol ?? "");
}

function normalize(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

function resolveSuite(repoRoot: string, explicit?: string): string {
  const candidates = explicit
    ? [path.resolve(repoRoot, explicit)]
    : [
        path.resolve(repoRoot, "bench", "audit"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "audit"),
      ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error("Audit evaluation suite not found. Looked for: " + candidates.join(", "));
}

function readConfig(file: string, fallback: string): EvalScenarioConfig {
  const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as Partial<EvalScenarioConfig>;
  if (!parsed.description || typeof parsed.description !== "string") throw new Error(file + ": description is required.");
  if (!Array.isArray(parsed.positive) || !Array.isArray(parsed.negative)) {
    throw new Error(file + ": positive and negative arrays are required.");
  }
  const mode = parsed.mode ?? "deep";
  if (mode !== "quick" && mode !== "deep" && mode !== "full") throw new Error(file + ": invalid mode " + mode);
  for (const entry of [...parsed.positive, ...parsed.negative]) {
    if (!entry || typeof entry.rule !== "string" || typeof entry.file !== "string") {
      throw new Error(file + ": every expectation needs rule and file strings.");
    }
    if (entry.file.includes("..") || path.isAbsolute(entry.file)) throw new Error(file + ": fixture paths must stay inside the repo.");
  }
  return {
    name: parsed.name ?? fallback,
    description: parsed.description,
    mode,
    positive: parsed.positive,
    negative: parsed.negative,
    ...(parsed.maxFindings !== undefined ? { maxFindings: parsed.maxFindings } : {}),
    ...(parsed.score ? { score: parsed.score } : {}),
    ...(parsed.disclose ? { disclose: parsed.disclose } : {}),
    ...(parsed.notes ? { notes: parsed.notes } : {}),
  };
}

export function renderEvalMarkdown(report: AuditEvalReport): string {
  const lines: string[] = [];
  lines.push("# Audit Evaluation Suite");
  lines.push("");
  lines.push("**Suite:** " + report.suite + " · **Scenarios:** " + report.totals.scenarios + " · **Result:** " + (report.pass ? "PASS" : "FAIL"));
  lines.push("");
  lines.push("**Precision:** " + report.totals.precision + " · **Recall:** " + report.totals.recall);
  lines.push("");
  lines.push("| Scenario | Result | Recall | False positives | Score | Deterministic | Runtime |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const scenario of report.scenarios) {
    lines.push(
      "| " +
        scenario.name +
        " | " +
        (scenario.passed ? "pass" : "FAIL") +
        " | " +
        scenario.positive.matched +
        "/" +
        scenario.positive.total +
        " | " +
        scenario.negative.triggered.length +
        " | " +
        scenario.score.value +
        " | " +
        (scenario.checks.deterministic ? "yes" : "no") +
        " | " +
        scenario.runtimeMs +
        "ms |",
    );
  }
  lines.push("");
  if (report.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of report.warnings) lines.push("- " + warning);
    lines.push("");
  }
  lines.push("## Limits");
  lines.push("");
  for (const limit of report.limits) lines.push("- " + limit);
  lines.push("");
  return lines.join("\n");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
