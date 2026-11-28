import fs from "node:fs";
import path from "node:path";
import { checkEvidence, seal } from "../evidence.js";
import { buildUnderstanding, type RepoUnderstanding } from "../understand/index.js";
import { analyzeSecurityStatic } from "../analyzers/securityStatic.js";
import { runAllAnalyzers } from "../analyzers/index.js";
import { shortHash } from "./text.js";
import { contentDigestOf, contentDigestValid } from "./integrity.js";
import { buildRepoIndex, normalizeScope, type IndexCache } from "./indexer.js";
import { analyzeRules, finalizeFindings, type SecurityInput } from "./rules.js";
import { scoreFindings } from "./score.js";
import { collectChurn, predictRisks } from "./risks.js";
import { renderMarkdown } from "./report.js";
import {
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
  type AuditCategory,
  type AuditFinding,
  type AuditMode,
  type AuditOptions,
  type AuditRecommendation,
  type AuditReport,
  type AuditRunResult,
  type AuditStrength,
  type CoverageReport,
  type FindingSeverity,
  type LanguageCoverage,
  type RiskPrediction,
} from "./types.js";
import type { JsFileIndex, PythonFileIndex, RepoIndex } from "./indexTypes.js";

/**
 * audit/run.ts — orchestration for one audit run.
 *
 * The flow is deliberately one-directional:
 *   understand -> index -> rules -> score -> risks -> report -> seal -> persist.
 * Every stage may degrade (missing git, failed analyzers, parser errors); the
 * report says what degraded rather than filling the gap with a guess.
 */

const MODE_LIMITS: Record<AuditMode, number> = { quick: 500, deep: 2500, full: 2500 };
const CACHE_VERSION = "audit-cache-v4";
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

interface DiskCache {
  version: string;
  entries: Record<string, JsFileIndex | PythonFileIndex>;
}

interface FullScan {
  security: { status: string; note?: string; issues: { type: string; severity: string; file?: string; line?: number; description: string; fix?: string; category?: string }[] };
  tests: { status: string; note?: string; framework?: string; total: number; passed: number; failed: number; coverage?: number };
  reliability: { status: string; note?: string; raceSmells: { severity: string; file?: string; line?: number; description: string; fix?: string; category?: string }[] };
  perf: { status: string; note?: string };
}

