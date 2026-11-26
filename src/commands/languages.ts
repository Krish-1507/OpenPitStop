import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { analyzeLanguages } from "../languages/index.js";
import type { LanguageAnalysis } from "../languages/types.js";

export function renderLanguageAnalysis(analysis: LanguageAnalysis): string {
  const lines: string[] = [];
  lines.push(chalk.bold("OpenPitStop language support"));
  lines.push(chalk.dim(path.relative(process.cwd(), analysis.repo) || "."));
  lines.push("");
  lines.push(`Primary: ${chalk.cyan(analysis.support.find((item) => item.id === analysis.primaryLanguage)?.displayName ?? analysis.primaryLanguage)}`);
  lines.push("");

  for (const support of analysis.support) {
    lines.push(
      `${chalk.bold(support.displayName)} · ${support.level} · ${support.files} file(s)`,
    );
    lines.push(`  parser: ${support.parser.status}${support.parser.backend ? ` (${support.parser.backend})` : ""} — ${support.parser.note}`);
    lines.push(`  analysis: ${support.analysis.status} — ${support.analysis.note}`);
    lines.push(`  verification: ${support.verification.status} — ${support.verification.note}`);
    lines.push(`  tests: ${support.tests.length ? support.tests.join(", ") : "none detected"}`);
    lines.push(`  build: ${support.build.length ? support.build.join(", ") : "none detected"}`);
    if (support.frameworks.length) lines.push(`  frameworks: ${support.frameworks.join(", ")}`);
    if (support.dependencies.length) lines.push(`  dependencies: ${support.dependencies.join(", ")}`);
    if (support.entryPoints.length) lines.push(`  entry points: ${support.entryPoints.join(", ")}`);
    lines.push("");
  }

  if (analysis.infrastructure.length) {
    lines.push(chalk.bold("Infrastructure"));
    for (const item of analysis.infrastructure) {
      lines.push(`  ${item.displayName}: ${item.files.length} file(s) — ${item.files.slice(0, 5).join(", ")}${item.files.length > 5 ? ", …" : ""}`);
    }
    lines.push("");
  }

  lines.push(chalk.bold("Tools"));
  for (const tool of analysis.tools) {
    const state = tool.enabled ? chalk.green("enabled") : tool.available ? chalk.yellow("available, not run") : tool.relevant ? chalk.dim("missing") : chalk.dim("not relevant");
    lines.push(`  ${tool.tool}: ${state} — ${tool.reason}`);
  }
  lines.push("");
  if (analysis.limits.skippedFiles > 0) {
    lines.push(chalk.dim(`${analysis.limits.maxFiles} file limit per language; ${analysis.limits.skippedFiles} additional source file(s) were not parsed.`));
  }
  lines.push(chalk.dim("Support levels are cumulative. Detected or parsed is not analyzed, and verified requires a supported reproduction and independent verification."));
  return lines.join("\n");
}

export const languages = new Command("languages")
  .description("show language, parser, analyzer and verification support for this repo")
  .argument("[repo]", "repository path", ".")
  .option("--json", "machine-readable language support")
  .action(async (repoArg: string, opts: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    const analysis = await analyzeLanguages(repo);
    if (opts.json) {
      console.log(JSON.stringify(analysis, null, 2));
      return;
    }
    console.log(renderLanguageAnalysis(analysis));
  });
