import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { computeScore } from "../report/score.js";
import type { ScanResult } from "../analyzers/types.js";
import { readyCheck } from "./readyCheck.js";

/**
 * `pitstop budget` — the token-economy ledger.
 *
 * The CLI cannot see a model's token counts (nobody can). What it CAN do is
 * keep an honest wall-clock / compute ledger of everything the autonomous loop
 * ran, and tell you exactly how much of it was waste that ready-check /
 * --reuse / --reliability-runs 1 would have saved.
 */

interface BudgetEntry {
  scans: { count: number; reliabilityRuns: number; testMs: number; buildMs: number; last: string };
  verifies: { count: number; last: string };
  pens: { count: number; last: string };
  ledgerRuns: number;
  auditCacheHits: number;
  totalComputeSeconds: number;
  loopRuns: number;
}

function history<T>(repo: string, glob: string): { at: string; data: T }[] {
  const dir = path.join(repo, ".pitstop");
  if (!fs.existsSync(dir)) return [];
  const re = new RegExp(`^${glob}$`);
  const out: { at: string; data: T }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!re.test(f)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T;
      const at = (data as { timestamp?: string }).timestamp ?? f;
      out.push({ at, data });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function budget(repo: string): BudgetEntry {
  const scans = history<ScanResult>(repo, "scan-.*\\.json");
  const verifies = history<{ timestamp?: string }>(repo, "verify-.*\\.json");
  const pens = history<{ timestamp?: string }>(repo, "pen-.*\\.json");
  const ledgerRuns = fs.existsSync(path.join(repo, ".pitstop"))
    ? fs.readdirSync(path.join(repo, ".pitstop")).filter((f) => /^ledger-evidence-.*\.json$/.test(f)).length
    : 0;

  const cacheDir = path.join(repo, ".pitstop", "cache");
  const auditCacheHits = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir).filter((f) => /^npm-audit-.*\.json$/.test(f)).length
    : 0;

  let reliabilityRuns = 0;
  let testMs = 0;
  let buildMs = 0;
  for (const s of scans) {
    const d = s.data;
    reliabilityRuns += d.reliability?.runs ?? 0;
    testMs += d.tests?.durationMs ?? 0;
    buildMs += d.perf?.buildTimeMs ?? 0;
  }
  const totalComputeSeconds = Math.round((testMs + buildMs) / 1000);

  return {
    scans: {
      count: scans.length,
      reliabilityRuns,
      testMs,
      buildMs,
      last: scans[scans.length - 1]?.at ?? "—",
    },
    verifies: { count: verifies.length, last: verifies[verifies.length - 1]?.at ?? "—" },
    pens: { count: pens.length, last: pens[pens.length - 1]?.at ?? "—" },
    ledgerRuns,
    auditCacheHits,
    totalComputeSeconds,
    loopRuns: verifies.length,
  };
}

export const budgetCmd = new Command("budget")
  .description(
    "Token-economy ledger: what the autonomous loop actually ran (scans, reliability runs, verifies, pen tests), " +
      "how much wall-clock compute that cost, and what ready-check/--reuse would have saved. Honest proxy: the CLI " +
      "cannot see model token counts.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "print machine-readable JSON")
  .action((repoArg: string, options: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    const b = budget(repo);
    const rc = readyCheck(repo);

    if (options.json) {
      console.log(JSON.stringify({ repo, ...b, readyCheck: rc }, null, 2));
      return;
    }

    const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
    const lines: string[] = [];
    lines.push(`${chalk.bold("Full scans")}:        ${b.scans.count}  (reliability runs: ${b.scans.reliabilityRuns} · tests: ${fmtMs(b.scans.testMs)} · builds: ${fmtMs(b.scans.buildMs)})`);
    lines.push(`${chalk.bold("Verify runs")}:        ${b.verifies.count}  (last ${b.verifies.last})`);
    lines.push(`${chalk.bold("Pen tests")}:          ${b.pens.count}  (last ${b.pens.last})`);
    lines.push(`${chalk.bold("Ledger boots")}:       ${b.ledgerRuns}`);
    lines.push(`${chalk.bold("Audit cache files")}:  ${b.auditCacheHits}  (each = one npm-audit network round-trip saved)`);
    lines.push("");
    lines.push(`${chalk.bold("Wall-clock compute")}: ${fmtMs((b.scans.testMs + b.scans.buildMs))} spent on test/build runs (models cost tokens; machines cost seconds — this is the honest meter).`);
    lines.push("");
    if (rc.ready) {
      lines.push(chalk.green("The tree is unchanged since the last scan — the next loop iteration should have used `scan --reuse`."));
    } else {
      lines.push(chalk.yellow("The tree HAS changed since the last scan — a re-scan is legitimate spend."));
    }
    lines.push("");
    lines.push(chalk.cyan("Cut the burn:"));
    lines.push(`  ready-check before every re-scan (exit 0 = reuse the baseline)`); 
    lines.push(`  scan --reuse inside the loop; full scan only at the end`);
    lines.push(`  verify during iteration, full reliability runs only on the final pass`);
    console.log(
      boxen(lines.join("\n"), {
        title: " PITSTOP — Budget ",
        titleAlignment: "center",
        borderStyle: "round",
        padding: 1,
        borderColor: "cyan",
      }),
    );
  });

export default budgetCmd;