export async function runAudit(repoInput: string, options: AuditOptions): Promise<AuditRunResult> {
  const started = Date.now();
  const repo = path.resolve(repoInput);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    throw new Error("Audit target is not a directory: " + repoInput);
  }
  const warnings: string[] = [];
  const scope = resolveScope(repo, options.scope ?? []);
  const mode = options.mode;

  const understanding = safeUnderstanding(repo, warnings);
  const cache = options.useCache === false ? undefined : openCache(repo, warnings);
  const requestedMaxFiles = options.maxFiles ?? MODE_LIMITS[mode];
  const maxFiles = Math.max(1, Math.min(requestedMaxFiles, 20000));
  if (requestedMaxFiles > 20000) {
    warnings.push("Requested file budget " + requestedMaxFiles + " was clamped to 20000.");
  }
  const index = buildRepoIndex({
    repo,
    scope,
    maxFiles,
    ...(cache ? { cache: cache.cache } : {}),
    warnings,
  });
  if (cache?.dirty && options.persist !== false) saveCache(repo, cache, warnings);

  const boundaries = understanding?.architecture.boundaries ?? [];
  const full = mode === "full" ? await safeFullAnalyze(repo, warnings) : undefined;
  let selected = selectCategories(mode, options.categories, warnings);
  const securityRequested = selected.includes("security");
  const securityResult = securityRequested
    ? collectSecurity(repo, mode, full, warnings, new Set(index.files.map((file) => file.file)))
    : { issues: [] as SecurityInput[], failed: false, fallback: false };
  if (securityRequested && securityResult.failed) {
    selected = selected.filter((category) => category !== "security");
    warnings.push("Security analysis failed; security is excluded from the score rather than scored as clean.");
    if (selected.length === 0) {
      throw new Error("Security analysis failed and no other category was selected; the audit cannot produce an honest score.");
    }
  }

  const rawFindings = analyzeRules({
    repo,
    index,
    mode,
    boundaries,
    categories: selected,
    ...(securityResult.issues.length > 0 ? { security: securityResult.issues } : {}),
    warnings,
  });

  const findings = rawFindings.filter((finding) => selected.includes(finding.category));
  applySuppressions(repo, findings, warnings);
  const cappedFindings = finalizeFindings(findings, warnings);
  const parseFailureCount = parseFailures(index);
  const unreadableCount = index.warnings.filter((warning) =>
    /^(Could not read|Skipped large file|Skipped binary-looking)/.test(warning),
  ).length;
  const duplicationTruncated = warnings.some((warning) => warning.startsWith("Duplication scan compared the first"));
  const completeView =
    scope.length === 0 &&
    index.skipped === 0 &&
    unreadableCount === 0 &&
    parseFailureCount === 0 &&
    (mode !== "full" || full !== undefined) &&
    understanding !== undefined &&
    !securityResult.failed &&
    !securityResult.fallback &&
    !duplicationTruncated &&
    !warnings.some((warning) => warning.startsWith("Finding budget reached")) &&
    !warnings.some((warning) => warning.startsWith("Rule cap reached"));
  const resolvedAll = completeView
    ? applyBaseline(repo, cappedFindings, warnings, new Set(index.files.map((file) => file.file)), selected)
    : [];
  if (!completeView) {
    warnings.push(
      "Lifecycle resolution was skipped because this run was bounded or an analyzer was unavailable; absence is not evidence of a fix.",
    );
  }
  const resolved = resolvedAll.filter((finding) => selected.includes(finding.category));

  const churn = mode === "quick"
    ? { churn: null as Map<string, number> | null, note: "Quick mode does not read git history." }
    : collectChurn(repo);
  if (churn.note) warnings.push(churn.note);

  const activeFindings = cappedFindings.filter((finding) => finding.lifecycle !== "suppressed");
  const unsupportedShare =
    index.files.length === 0
      ? 0
      : index.files.filter((file) => file.language !== "js" && file.language !== "python").length /
        index.files.length;
  const score = scoreFindings({
    findings: cappedFindings,
    measured: selected,
    mode,
    categoryNotes: categoryNotes(mode, full),
    parseFailures: parseFailureCount,
    unsupportedShare,
  });
  const coverage = buildCoverage(index, selected, mode, full, understanding, churn.churn !== null, warnings, scope, maxFiles);
  const risks = predictRisks({
    repo,
    index,
    findings: activeFindings,
    score,
    coverage,
    ...(understanding ? { verification: understanding.verificationCommands } : {}),
    churn: churn.churn ?? null,
  });
  if (full && full.tests.failed > 0 && selected.includes("testing")) {
    risks.unshift(verificationRisk(repo, full));
    // predictRisks already caps at eight; keep the explicit failed-suite risk
    // at the front without letting the combined list exceed the documented cap.
    risks.length = Math.min(risks.length, 8);
  }

  const indexSummary = {
    files: index.files.length,
    functions: index.stats.functions,
    imports: index.imports.length,
    callSites: index.stats.calls,
    resolvedCallSites: index.stats.resolvedCalls,
    routes: index.routes.length,
    entryPoints: unique([
      ...(understanding?.entryPoints ?? [])
        .map((file) => file.replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((file) => inScope(file, scope)),
      ...index.routes.slice(0, 10).map((route) => route.file),
    ]).slice(0, 15),
    executionPaths: index.executionPaths.slice(0, 20).map((execution) => ({
      route: execution.method + " " + execution.route,
      depth: execution.depth,
      path: execution.steps.map((step) => step.name),
    })),
    cycles: index.cycles,
    boundaries: boundaries.length,
  };

  // Suppressed findings still exist. A negative "none found" strength must see
  // them, even though they no longer deduct points or appear in recommendations.
  const strengths = buildStrengths(index, cappedFindings, selected, full, completeView);
  const recommendations = buildRecommendations(activeFindings, selected);
  const limits = buildLimits(index, mode, warnings, full);

  const report: AuditReport = {
    schemaVersion: 1,
    repo,
    mode,
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    score,
    coverage,
    findings: cappedFindings,
    resolved,
    risks,
    strengths,
    recommendations,
    index: indexSummary,
    limits,
  };
  report.durationMs = Date.now() - started;
  // The shared seal excludes keys named "evidence" at every depth; this digest
  // covers the nested finding/risk evidence too, and the top-level seal protects
  // the digest itself.
  report.contentDigest = contentDigestOf(report);
  const sealed = seal(report, "pitstop audit report for " + repo);
  // Keep every field seal() added (not only evidence), so a candidate binding,
  // when present, is part of the document that is written and checked later.
  Object.assign(report, sealed);

  const artifacts: { json?: string; markdown?: string } = {};
  if (options.persist !== false) {
    const persisted = persistArtifacts(repo, report, warnings);
    artifacts.json = persisted.json;
    artifacts.markdown = persisted.markdown;
  }
  return { report, artifacts, warnings: unique(warnings) };
}

