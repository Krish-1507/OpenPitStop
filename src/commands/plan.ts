import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import fs from "node:fs";
import path from "node:path";
import { createPlan, loadLatestPlan, checkPlanScope, type PlanImpact } from "../verify/plan.js";
import { addEntry } from "../memory/store.js";
import { computeImpact, type ChangeImpact } from "../architecture/impact.js";
import { buildUnderstanding } from "../understand/index.js";
import { walkFiles } from "../analyzers/util.js";
import { LANGUAGE_ADAPTERS } from "../languages/adapters.js";

export const plan = new Command("plan")
  .description(
    "Plan before patching: create the sealed change plan (goal, steps, expectedPaths the change " +
      "may touch, verification commands). The plan is a CONTRACT — `pitstop architecture-check " +
      "--against-plan` detects scope creep by comparing planned paths against the files the " +
      "agent actually changed. With no --verify-command the repository's own verification is used, " +
      "and the plan records what the declared scope already touches (importers, tests, routes, " +
      "boundaries) before a single line changes.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--goal <text>", "what this change is supposed to achieve (required unless --show or --file)")
  .option("--id <id>", "plan identifier (default: derived from goal)", "")
  .option("--step <text>", "an ordered step (repeatable, in order)", collect, [])
  .option("--path <glob>", "path/glob the change may touch (repeatable)", collect, [])
  .option("--verify-command <cmd>", "a command that will verify the change (repeatable; derived from the repo when omitted)", collect, [])
  .option("--risk <text>", "known risks (repeatable)", collect, [])
  .option("--file <plan.json>", "load the plan from a JSON file instead of flags")
  .option("--show", "show the latest plan and its scope against the current changes")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    if (opts.show) {
      const loaded = loadLatestPlan(repo);
      if (!loaded) {
        console.log(chalk.yellow("no plan exists — create one with `pitstop plan --goal … --path …`"));
        return;
      }
      const { getDiff } = await import("../analyzers/integrity/git.js");
      const changed = getDiff(repo, "HEAD").map((c) => c.path);
      const scope = checkPlanScope(loaded.plan, changed);
      const recorded = loaded.plan.impact;
      const constraintNote =
        recorded && recorded.constraints.length ? chalk.yellow(" · " + recorded.constraints.length + " constraint(s)") : "";
      const thenRun =
        recorded && recorded.recommended.length ? "\n" + chalk.bold("then run:") + " " + recorded.recommended.join(", ") : "";
      const impactLine = recorded
        ? chalk.bold("impact at planning:") +
          " " +
          recorded.dependents +
          " dependent(s) · " +
          recorded.modules.length +
          " module(s) · " +
          recorded.tests.length +
          " test file(s)" +
          constraintNote +
          thenRun
        : chalk.bold("impact at planning:") + " " + chalk.dim("not recorded — this plan predates impact-aware planning");
      console.log(
        boxen(
          `${chalk.bold("plan:")} ${chalk.cyan(loaded.plan.id)}\n${chalk.bold("goal:")} ${loaded.plan.goal}\n\n` +
            `${chalk.bold("steps:")}\n${(loaded.plan.steps ?? []).map((s, i) => `  ${i + 1}. ${s}`).join("\n") || chalk.dim("  (none)")}\n\n` +
            `${chalk.bold("expected paths:")}\n${loaded.plan.expectedPaths.map((p) => `  · ${p}`).join("\n")}\n\n` +
            `${chalk.bold("verification:")}\n${loaded.plan.verification.commands.map((c) => `  · ${chalk.cyan(c)}`).join("\n")}\n\n` +
            `${impactLine}\n\n` +
            `${chalk.bold("current changes:")} ${scope.planned.length} in scope, ${scope.unplanned.length ? chalk.red(`${scope.unplanned.length} OUT OF SCOPE`) : chalk.green("0 out of scope")}` +
            (scope.unplanned.length ? `\n${scope.unplanned.map((f) => `  ! ${f}`).join("\n")}` : "") +
            `\n\nevidence: ${loaded.check.status}`,
          { title: " PITSTOP — CHANGE PLAN ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: loaded.check.status === "verified" ? "cyan" : "red" },
        ),
      );
      return;
    }

    let plan = null as any;
    let impact: ChangeImpact | null = null;
    let skippedPaths: string[] = [];
    if (opts.file) {
      try {
        plan = JSON.parse(fs.readFileSync(path.resolve(opts.file), "utf8"));
      } catch (e: any) {
        console.log(chalk.red(`plan file unreadable: ${e.message}`));
        process.exitCode = 1;
        return;
      }
    } else {
      if (!opts.goal) {
        console.log(chalk.red("a plan needs a goal: --goal <text>"));
        process.exitCode = 1;
        return;
      }
      if (!opts.path.length) {
        console.log(chalk.red("a plan must declare what it may touch: --path <glob> (repeatable)"));
        process.exitCode = 1;
        return;
      }
      const verificationCommands: string[] = opts.verifyCommand.length ? opts.verifyCommand : deriveVerificationCommands(repo);
      if (verificationCommands.length === 0) {
        console.log(chalk.red("a plan must declare how it will be verified: --verify-command <cmd> (repeatable) — none could be derived from this repository"));
        process.exitCode = 1;
        return;
      }
      const expanded = expandPlanPaths(repo, opts.path);
      skippedPaths = expanded.skipped;
      impact = expanded.files.length ? computeImpact(repo, expanded.files.map((file) => ({ file }))) : null;
      plan = {
        id: opts.id || slugify(opts.goal) || "plan",
        goal: opts.goal,
        steps: opts.step,
        expectedPaths: opts.path,
        verification: { commands: verificationCommands },
        risks: opts.risk,
        ...(impact ? { impact: toPlanImpact(impact, expanded.files) } : {}),
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
    if (impact) console.log("\n" + renderPlanImpact(impact));
    if (skippedPaths.length) {
      console.log(
        chalk.dim(
          "impact preview skipped (glob or a path that does not exist yet): " + skippedPaths.join(", "),
        ),
      );
    }
    addEntry(repo, { type: "fix", summary: `plan ${plan.id}: ${plan.goal}`, context: `scope ${plan.expectedPaths.join(", ")}` });
  });

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

/** Readable plan id: "Add session rotation" -> "add-session-rotation". */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** The repository's own verification commands, in the order a change should face them. */
function deriveVerificationCommands(repo: string): string[] {
  const commands = buildUnderstanding(repo).verificationCommands;
  return [...new Set([commands.test, commands.typecheck, commands.lint, commands.build].filter((value): value is string => Boolean(value)))];
}

/**
 * A plan scope is written as paths or globs; impact analysis needs concrete
 * files, so directories and existing files are expanded. Globs and files that
 * do not exist yet (the change may create them) stay out of the preview.
 */
function expandPlanPaths(repo: string, declared: string[]): { files: string[]; skipped: string[] } {
  const extensions = [...new Set(LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.extensions))];
  const existing = walkFiles(repo, extensions).map((file) => path.relative(repo, file).replace(/\\/g, "/"));
  const existingSet = new Set(existing);
  const files = new Set<string>();
  const skipped: string[] = [];
  for (const entry of declared) {
    const normalized = entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (!normalized) continue;
    if (/[*?[\]{}]/.test(normalized)) {
      skipped.push(normalized);
      continue;
    }
    if (existingSet.has(normalized)) {
      files.add(normalized);
      continue;
    }
    const prefix = normalized + "/";
    const under = existing.filter((file) => file.startsWith(prefix));
    if (under.length) for (const file of under) files.add(file);
    else skipped.push(normalized);
  }
  return { files: [...files].sort(), skipped };
}

