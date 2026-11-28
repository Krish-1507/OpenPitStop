import path from "node:path";
import { safeExec } from "../analyzers/util.js";
import { isTestFile } from "../architecture/impact.js";
import { shortHash } from "./text.js";
import type { AuditFinding, CoverageReport, EngineeringScore, FindingConfidence, RiskHorizon, RiskPrediction } from "./types.js";
import type { RepoIndex } from "./indexTypes.js";

/**
 * audit/risks.ts — predictions, clearly separated from findings.
 *
 * A risk is a statement about the future: "this area is likely to produce a
 * defect or an incident". It always carries the evidence, the assumption that
 * must hold, a confidence, and an impact. It is never counted as a defect.
 */

export interface RiskInput {
  repo: string;
  index: RepoIndex;
  findings: AuditFinding[];
  score: EngineeringScore;
  coverage: CoverageReport;
  verification?: { test?: string; typecheck?: string; lint?: string; build?: string; e2e?: string };
  churn: Map<string, number> | null;
}

export function predictRisks(input: RiskInput): RiskPrediction[] {
  const risks: RiskPrediction[] = [];
  const findingsByFile = new Map<string, AuditFinding[]>();
  for (const finding of input.findings) {
    const list = findingsByFile.get(finding.location.file) ?? [];
    list.push(finding);
    findingsByFile.set(finding.location.file, list);
  }

  if (input.churn && input.churn.size > 0) {
    const hot = [...input.churn.entries()]
      .filter(([file]) => input.index.files.some((entry) => entry.file === file))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const hotWithFindings = hot
      .map(([file, commits]) => ({
        file,
        commits,
        findings: (findingsByFile.get(file) ?? []).filter((finding) => finding.severity === "high" || finding.severity === "medium"),
      }))
      .filter((entry) => entry.findings.length > 0);
    if (hotWithFindings.length > 0) {
      const first = hotWithFindings[0];
      risks.push(risk({
        category: "maintainability",
        title: "Change-heavy modules also carry the findings",
        explanation:
          first.file +
          " changed " +
          first.commits +
          " time(s) in the last 180 days and has " +
          first.findings.length +
          " medium/high finding(s). Areas that change often and already show structural problems are where the next regression is most likely.",
        locations: first.findings.slice(0, 5).map((finding) => finding.location),
        evidence: [
          { source: "git-history", detail: first.commits + " commits touching " + first.file + " in 180 days" },
          ...first.findings.slice(0, 3).map((finding) => ({ source: "audit-rule", detail: finding.rule + ": " + finding.title })),
        ],
        assumption: "Past change frequency correlates with future change; the repository history is local and complete for the period.",
        confidence: "medium",
        impact: "A defect introduced here reaches users through already-active code paths.",
        horizon: "short",
        relatedFindings: first.findings.map((finding) => finding.id),
      }));
    }
  }

  const complexHandlers = new Map<string, { route: string; file: string; name: string; line: number; complexity: number }>();
  const byKey = new Map(input.index.functions.map((fn) => [fn.file + "#" + fn.name + "@" + fn.line, fn]));
  for (const execution of input.index.executionPaths) {
    for (const step of execution.steps) {
      const fn = byKey.get(step.file + "#" + step.name + "@" + step.line);
      if (!fn || fn.cyclomatic < 10) continue;
      complexHandlers.set(step.file + "#" + fn.name, {
        route: execution.route,
        file: step.file,
        name: fn.name,
        line: fn.line,
        complexity: fn.cyclomatic,
      });
    }
  }
  const untestedHandlers = [...complexHandlers.values()].filter((entry) => !hasTestNearby(input.index, entry.file));
  if (untestedHandlers.length > 0) {
    const first = untestedHandlers[0];
    risks.push(risk({
      category: "testing",
      title: "Complex request handlers without nearby tests",
      explanation:
        untestedHandlers.length +
        " handler function(s) reachable from routes have cyclomatic complexity of at least 10 and no test file with a matching name. " +
        first.name +
        " serves " +
        first.route +
        " with complexity " +
        first.complexity +
        ".",
      locations: untestedHandlers.slice(0, 5).map((entry) => ({ file: entry.file, line: entry.line, endLine: entry.line })),
      evidence: [
        { source: "call-graph", detail: first.route + " -> " + first.name },
        { source: "test-inventory", detail: "no test file containing the module stem was found" },
      ],
      assumption: "A matching test-file name is a proxy for coverage; tests may import this module indirectly under another name.",
      confidence: "low",
      impact: "Behaviour changes in a branch-heavy handler can ship without a failing test.",
      horizon: "medium",
      relatedFindings: [],
    }));
  }

  const riskyCycles = input.index.cycles.filter((cycle) =>
    cycle.some((file) => (input.churn?.get(file) ?? 0) >= 3),
  );
  if (riskyCycles.length > 0) {
    risks.push(risk({
      category: "architecture",
      title: "Import cycles sit in actively changing modules",
      explanation:
        riskyCycles.length +
        " import cycle(s) involve files that changed at least three times in 180 days. Cycle members cannot be tested or deployed independently, so a change in one becomes a change in all.",
      locations: riskyCycles.slice(0, 3).map((cycle) => ({ file: cycle[0], line: 1, endLine: 1 })),
      evidence: riskyCycles.slice(0, 3).map((cycle) => ({ source: "import-graph", detail: cycle.join(" -> ") })),
      assumption: "The recorded changes touch the cyclic code rather than only comments or formatting.",
      confidence: "medium",
      impact: "Refactors in one module break another through initialisation order or shared state.",
      horizon: "medium",
      relatedFindings: input.findings.filter((finding) => finding.rule === "import-cycle").map((finding) => finding.id),
    }));
  }

  const sourceFiles = input.index.files.filter((file) => !isTestFile(file.file));
  const tests = input.index.tests.length;
  const inventoryScope =
    input.coverage.scope.length > 0 || input.coverage.indexed < input.coverage.sourceFiles
      ? "in the audited scope"
      : "in the repository";
  if (sourceFiles.length >= 10 && tests === 0) {
    risks.push(risk({
      category: "testing",
      title: "No test declarations were detected",
      explanation:
        "The index found " +
        sourceFiles.length +
        " non-test source files and 0 test declarations " +
        inventoryScope +
        ". This is a structural inventory, not a coverage percentage: a project could test through scripts that the index does not recognise.",
      locations: [],
      evidence: [{ source: "test-inventory", detail: sourceFiles.length + " source files, 0 tests" }],
      assumption: "Tests are declared in files and syntax this index understands (JS/TS test/it, Python test_ functions).",
      confidence: "medium",
      impact: "Every change relies on manual review; regressions have no automated detector.",
      horizon: "long",
      relatedFindings: [],
    }));
  } else if (sourceFiles.length >= 15 && tests > 0 && tests / sourceFiles.length < 0.25) {
    risks.push(risk({
      category: "testing",
      title: "Test inventory is thin relative to the source tree",
      explanation:
        tests +
        " test declaration(s) cover " +
        sourceFiles.length +
        " non-test source files " +
        inventoryScope +
        " (" +
        Math.round((tests / sourceFiles.length) * 100) +
        "%). The ratio is a structural proxy, not line coverage, but a thin inventory limits regression detection.",
      locations: [],
      evidence: [{ source: "test-inventory", detail: tests + " tests / " + sourceFiles.length + " source files" }],
      assumption: "Each test covers roughly one behaviour and tests are not heavily table-driven.",
      confidence: "low",
      impact: "Higher chance that a refactor breaks an unasserted behaviour.",
      horizon: "long",
      relatedFindings: [],
    }));
  }

  const verification = input.verification;
  if (
    verification !== undefined &&
    !verification.test &&
    !verification.typecheck &&
    !verification.lint &&
    !verification.build &&
    input.index.files.length >= 8
  ) {
    risks.push(risk({
      category: "testing",
      title: "No standard verification command was detected",
      explanation:
        "The repository has no test, typecheck, lint or build script that the tool can identify. Changes can only be verified manually, and automated checks cannot be added to the improvement workflow without a command.",
      locations: [],
      evidence: [{ source: "repo-understanding", detail: "no scripts.test/typecheck/lint/build and no conventional config" }],
      assumption: "The project does not run verification through an external CI-only command that is not declared in the repository.",
      confidence: "medium",
      impact: "Regressions are discovered in production rather than before merge.",
      horizon: "long",
      relatedFindings: [],
    }));
  }

  const unsupported = input.coverage.languages.filter((language) => language.semantic === "none" && language.files > 0);
  if (unsupported.length > 0) {
    risks.push(risk({
      category: "maintainability",
      title: "Some languages were counted but not semantically audited",
      explanation:
        unsupported
          .map((language) => language.displayName + " (" + language.files + " files)")
          .join(", ") +
        " were detected. The audit does not build a call graph or apply language-specific rules for them, so their findings are undercounted rather than absent.",
      locations: [],
      evidence: unsupported.map((language) => ({ source: "language-coverage", detail: language.displayName + ": " + language.note })),
      assumption: "The audit's supported-language set is a deliberate limit, not a claim that other languages are defect-free.",
      confidence: "high",
      impact: "A false sense of completeness for polyglot repositories.",
      horizon: "long",
      relatedFindings: [],
    }));
  }

  const anyFindings = input.findings.filter((finding) => finding.rule === "any-usage");
  if (anyFindings.length >= 5) {
    const anyFiles = new Set(anyFindings.map((finding) => finding.location.file));
    risks.push(risk({
      category: "type-safety",
      title: "Type escapes are widespread at module boundaries",
      explanation:
        "any appears " +
        anyFindings.length +
        " time(s) across " +
        anyFiles.size +
        " file(s). When values enter through untyped boundaries, validation is the only remaining guard, and it is usually absent.",
      locations: anyFindings.slice(0, 5).map((finding) => finding.location),
      evidence: anyFindings.slice(0, 3).map((finding) => ({ source: "audit-rule", detail: finding.title + " at " + finding.location.file })),
      assumption: "At least some any usage sits on input boundaries rather than in isolated compatibility shims.",
      confidence: "low",
      impact: "Malformed input reaches core logic and surfaces as a runtime error far from the entry point.",
      horizon: "medium",
      relatedFindings: anyFindings.map((finding) => finding.id),
    }));
  }

  // A category-filtered audit should not predict risk in an area it did not
  // measure. The risk is not a defect, but presenting it beside a partial score
  // still implies the area was assessed.
  return dedupe(risks)
    .filter((risk) => input.coverage.categoriesMeasured.includes(risk.category))
    .slice(0, 8);
}