function resolveScope(repo: string, entries: string[]): string[] {
  const realRepo = fs.realpathSync(repo);
  return normalizeScope(entries).map((entry) => {
    if (path.isAbsolute(entry)) {
      throw new Error("Scope must be a repository-relative path inside the repository: " + entry);
    }
    const absolute = path.resolve(repo, entry);
    const lexical = path.relative(repo, absolute).replace(/\\/g, "/");
    if (lexical === ".." || lexical.startsWith("../")) {
      throw new Error("Scope must be a repository-relative path inside the repository: " + entry);
    }
    if (!fs.existsSync(absolute)) {
      throw new Error("Scope path does not exist inside the repository: " + entry);
    }
    // "." and the repository root mean "no scope filter"; the indexer and
    // coverage table both treat an empty scope as the whole repository.
    if (lexical === "") return "";
    const relative = path.relative(realRepo, fs.realpathSync(absolute)).replace(/\\/g, "/");
    if (relative === ".." || relative.startsWith("../")) {
      throw new Error("Scope must be a repository-relative path inside the repository: " + entry);
    }
    return relative === "" ? "" : relative;
  }).filter((entry) => entry.length > 0);
}

function safeUnderstanding(repo: string, warnings: string[]): RepoUnderstanding | undefined {
  try {
    return buildUnderstanding(repo);
  } catch (error) {
    warnings.push("Repository understanding failed: " + (error as Error).message);
    return undefined;
  }
}

async function safeFullAnalyze(repo: string, warnings: string[]): Promise<FullScan | undefined> {
  try {
    const result = await runAllAnalyzers(repo, { reliabilityRuns: 1 });
    return {
      security: result.security,
      tests: result.tests,
      reliability: result.reliability,
      perf: result.perf,
    };
  } catch (error) {
    warnings.push("Full-mode analyzers could not complete: " + (error as Error).message);
    return undefined;
  }
}

function collectSecurity(
  repo: string,
  mode: AuditMode,
  full: FullScan | undefined,
  warnings: string[],
  indexedFiles: Set<string>,
): { issues: SecurityInput[]; failed: boolean; fallback: boolean } {
  if (mode === "quick") return { issues: [], failed: false, fallback: false };
  const source = full?.security.issues ?? [];
  let fallback = full !== undefined && full.security.status !== "ok";
  if (mode === "full" && full === undefined) {
    fallback = true;
    warnings.push("Security analyzer unavailable in full mode; static pattern rules were used instead.");
  }
  let failed = false;
  const issues = full?.security.status === "ok"
    ? source
    : (() => {
        try {
          return analyzeSecurityStatic(repo);
        } catch (error) {
          failed = true;
          warnings.push("Static security analysis failed: " + (error as Error).message);
          return [];
        }
      })();
  if (full !== undefined && full.security.status !== "ok") {
    warnings.push(
      "Security analyzer fallback (" +
        full.security.status +
        ")" +
        (full.security.note ? ": " + full.security.note : " using static pattern rules."),
    );
  }
  const filtered = issues
    .filter((issue) => typeof issue.file === "string" && issue.file.length > 0)
    .map((issue) => ({
      file: normalizeIssueFile(repo, issue.file as string),
      line:
        typeof issue.line === "number" && Number.isFinite(issue.line) && issue.line >= 1
          ? Math.floor(issue.line)
          : 1,
      severity: clampSeverity(issue.severity),
      description: issue.description,
      ...(issue.fix ? { fix: issue.fix } : {}),
      ...(issue.category ? { category: issue.category } : {}),
    }))
    // The security analyzer reads the whole repository. A scoped or budgeted
    // audit must not surface evidence for a file it did not index.
    .filter((issue) => indexedFiles.has(issue.file));
  return { issues: filtered, failed, fallback };
}

function normalizeIssueFile(repo: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.resolve(repo, file);
  const relative = path.relative(repo, absolute).replace(/\\/g, "/");
  return relative.startsWith("..") ? file.replace(/\\/g, "/") : relative;
}

function clampSeverity(value: string): FindingSeverity {
  if (value === "critical" || value === "high" || value === "medium") return value;
  return "low";
}

function selectCategories(mode: AuditMode, requested: AuditCategory[] | undefined, warnings: string[]): AuditCategory[] {
  const all = Object.keys(CATEGORY_WEIGHTS) as AuditCategory[];
  let selected = requested && requested.length > 0 ? all.filter((category) => requested.includes(category)) : all;
  if (mode === "quick" && selected.includes("security")) {
    selected = selected.filter((category) => category !== "security");
    warnings.push("Security is not measured in quick mode; rerun with --mode deep or --mode full.");
    if (selected.length === 0) {
      throw new Error("Quick mode cannot measure security; choose --mode deep or --mode full, or select another category.");
    }
  }
  if (selected.length === 0) {
    throw new Error("No requested audit categories are available.");
  }
  return selected;
}

