import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import { printNextCard } from "./next.js";
import Table from "cli-table3";
import path from "node:path";
import fs from "node:fs";
import { analyzeTests } from "../analyzers/tests.js";
import { analyzePerf } from "../analyzers/perf.js";
import { analyzeSecurity } from "../analyzers/security.js";
import { analyzeDuplication } from "../analyzers/duplication.js";
import { addEntry } from "../memory/store.js";
import { newestModifiedFile } from "../analyzers/util.js";
import type { ScanResult, ScanIssue } from "../analyzers/types.js";
import type { VerifyMetrics } from "../report/format.js";
import { classifyRisk, deltasOf, metricsOf } from "../verify/metrics.js";
import { computeScore, type ScoreResult } from "../report/score.js";
import { getDiff } from "../analyzers/integrity/git.js";
import { buildIntegrityReport } from "../graph/integrity.js";
import type { IntegrityFinding, Verdict } from "../analyzers/integrity/types.js";
import { seal, checkEvidence, type EvidenceCheck, type OpenPitStopEvidence } from "../evidence.js";
import { computeHonesty, type HonestyScore } from "../verify/honesty.js";

interface IntegrityGate {
  verdict: Verdict;
  findings: IntegrityFinding[];
  summary: { confirmed: number; suspicious: number; total: number };
}

type Risk = "Low" | "Medium" | "High";

export interface VerifyOutcome {
  repo: string;
  missingBaseline: boolean;
  baselineTimestamp?: string;
  evidence?: EvidenceCheck;
  stale: boolean;
  staleNote?: string;
  risk: Risk;
  integrity: IntegrityGate;
  blocked: boolean;
  current: VerifyMetrics;
  baseline: VerifyMetrics;
  deltas: ReturnType<typeof deltasOf>;
  baselineScore: ScoreResult;
  currentScore: ScoreResult;
  scoreDelta: number;
  exitCode: number;
  file?: string;
  /** 0-100 trust rating: did the agent (or auto-fix) fake the result? */
  honesty?: HonestyScore;
}

/**
 * Every verify run doubles as an integrity gate: it diffs the working tree
 * against the last commit (HEAD) and runs the AI-agent-cheat detectors. A
 * SUSPICIOUS or CONFIRMED_CHEAT verdict BLOCKS the change regardless of test
 * or perf numbers.
 */
function integrityGate(repo: string): IntegrityGate {
  const changes = getDiff(repo, "HEAD");
  const report = buildIntegrityReport(repo, "HEAD", "working tree", changes);
  return { verdict: report.verdict, findings: report.findings, summary: report.summary };
}

function readBaseline(repo: string): (ScanResult & { evidence?: OpenPitStopEvidence }) | null {
  const p = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    // PowerShell (and some editors) write UTF-8 JSON with a BOM; JSON.parse
    // rejects it, so strip a leading U+FEFF before parsing.
    const raw = fs.readFileSync(p, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return JSON.parse(clean) as ScanResult & {
      evidence?: OpenPitStopEvidence;
    };
  } catch {
    return null;
  }
}

async function currentMetrics(repo: string): Promise<VerifyMetrics> {
  const [tests, perf, security, duplication] = await Promise.all([
    analyzeTests(repo),
    analyzePerf(repo),
    analyzeSecurity(repo),
    analyzeDuplication(repo),
  ]);
  return {
    tests: {
      total: tests.total,
      passed: tests.passed,
      failed: tests.failed,
      durationMs: tests.durationMs,
      coverage: tests.coverage,
    },
    perf: {
      buildTimeMs: perf.buildTimeMs,
      bundleSizeBytes: perf.bundleSizeBytes,
    },
    securityCount: security.issues.length,
    duplicationCount: duplication.cloneCount,
  };
}

/**
 * Verify re-measures only the fast metrics (tests/perf/security/dup), so the
 * "current" OpenPitStop Score is computed from the last scan with exactly those
 * categories patched in — the other categories keep their scan snapshot.
 */
function currentScoreOf(
  baselineResult: ScanResult,
  current: VerifyMetrics,
  integrityPenalty: number,
): ScoreResult {
  // Only patch categories that actually ran in the baseline scan; a category
  // that printed "skipped" must stay skipped on both sides of the delta,
  // otherwise the score could move for purely toolchain reasons.
  const hybrid: ScanResult = { ...baselineResult };
  if (hybrid.tests.status === "ok") {
    hybrid.tests = {
      status: "ok",
      total: current.tests.total,
      passed: current.tests.passed,
      failed: current.tests.failed,
      durationMs: current.tests.durationMs,
      coverage: current.tests.coverage,
    };
  }
  if (hybrid.perf.status === "ok") {
    hybrid.perf = {
      status: "ok",
      buildTimeMs: current.perf.buildTimeMs,
      bundleSizeBytes: current.perf.bundleSizeBytes,
    };
  }
  if (hybrid.security.status === "ok") {
    const synthetic: ScanIssue[] = Array.from({ length: current.securityCount }, () => ({
      type: "security",
      severity: "high",
      description: "current security findings (from verify)",
    }));
    hybrid.security = { status: "ok", issues: synthetic };
  }
  if (hybrid.duplication.status === "ok") {
    hybrid.duplication = { status: "ok", cloneCount: current.duplicationCount, clones: [] };
  }
  return computeScore(hybrid, { integrityPenalty });
}

