/**
 * OpenPitStop's MCP tool set.
 *
 * Every tool maps onto logic the CLI already ships, runs in-process, and is
 * read-only with respect to source code. Two tools intentionally write, and
 * only outside source: `pitstop_scan` seals its quick-pass baseline under
 * `.pitstop/` (that is what makes `pitstop_release_gate` meaningful), and
 * `pitstop_reproduce` writes a repro test file (never a source patch).
 *
 * The independence rule lives here: the calling agent can inspect anything,
 * but `pitstop_release_gate` reasons over sealed evidence captured from the
 * working tree — the agent cannot talk its way to a VERIFIED verdict.
 */
import path from "node:path";
import { analyzeLanguages } from "../languages/index.js";
import { buildAttackSurface } from "../languages/map.js";
import { buildArchitectureMap } from "../architecture/map.js";
import { tryScan } from "../commands/try.js";
import { persistScan } from "../commands/scan.js";
import { stampFindings } from "../repro/ids.js";
import { correlate } from "../graph/correlate.js";
import { computeScore } from "../report/score.js";
import { applySuppressions } from "../findings/suppressions.js";
import { runVerify } from "../commands/verify.js";
import { gateOutcome } from "../commands/gate.js";
import { evaluateGate } from "../verify/gateMatrix.js";
import { runBench } from "../bench/run.js";
import { repro } from "../repro/index.js";
import type { McpTool } from "./protocol.js";

const REPO_ARG = {
  type: "string",
  description: "Repository path (absolute, or relative to the server's working directory). Defaults to the directory the server was started in.",
};

function repoArg(args: Record<string, unknown>, fallback: string): string {
  const raw = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : fallback;
  return path.resolve(raw);
}

function trimLanguageAnalysis(analysis: Awaited<ReturnType<typeof analyzeLanguages>>) {
  return {
    repo: analysis.repo,
    primaryLanguage: analysis.primaryLanguage,
    support: analysis.support.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      level: entry.level,
      files: entry.files,
      parser: entry.parser,
      analysis: entry.analysis,
      verification: entry.verification,
      frameworks: entry.frameworks,
      tests: entry.tests,
      build: entry.build,
    })),
    infrastructure: analysis.infrastructure,
    tools: analysis.tools,
    limits: analysis.limits,
  };
}

async function scanTool(args: Record<string, unknown>, fallbackRepo: string) {
  const repo = repoArg(args, fallbackRepo);
  const result = await tryScan(repo);
  stampFindings(result);
  applySuppressions(repo, result);
  result.clusters = correlate(repo, result).clusters;
  persistScan(repo, result);

  const score = computeScore(result);
  const issues = result.security.status === "ok" ? result.security.issues : [];
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  for (const issue of issues) {
    bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    const category = issue.category ?? issue.type;
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }
  return {
    repo,
    mode: "quick-static",
    score: { score: score.score, grade: score.grade, analyzed: score.analyzed, total: score.total },
    language: result.language,
    securityStatus: result.security.status,
    findingCount: issues.length,
    bySeverity,
    byCategory,
    findings: issues.slice(0, 50).map((issue) => ({
      id: issue.id,
      type: issue.type,
      category: issue.category,
      severity: issue.severity,
      file: issue.file,
      line: issue.line,
      description: issue.description,
      fix: issue.fix,
    })),
    notRun: [
      "tests (run `pitstop scan` or `pitstop check deep` for the suite)",
      "build/bundle timing",
      "flaky-test detection",
    ],
    note:
      "This is the quick static pass. A clean result is not a security verdict. " +
      "The baseline was sealed under .pitstop/ so pitstop_release_gate can use it.",
  };
}

async function gateTool(args: Record<string, unknown>, fallbackRepo: string) {
  const repo = repoArg(args, fallbackRepo);
  const threshold = typeof args.threshold === "number" ? args.threshold : Number(args.threshold ?? 60);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new Error("threshold must be a number from 0 to 100");
  }
  // Fail closed by default: an agent asking "may I merge?" must not read a
  // run with insufficient deep evidence as approval. `strict: false` restores
  // CLI parity (UNPROVEN exits 0 there, where a human reads the matrix).
  const strict = args.strict !== false;
  const requireLayers = typeof args.require === "string" ? args.require.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const outcome = await runVerify(repo);
  const gateResult = gateOutcome(outcome, threshold);
  const decision = evaluateGate(
    repo,
    {
      candidateBinding: outcome.candidateBinding,
      missingBaseline: outcome.missingBaseline,
      blocked: outcome.blocked,
      integrityVerdict: outcome.missingBaseline ? "CLEAN" : outcome.integrity.verdict,
      evidenceStatus: outcome.evidence?.status ?? "missing",
      risk: outcome.missingBaseline ? "Low" : outcome.risk,
      currentScore: outcome.missingBaseline ? 0 : outcome.currentScore.score,
      currentGrade: outcome.missingBaseline ? "F" : outcome.currentScore.grade,
      testsPassed: outcome.current.tests.passed,
      testsFailed: outcome.current.tests.failed,
      stale: outcome.stale,
      staleNote: outcome.staleNote,
    },
    { threshold, require: requireLayers, strict },
  );
  for (const reason of gateResult.reasons) {
    if (reason.startsWith("⚠") && !decision.reasons.some((existing) => existing.includes(reason.slice(1).trim().slice(0, 40)))) {
      decision.reasons.push(reason);
    }
  }
  return {
    repo,
    verdict: decision.verdict,
    // Agents read one field for "may I merge". It is true only for VERIFIED, so
    // UNPROVEN can never be mistaken for approval, whatever `strict` says.
    pass: decision.verdict === "VERIFIED",
    exitCode: decision.exitCode,
    layers: decision.layers,
    reasons: decision.reasons,
    summary: decision.summary,
    note:
      "This verdict reasons over sealed evidence and the working tree, not over the calling agent's claim. " +
      "`pass` is true only for VERIFIED; UNPROVEN means the evidence is insufficient, which is not a pass. " +
      "`strict` defaults to true here (it exits 1 on UNPROVEN); strict=false mirrors the CLI, where UNPROVEN exits 0. " +
      "A missing, stale or tampered baseline is never converted into a pass.",
  };
}

