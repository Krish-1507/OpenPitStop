import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { runCheck } from "../checks/run.js";
import { renderCheck, type CheckMode } from "../checks/report.js";
import { createSpinner } from "../ui/spinner.js";

const MODES: CheckMode[] = ["quick", "deep", "ship"];

function modeOf(value: string | undefined): CheckMode {
  return MODES.includes(value as CheckMode) ? (value as CheckMode) : "quick";
}

/**
 * `pitstop check` — one guided workflow with three depths:
 *   quick: understanding + fast static scan (no tests/build/flaky)
 *   deep:  full scan (tests, build, reliability)
 *   ship:  full scan + verification stack + strict release gate
 *
 * Existing `try`, `scan` and `gate` keep their own contracts; this command
 * composes the same implementations and presents one readable summary.
 */
export const check = new Command("check")
  .description(
    "Guided project check: `quick` (fast static pass), `deep` (full scan), or `ship` " +
      "(full scan + typecheck/lint/build + strict release gate).",
  )
  .argument("[mode-or-repo]", "quick | deep | ship, or a repository path", "quick")
  .argument("[repo]", "repository path (when the first argument is a mode)", ".")
  .option("--json", "print the machine-readable check report")
  .action(async (modeOrRepo: string, repoArg: string, opts: { json?: boolean }) => {
    const isMode = MODES.includes(modeOrRepo as CheckMode);
    const mode = isMode ? modeOf(modeOrRepo) : "quick";
    const repo = path.resolve(isMode ? repoArg : modeOrRepo);

    if (!opts.json) {
      const label = mode === "quick" ? "Quick Check" : mode === "deep" ? "Deep Audit" : "Ship Check";
      console.log(chalk.cyan(`\n${label} — ${repo}\n`));
    }

    const spin = opts.json ? null : createSpinner(
      mode === "quick"
        ? "Understanding the project and running fast checks"
        : mode === "deep"
          ? "Understanding the project and running the full audit"
          : "Running the audit, verification stack and release gate",
    );

    try {
      const report = await runCheck(repo, mode);
      spin?.succeed(`${mode === "quick" ? "Quick Check" : mode === "deep" ? "Deep Audit" : "Ship Check"} complete`);

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderCheck(report));
        if (report.evidencePath) {
          console.log(chalk.dim(`\nSealed check evidence written to ${report.evidencePath}\n`));
        }
      }

      if (mode === "ship" && report.gate) process.exitCode = report.gate.exitCode;
    } catch (error) {
      spin?.fail("Check failed");
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, mode, repo, error: (error as Error).message }, null, 2));
      } else {
        console.error(chalk.red(`\nCheck failed: ${(error as Error).message}\n`));
      }
      process.exitCode = 1;
    }
  });

export default check;
