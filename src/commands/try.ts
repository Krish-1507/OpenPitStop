import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import { performance } from "node:perf_hooks";
import path from "node:path";
import type { ScanResult } from "../analyzers/types.js";
import { analyzeDependencyGraph } from "../analyzers/dependencyGraph.js";
import { analyzeSecurity } from "../analyzers/security.js";
import { analyzeDuplication } from "../analyzers/duplication.js";
import { analyzeAccessibility } from "../analyzers/accessibility.js";
import { analyzeDevex } from "../analyzers/devex.js";
import { detectLanguage } from "../analyzers/util.js";
import { stampFindings } from "../repro/ids.js";
import { correlate } from "../graph/correlate.js";
import { computeScore } from "../report/score.js";
import { createSpinner } from "../ui/spinner.js";
import { persistScan, renderSecurityFixes } from "./scan.js";

function rel(repo: string, p?: string): string {
  return p ? path.relative(repo, path.resolve(repo, p)) : "";
}

function label(text: string): string {
  return chalk.bold(text.padEnd(17));
}

function gradePaint(g: string) {
  switch (g[0]) {
    case "A": return chalk.greenBright;
    case "B":
    case "C": return chalk.yellow;
    default: return chalk.red;
  }
}

/**
 * `pitstop try` — the instant wow. It runs only the cheap analyzers against
 * ANY existing repo (tests/build/flaky detection are intentionally skipped,
 * honest in the note text) so a OpenPitStop Score lands in a couple of seconds
 * with zero setup: no install, no tool config, no curated fixture. The result
 * is persisted as a sealed baseline so `pitstop scan`/`verify`/`gate` pick up
 * where it left off.
 */
export async function tryScan(repo: string): Promise<ScanResult> {
  const language = detectLanguage(repo);
  const notesFor = {
    tests: "try is the 2-second pass — `pitstop scan` runs the suite, coverage and build",
    perf: "try is the 2-second pass — `pitstop scan` measures build/bundle timing",
    reliability: "try is the 2-second pass — `pitstop scan` runs flaky-test detection",
  };

  // npm audit via analyzeSecurity is the only subprocess; it is cache-backed so
  // repeated `try` runs on the same lockfile are instant.
  const security = await analyzeSecurity(repo);

  return {
    timestamp: new Date().toISOString(),
    repo,
    mode: "try",
    language,
    dependencyGraph: analyzeDependencyGraph(repo),
    security,
    duplication: analyzeDuplication(repo),
    tests: {
      status: "skipped",
      note: notesFor.tests,
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: 0,
    },
    perf: { status: "skipped", note: notesFor.perf },
    accessibility: analyzeAccessibility(repo),
    reliability: {
      status: "skipped",
      note: notesFor.reliability,
      runs: 0,
      durationMs: 0,
      flakyTests: [],
      raceSmells: [],
    },
    devex: analyzeDevex(repo),
    clusters: [],
  };
}

function categoryLines(r: ScanResult): string[] {
  const lines: string[] = [];

  const dg = r.dependencyGraph;
  if (dg.status === "ok") {
    if (dg.circular.length > 0) {
      const cyc = dg.circular[0].map((f) => rel(r.repo, f)).join(" → ");
      lines.push(`${label("Dependency Graph")}: ${chalk.red(`${dg.circular.length} circular`)} — ${cyc}`);
    } else {
      lines.push(`${label("Dependency Graph")}: ${chalk.green("0 circular")} — clean`);
    }
  } else {
    lines.push(`${label("Dependency Graph")}: ${chalk.yellow(`skipped — ${dg.note ?? "unavailable"}`)}`);
  }

  const sec = r.security;
  if (sec.status === "ok") {
    if (sec.issues.length > 0) {
      const i = sec.issues[0];
      const desc =
        i.description.length > 84
          ? i.description.slice(0, 84) + "…"
          : i.description;
      lines.push(
        `${label("Security")}: ${chalk.red(`${sec.issues.length} issue(s)`)} — ${i.severity} ${i.category ?? i.type}: ${desc}`,
      );
    } else {
      lines.push(`${label("Security")}: ${chalk.green("clean")} — ${sec.issues.length} issues`);
    }
  } else {
    lines.push(`${label("Security")}: ${chalk.yellow(`skipped — ${sec.note ?? "unavailable"}`)}`);
  }

  const dup = r.duplication;
  if (dup.status === "ok") {
    lines.push(
      dup.cloneCount > 0
        ? `${label("Duplication")}: ${chalk.yellow(`${dup.cloneCount} clone(s)`)}`
        : `${label("Duplication")}: ${chalk.green("clean")}`,
    );
  } else {
    lines.push(`${label("Duplication")}: ${chalk.yellow(`skipped — ${dup.note ?? "unavailable"}`)}`);
  }

  const a = r.accessibility;
  if (a.status === "ok") {
    lines.push(
      a.issues.length > 0
        ? `${label("Accessibility")}: ${chalk.yellow(`${a.issues.length} issue(s)`)}`
        : `${label("Accessibility")}: ${chalk.green("clean")}`,
    );
  } else {
    lines.push(`${label("Accessibility")}: ${chalk.yellow(`skipped — ${a.note ?? "unavailable"}`)}`);
  }

  const dx = r.devex;
  if (dx.status === "ok") {
    const parts = [
      dx.unusedExports.length > 0 ? chalk.yellow(`${dx.unusedExports.length} unused export(s)`) : chalk.green("0 unused"),
      dx.duplicateFunctions.length > 0 ? chalk.yellow(`${dx.duplicateFunctions.length} dup fn(s)`) : chalk.green("0 dup fn"),
    ];
    lines.push(`${label("DevEx")}: ${parts.join(" · ")}`);
  } else {
    lines.push(`${label("DevEx")}: ${chalk.yellow(`skipped — ${dx.note ?? "unavailable"}`)}`);
  }

  return lines;
}