function categoryNotes(mode: AuditMode, full: FullScan | undefined): Partial<Record<AuditCategory, string>> {
  const notes: Partial<Record<AuditCategory, string>> = {
    testing: "Structural test inventory; line coverage is not inferred without a coverage run.",
    security:
      mode === "quick"
        ? "Not measured in quick mode."
        : mode === "deep"
          ? "Deterministic pattern rules only; no taint analysis."
          : full?.security.status === "ok"
            ? "Static rules plus the repository's existing security analyzer; not a penetration test."
            : "Static pattern rules only; the existing security analyzer was unavailable, so this is not a full-mode security pass.",
  };
  if (full?.tests.coverage !== undefined) {
    notes.testing = "Existing coverage report: " + full.tests.coverage + "% line coverage.";
  }
  if (full?.perf.status === "ok") notes.performance = "Full mode also ran the existing build/perf analyzer.";
  return notes;
}

function parseFailures(index: RepoIndex): number {
  const expected = index.files.filter((file) => file.language === "js" || file.language === "python");
  return Math.max(0, expected.length - index.stats.parsed);
}

function buildCoverage(
  index: RepoIndex,
  selected: AuditCategory[],
  mode: AuditMode,
  full: FullScan | undefined,
  understanding: RepoUnderstanding | undefined,
  churnUsed: boolean,
  warnings: string[],
  scope: string[],
  budget: number,
): CoverageReport {
  const all = Object.keys(CATEGORY_WEIGHTS) as AuditCategory[];
  const groups = new Map<string, { language: string; files: number; indexed: number; js: boolean; python: boolean }>();
  for (const file of index.files) {
    const key = file.language;
    const group = groups.get(key) ?? {
      language: key,
      files: 0,
      indexed: 0,
      js: key === "js",
      python: key === "python",
    };
    group.indexed += 1;
    group.files += 1;
    groups.set(key, group);
  }
  if (groups.size === 0) {
    groups.set("unknown", { language: "unknown", files: 0, indexed: 0, js: false, python: false });
  }
  const languages: LanguageCoverage[] = [...groups.values()].map((group) => {
    const semantic: LanguageCoverage["semantic"] = group.js
      ? index.stats.semantic > 0
        ? "call-graph"
        : "structural"
      : group.python
        ? "lexical"
        : "none";
    return {
      language: group.language,
      displayName: displayLanguage(group.language),
      files: group.files,
      indexed: group.indexed,
      semantic,
      note:
        semantic === "call-graph"
          ? "Babel AST: functions, calls, routes and tests are indexed."
          : semantic === "structural"
            ? "Files were parsed but no call graph could be resolved."
            : semantic === "lexical"
              ? "Indentation-aware scan; not a Python AST or call graph."
              : "Detected by extension only; no language-specific rules were applied.",
    };
  }).sort((a, b) => b.files - a.files);

  const tools = [
    { name: "Babel parser (JS/TS)", available: true, used: index.files.some((file) => file.js), note: "Bundled; offline." },
    { name: "Python scanner", available: true, used: index.files.some((file) => file.python), note: "Lexical/indentation scan, not an AST." },
    { name: "git history", available: churnUsed, used: churnUsed, note: "Local history only; skipped in quick mode or when git is unavailable." },
    { name: "static security rules", available: true, used: selected.includes("security"), note: "Pattern rules; no taint/dataflow." },
    { name: "existing analyzers (full mode)", available: true, used: full !== undefined, note: full?.tests.note ?? "Dependency, security, duplication, tests, perf and reliability analyzers." },
  ];
  const limitations = [
    "Static analysis reads source, not runtime behaviour; a clean result is not proof of correctness.",
    "Only JavaScript/TypeScript receive a full parser and call graph. Python is scanned lexically; other languages are counted but not semantically audited.",
    "Calls through method receivers, aliases and dynamic imports stay unresolved, so N+1 and execution-path findings can be undercounted.",
    "Security results are pattern leads, not exploitability proofs. No taint or dataflow analysis runs.",
    "The Engineering Quality Score measures the rules and categories that were actually evaluated. It is not an industry benchmark.",
    "Duplication uses token similarity (90% threshold); semantic duplication with different identifiers is missed.",
    "Git churn is local history only; when git is unavailable, churn-based risks are skipped rather than guessed.",
  ];
  if (index.skipped > 0) {
    limitations.push(index.skipped + " file(s) were skipped by the mode budget; findings for them are absent.");
  }
  if (scope.length > 0) {
    limitations.push(
      "Scope filters indexed findings and evidence; repository-understanding and full-mode metrics may still describe the whole repository.",
    );
  }
  if (parseFailures(index) > 0) {
    limitations.push(parseFailures(index) + " supported-language file(s) could not be parsed; they contribute no findings.");
  }
  if (understanding === undefined) {
    limitations.push("Repository understanding was unavailable, so architecture boundaries and verification commands are missing.");
  }
  if (
    warnings.some(
      (warning) =>
        warning.startsWith("Could not write the audit cache") ||
        warning.startsWith("Audit cache exceeded"),
    )
  ) {
    limitations.push("The index cache could not be written; the next run will re-parse files.");
  }
  const unreadable = index.warnings.filter((warning) =>
    /^(Could not read|Skipped large file|Skipped binary-looking)/.test(warning),
  ).length;
  if (unreadable > 0) {
    limitations.push(unreadable + " discovered file(s) could not be read, were too large, or looked binary; they are counted but not indexed.");
  }
  const incompleteReasons: string[] = [];
  if (mode === "full" && full === undefined) incompleteReasons.push("full-mode analyzers unavailable");
  if (understanding === undefined) incompleteReasons.push("repository understanding unavailable");
  if (scope.length > 0) incompleteReasons.push("scoped run");
  if (index.skipped > 0) incompleteReasons.push(index.skipped + " file(s) skipped by budget");
  if (unreadable > 0) incompleteReasons.push(unreadable + " file(s) unreadable, too large or binary");
  if (parseFailures(index) > 0) incompleteReasons.push(parseFailures(index) + " supported file(s) failed to parse");
  if (warnings.some((warning) => warning.startsWith("Duplication scan compared the first"))) {
    incompleteReasons.push("duplication scan truncated");
  }
  if (warnings.some((warning) => warning.startsWith("Finding budget reached"))) {
    incompleteReasons.push("finding budget reached");
  }
  const cappedRules = unique(
    warnings
      .filter((warning) => warning.startsWith("Rule cap reached for "))
      .map((warning) => warning.split(":")[0].replace("Rule cap reached for ", "")),
  );
  if (cappedRules.length > 0) {
    incompleteReasons.push("per-rule finding caps reached: " + cappedRules.join(", "));
  }
  if (warnings.some((warning) => /security (analysis|analyzer).*(failed|error|unavailable|fallback)/i.test(warning))) {
    incompleteReasons.push("security analyzer failed or fell back");
  }
  return {
    scope,
    budget,
    wholeRepository: incompleteReasons.length === 0,
    ...(incompleteReasons.length > 0 ? { wholeRepositoryReason: incompleteReasons.join("; ") } : {}),
    sourceFiles: index.discovered,
    indexed: index.files.length,
    parsed: index.stats.parsed,
    semantic: index.stats.semantic,
    skipped: index.skipped,
    testsDetected: index.tests.length,
    testFiles: index.testsByFile.size,
    categoriesMeasured: selected,
    categoriesNotMeasured: all.filter((category) => !selected.includes(category)),
    languages,
    tools,
    limitations: unique(limitations),
  };
}

