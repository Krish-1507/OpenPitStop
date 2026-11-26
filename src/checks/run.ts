import fs from "node:fs";
import path from "node:path";
import { seal } from "../evidence.js";
import { buildUnderstanding, sealUnderstanding } from "../understand/index.js";
import { detectProject } from "../onboarding/detect.js";
import { tryScan } from "../commands/try.js";
import { persistScan, runScan } from "../commands/scan.js";
import { stampFindings } from "../repro/ids.js";
import { correlate } from "../graph/correlate.js";
import { applySuppressions } from "../findings/suppressions.js";
import { runVerifyStack, sealStackResult } from "../verify/stack.js";
import { runVerify } from "../commands/verify.js";
import { evaluateGate, type GateDecision } from "../verify/gateMatrix.js";
import { buildCheckReport, type CheckMode, type CheckReport } from "./report.js";

export interface RunCheckOptions {
  /** Persist the sealed check report (default true). Disable for pure previews. */
  persist?: boolean;
}

function persistCheck(repo: string, report: CheckReport): CheckReport {
  const outDir = path.join(repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `check-${ts}.json`);
  report.evidencePath = path.relative(repo, file).replace(/\\/g, "/");
  const sealed = seal({ kind: "openpitstop-check", ...report }, `pitstop ${report.mode} check for ${repo}`);
  const json = JSON.stringify(sealed, null, 2);
  fs.writeFileSync(file, json);
  fs.writeFileSync(path.join(outDir, "check-latest.json"), json);
  return report;
}

/**
 * One implementation behind `pitstop check quick|deep|ship` and the guided
 * first-run. Quick intentionally excludes tests/build/reliability; deep runs
 * the full scan; ship adds the verification stack and the strict release gate.
 */
export async function runCheck(
  repoInput: string,
  mode: CheckMode,
  opts: RunCheckOptions = {},
): Promise<CheckReport> {
  const repo = path.resolve(repoInput);
  if (!["quick", "deep", "ship"].includes(mode)) {
    throw new Error(`unknown check mode "${mode}" — choose quick, deep, or ship`);
  }

  const project = detectProject(repo);
  if (project.type === "Unknown project type") {
    throw new Error(
      "no supported project detected — expected package.json, tsconfig.json, requirements.txt, " +
        "pyproject.toml, setup.py, go.mod, Cargo.toml, a Maven/Gradle build, or a .NET project",
    );
  }
  const understanding = sealUnderstanding(repo, buildUnderstanding(repo));

  if (mode === "quick") {
    const scan = await tryScan(repo);
    stampFindings(scan);
    applySuppressions(repo, scan);
    scan.clusters = correlate(repo, scan).clusters;
    const { file } = persistScan(repo, scan);
    const report = buildCheckReport({
      mode,
      repo,
      project,
      scan,
      scanPath: path.relative(repo, file).replace(/\\/g, "/"),
      understandingPath: understanding.sealedPath
        ? path.relative(repo, understanding.sealedPath).replace(/\\/g, "/")
        : undefined,
    });
    return opts.persist === false ? report : persistCheck(repo, report);
  }

  // A full scan is the evidence base for both deep and ship. Ship uses one
  // reliability run because the verification stack runs the test layers again.
  const { result: scan, file } = await runScan(repo, {
    reliabilityRuns: mode === "ship" ? 1 : 2,
  });

  let stack: Awaited<ReturnType<typeof runVerifyStack>> | undefined;
  let gate: GateDecision | undefined;
  if (mode === "ship") {
    stack = sealStackResult(await runVerifyStack({ repo }));
    const outcome = await runVerify(repo);
    gate = evaluateGate(repo, {
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
    }, { threshold: 60, strict: true, require: ["stack"] });
  }

  const report = buildCheckReport({
    mode,
    repo,
    project,
    scan,
    scanPath: path.relative(repo, file).replace(/\\/g, "/"),
    understandingPath: understanding.sealedPath
      ? path.relative(repo, understanding.sealedPath).replace(/\\/g, "/")
      : undefined,
    stack,
    gate,
  });
  return opts.persist === false ? report : persistCheck(repo, report);
}

/** Latest sealed check summary, for the returning-user first-run screen. */
export function readLatestCheck(repo: string): { timestamp?: string; mode?: string; score?: number; grade?: string; path: string } | null {
  const file = path.join(path.resolve(repo), ".pitstop", "check-latest.json");
  if (!fs.existsSync(file)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return {
      timestamp: doc.generatedAt ?? doc.timestamp,
      mode: doc.mode,
      score: doc.score?.value,
      grade: doc.score?.grade,
      path: file,
    };
  } catch {
    return null;
  }
}
