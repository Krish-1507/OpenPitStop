import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { buildUnderstanding, sealUnderstanding } from "../understand/index.js";
import { addEntry } from "../memory/store.js";

export const understand = new Command("understand")
  .description(
    "Repo awareness: build the sealed understanding artifact (.pitstop/understanding.json) — " +
      "languages, frameworks, package manager, scripts, verification commands (test/typecheck/" +
      "lint/build), test layers, CI provider, module map, entry points, CODEOWNERS ownership, " +
      "and the architecture config (boundaries/protected/forbidden). Stage 1 of the pipeline; " +
      "planning, boundaries and the verification stack all read this.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    try {
      const u = sealUnderstanding(repo, buildUnderstanding(repo));
      if (opts.json) {
        console.log(JSON.stringify(u, null, 2));
      } else {
        const lines = [
          `${chalk.bold("language:")} ${u.primaryLanguage}${u.languages.length > 1 ? chalk.dim(` (+${u.languages.slice(1).join(", ")})`) : ""}`,
          `${chalk.bold("frameworks:")} ${u.frameworks.length ? u.frameworks.join(", ") : chalk.dim("none detected")}`,
          `${chalk.bold("package manager:")} ${u.packageManager}`,
          `${chalk.bold("verification commands:")}`,
          ...Object.entries(u.verificationCommands).map(([k, v]) => `  ${k.padEnd(11)} ${chalk.cyan(v!)}`),
          `${chalk.bold("test layers:")} ${u.testLayers.map((l) => l.layer).join(", ") || chalk.dim("none discovered")}`,
          `${chalk.bold("ci:")} ${u.ci.provider ?? chalk.dim("none")}${u.ci.workflows.length ? chalk.dim(` (${u.ci.workflows.length} workflow(s))`) : ""}`,
          `${chalk.bold("module map:")} ${u.moduleMap.map((m) => `${m.dir}(${m.role}, ${m.files})`).join(", ") || chalk.dim("empty")}`,
          `${chalk.bold("entry points:")} ${u.entryPoints.join(", ") || chalk.dim("none")}`,
          `${chalk.bold("ownership:")} ${u.ownership.length ? `${u.ownership.length} CODEOWNERS rule(s)` : chalk.dim("no CODEOWNERS")}`,
          `${chalk.bold("architecture config:")} ${u.architectureConfigPath ?? chalk.dim("none — boundaries/protected/forbidden are unconfigured")}`,
        ];
        console.log(
          boxen(lines.join("\n"), { title: " PITSTOP — REPO UNDERSTANDING ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "cyan" }),
        );
        if (u.sealedPath) console.log(chalk.dim(`\nSealed understanding written to ${u.sealedPath}\n`));
      }
      addEntry(repo, { type: "fix", summary: "understand: repo awareness artifact built", context: `${u.primaryLanguage}, ${u.frameworks.length} frameworks, ${u.testLayers.length} test layers` });
    } catch (e: any) {
      console.log(chalk.red(`understand failed: ${e.message}`));
      process.exitCode = 1;
    }
  });

export default understand;
