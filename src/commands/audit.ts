import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { runAudit } from "../audit/run.js";
import { renderAuditSummary, renderMarkdown } from "../audit/report.js";
import { applyFixPlan, createFixPlan } from "../audit/fixes.js";
import { runAuditEval } from "../audit/eval.js";
import { contentDigestOf } from "../audit/integrity.js";
import { seal } from "../evidence.js";
import { SEVERITY_ORDER, type AuditCategory, type AuditMode, type FindingSeverity } from "../audit/types.js";

/**
 * pitstop audit — deep, evidence-first repository intelligence.
 *
 * Default is read-only and deep. Applying a fix plan requires --yes, an intact
 * sealed plan and an isolated git worktree; the working tree is never edited.
 */

const CATEGORIES: AuditCategory[] = [
  "correctness",
  "maintainability",
  "architecture",
  "performance",
  "readability",
  "type-safety",
  "security",
  "testing",
];

export const audit = new Command("audit")
  .description(
    "Audit the whole repository for engineering quality, architecture, performance, " +
      "type safety, reliability and risk. Read-only by default; fixes are isolated and require --yes.",
  )
  .argument("[repo]", "path to the repository to audit", ".")
  .option("--mode <mode>", "quick (fast pass), deep (default, full index), or full (+ existing analyzers)", "deep")
  .option("--scope <path>", "limit the audit to a directory or file (repeatable)", collect, [] as string[])
  .option("--category <list>", "comma-separated categories to measure: " + CATEGORIES.join(", "))
  .option("--json", "print the complete report as JSON")
  .option("--report <file>", "also write the markdown report to this path")
  .option("--fix-plan", "write a sealed plan of deterministic patches (does not apply them)")
  .option("--apply <plan>", "apply a sealed fix plan in an isolated git worktree (requires the global --yes)")
  .option("--fail-on <severity>", "exit 1 when an active finding is at or above this severity: critical, high, medium, low")
  .option("--no-cache", "ignore and do not write the local index cache")
  .option("--no-persist", "do not write the audit report, cache or baseline under .pitstop")
  .option("--max-files <n>", "override the mode's file budget")
  .option("--eval [suite]", "run the bundled audit evaluation suite (or a suite directory) instead of auditing a repository")
  .action(
    async function (
      this: Command,
      repoArg: string,
      options: {
        mode: string;
        scope: string[];
        category?: string;
        json?: boolean;
        report?: string;
        fixPlan?: boolean;
        apply?: string;
        yes?: boolean;
        failOn?: string;
        cache?: boolean;
        persist?: boolean;
        maxFiles?: string;
        eval?: boolean | string;
      },
    ) {
      const repo = path.resolve(repoArg);
      try {
        if (options.eval !== undefined) {
          const evaluation = await runAuditEval(repo, {
            ...(typeof options.eval === "string" ? { suiteDir: options.eval } : {}),
          });
          if (options.json) {
            console.log(JSON.stringify(evaluation.report, null, 2));
          } else {
            console.log(evaluation.markdown);
          }
          if (!evaluation.report.pass) process.exitCode = 1;
          return;
        }

        if (options.apply) {
          // The root command owns --yes; a duplicate subcommand flag would be
          // shadowed by Commander's global option, so read both scopes.
          if (!this.optsWithGlobals().yes && !options.yes) {
            console.error(chalk.red("Refusing to apply a fix plan without --yes."));
            process.exitCode = 2;
            return;
          }
          // A relative plan path is resolved against the audited repository, so
          // the path printed by --fix-plan works from any working directory.
          const result = await applyFixPlan(repo, options.apply, { confirmed: true });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(chalk.bold("\nAudit fix plan " + result.planId));
            console.log("Status: " + result.status);
            if (result.worktree) console.log("Worktree: " + result.worktree);
            console.log("Applied: " + result.applied.length + " · skipped: " + result.skipped.length);
            if (result.verification.length > 0) {
              for (const step of result.verification) {
                console.log("  " + (step.status === "passed" ? chalk.green("PASS") : chalk.red("FAIL")) + " " + step.command + " (" + step.durationMs + "ms)");
              }
            }
            if (result.beforeScore !== undefined && result.afterScore !== undefined) {
              console.log("Score: " + result.beforeScore + " -> " + result.afterScore);
            }
            if (result.regressions.length > 0) {
              console.log(chalk.yellow("Regressions detected:"));
              for (const regression of result.regressions) console.log("  " + regression.severity + " " + regression.title + " (" + regression.file + ")");
            }
            console.log(result.note);
            console.log(
              chalk.dim(
                result.worktree
                  ? "Your source working tree was not modified and nothing was committed; the isolated worktree is left for review.\n"
                  : "Your source working tree was not modified and nothing was committed; no worktree was left behind.\n",
              ),
            );
          }
          if (result.status === "blocked" || result.status === "failed") process.exitCode = 1;
          return;
        }

        const mode = parseMode(options.mode);
        const categories = parseCategories(options.category);
        const failOn = options.failOn ? parseSeverity(options.failOn) : undefined;
        const result = await runAudit(repo, {
          mode,
          scope: options.scope ?? [],
          ...(categories ? { categories } : {}),
          useCache: options.cache !== false,
          persist: options.persist !== false,
          ...(parseMaxFiles(options.maxFiles) !== undefined ? { maxFiles: parseMaxFiles(options.maxFiles) } : {}),
        });

        let planFile: string | undefined;
        if (options.fixPlan) {
          const planned = createFixPlan(repo, result.report);
          planFile = planned.file;
        }

        if (options.report) {
          const target = path.resolve(options.report);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, renderMarkdown(result.report));
        }

        if (options.json) {
          // The report was sealed before the CLI knew the artifact paths and
          // the fix-plan path. Re-seal the exact object printed so consumers can
          // verify the emitted JSON instead of receiving an unverifiable wrapper.
          const drafted = {
            ...result.report,
            artifacts: result.artifacts,
            ...(planFile ? { fixPlan: path.relative(repo, planFile).replace(/\\/g, "/") } : {}),
            warnings: result.warnings,
          };
          drafted.contentDigest = contentDigestOf(drafted);
          const output = seal(drafted, "pitstop audit report for " + repo);
          console.log(JSON.stringify(output, null, 2));
        } else {
          console.log(renderAuditSummary(result.report));
          if (result.artifacts.json) console.log(chalk.dim("JSON: " + result.artifacts.json));
          if (result.artifacts.markdown) console.log(chalk.dim("Markdown: " + result.artifacts.markdown));
          if (planFile) console.log(chalk.dim("Fix plan: " + path.relative(repo, planFile)));
          if (result.warnings.length > 0) {
            console.log(chalk.dim("\nRun notes:"));
            for (const warning of result.warnings.slice(0, 8)) console.log(chalk.dim("  - " + warning));
          }
          console.log("");
        }

        if (failOn && result.report.findings.some((finding) => finding.lifecycle !== "suppressed" && finding.lifecycle !== "resolved" && SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[failOn])) {
          process.exitCode = 1;
        }
      } catch (error) {
        console.error(chalk.red("Audit failed: " + (error as Error).message));
        process.exitCode = 1;
      }
    },
  );

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseMode(value: string): AuditMode {
  if (value === "quick" || value === "deep" || value === "full") return value;
  throw new Error("Invalid mode '" + value + "'. Use quick, deep or full.");
}

function parseSeverity(value: string): FindingSeverity {
  if (value === "critical" || value === "high" || value === "medium" || value === "low") return value;
  throw new Error("Invalid severity '" + value + "'. Use critical, high, medium or low.");
}

function parseMaxFiles(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("Invalid --max-files '" + value + "'. Use a positive integer.");
  return parsed;
}

function parseCategories(value: string | undefined): AuditCategory[] | undefined {
  if (!value) return undefined;
  const requested = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (requested.length === 0) throw new Error("At least one category is required after --category.");
  const invalid = requested.filter((entry) => !CATEGORIES.includes(entry as AuditCategory));
  if (invalid.length > 0) throw new Error("Unknown category: " + invalid.join(", ") + ". Valid: " + CATEGORIES.join(", "));
  return requested as AuditCategory[];
}