export function mcpTools(fallbackRepo: string): McpTool[] {
  return [
    {
      name: "pitstop_understand",
      description:
        "Detect the repository's languages, frameworks, parser/analysis/verification support levels, " +
        "infrastructure files and which optional tools would run. Read-only.",
      inputSchema: {
        type: "object",
        properties: { repo: REPO_ARG },
        additionalProperties: false,
      },
      handler: async (args) => trimLanguageAnalysis(await analyzeLanguages(repoArg(args, fallbackRepo))),
    },
    {
      name: "pitstop_map",
      description:
        "Map candidate HTTP routes, entry points, auth/data-access path evidence and infrastructure " +
        "(set architecture=true for modules, dependencies, cycles, services and boundaries). " +
        "Routes and path labels are leads, not reachability proof. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO_ARG,
          architecture: { type: "boolean", description: "Return the module/dependency/boundary map instead of the attack-surface map." },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const analysis = await analyzeLanguages(repoArg(args, fallbackRepo));
        return args.architecture === true ? buildArchitectureMap(analysis.repo) : buildAttackSurface(analysis);
      },
    },
    {
      name: "pitstop_scan",
      description:
        "Run the quick static security and quality pass (offline rules, dependency graph, duplication, " +
        "devex) and seal the result as the scan baseline under .pitstop/. Does NOT run tests or build. " +
        "Writes only under .pitstop/.",
      inputSchema: {
        type: "object",
        properties: { repo: REPO_ARG },
        additionalProperties: false,
      },
      handler: (args) => scanTool(args, fallbackRepo),
    },
    {
      name: "pitstop_release_gate",
      description:
        "The independent release gate: deterministic matrix over the scan baseline, integrity detectors, " +
        "evidence seals and every sealed deep-verification layer. The verdict comes from evidence, " +
        "NEVER from the calling agent's own claim. threshold 0-100 (default 60); strict defaults to true, " +
        "so only VERIFIED passes and UNPROVEN fails; require=<layer,...> demands specific passing layers.",
      inputSchema: {
        type: "object",
        properties: {
          repo: REPO_ARG,
          threshold: { type: "number", description: "Minimum OpenPitStop Score (0-100, default 60; 0 disables the score check)." },
          strict: { type: "boolean", description: "Only VERIFIED passes; UNPROVEN fails. Default true; false gives CLI parity." },
          require: { type: "string", description: "Comma-separated layers that must pass, e.g. 'baseline,acceptance,holdout'." },
        },
        additionalProperties: false,
      },
      handler: (args) => gateTool(args, fallbackRepo),
    },
    {
      name: "pitstop_reproduce",
      description:
        "Generate and run a permanent repro test for a finding id from the sealed scan: it must FAIL " +
        "while the bug is present and PASS only after the fix. Writes one repro test file; never a source patch.",
      inputSchema: {
        type: "object",
        properties: {
          findingId: { type: "string", description: "Finding id from pitstop_scan or scan-latest.json." },
          repo: REPO_ARG,
          writeOnly: { type: "boolean", description: "Write the repro test but do not run it." },
        },
        required: ["findingId"],
        additionalProperties: false,
      },
      handler: async (args) => {
        if (typeof args.findingId !== "string" || !args.findingId.trim()) {
          throw new Error("findingId is required");
        }
        return repro(repoArg(args, fallbackRepo), args.findingId.trim(), { writeOnly: args.writeOnly === true });
      },
    },
    {
      name: "pitstop_bench",
      description:
        "Run the reproducible detection benchmark (vulnerable/fixed pairs, benign near-misses, documented " +
        "misses) against the built-in static security check. Reports precision/recall with denominators. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          dir: { type: "string", description: "Benchmark directory (default: 'bench' in the server's working directory)." },
          filter: { type: "string", description: "Only scenarios whose id, title, stack or kind contains this text." },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const root = path.resolve(typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : "bench");
        const report = await runBench(root, { filter: typeof args.filter === "string" ? args.filter : undefined });
        return {
          summary: report.summary,
          coverage: report.coverage,
          limits: report.limits,
          scenarios: report.scenarios.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            stack: entry.stack,
            verdict: entry.verdict,
            matched: entry.matched,
            missing: entry.missing,
          })),
        };
      },
    },
  ];
}