function inScope(file: string, scope: string[]): boolean {
  if (scope.length === 0) return true;
  const fold = (value: string): string =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const normalized = fold(file.replace(/\\/g, "/").replace(/^\.\//, ""));
  return scope.some((entry) => {
    const target = fold(entry);
    return normalized === target || normalized.startsWith(target + "/");
  });
}

function displayLanguage(language: string): string {
  switch (language) {
    case "js":
      return "JavaScript / TypeScript";
    case "python":
      return "Python";
    case "go":
      return "Go";
    case "rust":
      return "Rust";
    case "java":
      return "Java";
    case "ruby":
      return "Ruby";
    case "php":
      return "PHP";
    case "dotnet":
      return ".NET";
    case "c":
      return "C";
    case "cpp":
      return "C++";
    case "swift":
      return "Swift";
    case "kotlin":
      return "Kotlin";
    case "dart":
      return "Dart";
    case "unknown":
      return "Unclassified";
    default:
      return language;
  }
}

function buildStrengths(
  index: RepoIndex,
  findings: AuditFinding[],
  selected: AuditCategory[],
  full: FullScan | undefined,
  completeView: boolean,
): AuditStrength[] {
  const strengths: AuditStrength[] = [];
  // A negative "none found" claim is only meaningful when the run examined every
  // indexed file and no finding cap hid a match.
  if (completeView && selected.includes("architecture") && index.files.length >= 5 && index.cycles.length === 0) {
    strengths.push({
      title: "No import cycles in the resolved graph",
      evidence: index.imports.length + " relative imports across " + index.files.length + " files produced no back edges.",
    });
  }
  if (selected.includes("testing") && index.tests.length > 0) {
    const testRatio = index.testsByFile.size / Math.max(1, index.files.length - index.testsByFile.size);
    strengths.push({
      title: "A structural test suite is present",
      evidence:
        index.tests.length +
        " test declaration(s) across " +
        index.testsByFile.size +
        " file(s); test-file ratio " +
        Math.round(testRatio * 100) +
        "%.",
    });
  }
  if (completeView && selected.includes("security") && !findings.some((finding) => finding.category === "security")) {
    strengths.push({
      title: "No security pattern matched",
      evidence: "The measured security rules produced no finding across " + index.files.length + " indexed files (negative result only).",
    });
  }
  if (
    completeView &&
    selected.includes("maintainability") &&
    index.functions.length >= 10 &&
    !findings.some((finding) => finding.rule === "duplicate-function")
  ) {
    strengths.push({
      title: "No near-duplicate function bodies above the threshold",
      evidence: index.functions.length + " functions compared at 90% token similarity; none matched.",
    });
  }
  if (
    completeView &&
    selected.includes("type-safety") &&
    index.files.some((file) => file.js) &&
    !findings.some((finding) => finding.rule === "any-usage")
  ) {
    strengths.push({
      title: "No explicit TypeScript any in the indexed files",
      evidence: "The parser found zero any annotations or casts.",
    });
  }
  if (
    selected.includes("testing") &&
    full?.tests.status === "ok" &&
    full.tests.failed === 0 &&
    full.tests.total > 0
  ) {
    strengths.push({
      title: "The existing test suite passes",
      evidence: full.tests.total + " test(s) passed in " + (full.tests.framework ?? "the detected runner") + ".",
    });
  }
  if (
    selected.includes("correctness") &&
    full?.reliability.status === "ok" &&
    full.reliability.raceSmells.length === 0
  ) {
    strengths.push({
      title: "No timer or race smells in the reliability pass",
      evidence: "The reliability analyzer reported no heuristic race patterns.",
    });
  }
  return strengths.slice(0, 6);
}

function buildRecommendations(findings: AuditFinding[], selected: AuditCategory[]): AuditRecommendation[] {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.rule) ?? [];
    list.push(finding);
    groups.set(finding.rule, list);
  }
  const ranked = [...groups.entries()]
    .map(([rule, group]) => ({
      rule,
      group,
      weight: group.reduce((sum, finding) => sum + Math.max(0.1, finding.deduction), 0),
    }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 5);

  return ranked.map((entry, index) => {
    const first = entry.group[0];
    const locations = unique(entry.group.map((finding) => finding.location.file)).slice(0, 3);
    const confirmed = entry.group.filter((finding) => finding.confirmation === "confirmed").length;
    return {
      priority: index + 1,
      findingIds: entry.group.slice(0, 10).map((finding) => finding.id),
      title: CATEGORY_LABELS[first.category] + ": " + first.title,
      action: first.suggestion.summary,
      rationale:
        entry.group.length +
        " occurrence(s), " +
        confirmed +
        " confirmed; " +
        Math.round(entry.weight * 10) / 10 +
        " score point(s) at stake. Files: " +
        locations.join(", ") +
        (locations.length < entry.group.length ? " and others." : "."),
      effort: entry.group.some((finding) => finding.suggestion.effort === "large")
        ? "large"
        : entry.group.some((finding) => finding.suggestion.effort === "medium")
          ? "medium"
          : "small",
    };
  });
}

function buildLimits(index: RepoIndex, mode: AuditMode, warnings: string[], full: FullScan | undefined): string[] {
  const limits: string[] = [
    mode === "full"
      ? "This audit is local-first and calls no model or telemetry service. Full mode runs the repository's existing analyzers, which may execute its test suite or build."
      : "This audit is static and local-first: no repository code is executed, no telemetry is sent, and no model is required.",
    "Severity is an impact estimate for the pattern, not a CVSS score. Confirmation says whether the pattern is certain, not whether it matters to users.",
    "Score points are relative to this tool's weights and always map to a finding id; the number is not comparable across tools.",
    "Unsupported languages and unresolved calls are disclosed in coverage; they are not counted as defects.",
  ];
  if (mode === "quick") {
    limits.push("Quick mode uses the 500-file default budget unless --max-files overrides it, and skips security, git churn and full-mode analyzers.");
  }
  if (mode === "deep") limits.push("Deep mode does not run the repository's test suite, build or existing analyzers; use full mode for verification evidence.");
  if (mode === "full" && full === undefined) limits.push("Full mode was requested but the existing analyzer stack could not complete; the report is effectively deep mode.");
  if (index.skipped > 0) limits.push("The file budget skipped " + index.skipped + " file(s); rules never saw them.");
  if (warnings.length > 0) {
    limits.push("Run warnings: " + unique(warnings).slice(0, 4).join(" | "));
  }
  return limits;
}

function applySuppressions(repo: string, findings: AuditFinding[], warnings: string[]): void {
  const file = path.join(repo, ".pitstop", "audit-suppress.json");
  if (!fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    const entries = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { suppressions?: unknown[] }).suppressions)
        ? (raw as { suppressions: unknown[] }).suppressions
        : [];
    const now = Date.now();
    const active = new Map<string, { reason?: string; expires?: string }>();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const candidate = entry as { fingerprint?: string; id?: string; reason?: string; expires?: string };
      const key = candidate.fingerprint ?? candidate.id;
      if (typeof key !== "string" || key.length === 0) continue;
      if (candidate.expires) {
        // A date-only value covers that whole UTC day; an explicit timestamp is exact.
        const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(candidate.expires);
        const expiresAt = Date.parse(dateOnly ? candidate.expires + "T23:59:59.999Z" : candidate.expires);
        if (!Number.isFinite(expiresAt)) {
          warnings.push("Suppression has an invalid expiry and was ignored: " + key);
          continue;
        }
        if (expiresAt < now) {
          warnings.push("Suppression expired and was ignored: " + key);
          continue;
        }
      }
      active.set(key, {
        ...(candidate.reason ? { reason: candidate.reason } : {}),
        ...(candidate.expires ? { expires: candidate.expires } : {}),
      });
    }
    for (const finding of findings) {
      const metadata = active.get(finding.fingerprint) ?? active.get(finding.id);
      if (metadata) {
        finding.lifecycle = "suppressed";
        finding.suppression = metadata;
      }
    }
  } catch (error) {
    warnings.push("Could not read .pitstop/audit-suppress.json: " + (error as Error).message);
  }
}

