import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { computeImpact, type ChangeImpact } from "../architecture/impact.js";
import { getDiff } from "../analyzers/integrity/git.js";
import { addEntry } from "../memory/store.js";

const STATUS_MARK: Record<string, string> = {
  added: chalk.green("+"),
  deleted: chalk.red("-"),
  renamed: chalk.cyan("→"),
  modified: chalk.yellow("~"),
};

export function renderImpact(impact: ChangeImpact): string {
  const lines: string[] = [];
  lines.push(chalk.bold("OpenPitStop change impact"));
  lines.push(chalk.dim(path.relative(process.cwd(), impact.repo) || "."));
  lines.push("");

  lines.push(`${chalk.bold("Changed")} (${impact.changed.length})`);
  for (const change of impact.changed) {
    const owners = change.owners.length ? chalk.dim(`  @${change.owners.join(", ")}`) : "";
    lines.push(`  ${STATUS_MARK[change.status] ?? "~"} ${change.file}${owners}`);
  }
  lines.push("");

  const direct = impact.dependents.filter((entry) => entry.distance === 1);
  const transitive = impact.dependents.filter((entry) => entry.distance > 1);
  lines.push(`${chalk.bold("Dependents")} (${impact.dependents.length}${direct.length ? ` · ${direct.length} direct` : ""})`);
  if (impact.dependents.length === 0) {
    lines.push(chalk.dim(impact.engine ? "  none — no file imports the changed files" : "  not discovered — no import graph is available for this repository"));
  }
  for (const dependent of direct.slice(0, 25)) lines.push(`  ← ${dependent.file}`);
  if (direct.length > 25) lines.push(chalk.dim(`  … ${direct.length - 25} more direct dependent(s)`));
  if (transitive.length) {
    lines.push(chalk.dim(`  ${transitive.length} transitive dependent(s), closest first:`));
    for (const dependent of transitive.slice(0, 15)) {
      lines.push(`  ${chalk.dim("←")} ${dependent.file} ${chalk.dim(`(${dependent.distance} hop(s) via ${dependent.via})`)}`);
    }
    if (transitive.length > 15) lines.push(chalk.dim(`  … ${transitive.length - 15} more`));
  }
  if (impact.depthLimited) lines.push(chalk.dim(`  depth limited to ${impact.depth} hop(s) — pass --depth to follow further`));
  if (impact.truncated) lines.push(chalk.yellow("  dependent list truncated at the safety cap"));
  lines.push("");

  lines.push(chalk.bold("Affected modules"));
  lines.push(
    impact.affectedModules.length
      ? impact.affectedModules.slice(0, 12).map((module) => `  ${module.module} ${chalk.dim(`(${module.files} file(s))`)}`).join("\n")
      : chalk.dim("  none"),
  );
  lines.push("");

  lines.push(`${chalk.bold("Routes at risk")} (${impact.routes.length})`);
  if (impact.routes.length === 0) lines.push(chalk.dim("  none of the affected files defines an HTTP route"));
  for (const route of impact.routes.slice(0, 20)) {
    const sensitive = route.sensitive ? chalk.yellow(" sensitive") : "";
    lines.push(`  ${route.method.padEnd(6)} ${route.path}${sensitive} — ${route.file}:${route.line}`);
  }
  if (impact.routes.length > 20) lines.push(chalk.dim(`  … ${impact.routes.length - 20} more`));
  lines.push("");

  lines.push(`${chalk.bold("Tests to run")} (${impact.tests.length})`);
  if (impact.tests.length === 0) lines.push(chalk.dim("  no test file imports an affected file or pairs with a changed file name"));
  for (const test of impact.tests.slice(0, 20)) {
    lines.push(`  ${test.file} ${chalk.dim(`(${test.reason === "imports-affected-file" ? "imports an affected file" : "name matches a changed file"})`)}`);
  }
  if (impact.tests.length > 20) lines.push(chalk.dim(`  … ${impact.tests.length - 20} more`));
  lines.push("");

  lines.push(`${chalk.bold("Architecture constraints")} (${impact.constraints.length})`);
  if (impact.constraints.length === 0) lines.push(chalk.dim("  no declared boundary, protected or forbidden path applies to the changed files"));
  for (const constraint of impact.constraints) {
    const paint = constraint.kind === "forbidden" ? chalk.red : constraint.kind === "protected" ? chalk.yellow : chalk.dim;
    lines.push(`  ${paint(constraint.kind.padEnd(9))} ${constraint.file} ${chalk.dim(`— ${constraint.rule}`)}${constraint.reason ? chalk.dim(` (${constraint.reason})`) : ""}`);
  }
  lines.push("");

  lines.push(chalk.bold("Recommended checks (in order)"));
  impact.recommended.forEach((recommendation, index) => {
    lines.push(`  ${index + 1}. ${chalk.cyan(recommendation.command)}`);
    lines.push(`     ${chalk.dim(recommendation.why)}`);
  });
  lines.push("");
  lines.push(chalk.dim("Limits:"));
  for (const limit of impact.limits) lines.push(chalk.dim(`  - ${limit}`));
  return lines.join("\n");
}

