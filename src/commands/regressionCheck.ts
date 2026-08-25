import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import {
  runRegressionCheck,
  sealRegressionResult,
  checkRegressionEvidence,
} from "../verify/regression.js";
import { addEntry } from "../memory/store.js";

const MARK = (pass: boolean | null) =>
  pass === null ? chalk.yellow("?") : pass ? chalk.green("✓") : chalk.red("✗");

const CLASS_PAINT: Record<string, (s: string) => string> = {
  REGRESSION: chalk.red,
  NEW_FAILURE: chalk.red,
  FIXED: chalk.green,
  NEW_PASS: chalk.green,
  UNCHANGED: chalk.dim,
  UNPROVEN: chalk.yellow,
};

export const regressionCheck = new Command("regression-check")
  .description(
    "Regression verification: compare check-level results (per-test names where the runner " +
      "exposes them) between a BASELINE and the CANDIDATE. Only behavior that was previously " +
      "verified passing and now fails is a REGRESSION — fixed, new, and unchanged checks are " +
      "classified honestly. Runs in isolated worktrees; seals per-check evidence; the gate " +
      "blocks on regressions.",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption("--command <cmd>", "verification command whose per-check results are compared")
  .option("--baseline <ref>", "baseline commit/ref (its checks define 'previously working')")
  .option("--candidate <ref>", "candidate commit/ref (default: HEAD)", "HEAD")
  .option("--baseline-evidence <file>", "sealed baseline evidence (.pitstop/regression-baseline.json) instead of a git ref")
  .option("--record", "record the candidate run as the regression baseline evidence and exit")
  .option("--runs <n>", "candidate executions for flakiness detection (default 1; >1 flags inconsistent checks as UNPROVEN)", "1")
  .option("--timeout <ms>", "per-run timeout in ms")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    let result = await runRegressionCheck({
      repo,
      command: opts.command,
      baselineRef: opts.baseline,
      candidateRef: opts.candidate,
      baselineEvidenceFile: opts.baselineEvidence,
      runs: Number(opts.runs) || 1,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    });

    if (opts.record) {
      const { recordBaselineEvidence } = await import("../verify/regression.js");
      const checks = result.entries.map((e) => ({ id: e.id, pass: e.candidatePass === true }));
      const file = recordBaselineEvidence(repo, opts.command, checks, {
        recordedFrom: result.candidateRef,
        sha: result.candidateSha,
      });
      if (opts.json) {
        console.log(JSON.stringify({ recorded: file, checks: checks.length, candidateSha: result.candidateSha }, null, 2));
      } else {
        console.log(
          boxen(
            `recorded ${checks.length} check(s) as the regression baseline\n\n${chalk.dim(file)}\n\n${chalk.dim("future runs compare against this sealed evidence: --baseline-evidence")}`,
            { title: " PITSTOP — Regression Baseline ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "cyan" },
          ),
        );
      }
      return;
    }

    result = sealRegressionResult(result);

    if (opts.json) {
      console.log(JSON.stringify({
        repo: result.repo,
        command: result.command,
        baseline: { ref: result.baselineRef, sha: result.baselineSha, suiteExit: result.baselineSuiteExit },
        candidate: { ref: result.candidateRef, sha: result.candidateSha, suiteExit: result.candidateSuiteExit, runs: result.runs },
        entries: result.entries,
        regressions: result.regressions,
        newFailures: result.newFailures,
        fixed: result.fixed,
        unproven: result.unproven,
        verdict: result.verdict,
        reasons: result.reasons,
        notes: result.notes,
        sealedPath: result.sealedPath,
      }, null, 2));
    } else {
      const baselineById = new Map(result.entries.map((e) => [e.id, e.baselinePass]));
      const candidateById = new Map(result.entries.map((e) => [e.id, e.candidatePass]));
      const listChecks = (pass: boolean | null) =>
        result.entries
          .filter((e) => e.baselinePass === pass)
          .slice(0, 12)
          .map((e) => `  ${MARK(pass)} ${e.id}`)
          .join("\n");

      const baselineBlock =
        (result.baselineRef ? `${chalk.dim(result.baselineRef)}` : chalk.dim("n/a")) +
        (result.baselineSuiteExit !== null ? chalk.dim(`  (suite exit ${result.baselineSuiteExit})`) : "") +
        (listChecks(true) ? "\n" + listChecks(true) : "") +
        (listChecks(false) ? "\n" + listChecks(false) : "") +
        (listChecks(null) ? "\n" + listChecks(null) : "");

      const candidateBlock =
        chalk.dim(result.candidateRef) +
        (result.candidateSuiteExit !== null ? chalk.dim(`  (suite exit ${result.candidateSuiteExit}${result.runs > 1 ? `, ${result.runs} runs` : ""})`) : "") +
        "\n" +
        result.entries
          .slice(0, 14)
          .map((e) => {
            const cls = CLASS_PAINT[e.classification] ?? chalk.dim;
            return `  ${MARK(e.candidatePass)} ${e.id}${e.classification === "UNCHANGED" ? "" : "  " + cls(e.classification)}${e.flaky ? chalk.yellow("  (flaky)") : ""}`;
          })
          .join("\n") +
        (result.entries.length > 14 ? chalk.dim(`\n  … ${result.entries.length - 14} more`) : "");

      console.log(
        boxen(`BASELINE\n${baselineBlock}`, { title: " PREVIOUSLY VERIFIED ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "cyan" }),
      );
      console.log(
        boxen(`CANDIDATE\n${candidateBlock}`, { title: " CURRENT RESULTS ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: result.regressions.length || result.newFailures.length ? "red" : "green" }),
      );

      const regressionList = [...result.regressions, ...result.newFailures];
      const verdictColor: any = result.verdict === "NO_REGRESSION" ? "green" : result.verdict === "UNPROVEN" ? "yellow" : "red";
      console.log(
        boxen(
          (regressionList.length
            ? `${chalk.bold("REGRESSION:")}\n  ${regressionList.map((id) => chalk.red(id)).join("\n  ")}\n\n`
            : "") +
            `${chalk.bold("VERDICT:")} ${chalk.bold(result.verdict === "NO_REGRESSION" ? "NO_REGRESSION — safe" : result.verdict === "REGRESSION" ? "REGRESSION — BLOCKED" : result.verdict)}\n\n` +
            result.reasons.map((r) => `· ${r}`).join("\n") +
            (result.fixed.length ? `\n\n${chalk.green(`fixed: ${result.fixed.join(", ")}`)}` : "") +
            (result.notes.length ? "\n\n" + result.notes.map((n) => chalk.dim(`· ${n}`)).join("\n") : "") +
            `\n\n${chalk.dim("only previously-passing behavior that now fails is a regression — flaky checks (with --runs >1) are UNPROVEN, not regressions")}`,
          { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: verdictColor },
        ),
      );
      if (result.sealedPath) {
        console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
        const ev = checkRegressionEvidence(result.sealedPath);
        if (ev.status !== "verified") console.log(chalk.red(`Evidence check: ${ev.status} — ${ev.reason}`));
      }
    }

    addEntry(repo, {
      type: "fix",
      summary: `regression-check: ${result.verdict} (${result.regressions.length} regressions, ${result.fixed.length} fixed)`,
      context: result.regressions.length ? `regressions: ${result.regressions.join(", ")}` : `command ${result.command.slice(0, 60)}`,
    });

    process.exitCode =
      result.verdict === "NO_REGRESSION" ? 0 : result.verdict === "REGRESSION" ? 1 : result.verdict === "UNPROVEN" ? 2 : 3;
  });

export default regressionCheck;