function applyBaseline(
  repo: string,
  findings: AuditFinding[],
  warnings: string[],
  indexedFiles: Set<string>,
  selectedCategories: AuditCategory[],
): AuditFinding[] {
  const file = path.join(repo, ".pitstop", "audit-latest.json");
  if (!fs.existsSync(file)) return [];
  let previous: AuditReport;
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8")) as AuditReport;
  } catch (error) {
    warnings.push("Previous audit artifact is not valid JSON; lifecycle comparison skipped.");
    return [];
  }
  const check = checkEvidence(previous);
  if (check.status !== "verified") {
    warnings.push("Previous audit artifact failed its evidence check; lifecycle comparison skipped.");
    return [];
  }
  if (previous.schemaVersion !== 1 || !Array.isArray(previous.findings)) {
    warnings.push("Previous audit artifact has an unsupported schema; lifecycle comparison skipped.");
    return [];
  }
  if (previous.contentDigest !== undefined && !contentDigestValid(previous)) {
    warnings.push("Previous audit artifact failed its nested content digest; lifecycle comparison skipped.");
    return [];
  }
  if (typeof previous.repo !== "string" || path.resolve(previous.repo) !== path.resolve(repo)) {
    warnings.push("Previous audit artifact belongs to a different repository; lifecycle comparison skipped.");
    return [];
  }
  if (previous.coverage?.wholeRepository !== true) {
    warnings.push("Previous audit artifact was scoped, budget-limited or incomplete; lifecycle comparison skipped.");
    return [];
  }
  if (selectedCategories.length < Object.keys(CATEGORY_WEIGHTS).length) {
    warnings.push(
      "Lifecycle comparison covers only the categories measured in this run; unmeasured categories are not treated as resolved.",
    );
  }
  const previousCategories = Array.isArray(previous.coverage?.categoriesNotMeasured)
    ? previous.coverage.categoriesNotMeasured
    : undefined;
  if (previousCategories === undefined || previousCategories.length > 0) {
    warnings.push(
      "The previous audit did not measure every category; lifecycle comparison is limited to the categories it did measure.",
    );
  }
  const current = new Set(findings.map((finding) => finding.fingerprint));
  const activePrevious = previous.findings.filter(
    (finding) =>
      finding &&
      finding.lifecycle !== "suppressed" &&
      finding.lifecycle !== "resolved" &&
      typeof finding.fingerprint === "string" &&
      selectedCategories.includes(finding.category),
  );
  for (const finding of findings) {
    if (finding.lifecycle === "suppressed") continue;
    finding.lifecycle = activePrevious.some((entry) => entry.fingerprint === finding.fingerprint) ? "existing" : "new";
  }
  return activePrevious
    .filter((entry) => {
      if (current.has(entry.fingerprint)) return false;
      // A file outside this run's index (scope, budget or parse failure) and a
      // category this run did not measure were not re-examined, so their absence
      // is not evidence that the issue is fixed.
      if (!selectedCategories.includes(entry.category)) return false;
      const file = String(entry.location?.file ?? "").replace(/\\/g, "/");
      return indexedFiles.has(file);
    })
    .map((entry) => ({ ...entry, lifecycle: "resolved" as const, deduction: 0 }));
}