export const impact = new Command("impact")
  .description(
    "Change impact: what else a change touches — importers, modules, routes, tests and declared " +
      "boundaries — plus the checks to run before trusting a green suite. Analysis only: it orders " +
      "the review, it does not prove reachability.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--base <ref>", "compare this ref against the working tree", "HEAD")
  .option("--to <ref>", "compare two refs instead of the working tree")
  .option("--changed <path>", "analyze this file directly instead of a git diff (repeatable)", collect, [])
  .option("--depth <n>", "how many import hops to follow", "8")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    let changed: { file: string; status: string }[];
    if (opts.changed.length) {
      changed = opts.changed.map((file: string) => ({ file, status: "declared" }));
    } else {
      try {
        changed = getDiff(repo, opts.base, opts.to).map((change) => ({ file: change.path, status: change.status }));
      } catch (error: any) {
        console.log(chalk.red(`could not read git changes: ${error?.message ?? String(error)}`));
        process.exitCode = 1;
        return;
      }
    }

    if (changed.length === 0) {
      const range = opts.changed.length ? "" : ` vs ${opts.base}${opts.to ? `..${opts.to}` : ""}`;
      console.log(chalk.yellow(`no changed files${range} — nothing to analyze`));
      console.log(chalk.dim("pass --changed <path> to analyze a file directly"));
      return;
    }

    const parsedDepth = Number.parseInt(String(opts.depth), 10);
    const result = computeImpact(repo, changed, {
      depth: Number.isFinite(parsedDepth) && parsedDepth > 0 ? parsedDepth : undefined,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(renderImpact(result));

    const breadth = result.summary.dependents === 0 ? "contained" : result.summary.dependents <= 5 ? "local" : "wide";
    const color = result.constraints.some((constraint) => constraint.kind !== "boundary") ? "yellow" : breadth === "wide" ? "cyan" : "green";
    console.log(
      "\n" +
        boxen(
          `${chalk.bold(breadth)} — ${result.changed.length} changed file(s), ${result.summary.dependents} dependent(s), ${result.summary.modules} module(s)\n` +
            `${result.summary.routes} route(s) · ${result.summary.tests} test file(s) · ${result.summary.constraints} constraint(s)\n\n` +
            chalk.dim("a green suite on the changed files is not evidence about their dependents — run the recommended checks in order"),
          { title: " IMPACT ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: color as any },
        ),
    );

    addEntry(repo, {
      type: "fix",
      summary: `impact: ${result.changed.length} changed file(s), ${result.summary.dependents} dependent(s)`,
      context: result.recommended.map((recommendation) => recommendation.command).join("; ").slice(0, 200),
    });
  });

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export default impact;
