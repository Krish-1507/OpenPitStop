import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { commandExists, safeExec } from "../analyzers/util.js";

/**
 * `pitstop doctor` — why is a category "skipped"? One command answers it.
 * Checks the toolchain (node, git, jscpd, gitleaks, semgrep, pa11y/axe) and
 * prints install hints for everything missing.
 */

function hasCommand(cmd: string): boolean {
  try {
    return commandExists(cmd);
  } catch {
    return false;
  }
}

export const doctor = new Command("doctor")
  .description("Check the local toolchain and explain which scan categories can (and cannot) run")
  .argument("[repo]", "path to the repo to diagnose (defaults to cwd)", ".")
  .action((repoArg: string) => {
    const repo = path.resolve(repoArg);

    const rows: [string, boolean, string][] = [];

    const major = Number(process.versions.node.split(".")[0]);
    rows.push([
      "Node.js",
      major >= 22,
      `v${process.versions.node}${major >= 22 ? "" : " — OpenPitStop needs v22+ (npm install node@latest)"}`,
    ]);

    const git = hasCommand("git");
    rows.push(["git", git, "the fix loop, integrity gate and verify all diff against git"]);

    let hasHead = false;
    if (git) {
      const inRepo = safeExec("git", ["rev-parse", "--is-inside-work-tree"], repo, 10000);
      hasHead =
        inRepo.code === 0 &&
        safeExec("git", ["rev-parse", "--verify", "HEAD"], repo, 10000).code === 0;
    }
    rows.push([
      "git baseline (HEAD)",
      hasHead,
      hasHead ? "commits present — integrity gate can diff fixes" : "no commits yet — the integrity gate needs a committed baseline",
    ]);

    rows.push(["npm", hasCommand("npm"), "bundled with Node.js"]);

    const jscpd = hasCommand("jscpd");
    rows.push(["jscpd (duplication)", jscpd, jscpd ? "ready" : "npm install -g jscpd — enables the duplication analyzer"]);

    const gitleaks = hasCommand("gitleaks");
    rows.push(["gitleaks (secrets)", gitleaks, gitleaks ? "ready" : "brew install gitleaks / scoop install gitleaks — adds secret scanning"]);

    const semgrep = hasCommand("semgrep");
    rows.push(["semgrep (code scanning)", semgrep, semgrep ? "ready" : "pip install semgrep — adds static code scanning"]);

    const pa11y = hasCommand("pa11y");
    rows.push(["pa11y / axe (accessibility)", pa11y, pa11y ? "ready" : "npm install -g pa11y — enables live-page accessibility checks (falls back to static JSX lint)"]);

    let testFrameworks = "none detected";
    const pkgPath = path.join(repo, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
        const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const found = ["jest", "vitest", "mocha", "ava"].filter((f) => f in all);
        if (found.length > 0) testFrameworks = found.join(", ");
      } catch {
        /* ignore */
      }
    }
    rows.push(["test framework", testFrameworks !== "none detected", testFrameworks]);

    const pitstopDir = path.join(repo, ".pitstop");
    rows.push([
      ".pitstop history",
      fs.existsSync(pitstopDir),
      fs.existsSync(pitstopDir) ? "scans recorded" : "no scans yet — run `pitstop scan` to start the history",
    ]);

    const lines = rows.map(([name, ok, note]) => {
      const statusRaw = ok ? "✓ ok" : "✗ missing";
      const status = (ok ? chalk.green : chalk.red)(statusRaw.padEnd(9));
      const label = chalk.bold(name.padEnd(24));
      const hint = ok ? chalk.dim(note) : chalk.yellow(note);
      return `  ${label} ${status} ${hint}`;
    });

    const missing = rows.filter(([, ok]) => !ok);
    const critical = rows.filter(
      ([name, ok]) => !ok && ["Node.js", "git", "npm"].includes(name),
    );
    const verdict =
      critical.length > 0
        ? chalk.red(`${critical.length} critical missing — install those before relying on OpenPitStop`)
        : missing.length === 0
          ? chalk.green("everything OpenPitStop needs is installed — the full scan should run with no `skipped` categories")
          : chalk.yellow(`${missing.length} optional tool(s) missing — those scan categories will print "skipped" (install hints above)`);

    console.log(
      boxen([...lines, "", `  ${chalk.bold("Verdict:")} ${verdict}`].join("\n"), {
        title: " PITSTOP — Doctor ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: critical.length > 0 ? "red" : missing.length > 0 ? "yellow" : "green",
      }),
    );
  });