interface CacheState {
  cache: IndexCache;
  entries: Record<string, JsFileIndex | PythonFileIndex>;
  dirty: boolean;
}

function openCache(repo: string, warnings: string[]): CacheState | undefined {
  const file = path.join(repo, ".pitstop", "audit-cache.json");
  const entries: Record<string, JsFileIndex | PythonFileIndex> = Object.create(null) as Record<
    string,
    JsFileIndex | PythonFileIndex
  >;
  if (fs.existsSync(file)) {
    try {
      if (fs.statSync(file).size <= MAX_CACHE_BYTES * 2) {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as DiskCache;
        if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === "object") {
          for (const [key, value] of Object.entries(parsed.entries)) {
            if (isCacheEntry(value)) entries[key] = value;
          }
        }
      }
    } catch {
      warnings.push("Audit cache is unreadable; rebuilding the index from source.");
    }
  }
  const state: CacheState = {
    entries,
    dirty: false,
    cache: {
      get: (hash: string) => entries[hash],
      set: (hash: string, value: JsFileIndex | PythonFileIndex) => {
        entries[hash] = value;
        state.dirty = true;
      },
    },
  };
  return state;
}

function isCacheEntry(value: unknown): value is JsFileIndex | PythonFileIndex {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.file !== "string" || typeof record.lines !== "number") return false;
  const common = ["imports", "functions", "strings", "numbers", "calls", "tests", "usedNames"];
  if (!common.every((key) => Array.isArray(record[key]))) return false;
  if (typeof record.anyCount === "number") {
    return ["exports", "routes", "catches", "regexes", "anyLines", "nonNullLines", "typeIgnoreLines", "looseEquality"].every(
      (key) => Array.isArray(record[key]),
    );
  }
  return Array.isArray(record.broadExcept);
}