function renderTryBox(r: ScanResult, elapsedMs: number): string {
  const sc = computeScore(r);
  const paint = gradePaint(sc.grade);
  const skipped = sc.total - sc.analyzed;
  const skippedStr = skipped > 0 ? chalk.dim(` · ${skipped} skipped (tests/perf are a scan-detail)`) : "";

  const lines: string[] = [];
  lines.push(`${label("OpenPitStop Score")}: ${paint.bold(`${sc.score}/100 (${sc.grade})`)}${skippedStr}`);
  lines.push("");
  lines.push(...categoryLines(r));

  lines.push("");
  lines.push(
    chalk.dim(`scanned in ${elapsedMs}ms · ${chalk.bold("static pass")} only — `) +
      chalk.dim("no tests/build/flaky yet"),
  );

  lines.push("");
  lines.push(chalk.cyan("next:"));
  lines.push(`  pitstop scan      full audit (tests, perf, flaky, ledger) — cached 24h audit`);
  lines.push(`  pitstop verify    gate every future fix against this baseline`);
  lines.push(`  pitstop demo      the guided fix-loop tour`);

  return boxen(lines.join("\n"), {
    title: " PITSTOP — Try ",
    titleAlignment: "center",
    borderStyle: "single",
    padding: 1,
    borderColor: paint === chalk.greenBright ? "green" : paint === chalk.yellow ? "yellow" : "red",
  });
}

export const try_ = new Command("try")
  .description(
    "Zero-setup 2-second check: static-analyze ANY existing repo (no install, no tool config) " +
      "and print its OpenPitStop Score. Persists a real baseline for scan/verify/gate to build on.",
  )
  .argument("[repo]", "path to the repo to try (default: current dir)", ".")
  .option("--json", "print the raw quick-scan result as JSON")
  .action(async (repoArg: string, options: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    if (!options.json) {
      console.log(chalk.cyan(`\nTrying ${repo} ...\n`));
    }

    const language = detectLanguage(repo);
    if (language === "unknown") {
      const msg =
        `couldn't find a supported project in ${repo} — looking for package.json, ` +
        `requirements.txt, pyproject.toml or setup.py`;
      if (options.json) {
        console.log(JSON.stringify({ ok: false, repo, reason: msg }));
      } else {
        console.log(chalk.red(msg));
      }
      process.exitCode = 1;
      return;
    }

    const t0 = performance.now();
    const spin = createSpinner("Running static analyzers");
    let result: ScanResult;
    try {
      result = await tryScan(repo);
      spin.succeed("Probe complete");
    } catch (err: any) {
      spin.fail("Probe failed");
      throw err;
    }
    const elapsedMs = Math.max(1, Math.round(performance.now() - t0));

    stampFindings(result);
    result.clusters = correlate(repo, result).clusters;
    persistScan(repo, result);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(renderTryBox(result, elapsedMs));
    console.log(renderSecurityFixes(result));
    console.log(chalk.dim(`\nBaseline saved to ${path.join(repo, ".pitstop", "scan-latest.json")}\n`));
  });