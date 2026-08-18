import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { runVerify, type VerifyOutcome } from "./verify.js";

/**
 * `pitstop gate` — the agentless, CI-usable gate. One command answers "is this
 * change safe to commit?" with a plain exit code:
 *
 *   exit 0  PASS — score >= threshold, integrity clean, evidence chain intact
 *   exit 1  FAIL — score below threshold, High regression risk, SUSPICIOUS
 *                  integrity, or tampered evidence
 *   exit 2  FAIL-HARD — CONFIRMED_CHEAT integrity violation
 *
 * No AI tool, no `/pitstop` loop, no config: scan (or try) once for the
 * baseline, then `pitstop gate` every step of a fix loop — also usable as a
 * pre-commit hook or the last line of a CI job.
 */
export function gateOutcome(o: VerifyOutcome, threshold: number): {
  pass: boolean;
  exitCode: number;
  reasons: string[];
} {
  if (o.missingBaseline) {
    return {
      pass: false,
      exitCode: 1,
      reasons: ["no baseline — run `pitstop scan` (or `pitstop try`) once to create one"],
    };
  }

  const reasons: string[] = [];
  let exitCode = 0;

  if (o.blocked) {
    if (o.integrity.verdict === "CONFIRMED_CHEAT") {
      reasons.push(`integrity gate CONFIRMED_CHEAT (${o.integrity.summary.confirmed} confirmed findings)`);
      exitCode = 2;
    } else {
      reasons.push(`integrity gate ${o.integrity.verdict} — needs human review before committing`);
      exitCode = 1;
    }
  }

  if (o.evidence?.status === "tampered") {
    reasons.push("evidence chain broken — baseline was edited after OpenPitStop signed it; re-run `pitstop scan`");
    exitCode = Math.max(exitCode, 1);
  }

  if (o.risk === "High") {
    reasons.push("regression risk High — suite or perf regressed vs baseline");
    exitCode = Math.max(exitCode, 1);
  }

  if (o.currentScore.score < threshold) {
    reasons.push(
      `OpenPitStop Score ${o.currentScore.score}/100 is below the ${threshold}/100 gate`,
    );
    exitCode = Math.max(exitCode, 1);
  }

  if (o.stale) {
    reasons.push(`⚠ ${o.staleNote}`);
  }

  return { pass: exitCode === 0, exitCode, reasons };
}

export function renderGateBox(o: VerifyOutcome, gate: ReturnType<typeof gateOutcome>, threshold: number): string {
  const score = o.currentScore;
  const scorePaint = score.score >= threshold ? chalk.greenBright : chalk.red;

  const lines: string[] = [];
  lines.push(
    `${chalk.bold("OpenPitStop Score")}: ${scorePaint.bold(`${score.score}/100 (${score.grade})`)} — gate at ${threshold}/100`,
  );
  lines.push(
    `${chalk.bold("Integrity")}: ${
      o.blocked
        ? chalk.red(o.integrity.verdict)
        : chalk.green(o.integrity.verdict)
    } · ${o.integrity.summary.total} finding(s)`,
  );
  lines.push(
    `${chalk.bold("Evidence")}: ${
      o.evidence?.status === "verified"
        ? chalk.green(`verified ${o.evidence.digest.slice(0, 12)}…`)
        : o.evidence?.status === "tampered"
          ? chalk.red("TAMPERED")
          : chalk.yellow("untracked (pre-0.6.0 baseline)")
    }`,
  );
  lines.push(`${chalk.bold("Risk")}: ${o.risk === "High" ? chalk.red("HIGH") : o.risk === "Medium" ? chalk.yellow("MEDIUM") : chalk.green("LOW")}`);

  if (gate.reasons.length > 0) {
    lines.push("");
    for (const r of gate.reasons) lines.push(r.startsWith("⚠") ? chalk.yellow(r) : chalk.red(`✗ ${r}`));
  }
  if (gate.pass) {
    lines.push("");
    lines.push(chalk.green("PASS — safe to commit."));
  } else {
    lines.push("");
    lines.push(chalk.red("FAIL — do not commit this state."));
  }

  return boxen(lines.join("\n"), {
    title: ` PITSTOP — GATE ${gate.pass ? "PASS" : "FAIL"} `,
    titleAlignment: "center",
    borderStyle: gate.pass ? "round" : "double",
    padding: 1,
    borderColor: gate.pass ? "green" : exitCodeColor(gate.exitCode),
  });
}

function exitCodeColor(code: number): "red" | "yellow" {
  return code >= 2 ? "red" : "yellow";
}

export const gate = new Command("gate")
  .description(
    "Agentless commit gate: verifies score vs threshold, regression risk, integrity diff and " +
      "the baseline evidence signature — exit 0=PASS, 1=FAIL, 2=CONFIRMED_CHEAT. CI and " +
      "pre-commit ready; no AI tool required.",
  )
  .argument("[repo]", "path to the repo to gate (default: current dir)", ".")
  .option(
    "--score <n>",
    "minimum OpenPitStop Score required to pass (default 60; 0 disables the score check)",
    "60",
  )
  .option("--json", "print a machine-readable gate result")
  .action(async (repoArg: string, options: { score?: string; json?: boolean }) => {
    const repo = path.resolve(repoArg);
    const threshold = Math.max(0, Math.min(100, Math.floor(Number(options.score) || 60)));

    if (!options.json) {
      console.log(chalk.cyan(`\nGating ${repo} (score >= ${threshold}/100) ...\n`));
    }

    const outcome = await runVerify(repo);
    const gateResult = gateOutcome(outcome, threshold);

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            repo,
            pass: gateResult.pass,
            exitCode: gateResult.exitCode,
            reasons: gateResult.reasons,
            threshold,
            score: outcome.missingBaseline ? null : outcome.currentScore.score,
            grade: outcome.missingBaseline ? null : outcome.currentScore.grade,
            risk: outcome.missingBaseline ? null : outcome.risk,
            integrity: outcome.missingBaseline ? null : outcome.integrity.verdict,
            evidence: outcome.evidence?.status ?? "missing",
            stale: outcome.stale,
            baselineTimestamp: outcome.baselineTimestamp ?? null,
          },
          null,
          2,
        ),
      );
    } else if (outcome.missingBaseline) {
      console.log(
        chalk.red(`no baseline found — run \`pitstop scan\` (or \`pitstop try\`) once to create one`),
      );
    } else {
      console.log(renderGateBox(outcome, gateResult, threshold));
      if (outcome.file) {
        console.log(chalk.dim(`\nVerify report written to ${outcome.file}\n`));
      }
    }

    process.exitCode = gateResult.exitCode;
  });