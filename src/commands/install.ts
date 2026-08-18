import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import Table from "cli-table3";
import fs from "node:fs";
import path from "node:path";
import {
  getTargets,
  getSubcommandTargets,
  resolveCommandTemplatePath,
  renderContent,
} from "../installer/targets.js";

const READY_MESSAGE =
  "OpenPitStop is ready. Type /pitstop in Claude Code, Cursor, OpenCode, Kilo Code, Antigravity, Codex CLI or any AI coding tool installed, hit enter, and watch it work.";

const CODEX_APP_MESSAGE =
  "Codex App and Codex VS Code extension don't support custom slash commands yet (OpenAI hasn't shipped this) — use Codex CLI for /pitstop, or copy templates/pitstop.prompt.md's content directly into a Codex App chat as a one-off prompt.";

/**
 * The git pre-commit gate hook, written by `pitstop install --hooks`.
 * POSIX sh on purpose: git runs hooks through its own bundled sh on every
 * platform (including Windows Git for Windows), so no interpreter guessing.
 *
 * Honest by design:
 *  - no HEAD yet (first commit) -> allowed, nothing to diff against
 *  - no baseline scanned yet   -> warned, allowed — never jail an unscanned repo
 *  - gate verdict FAIL/HARD     -> commit blocked, with the full gate box
 *  - PITSTOP_CLI / PITSTOP_SCORE env overrides honored
 */
const PRE_COMMIT_HOOK = `#!/usr/bin/env sh
# OpenPitStop pre-commit gate — installed by \`npx openpitstop install --hooks\`.
# Blocks commits the gate would fail (SUSPICIOUS, CONFIRMED_CHEAT, High risk,
# score below threshold, tampered evidence). Bypass once: git commit --no-verify
set -u

CLI="\${PITSTOP_CLI:-npx --yes openpitstop@latest}"
SCORE="\${PITSTOP_SCORE:-60}"

if ! git rev-parse --verify HEAD > /dev/null 2>&1; then
  echo "[openpitstop] first commit (no HEAD yet) — allowed."
  exit 0
fi

# git runs hooks with the repo root as cwd, so no repo arg is passed — a
# POSIX-style \$PWD would break Windows builds of the CLI.
echo "[openpitstop] gating commit (score >= \${SCORE}/100) ..."
OUT="\$(\$CLI gate --score "\$SCORE" 2>&1)"
CODE=\$?

if printf '%s' "\$OUT" | grep -q 'no baseline'; then
  echo "[openpitstop] no baseline yet — run \`npx openpitstop scan\` once to arm the gate. Commit allowed."
  exit 0
fi

if [ "\$CODE" -ne 0 ]; then
  printf '%s\\n' "\$OUT"
  echo ""
  echo "[openpitstop] GATE FAILED (exit \$CODE) — commit blocked."
  echo "[openpitstop] Bypass once (e.g. a false alarm) with: git commit --no-verify"
fi

exit "\$CODE"
`;