export function collectChurn(repo: string, days = 180): { churn: Map<string, number> | null; note?: string } {
  if (!isGitRepo(repo)) {
    return { churn: null, note: "Git metadata is unavailable (not a repository or git is blocked); churn-based risks skipped." };
  }
  const result = safeExec(
    "git",
    ["-C", repo, "log", "--since=" + days + ".days", "--name-only", "--pretty=format:__commit__"],
    repo,
    20000,
  );
  if (result.code !== 0 || !result.stdout.trim()) {
    return { churn: null, note: "Git history could not be read; churn-based risks skipped." };
  }
  const churn = new Map<string, number>();
  let current = new Set<string>();
  const flush = () => {
    for (const file of current) churn.set(file, (churn.get(file) ?? 0) + 1);
    current = new Set();
  };
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "__commit__") {
      flush();
      continue;
    }
    const normalized = line.replace(/\\/g, "/");
    if (path.isAbsolute(normalized) || normalized.includes("..")) continue;
    current.add(normalized);
  }
  flush();
  return { churn };
}

function isGitRepo(repo: string): boolean {
  try {
    return safeExec("git", ["-C", repo, "rev-parse", "--is-inside-work-tree"], repo, 5000).stdout.trim() === "true";
  } catch {
    return false;
  }
}

function hasTestNearby(index: RepoIndex, file: string): boolean {
  const stem = path.posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
  if (!stem || stem === "index") return index.tests.length > 0;
  return [...index.testsByFile.keys()].some((testFile) => path.posix.basename(testFile).toLowerCase().includes(stem));
}

interface RiskSpec {
  category: RiskPrediction["category"];
  title: string;
  explanation: string;
  locations: RiskPrediction["locations"];
  evidence: RiskPrediction["evidence"];
  assumption: string;
  confidence: FindingConfidence;
  impact: string;
  horizon: RiskHorizon;
  relatedFindings: string[];
}

function risk(spec: RiskSpec): RiskPrediction {
  const id = "risk-" + shortHash(spec.title + "|" + JSON.stringify(spec.locations));
  return { id, ...spec };
}

function dedupe(risks: RiskPrediction[]): RiskPrediction[] {
  const seen = new Set<string>();
  return risks.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}