/**
 * The shared verify pipeline (also used by `pitstop gate`): re-measure the
 * fast metrics, diff against the scan baseline, run the integrity gate, check
 * the baseline's evidence signature, and write a sealed verify report. Returns
 * everything a renderer needs plus the exit code to propagate.
 */
export async function runVerify(repo: string): Promise<VerifyOutcome> {
  const baselineResult = readBaseline(repo);
  if (!baselineResult) {
    const outcome: VerifyOutcome = {
      repo,
      missingBaseline: true,
      stale: false,
      risk: "High",
      integrity: {
        verdict: "CLEAN",
        findings: [],
        summary: { confirmed: 0, suspicious: 0, total: 0 },
      },
      blocked: false,
      current: {
        tests: { total: 0, passed: 0, failed: 0, durationMs: 0 },
        perf: {},
        securityCount: 0,
        duplicationCount: 0,
      },
      baseline: {
        tests: { total: 0, passed: 0, failed: 0, durationMs: 0 },
        perf: {},
        securityCount: 0,
        duplicationCount: 0,
      },
      deltas: {
        passed: 0,
        failed: 0,
        durationMs: 0,
        coverage: 0,
        buildTimeMs: 0,
        bundleSizeBytes: 0,
        security: 0,
        duplication: 0,
      },
      baselineScore: { score: 0, grade: "F", categories: [], analyzed: 0, total: 0 },
      currentScore: { score: 0, grade: "F", categories: [], analyzed: 0, total: 0 },
      scoreDelta: 0,
      exitCode: 1,
    };
    return { ...outcome, honesty: computeHonesty(outcome) };
  }

  // Evidence signature: recompute the digest of the stored scan and compare.
  // A baseline edited after OpenPitStop wrote it breaks the chain — the score
  // delta is then computed against a document OpenPitStop cannot vouch for.
  const evidence = checkEvidence(baselineResult);

  const baseline = metricsOf(baselineResult);
  const current = await currentMetrics(repo);
  const d = deltasOf(baseline, current);

  // Baseline staleness: if files changed after the baseline scan, the delta
  // and score are computed against a snapshot that no longer matches the
  // working tree — warn loudly instead of silently presenting stale math.
  let staleNote = "";
  const newest = newestModifiedFile(repo);
  const baselineAt = Date.parse(baselineResult.timestamp);
  if (newest && baselineAt && newest.mtimeMs > baselineAt + 1000) {
    const relFile = path.relative(repo, newest.file) || newest.file;
    staleNote =
      `baseline is STALE — ${relFile} changed ${new Date(newest.mtimeMs).toISOString()}, ` +
      `after the baseline scan (${baselineResult.timestamp}). Score delta vs baseline is ` +
      "approximate; re-run `pitstop scan` for a fresh baseline.";
  }
  const stale = staleNote !== "";

  const risk = classifyRisk(baseline, current, d);

  // Integrity gate — runs automatically on every verify, gating the commit.
  const integrity = integrityGate(repo);
  const blocked =
    integrity.verdict === "SUSPICIOUS" || integrity.verdict === "CONFIRMED_CHEAT";
  const integrityPenalty = blocked
    ? integrity.verdict === "CONFIRMED_CHEAT"
      ? 25
      : 10
    : 0;

  const baselineScore = computeScore(baselineResult);
  const currentScore = currentScoreOf(
    baselineResult,
    current,
    integrityPenalty,
  );
  const scoreDelta = currentScore.score - baselineScore.score;

  const outDir = path.join(repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `verify-${ts}.json`);

  const honesty = computeHonesty({
    repo,
    missingBaseline: false,
    stale,
    risk,
    integrity,
    blocked,
    current,
    baseline,
    deltas: d,
    baselineScore,
    currentScore,
    scoreDelta,
    exitCode: blocked
      ? integrity.verdict === "CONFIRMED_CHEAT"
        ? 2
        : 1
      : risk === "High"
        ? 1
        : 0,
  } as VerifyOutcome);

  const outcome: VerifyOutcome = {
    repo,
    missingBaseline: false,
    baselineTimestamp: baselineResult.timestamp,
    evidence,
    stale,
    staleNote: stale ? staleNote : undefined,
    risk,
    integrity,
    blocked,
    current,
    baseline,
    deltas: d,
    baselineScore,
    currentScore,
    scoreDelta,
    exitCode: blocked
      ? integrity.verdict === "CONFIRMED_CHEAT"
        ? 2
        : 1
      : risk === "High"
        ? 1
        : 0,
    file,
    honesty,
  };

  const report = {
    timestamp: new Date().toISOString(),
    repo,
    baselineTimestamp: baselineResult.timestamp,
    risk,
    blocked,
    stale,
    staleNote: stale ? staleNote : undefined,
    // named `baselineEvidence` (NOT `evidence`): the seal block occupies the
    // `evidence` key, which is excluded from the tamper digest — the baseline
    // evidence check must stay INSIDE the protected content.
    baselineEvidence: evidence,
    status: blocked ? "BLOCKED" : evidence.status === "tampered" ? "SUSPICIOUS_EVIDENCE" : "OK",
    exitCode: outcome.exitCode,
    integrity,
    deltas: d,
    baseline,
    current,
    score: {
      baseline: baselineScore.score,
      current: currentScore.score,
      delta: scoreDelta,
      grade: currentScore.grade,
    },
    honesty,
  };
  fs.writeFileSync(file, JSON.stringify(seal(report, `pitstop verify result for ${repo}`), null, 2));

  return outcome;
}