export const install = new Command("install")
  .description("Install the pitstop slash-command (and pitstop-menu / pitstop-scan / … subcommands) into Claude Code, Cursor, OpenCode, Antigravity, Kilo Code, Gemini CLI, Codex (--hooks also adds the git pre-commit gate)")
  .argument("[repo]", "target repo (defaults to cwd)", ".")
  .option("--force", "overwrite existing pitstop files", false)
  .option("-y, --yes", "same as --force (re-runnable one-liner: npx openpitstop@latest install -y)", false)
  .option("--uninstall", "remove pitstop files only", false)
  .option(
    "--hooks",
    "also install (or with --uninstall, remove) the git pre-commit gate hook — every commit is gated before it can land",
    false,
  )
  .action(async (repoArg: string, opts: any) => {
    const cwd = path.resolve(repoArg);
    const mains = getTargets(cwd);
    const subs = getSubcommandTargets(cwd);
    const codexNote = mains.find((t) => t.note)?.note;
    const force = Boolean(opts.force || opts.yes);

    if (opts.uninstall) {
      const table = new Table({
        head: ["Tool", "Path", "Status"],
        style: { head: ["cyan"], border: [] },
      });
      let removed = 0;
      for (const t of [...mains, ...subs]) {
        if (fs.existsSync(t.path)) {
          fs.rmSync(t.path);
          table.push([t.tool, t.path, chalk.red("🗑️  removed")]);
          removed++;
        } else {
          table.push([t.tool, t.path, chalk.dim("— absent")]);
        }
      }
      console.log(table.toString());
      if (opts.hooks) {
        const hook = path.join(cwd, ".git", "hooks", "pre-commit");
        if (fs.existsSync(hook)) {
          fs.rmSync(hook);
          console.log(chalk.red("🗑️  ") + `pre-commit gate hook removed (${hook})`);
        } else {
          console.log(`pre-commit gate hook: ${chalk.dim("— absent")}`);
        }
      }
      console.log(
        chalk.bold(
          `\nOpenPitStop uninstalled (${removed} file(s) removed). Nothing else was touched.`,
        ),
      );
      return;
    }

    // Pre-commit gate hook first (independent of the slash-command files).
    const hookPath = path.join(cwd, ".git", "hooks", "pre-commit");
    if (opts.hooks) {
      if (!fs.existsSync(path.join(cwd, ".git"))) {
        console.log(chalk.yellow("\n⚠ not a git repo — skipping the pre-commit gate hook"));
      } else if (fs.existsSync(hookPath) && !force) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (existing.includes("OpenPitStop pre-commit gate")) {
          console.log(chalk.green("\n✅ Pre-commit gate hook refreshed (already installed)"));
        } else {
          console.log(
            chalk.yellow("\n⚠ existing pre-commit hook kept — to combine, append this line to it:\n") +
              chalk.dim("    npx --yes openpitstop@latest gate || exit $?\n"),
          );
        }
      } else {
        fs.mkdirSync(path.dirname(hookPath), { recursive: true });
        fs.writeFileSync(hookPath, PRE_COMMIT_HOOK);
        try {
          fs.chmodSync(hookPath, 0o755);
        } catch {
          /* Windows: no chmod, git still runs hooks via its bundled sh */
        }
        console.log(chalk.green("\n✅ Pre-commit gate hook installed at " + chalk.cyan(hookPath)));
        console.log(
          chalk.dim(
            "   Every commit is now gated before it can land — SUSPICIOUS → blocked," +
              " CONFIRMED_CHEAT → blocked.\n   Bypass once with: git commit --no-verify",
          ),
        );
      }
    }

    // The slash-command file the user SEES is the short pointer; the full SOP
    // lives behind `pitstop prompt` so the chat only shows `/pitstop <args>`.
    const templateText = fs.readFileSync(resolveCommandTemplatePath(), "utf8");

    const table = new Table({
      head: ["Tool", "Path", "Status"],
      style: { head: ["cyan"], border: [] },
    });
    let installed = 0;
    let skipped = 0;
    let subInstalled = 0;
    let subSkipped = 0;
    // Main commands go in the table; generated subcommands (pitstop-scan,
    // pitstop-menu, …) are written silently and summarized below.
    for (const t of mains) {
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
    for (const t of subs) {
      fs.mkdirSync(path.dirname(t.path), { recursive: true });
      if (fs.existsSync(t.path) && !force) {
        subSkipped++;
        continue;
      }
      fs.writeFileSync(t.path, renderContent(t, t.inlineBody ?? templateText));
      subInstalled++;
    }
    // Codex App / Codex VS Code extension: no custom slash commands exist yet,
    // so there is deliberately NO file written for them — only an honest status.
    table.push([
      "Codex App / VS Code extension",
      "— (none written)",
      chalk.yellow("⚠️ Manual copy needed"),
    ]);

    console.log(table.toString());
    if (subInstalled > 0) {
      console.log(
        chalk.green(
          `✅ Installed ${subInstalled} subcommand(s) — pitstop-menu, pitstop-scan, pitstop-pen, pitstop-fix, pitstop-verify, pitstop-gate, pitstop-report, pitstop-honesty, pitstop-watch, pitstop-memory, pitstop-next, pitstop-ask, pitstop-install`,
        ),
      );
      console.log(
        chalk.dim(
          "   Type /pitstop in your tool to see the clickable dropdown, or run /pitstop menu for an interactive card.",
        ),
      );
    }
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