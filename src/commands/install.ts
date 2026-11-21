import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import Table from "cli-table3";
import fs from "node:fs";
import path from "node:path";
import {
  getTargets,
  getSubcommandTargetsFor,
  targetsForAgents,
  isAgentId,
  AGENT_DEFINITIONS,
  type AgentId,
  type InstallTarget,
} from "../installer/targets.js";
import {
  applyInstallPlan,
  buildInstallPlan,
  purgeManifestPaths,
  removeManagedTargets,
  rollbackLastInstall,
} from "../installer/transaction.js";

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

const PRE_COMMIT_MARKER = "OpenPitStop pre-commit gate";

function parseAgents(value: string | undefined): AgentId[] | undefined {
  if (!value) return undefined;
  const requested = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalid = requested.filter((entry) => !isAgentId(entry));
  if (invalid.length > 0) {
    throw new Error(
      `unknown agent(s): ${invalid.join(", ")} — choose from ${AGENT_DEFINITIONS.map((agent) => agent.id).join(", ")}`,
    );
  }
  return [...new Set(requested as AgentId[])];
}

function codexNote(targets: InstallTarget[]): string {
  return targets.find((target) => target.note)?.note ?? "";
}

function printHookUninstallResult(cwd: string): void {
  const hook = path.join(cwd, ".git", "hooks", "pre-commit");
  if (!fs.existsSync(hook)) {
    console.log(`pre-commit gate hook: ${chalk.dim("— absent")}`);
    return;
  }
  const content = fs.readFileSync(hook, "utf8");
  if (!content.includes(PRE_COMMIT_MARKER)) {
    console.log(chalk.yellow(`pre-commit hook kept — it was not installed by OpenPitStop (${hook})`));
    return;
  }
  fs.rmSync(hook);
  console.log(chalk.red("🗑️  ") + `pre-commit gate hook removed (${hook})`);
}

