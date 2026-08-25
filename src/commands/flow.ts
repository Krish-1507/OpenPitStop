import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { runFlow, renderFlowStages } from "../verify/flow.js";
import { renderGateMatrix } from "../verify/gateMatrix.js";

/**
 * `pitstop flow` — the full pipeline in one command:
 *
 *   Understand → Contract? → Plan-scope → Verify stack → Architecture →
 *   Baseline? → Regression? → Holdout? → GATE
 *
 * Stages with no configured input are SKIPPED (and the gate renders their
 * layers as NOT_CONFIGURED) — the flow never invents evidence.
 */
export const flow = new Command("flow")
  .description(
    "Run the full verification pipeline: understand the repo, run the verification stack " +
      "(tests/typecheck/lint/build with failure diagnosis), check architecture/boundaries/plan " +
      "scope, then — when configured — baseline, regression, acceptance contract and holdout — " +
      "and finish with the GATE as the single verdict.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--baseline <ref>", "baseline commit for baseline-verify + regression-check")
  .option("--command <cmd>", "verification command for baseline/regression comparison")
  .option("--contract <spec>", "acceptance contract to verify")
  .option("--suite <spec>", "holdout suite to run (final hidden exam)")
  .option("--plan-scope", "enforce plan scope in the architecture check")
  .option("--skip <stages>", "comma-separated stages to skip (acceptance,architecture,stack,baseline,regression,holdout)")
  .option("--score <n>", "gate score threshold", "60")
  .option("--require <layers>", "layers that must pass for VERIFIED")
  .option("--timeout <ms>", "per-stage timeout")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);
    console.log(chalk.cyan(`\nFlow: understand → contract → plan-scope → verify-stack → architecture → baseline → regression → holdout → gate\n`));

    const { stages, gateExit, verdict, decision } = await runFlow({
      repo,
      baselineRef: opts.baseline,
      command: opts.command,
      contractSpec: opts.contract,
      suiteSpec: opts.suite,
      planScope: opts.planScope,
      skip: (opts.skip ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      threshold: Number(opts.score) || 60,
      require: (opts.require ?? "").split(",").map((s: string) => s.trim()).filter(Boolean),
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    });

    console.log(
      boxen(renderFlowStages(stages), {
        title: " PIPELINE STAGES ",
        titleAlignment: "center",
        borderStyle: "round",
        padding: 1,
        borderColor: "cyan",
      }),
    );

    console.log(
      boxen(renderGateMatrix(decision), {
        title: " OPENPITSTOP GATE ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: gateExit === 0 ? "green" : gateExit >= 2 ? "red" : "yellow",
      }),
    );
    if (decision.reasons.length) {
      for (const r of decision.reasons) console.log(r.startsWith("⚠") ? chalk.yellow(r) : chalk.red(`✗ ${r}`));
      console.log("");
    }

    const vColor = verdict === "VERIFIED" ? chalk.green : verdict === "UNPROVEN" ? chalk.yellow : chalk.red;
    console.log(
      boxen(`${chalk.bold("FINAL VERDICT:")} ${vColor(chalk.bold(verdict))}\n\n${chalk.dim("full chain: pitstop explain")}`, {
        title: " FLOW VERDICT ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: gateExit === 0 ? "green" : gateExit >= 2 ? "red" : "yellow",
      }),
    );

    process.exitCode = gateExit;
  });

export default flow;
