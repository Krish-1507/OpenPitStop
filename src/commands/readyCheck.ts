import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { checkScanReuse } from "../scanCache.js";
import { loadPenLatest } from "../pen/store.js";

/**
 * `pitstop ready-check` — the token-economy gate.
 *
 * Answers ONE question: "is this full scan still eligible for reuse?"
 * If yes, re-running the full suite is pure waste: `scan --reuse` (or the
 * agent loop) can skip the heavy analyzers entirely. The autonomous fix loop
 * calls this before every re-scan instead of burning model credits on tests
 * that cannot have changed.
 */

export interface ReadyCheckOutcome {
  ready: boolean;
  baselineTimestamp?: string;
  baselineMode?: string;
  changedFile?: string;
  changedMtime?: number;
  staleReason?: string;
}

export function readyCheck(repo: string): ReadyCheckOutcome {
  const result = checkScanReuse(repo);
  return { ready: !!result.scan, baselineTimestamp: result.scan?.timestamp,
    baselineMode: result.scan?.mode, changedFile: result.changedFile, staleReason: result.reason };
}

export const readyCheckCmd = new Command("ready-check")
  .description(
    "Token-economy gate: reports whether the working tree changed since the last scan. " +
      "Exit 0 = nothing changed (re-scan is waste, use `scan --reuse`), exit 1 = sources changed since baseline.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "print machine-readable JSON")
  .action((repoArg: string, options: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    const r = readyCheck(repo);

    if (options.json) {
      console.log(JSON.stringify({ repo, ...r }, null, 2));
    } else if (r.ready) {
      const pen = loadPenLatest(repo);
      console.log(
        boxen(
          `${chalk.green("READY")} — nothing changed since the baseline.\n\n` +
            `baseline: ${r.baselineTimestamp ?? "?"} (mode: ${r.baselineMode ?? "?"})${pen ? ` · pen report: ${pen.timestamp}` : ""}\n\n` +
            chalk.dim(`Use \`pitstop scan --reuse\` during iteration; run fresh checks for release evidence.\n`),
          { title: " PITSTOP — Ready Check ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "green" },
        ),
      );
    } else {
      console.log(
        boxen(
          `${chalk.yellow("FRESH SCAN NEEDED")} — baseline is not eligible for reuse.\n\n` +
            `changed: ${chalk.cyan(r.changedFile ?? "?")}\n` +
            `baseline: ${r.baselineTimestamp ?? "?"} (mode: ${r.baselineMode ?? "?"})\n\n` +
            (r.staleReason ?? "a re-scan is needed before `verify`/`gate` can be trusted."),
          { title: " PITSTOP — Ready Check ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "yellow" },
        ),
      );
    }
    process.exitCode = r.ready ? 0 : 1;
  });

export default readyCheckCmd;