function saveCache(repo: string, state: CacheState, warnings: string[]): void {
  const file = path.join(repo, ".pitstop", "audit-cache.json");
  try {
    const payload = JSON.stringify({ version: CACHE_VERSION, entries: state.entries } satisfies DiskCache);
    if (payload.length > MAX_CACHE_BYTES) {
      warnings.push("Audit cache exceeded 8 MB and was not persisted; the next run will re-parse changed files.");
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, payload);
  } catch (error) {
    warnings.push("Could not write the audit cache: " + (error as Error).message);
  }
}

function persistArtifacts(
  repo: string,
  report: AuditReport,
  warnings: string[],
): { json: string; markdown: string } {
  const dir = path.join(repo, ".pitstop");
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonName = "audit-" + stamp + ".json";
  const markdownName = "audit-" + stamp + ".md";
  const json = JSON.stringify(report, null, 2) + "\n";
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, jsonName), json);
    fs.writeFileSync(path.join(dir, "audit-latest.json"), json);
    fs.writeFileSync(path.join(dir, markdownName), renderMarkdown(report));
    fs.writeFileSync(path.join(dir, "audit-latest.md"), renderMarkdown(report));
    return { json: ".pitstop/" + jsonName, markdown: ".pitstop/" + markdownName };
  } catch (error) {
    warnings.push("Could not persist audit artifacts: " + (error as Error).message);
    return { json: "", markdown: "" };
  }
}

function verificationRisk(repo: string, full: FullScan): RiskPrediction {
  return {
    id: "risk-" + shortHash("verification|" + repo + "|" + full.tests.failed),
    category: "testing",
    title: "The existing test suite is failing",
    explanation:
      full.tests.failed +
      " of " +
      full.tests.total +
      " detected test(s) failed in the full-mode run. A red baseline makes it impossible to attribute a future regression to a specific change.",
    locations: [],
    evidence: [{ source: "test-run", detail: full.tests.failed + " failed / " + full.tests.total + " total" }],
    assumption: "The failure is reproducible in the project's normal environment rather than an artifact of this runner.",
    confidence: "high",
    impact: "Regressions cannot be distinguished from pre-existing failures; merge confidence drops.",
    horizon: "short",
    relatedFindings: [],
  };
}

function humanize(rule: string): string {
  return rule.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
