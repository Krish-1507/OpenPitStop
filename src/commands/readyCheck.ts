import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { newestModifiedFile } from "../analyzers/util.js";
import type { ScanResult } from "../analyzers/types.js";
import { loadPenLatest } from "../pen/store.js";

/**
 * `pitstop ready-check` — the token-economy gate.
 *
 * Answers ONE question: "is the working tree unchanged since the last scan?"
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
  const scanPath = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(scanPath)) {
    return {
      ready: false,
      staleReason: "no scan baseline yet (.pitstop/scan-latest.json) — a first scan is required",
    };
  }
  let scan: ScanResult;
  try {
    scan = JSON.parse(fs.readFileSync(scanPath, "utf8")) as ScanResult;
  } catch {
    return { ready: false, staleReason: "scan-latest.json is corrupt — re-run `pitstop scan`" };
  }
  const baselineMs = Date.parse(scan.timestamp ?? "");
  if (!baselineMs || Number.isNaN(baselineMs)) {
    return { ready: false, staleReason: "baseline has no readable timestamp — re-run `pitstop scan`" };
  }

  const newest = newestModifiedFile(repo);
  if (!newest) return { ready: true, baselineTimestamp: scan.timestamp, baselineMode: scan.mode };

  // Ignore pitstop's own writes: they live under .pitstop which newestModifiedFile skips.
  if (newest.mtimeMs > baselineMs) {
    return {
      ready: false,
      baselineTimestamp: scan.timestamp,
      baselineMode: scan.mode,
      changedFile: path.relative(repo, newest.file).replace(/\\/g, "/"),
      changedMtime: newest.mtimeMs,
    };
  }
  return { ready: true, baselineTimestamp: scan.timestamp, baselineMode: scan.mode };
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
            chalk.dim(`The agent loop can skip the full suite: \`pitstop scan --reuse\` returns the baseline instantly.\n`),
          { title: " PITSTOP — Ready Check ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "green" },
        ),
      );
    } else {
      console.log(
        boxen(
          `${chalk.yellow("STALE")} — the working tree moved since the baseline.\n\n` +
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
