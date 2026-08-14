import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import Table from "cli-table3";
import fs from "node:fs";
import path from "node:path";
import {
  getTargets,
  resolveTemplatePath,
  renderContent,
} from "../installer/targets.js";

const READY_MESSAGE =
  "OpenPitStop is ready. Type /pitstop in Claude Code, Cursor, OpenCode, Kilo Code, Antigravity, Codex CLI or any AI coding tool installed, hit enter, and watch it work.";

const CODEX_APP_MESSAGE =
  "Codex App and Codex VS Code extension don't support custom slash commands yet (OpenAI hasn't shipped this) — use Codex CLI for /pitstop, or copy templates/pitstop.prompt.md's content directly into a Codex App chat as a one-off prompt.";

export const install = new Command("install")
  .description("Install the pitstop slash-command into Claude Code, Cursor, OpenCode, Antigravity, Kilo Code, Gemini CLI, Codex")
  .argument("[repo]", "target repo (defaults to cwd)", ".")
  .option("--force", "overwrite existing pitstop files", false)
  .option("-y, --yes", "same as --force (re-runnable one-liner: npx openpitstop@latest install -y)", false)
  .option("--uninstall", "remove pitstop files only", false)
  .action(async (repoArg: string, opts: any) => {
    const cwd = path.resolve(repoArg);
    const targets = getTargets(cwd);
    const codexNote = targets.find((t) => t.note)?.note;
    const force = Boolean(opts.force || opts.yes);

    if (opts.uninstall) {
      const table = new Table({
        head: ["Tool", "Path", "Status"],
        style: { head: ["cyan"], border: [] },
      });
      let removed = 0;
      for (const t of targets) {
        if (fs.existsSync(t.path)) {
          fs.rmSync(t.path);
          table.push([t.tool, t.path, chalk.red("🗑️  removed")]);
          removed++;
        } else {
          table.push([t.tool, t.path, chalk.dim("— absent")]);
        }
      }
      console.log(table.toString());
      console.log(
        chalk.bold(
          `\nOpenPitStop uninstalled (${removed} file(s) removed). Nothing else was touched.`,
        ),
      );
      return;
    }

    const templateText = fs.readFileSync(resolveTemplatePath(), "utf8");

    const table = new Table({
      head: ["Tool", "Path", "Status"],
      style: { head: ["cyan"], border: [] },
    });
    let installed = 0;
    let skipped = 0;
    for (const t of targets) {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      const exists = fs.existsSync(t.path);
      if (exists && !force) {
        table.push([t.tool, t.path, chalk.yellow("⚠️ skipped — use --force")]);
        skipped++;
        continue;
      }
      fs.writeFileSync(t.path, renderContent(t, templateText));
      table.push([t.tool, t.path, chalk.green("✅ Installed")]);
      installed++;
    }
    // Codex App / Codex VS Code extension: no custom slash commands exist yet,
    // so there is deliberately NO file written for them — only an honest status.
    table.push([
      "Codex App / VS Code extension",
      "— (none written)",
      chalk.yellow("⚠️ Manual copy needed"),
    ]);

    console.log(table.toString());
    console.log(chalk.yellow(CODEX_APP_MESSAGE));
    if (codexNote) {
      console.log(chalk.dim(`Note: ${codexNote}.`));
    }
    console.log(
      boxen(chalk.bold(READY_MESSAGE), {
        padding: 1,
        borderStyle: "double",
        borderColor: "cyan",
      }),
    );
    if (skipped > 0) {
      console.log(
        chalk.dim(
          `\n(${skipped} existing file(s) kept — run with --force to overwrite them.)`,
        ),
      );
    }
  });