function fmtBundle(b?: number): string {
  return b == null ? "—" : `${(b / 1024).toFixed(1)} KB`;
}
function fmtMs(n?: number): string {
  return n == null ? "—" : `${n} ms`;
}
function fmtPct(n?: number): string {
  return n == null ? "—" : `${n.toFixed(1)}%`;
}
function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
function deltaBytes(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${(n / 1024).toFixed(1)} KB`;
}
function deltaMs(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n} ms`;
}
function deltaPct(n: number): string {
  if (n === 0) return "0";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function evidenceLine(ev: EvidenceCheck | undefined): string {
  if (!ev || ev.status === "missing") {
    return chalk.dim(`evidence: untracked (baseline carries no OpenPitStop signature)`);
  }
  if (ev.status === "verified") {
    return chalk.green(`evidence: ✓ signed ${ev.digest.slice(0, 12)}…`);
  }
  return chalk.red(
    `evidence: ✗ TAMPERED — ${ev.reason ?? "digest mismatch"} ` +
      `(expected ${ev.expected?.slice(0, 12)}…, got ${ev.digest.slice(0, 12)}…)`,
  );
}

function renderVerifyBox(o: VerifyOutcome): { text: string; color: string } {
  const d = o.deltas;
  const baseline = o.baseline;
  const current = o.current;
  const baselineScore = o.baselineScore;
  const currentScore = o.currentScore;

  const table = new Table({
    head: ["Metric", "Baseline", "Current", "Δ"],
    style: { head: ["cyan"], border: [] },
  });

  const row = (
    name: string,
    baseStr: string,
    curStr: string,
    deltaNum: number,
    deltaStr: string,
    higherIsBetter: boolean,
  ) => {
    const col =
      deltaNum === 0
        ? chalk.dim
        : (higherIsBetter ? deltaNum > 0 : deltaNum < 0)
          ? chalk.green
          : chalk.red;
    table.push([chalk.bold(name), baseStr, curStr, col(deltaStr)]);
  };

  row("Tests passed", String(baseline.tests.passed), String(current.tests.passed), d.passed, signed(d.passed), true);
  row("Tests failed", String(baseline.tests.failed), String(current.tests.failed), d.failed, signed(d.failed), false);
  row("Duration", fmtMs(baseline.tests.durationMs), fmtMs(current.tests.durationMs), d.durationMs, deltaMs(d.durationMs), false);
  row(
    "Coverage",
    fmtPct(baseline.tests.coverage),
    fmtPct(current.tests.coverage),
    d.coverage,
    deltaPct(d.coverage),
    true,
  );
  row(
    "Build time",
    fmtMs(baseline.perf.buildTimeMs),
    fmtMs(current.perf.buildTimeMs),
    d.buildTimeMs,
    deltaMs(d.buildTimeMs),
    false,
  );
  row(
    "Bundle size",
    fmtBundle(baseline.perf.bundleSizeBytes),
    fmtBundle(current.perf.bundleSizeBytes),
    d.bundleSizeBytes,
    deltaBytes(d.bundleSizeBytes),
    false,
  );
  row("Security findings", String(baseline.securityCount), String(current.securityCount), d.security, signed(d.security), false);
  row(
    "Duplication clones",
    String(baseline.duplicationCount),
    String(current.duplicationCount),
    d.duplication,
    signed(d.duplication),
    false,
  );
  row(
    "OpenPitStop score",
    `${baselineScore.score}/100 (${baselineScore.grade})`,
    `${currentScore.score}/100 (${currentScore.grade})`,
    o.scoreDelta,
    o.scoreDelta > 0 ? `+${o.scoreDelta} pts` : `${o.scoreDelta} pts`,
    true,
  );

  const riskColor = o.risk === "High" ? chalk.red : o.risk === "Medium" ? chalk.yellow : chalk.green;
  let riskLine: string;
  if (o.blocked) {
    riskLine = `${chalk.bold("Regression risk:")} ${chalk.red("BLOCKED — integrity violation")} (${o.integrity.verdict})`;
  } else {
    riskLine = `${chalk.bold("Regression risk:")} ${riskColor(o.risk.toUpperCase())}`;
  }

  const integrityParts: string[] = [];
  if (o.blocked) {
    integrityParts.push(
      chalk.red(
        `${chalk.bold("Integrity gate:")} ${o.integrity.verdict} — ` +
          `${o.integrity.summary.confirmed} confirmed · ${o.integrity.summary.suspicious} suspicious`,
      ),
    );
    for (const f of o.integrity.findings) {
      const tag =
        f.confidence === "confirmed" ? chalk.red("CONFIRMED") : chalk.yellow("SUSPICIOUS");
      const loc = f.line ? `${f.file}:${f.line}` : f.file;
      integrityParts.push(
        `  ${tag} ${chalk.bold(f.detector)} / ${f.pattern} @ ${chalk.cyan(loc)}`,
        `    ${f.evidence}`,
      );
    }
  }

  const contentParts: string[] = [];
  if (o.stale) {
    contentParts.push(chalk.yellow(`⚠ ${o.staleNote}`));
  }
  contentParts.push(evidenceLine(o.evidence));

  if (o.evidence && o.evidence.status === "tampered") {
    contentParts.push(
      chalk.red(
        `${chalk.bold("Evidence gate:")} the baseline was edited after OpenPitStop signed it — ` +
          "score delta is against an untrustworthy snapshot. Re-run `pitstop scan`.",
      ),
    );
  }

  if (o.stale) contentParts.push("");
  contentParts.push(...integrityParts, riskLine);

  if (o.honesty) {
    const hc =
      o.honesty.rating === "TRUSTWORTHY"
        ? chalk.green
        : o.honesty.rating === "QUESTIONABLE"
          ? chalk.yellow
          : chalk.red;
    contentParts.push(
      hc(`Honesty Score: ${o.honesty.score}/100 · ${o.honesty.rating}`),
    );
    if (o.honesty.rating !== "TRUSTWORTHY") {
      for (const r of o.honesty.reasons) contentParts.push(chalk.dim(`  · ${r}`));
    }
  }
  contentParts.push("", table.toString());
  const content = contentParts.join("\n");

  const color = o.blocked ? "red" : o.risk === "High" ? "red" : o.risk === "Medium" ? "yellow" : "green";
  return {
    text: content,
    color,
  };
}

export const verify = new Command("verify")
  .description(
    "Re-run tests/perf, diff against the last scan baseline, AND gate on the integrity diff since HEAD — " +
      "SUSPICIOUS/CONFIRMED_CHEAT verifies exit 1/2 with 'BLOCKED — integrity violation'.",
  )
  .argument("[repo]", "path to the repo to verify", ".")
  .action(async (repoArg: string) => {
    const repo = path.resolve(repoArg);
    console.log(chalk.cyan(`\nVerifying ${repo} ...\n`));

    const outcome = await runVerify(repo);

    if (outcome.missingBaseline) {
      console.log(
        chalk.red("no baseline found — run `pitstop scan` first to create .pitstop/scan-latest.json"),
      );
      process.exitCode = 1;
      return;
    }

    const { text, color } = renderVerifyBox(outcome);

    console.log(
      boxen(text, {
        title: " PITSTOP — Verify ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: color,
      }),
    );

    console.log(chalk.dim(`\nReport written to ${outcome.file}\n`));
    // Pure-CLI users get the sticky-loop card too — no agent required.
    await printNextCard(repo);

    const summary = outcome.blocked
      ? `verify BLOCKED (integrity ${outcome.integrity.verdict})`
      : `verify ${outcome.risk}: score ${outcome.currentScore.score}/100 (${outcome.currentScore.grade}) · tests ${signed(outcome.deltas.failed)} fail, bundle ${deltaBytes(outcome.deltas.bundleSizeBytes)}, security ${signed(outcome.deltas.security)}`;
    addEntry(repo, {
      type: "fix",
      summary,
      context: `verify against baseline ${outcome.baselineTimestamp} — integrity ${outcome.integrity.verdict}`,
    });

    process.exitCode = outcome.exitCode;
  });