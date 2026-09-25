import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { matchIntent, INTENT_EXAMPLES } from "../intent.js";

export const askCmd = new Command("ask")
  .description("Tell PitStop what to do in plain English. Local routing, no model credits. Checks run immediately; writes/live attacks need --execute.")
  .argument("<text...>", "what you want, in plain English")
  .option("--repo <path>", "repository to work in", ".")
  .option("--dry-run", "preview the command and its effects without running it")
  .option("--execute", "allow the resolved write, live attack, installation or paid agent action")
  .option("--json", "preview the routing decision as JSON (does not execute)")
  .action(async (textArg: string[], options: { repo: string; dryRun?: boolean; execute?: boolean; json?: boolean }) => {
    const text = textArg.join(" ");
    const resolved = matchIntent(text);
    const repo = path.resolve(options.repo);
    const needsExecution = !!resolved?.requiresExecution && !options.execute;
    if (options.json) {
      console.log(JSON.stringify({ text, repo, ...(resolved ?? { command: null, label: null }),
        needsExecution, executes: false, modelCalls: 0 }, null, 2));
      if (!resolved) process.exitCode = 2;
      return;
    }
    if (!resolved) {
      console.log(chalk.yellow("I couldn't safely resolve that request. Nothing ran. Try one action at a time:"));
      console.log(INTENT_EXAMPLES.slice(0, 6).map((e) => `  pitstop ask "${e.phrase}"`).join("\n"));
      process.exitCode = 2;
      return;
    }
    console.log(boxen(`${chalk.bold(resolved.label)}\n${chalk.cyan(resolved.command)}\n\n${resolved.effect}\nLocal routing · 0 model calls`,
      { title: " PITSTOP — Ask ", borderStyle: "round", padding: 1, borderColor: "cyan" }));
    if (options.dryRun) return;
    if (needsExecution) {
      console.log("Preview only. Add --execute to this request to run the action above.");
      process.exitCode = 2;
      return;
    }
    // Fixed argv from the router; never execute natural language through a shell.
    const extension = path.extname(fileURLToPath(import.meta.url));
    const cli = fileURLToPath(new URL(`../cli${extension}`, import.meta.url));
    const result = await execa(process.execPath, [...process.execArgv, cli, ...resolved.args], {
      cwd: repo, stdio: "inherit", reject: false, windowsHide: true,
    });
    process.exitCode = result.exitCode ?? 1;
  });

export default askCmd;