export const install = new Command("install")
  .description(
    "Install the pitstop slash-command (and pitstop-menu / pitstop-scan / … subcommands) into Claude Code, " +
      "Cursor, OpenCode, Antigravity, Kilo Code, Gemini CLI, Codex (--hooks also adds the git pre-commit gate)",
  )
  .argument("[repo]", "target repo (defaults to cwd)", ".")
  .option("--force", "overwrite existing pitstop files", false)
  .option("-y, --yes", "same as --force (re-runnable one-liner: npx openpitstop@latest install -y)", false)
  .option("--uninstall", "remove OpenPitStop-managed files only (--force removes every target path)", false)
  .option("--hooks", "also install (or with --uninstall, remove) the git pre-commit gate hook", false)
  .option("--agents <ids>", "comma-separated agent ids to configure instead of every supported tool")
  .option("--dry-run", "show exactly which files would be written; write nothing", false)
  .option("--no-subcommands", "install only the main /pitstop command, not pitstop-* subcommands")
  .option("--rollback", "undo the most recent install transaction", false)
  .option("--json", "machine-readable result", false)
  .action(async (repoArg: string, opts: {
    force?: boolean; yes?: boolean; uninstall?: boolean; hooks?: boolean; agents?: string;
    dryRun?: boolean; subcommands?: boolean; rollback?: boolean; json?: boolean;
  }) => {
    const cwd = path.resolve(repoArg);
    const force = Boolean(opts.force || opts.yes);
    const json = Boolean(opts.json);

    try {
      const selected = parseAgents(opts.agents);
      const mains = selected ? targetsForAgents(cwd, selected) : getTargets(cwd);
      const subs = opts.subcommands === false ? [] : getSubcommandTargetsFor(mains);
      const codexAppNote = codexNote(mains);
      const hookPath = path.join(cwd, ".git", "hooks", "pre-commit");

      if (opts.rollback) {
        const result = rollbackLastInstall(cwd, { force });
        if (json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (!result.transactionId) {
            console.log(chalk.dim("No install transaction to roll back."));
          } else {
            if (result.removed.length > 0) {
              console.log(chalk.red(`🗑️  removed ${result.removed.length} file(s) created by ${result.transactionId}`));
              for (const file of result.removed) console.log(`   ${file}`);
            }
            if (result.restored.length > 0) {
              console.log(chalk.green(`↩️  restored ${result.restored.length} previous file(s)`));
              for (const file of result.restored) console.log(`   ${file}`);
            }
            for (const conflict of result.conflicts) {
              console.log(chalk.yellow(`⚠️  kept ${conflict.path} — ${conflict.reason}`));
            }
            if (result.conflicts.length === 0) console.log(chalk.dim("Rollback complete. Nothing else was touched."));
          }
        }
        process.exitCode = result.conflicts.length > 0 ? 1 : 0;
        return;
      }

      if (opts.uninstall) {
        const removal = removeManagedTargets([...mains, ...subs], { force });
        purgeManifestPaths(cwd, removal.removed);
        if (json) {
          console.log(JSON.stringify(removal, null, 2));
        } else {
          const table = new Table({
            head: ["Path", "Status"],
            style: { head: ["cyan"], border: [] },
          });
          for (const file of removal.removed) table.push([file, chalk.red("🗑️  removed")]);
          for (const kept of removal.kept) table.push([kept.path, chalk.yellow(`kept — ${kept.reason}`)]);
          if (removal.removed.length === 0 && removal.kept.length === 0) {
            console.log(chalk.dim("No OpenPitStop-managed files found."));
          } else {
            console.log(table.toString());
          }
          if (opts.hooks) printHookUninstallResult(cwd);
          console.log(
            chalk.bold(
              `\nOpenPitStop uninstalled (${removal.removed.length} managed file(s) removed, ${removal.kept.length} kept). Nothing else was touched.`,
            ),
          );
        }
        return;
      }

      if (opts.hooks && !opts.dryRun) {
        if (!fs.existsSync(path.join(cwd, ".git"))) {
          if (!json) console.log(chalk.yellow("\n⚠ not a git repo — skipping the pre-commit gate hook"));
        } else if (fs.existsSync(hookPath) && !force) {
          const existing = fs.readFileSync(hookPath, "utf8");
          if (existing.includes(PRE_COMMIT_MARKER)) {
            if (!json) console.log(chalk.green("\n✅ Pre-commit gate hook already installed"));
          } else {
            if (!json) {
              console.log(
                chalk.yellow("\n⚠ existing pre-commit hook kept — to combine, append this line to it:\n") +
                  chalk.dim("    npx --yes openpitstop@latest gate || exit $?\n"),
              );
            }
          }
        } else {
          fs.mkdirSync(path.dirname(hookPath), { recursive: true });
          fs.writeFileSync(hookPath, PRE_COMMIT_HOOK);
          try {
            fs.chmodSync(hookPath, 0o755);
          } catch {
            /* Windows: no chmod, git still runs hooks via its bundled sh */
          }
          if (!json) {
            console.log(chalk.green("\n✅ Pre-commit gate hook installed at " + chalk.cyan(hookPath)));
            console.log(
              chalk.dim(
                "   Every commit is now gated before it can land — SUSPICIOUS → blocked," +
                  " CONFIRMED_CHEAT → blocked.\n   Bypass once with: git commit --no-verify",
              ),
            );
          }
        }
      }

      const plan = buildInstallPlan([...mains, ...subs], { overwrite: force ? "all" : "never" });
      const mainPaths = new Set(mains.map((target) => path.resolve(target.path)));
      const mainEntries = plan.entries.filter((entry) => mainPaths.has(entry.path));
      const subEntries = plan.entries.filter((entry) => !mainPaths.has(entry.path));
      const changedMain = mainEntries.filter((entry) => entry.action === "create" || entry.action === "update");
      const changedSubs = subEntries.filter((entry) => entry.action === "create" || entry.action === "update");
      const changed = [...changedMain, ...changedSubs];

      if (json) {
        if (opts.dryRun) {
          console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
          return;
        }
        const applied = applyInstallPlan(cwd, plan);
        console.log(JSON.stringify({
          applied: applied.changed.map((entry) => ({ path: entry.path, action: entry.action, tool: entry.target.tool })),
          unchanged: applied.unchanged.length,
          skipped: applied.skipped.map((entry) => ({ path: entry.path, reason: entry.reason })),
          transaction: applied.transaction.id,
          rollback: "pitstop install --rollback",
        }, null, 2));
        return;
      }

      const table = new Table({
        head: ["Tool", "Path", "Status"],
        style: { head: ["cyan"], border: [] },
      });
      for (const entry of mainEntries) {
        const status = entry.action === "create"
          ? chalk.green("✅ Install")
          : entry.action === "update"
            ? chalk.cyan("♻️  Update (backup kept)")
            : entry.action === "unchanged"
              ? chalk.green("✅ Current")
              : chalk.yellow(`⚠️ skipped — ${entry.reason ?? "existing file kept"}`);
        table.push([entry.target.tool, entry.path, status]);
      }
      if (mains.some((target) => target.note)) {
        table.push(["Codex App / VS Code extension", "— (none written)", chalk.yellow("⚠️ Manual copy needed")]);
      }
      console.log(table.toString());

      if (opts.dryRun) {
        console.log(
          chalk.bold(
            `\nPreview only: ${changed.length} file(s) would change ` +
              `(${changedMain.filter((entry) => entry.action === "create").length} new main, ` +
              `${changedMain.filter((entry) => entry.action === "update").length} updated main, ` +
              `${changedSubs.length} subcommand file(s)).`,
          ),
        );
        console.log(chalk.dim("No files were written. Re-run without --dry-run to apply."));
        return;
      }

      const applied = applyInstallPlan(cwd, plan);
      if (applied.changed.length === 0) {
        console.log(chalk.green("\n✅ Everything is already current — no files were changed."));
      } else {
        console.log(chalk.green(`\n✅ ${applied.changed.length} file(s) written (${applied.unchanged.length} already current, ${applied.skipped.length} kept).`));
        for (const entry of applied.changed.slice(0, 20)) {
          console.log(`  ${entry.action === "create" ? "+" : "↻"} ${entry.path}`);
        }
        if (applied.changed.length > 20) {
          console.log(chalk.dim(`  … ${applied.changed.length - 20} more recorded in .pitstop/install-manifest.json`));
        }
        console.log(chalk.dim("Undo this integration with: pitstop install --rollback"));
      }
      if (codexAppNote) console.log(chalk.dim(`Note: ${codexAppNote}.`));
      console.log(chalk.yellow(CODEX_APP_MESSAGE));
      console.log(
        boxen(chalk.bold(READY_MESSAGE), {
          padding: 1,
          borderStyle: "double",
          borderColor: "cyan",
        }),
      );
    } catch (error) {
      if (json) {
        console.log(JSON.stringify({ ok: false, error: (error as Error).message }, null, 2));
      } else {
        console.error(chalk.red(`install failed: ${(error as Error).message}`));
      }
      process.exitCode = 1;
    }
  });