function toPlanImpact(impact: ChangeImpact, files: string[]): PlanImpact {
  return {
    files,
    dependents: impact.summary.dependents,
    directDependents: impact.directDependents.length,
    modules: impact.affectedModules.map((module) => module.module).slice(0, 20),
    routes: impact.routes.map((route) => route.method + " " + route.path).slice(0, 20),
    tests: impact.tests.map((test) => test.file),
    // the same rule can match several changed files — the summary keeps the rule once
    constraints: [...new Set(impact.constraints.map((constraint) => constraint.kind + ": " + constraint.rule))],
    recommended: impact.recommended.map((recommendation) => recommendation.command),
  };
}

function renderPlanImpact(impact: ChangeImpact): string {
  const lines: string[] = [];
  lines.push(chalk.bold("if you change the planned scope, this is what it touches:"));
  lines.push(
    "  " + impact.changed.length + " existing file(s) · " + impact.summary.dependents + " dependent(s) (" +
      impact.directDependents.length + " direct) · " + impact.summary.modules + " module(s)",
  );
  if (impact.routes.length) {
    const routes = impact.routes.slice(0, 6).map((route) => route.method + " " + route.path).join(", ");
    lines.push("  routes: " + routes + (impact.routes.length > 6 ? ", …" : ""));
  }
  if (impact.tests.length) {
    const tests = impact.tests.slice(0, 6).map((test) => test.file).join(", ");
    lines.push("  tests: " + tests + (impact.tests.length > 6 ? ", …" : ""));
  }
  if (impact.constraints.length) {
    lines.push("  constraints: " + impact.constraints.map((constraint) => constraint.kind + " " + constraint.rule).join(", "));
  }
  lines.push("  then: " + impact.recommended.map((recommendation) => recommendation.command).join(", "));
  const color = impact.constraints.some((constraint) => constraint.kind !== "boundary") ? "yellow" : "cyan";
  return boxen(lines.join("\n"), {
    title: " PITSTOP — PLAN IMPACT ",
    titleAlignment: "center",
    borderStyle: "round",
    padding: 1,
    borderColor: color as any,
  });
}

export default plan;

