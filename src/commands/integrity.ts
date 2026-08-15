import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import chalk from "chalk";
import boxen from "boxen";
import { getDiff, resolveRefs } from "../analyzers/integrity/git.js";
import { buildIntegrityReport } from "../graph/integrity.js";
import { seal } from "../evidence.js";
import type { IntegrityFinding, Verdict } from "../analyzers/integrity/types.js";

export const integrity = new Command("integrity")
  .description(
    "Diff-scoped scan for AI-agent-cheat patterns (deleted/neutered tests, swallowed " +
      "errors, suppressions, hardcoded-to-pass values, mocked SUT, forced exits). " +
      "Writes .pitstop/integrity-<timestamp>.json. Exit 0=CLEAN, 1=SUSPICIOUS, 2=CONFIRMED_CHEAT.",
  )
  .argument("[repo]", "path to the repo to analyze", ".")
  .option("--from <ref>", "diff base ref (default: commit before last fix)")
  .option("--to <ref>", "diff head ref (default: current working tree)")
  .action(async (repoArg: string, options: { from?: string; to?: string }) => {
    const repo = path.resolve(repoArg);

    const gitOk = (() => {
      try {
        const gitDir = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
          cwd: repo,
          encoding: "utf8",
          timeout: 10000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return gitDir.status === 0 && gitDir.stdout.trim() === "true";
      } catch {
        return false;
      }
    })();
    if (!gitOk) {
      console.log(
        chalk.yellow("\nnot a git repo — integrity diffs your committed history against the working tree,\n") +
          chalk.yellow("and there is nothing to diff here. Reporting CLEAN would be a lie.\n") +
          chalk.dim("hint: run inside a git repo (`git init` first), or use `pitstop scan` for a full\n") +
          chalk.dim("report that does not need git.\n"),
      );
      process.exitCode = 1;
      return;
    }

    const { from, to } = resolveRefs(repo, options.from, options.to);

    console.log(chalk.cyan(`\nScanning diff ${from}..${to ?? "working tree"} for integrity cheats ...\n`));

    const changes = getDiff(repo, from, to);
    const report = buildIntegrityReport(repo, from, to ?? "working tree", changes);

    const outDir = path.join(repo, ".pitstop");
    fs.mkdirSync(outDir, { recursive: true });
    const ts = report.timestamp.replace(/[:.]/g, "-");
    const outPath = path.join(outDir, `integrity-${ts}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(seal(report, `pitstop integrity report for ${repo}`), null, 2),
    );

    printReport(report, outPath);
    process.exitCode = verdictExit(report.verdict);
  });

function verdictExit(v: Verdict): number {
  return v === "CLEAN" ? 0 : v === "SUSPICIOUS" ? 1 : 2;
}

function printReport(report: ReturnType<typeof buildIntegrityReport>, outPath: string): void {
  const { verdict, summary, findings } = report;
  const paint =
    verdict === "CLEAN" ? chalk.green : verdict === "SUSPICIOUS" ? chalk.yellow : chalk.red;
  const borderColor = verdict === "CLEAN" ? "green" : verdict === "SUSPICIOUS" ? "yellow" : "red";

  const lines: string[] = [];
  lines.push(`verdict: ${paint(verdict)}`);
  lines.push(`findings: ${summary.total} (${summary.confirmed} confirmed · ${summary.suspicious} suspicious)`);
  lines.push("");
  if (findings.length === 0) {
    lines.push(chalk.green("No cheat patterns detected in this diff."));
  } else {
    for (const f of findings) lines.push(renderFinding(f));
  }
  lines.push("");
  lines.push(chalk.dim(`report written to ${outPath}`));

  console.log(
    boxen(lines.join("\n"), {
      title: ` PITSTOP — Integrity ${verdict} `,
      titleAlignment: "center",
      borderStyle: verdict === "CLEAN" ? "round" : "double",
      padding: 1,
      borderColor,
    }),
  );

  if (verdict === "CONFIRMED_CHEAT") {
    console.log(
      chalk.red(
        "\nCONFIRMED_CHEAT: at least one unambiguous cheat pattern was found. Auto-block this change.\n",
      ),
    );
  } else if (verdict === "SUSPICIOUS") {
    console.log(
      chalk.yellow(
        "\nSUSPICIOUS: patterns need human judgment — do NOT auto-block; review the evidence below.\n",
      ),
    );
  }
}

function renderFinding(f: IntegrityFinding): string {
  const tag =
    f.confidence === "confirmed" ? chalk.red("CONFIRMED") : chalk.yellow("SUSPICIOUS");
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  const second = f.file2 ? chalk.dim(`  ⟂ test: ${f.file2}${f.line2 ? ":" + f.line2 : ""}`) : "";
  return [
    `${tag} ${chalk.bold(f.detector)} / ${f.pattern}`,
    `  ${chalk.cyan(loc)}${second}`,
    `  ${f.evidence}`,
  ].join("\n");
}
