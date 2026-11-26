import { analyzeDependencyGraph } from "./dependencyGraph.js";
import { analyzeSecurity } from "./security.js";
import { analyzeDuplication } from "./duplication.js";
import { analyzeTests } from "./tests.js";
import { analyzePerf } from "./perf.js";
import { analyzeAccessibility } from "./accessibility.js";
import { analyzeReliability } from "./reliability.js";
import { analyzeDevex } from "./devex.js";
import { detectLanguage } from "./util.js";
import { analyzeLanguages } from "../languages/index.js";
import type { ScanResult } from "./types.js";

export interface AnalyzerOptions {
  /** How many sequential suite runs the flaky detector performs (default 2). */
  reliabilityRuns?: number;
}

/**
 * Run every analyzer. The four subprocess-bound analyzers (security audit,
 * tests, perf build, reliability suite runs) run in parallel — they spend their
 * time waiting on child processes, not on CPU. The static analyzers (graph,
 * duplication, a11y, devex) stay synchronous.
 */
export async function runAllAnalyzers(
  repo: string,
  opts: AnalyzerOptions = {},
): Promise<ScanResult> {
  const [security, tests, perf, reliability, languageAnalysis] = await Promise.all([
    analyzeSecurity(repo),
    analyzeTests(repo),
    analyzePerf(repo),
    analyzeReliability(repo, { runs: opts.reliabilityRuns }),
    analyzeLanguages(repo),
  ]);
  return {
    timestamp: new Date().toISOString(),
    repo,
    language: detectLanguage(repo),
    dependencyGraph: analyzeDependencyGraph(repo),
    security,
    duplication: analyzeDuplication(repo),
    tests,
    perf,
    accessibility: analyzeAccessibility(repo),
    reliability,
    devex: analyzeDevex(repo),
    languageAnalysis,
    clusters: [],
  };
}
