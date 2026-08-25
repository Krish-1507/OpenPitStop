import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { createPlan, loadLatestPlan, checkPlanScope } from "../verify/plan.js";
import { addEntry } from "../memory/store.js";

export const plan = new Command("plan")
  .description(
    "Plan before patching: create the sealed change plan (goal, steps, expectedPaths the change " +
      "may touch, verification commands). The plan is a CONTRACT — `pitstop architecture-check " +
      "--against-plan` detects scope creep by comparing planned paths against the files the " +
      "agent actually changed.",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption("--goal <text>", "what this change is supposed to achieve")
  .option("--id <id>", "plan identifier (default: derived from goal)", "")
  .option("--step <text>", "an ordered step (repeatable, in order)", collect, [])
  .option("--path <glob>", "path/glob the change may touch (repeatable)", collect, [])
  .option("--verify-command <cmd>", "a command that will verify the change (repeatable)", collect, [])
  .option("--risk <text>", "known risks (repeatable)", collect, [])
  .option("--file <plan.json>", "load the plan from a JSON file instead of flags")
  .option("--show", "show the latest plan and its scope against the current changes")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    if (opts.show) {
      const loaded = loadLatestPlan(repo);
      if (!loaded) {
        console.log(chalk.yellow("no plan exists — create one with `pitstop plan --goal … --path … --verify-command …`"));
        return;
      }
      const { getDiff } = await import("../analyzers/integrity/git.js");
      const changed = getDiff(repo, "HEAD").map((c) => c.path);
      const scope = checkPlanScope(loaded.plan, changed);
      console.log(
        boxen(
          `${chalk.bold("plan:")} ${chalk.cyan(loaded.plan.id)}\n${chalk.bold("goal:")} ${loaded.plan.goal}\n\n` +
            `${chalk.bold("steps:")}\n${(loaded.plan.steps ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n") || chalk.dim("  (none)")}\n\n` +
            `${chalk.bold("expected paths:")}\n${loaded.plan.expectedPaths.map((p) => `  · ${p}`).join("\n")}\n\n` +
            `${chalk.bold("verification:")}\n${loaded.plan.verification.commands.map((c) => `  · ${chalk.cyan(c)}`).join("\n")}\n\n` +
            `${chalk.bold("current changes:")} ${scope.planned.length} in scope, ${scope.unplanned.length ? chalk.red(`${scope.unplanned.length} OUT OF SCOPE`) : chalk.green("0 out of scope")}` +
            (scope.unplanned.length ? `\n${scope.unplanned.map((f) => `  ! ${f}`).join("\n")}` : "") +
            `\n\nevidence: ${loaded.check.status}`,
          { title: " PITSTOP — CHANGE PLAN ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: loaded.check.status === "verified" ? "cyan" : "red" },
        ),
      );
      return;
    }

    let plan = null as any;
    if (opts.file) {
      try {
        plan = JSON.parse(fs.readFileSync(path.resolve(opts.file), "utf8"));
      } catch (e: any) {
        console.log(chalk.red(`plan file unreadable: ${e.message}`));
        process.exitCode = 1;
        return;
      }
    } else {
      if (!opts.path.length) {
        console.log(chalk.red("a plan must declare what it may touch: --path <glob> (repeatable)"));
        process.exitCode = 1;
        return;
      }
      if (!opts.verifyCommand.length) {
        console.log(chalk.red("a plan must declare how it will be verified: --verify-command <cmd> (repeatable)"));
        process.exitCode = 1;
        return;
      }
      plan = {
        id: opts.id || `plan-${Date.now().toString(36)}`,
        goal: opts.goal,
        steps: opts.step,
        expectedPaths: opts.path,
        verification: { commands: opts.verifyCommand },
        risks: opts.risk,
      };
    }

    const created = createPlan(repo, plan);
    if ("error" in created) {
      console.log(chalk.red(`invalid plan: ${created.error}`));
      process.exitCode = 1;
      return;
    }
    console.log(
      boxen(
        `${chalk.bold("plan:")} ${chalk.cyan(plan.id)}\n${chalk.bold("goal:")} ${plan.goal}\n` +
          `${chalk.bold("scope:")} ${plan.expectedPaths.join(", ")}\n` +
          `${chalk.bold("verification:")} ${plan.verification.commands.join(", ")}\n\n` +
          chalk.dim(`${created.file}\n${created.latest} (latest — architecture-check --against-plan reads this)`),
        { title: " PITSTOP — PLAN CREATED ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "cyan" },
      ),
    );
    addEntry(repo, { type: "fix", summary: `plan ${plan.id}: ${plan.goal}`, context: `scope ${plan.expectedPaths.join(", ")}` });
  });

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

import fs from "node:fs";
export default plan;
