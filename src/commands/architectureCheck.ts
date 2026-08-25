import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { checkArchitecture, sealArchitectureResult } from "../verify/architecture.js";
import { addEntry } from "../memory/store.js";

const KIND_PAINT: Record<string, (s: string) => string> = {
  "boundary-violation": chalk.red,
  "forbidden-path": chalk.red,
  "scope-creep": chalk.red,
  shortcut: chalk.yellow,
  "protected-path": chalk.yellow,
  "review-required": chalk.dim,
};

export const architectureCheck = new Command("architecture-check")
  .description(
    "Architecture & boundary verification: does the change FIT THE SYSTEM? Checks the diff " +
      "against the repo's declared architecture config (openpitstop.architecture.json: " +
      "boundaries, protected paths, forbidden paths), CODEOWNERS ownership, the AI-cheat " +
      "detectors (shortcuts), and — with --against-plan — the change plan's declared scope.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--from <ref>", "baseline ref (default HEAD)", "HEAD")
  .option("--to <ref>", "candidate ref (default: working tree)")
  .option("--against-plan", "also flag changed files outside the latest plan's expectedPaths")
  .option("--approved", "record explicit human approval for protected-path touches")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);
    let result = await checkArchitecture({
      repo,
      from: opts.from,
      to: opts.to,
      againstPlan: opts.againstPlan,
      approved: opts.approved,
    });
    result = sealArchitectureResult(result);

    if (opts.json) {
      console.log(JSON.stringify({
        repo: result.repo, from: result.from, to: result.to,
        configPath: result.configPath, changedFiles: result.changedFiles,
        entries: result.entries, verdict: result.verdict,
        reasons: result.reasons, notes: result.notes,
        planRef: result.planRef, approved: result.approved,
        sealedPath: result.sealedPath,
      }, null, 2));
    } else {
      const bySeverity = {
        violation: result.entries.filter((e) => e.severity === "violation"),
        approval: result.entries.filter((e) => e.severity === "approval"),
        info: result.entries.filter((e) => e.severity === "info"),
      };
      const lines: string[] = [];
      lines.push(`${chalk.bold("changed files:")} ${result.changedFiles.length}`);
      lines.push(`${chalk.bold("config:")} ${result.configPath ?? chalk.dim("none (generic checks only)")}`);
      if (result.entries.length === 0) {
        lines.push("");
        lines.push(chalk.green("no entries — nothing flagged"));
      }
      for (const [sev, list] of Object.entries(bySeverity)) {
        if (!list.length) continue;
        lines.push("");
        lines.push(chalk.bold(sev === "violation" ? "VIOLATIONS (blocking):" : sev === "approval" ? "APPROVAL REQUIRED:" : "INFORMATIONAL:"));
        for (const e of list.slice(0, 20)) {
          const paint = KIND_PAINT[e.kind] ?? chalk.dim;
          lines.push(`  ${paint(e.kind.padEnd(20))} ${e.file} — ${e.detail}${e.reason ? chalk.dim(` (${e.reason})`) : ""}`);
        }
        if (list.length > 20) lines.push(chalk.dim(`  … ${list.length - 20} more`));
      }
      console.log(
        boxen(lines.join("\n"), {
          title: " PITSTOP — ARCHITECTURE CHECK ",
          titleAlignment: "center",
          borderStyle: "round",
          padding: 1,
          borderColor: result.verdict === "CONFORMS" ? "green" : result.verdict === "APPROVAL_REQUIRED" ? "yellow" : "red",
        }),
      );
      const color: any = result.verdict === "CONFORMS" ? "green" : result.verdict === "APPROVAL_REQUIRED" ? "yellow" : "red";
      console.log(
        boxen(
          `${chalk.bold(result.verdict)}\n\n${result.reasons.map((r) => `· ${r}`).join("\n")}` +
            (result.notes.length ? "\n\n" + result.notes.map((n) => chalk.dim(`· ${n}`)).join("\n") : "") +
            `\n\n${chalk.dim("a change can pass every test and still be wrong for the system — this checks the system fit")}`,
          { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: color },
        ),
      );
      if (result.sealedPath) console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
    }

    addEntry(repo, {
      type: "fix",
      summary: `architecture-check: ${result.verdict} (${result.entries.length} entries)`,
      context: result.reasons.join("; ").slice(0, 200),
    });

    process.exitCode =
      result.verdict === "CONFORMS" ? 0 : result.verdict === "APPROVAL_REQUIRED" ? (result.approved ? 0 : 2) : result.verdict === "VIOLATIONS" ? 1 : 3;
  });

export default architectureCheck;
