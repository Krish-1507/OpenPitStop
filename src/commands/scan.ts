import { Command } from "commander";
import chalk, { type ChalkInstance } from "chalk";
import boxen from "boxen";
import { printNextCard } from "./next.js";
import path from "node:path";
import fs from "node:fs";
import { runAllAnalyzers } from "../analyzers/index.js";
import { runLedgerAnalyzer } from "../analyzers/ledger/index.js";
import { newestModifiedFile } from "../analyzers/util.js";
import { correlate } from "../graph/correlate.js";
import { relevantEntriesForFiles, type MemoryType } from "../memory/store.js";
import { stampFindings, findingIdFor } from "../repro/ids.js";
import { computeScore, type ScoreResult } from "../report/score.js";
import { createSpinner } from "../ui/spinner.js";
import { seal } from "../evidence.js";
import type { ScanResult } from "../analyzers/types.js";

function memTypeColor(t: MemoryType): (s: string) => string {
  switch (t) {
    case "decision":
      return chalk.cyan;
    case "fix":
      return chalk.green;
    case "rejection":
      return chalk.red;
  }
}

function rel(repo: string, p?: string): string {
  return p ? path.relative(repo, path.resolve(repo, p)) : "";
}

function label(text: string): string {
  return chalk.bold(text.padEnd(17));
}

function scorePaint(s: ScoreResult): ChalkInstance {
  switch (s.grade[0]) {
    case "A": return chalk.greenBright;
    case "B":
    case "C": return chalk.yellow;
    default: return chalk.red;
  }
}

/**
 * One-line fix for a category that printed "skipped" because a dependency was
 * missing. Doubles as `pitstop doctor`-lite, right inside the box, so a fresh
 * machine's first scan never looks like the product is half-missing.
 */
const SKIPPED_HINTS: [RegExp, string][] = [
  [/jscpd not found/i, "install: npm i -g jscpd"],
  [/pa11y\/axe/i, "install: npm i -g pa11y (falls back to static JSX lint)"],
  [/pa11y/i, "install: npm i -g pa11y"],
  [/unsupported language/i, "install: npm i -g gitleaks · pip install semgrep"],
  [/semgrep can?t/i, "install: pip install semgrep"],
];

function skipHint(note?: string): string {
  if (!note) return "";
  for (const [re, hint] of SKIPPED_HINTS) if (re.test(note)) return hint;
  return "";
}

function skippedLine(status: string, note?: string): string {
  const hint = skipHint(note);
  return `skipped — ${note ?? "unavailable"}${hint ? ` · ${chalk.cyan(hint)}` : ""}`;
}

export function renderBox(r: ScanResult): string {
  const lines: string[] = [];

  const sc = computeScore(r);
  const paint = scorePaint(sc);
  const skippedHint =
    sc.analyzed < sc.total ? chalk.dim(` · ${sc.total - sc.analyzed} skipped`) : "";
  lines.push(
    `${label("OpenPitStop Score")}: ${paint.bold(`${sc.score}/100 (${sc.grade})`)}${skippedHint}`,
  );
  lines.push("");

  const dg = r.dependencyGraph;
  if (dg.status === "ok") {
    if (dg.circular.length > 0) {
      const cyc = dg.circular[0].map((f) => rel(r.repo, f)).join(" → ");
      lines.push(
        `${label("Dependency Graph")}: ${chalk.red(`${dg.circular.length} circular`)} — ${cyc}`,
      );
    } else {
      const top = dg.mostDependedOn[0];
      const topStr = top ? `${top.file} (${top.count} dependents)` : "no hubs";
      lines.push(
        `${label("Dependency Graph")}: ${chalk.green("0 circular")} — clean · ${topStr} · ${dg.orphans.length} orphans`,
      );
    }
  } else {
    lines.push(
      `${label("Dependency Graph")}: ${chalk.yellow(skippedLine(dg.status, dg.note))}`,
    );
  }

  const securityClusterCount = r.clusters.filter((c) =>
    [c.rootCause, ...c.symptoms].some((f) => f.source === "security"),
  ).length;
  const clusteredSecurity = r.clusters.reduce(
    (n, c) =>
      n + [c.rootCause, ...c.symptoms].filter((f) => f.source === "security").length,
    0,
  );
  const sec = r.security;
  if (sec.status === "ok") {
    if (sec.issues.length > 0) {
      if (securityClusterCount > 0) {
        lines.push(
          `${label("Security")}: ${chalk.red(`${securityClusterCount} root cause(s)`)} → ${clusteredSecurity} symptoms (see below)`,
        );
      } else {
        const i = sec.issues[0];
        const loc = i.file
          ? ` (${rel(r.repo, i.file)}${i.line ? ":" + i.line : ""})`
          : "";
        lines.push(
          `${label("Security")}: ${chalk.red(`${sec.issues.length} issues`)} — ${i.severity} ${i.type}: ${i.description}${loc} [${chalk.dim(findingIdFor("security", i.type, i.file, i.description))}]`,
        );
      }    } else {
      lines.push(`${label("Security")}: ${chalk.green("0 issues")} — clean`);
    }
  } else {
    lines.push(
      `${label("Security")}: ${chalk.yellow(skippedLine(sec.status, sec.note))}`,
    );
  }

  const lg = r.ledger;
  if (lg) {
    if (lg.status === "ok") {
      const proven = lg.evidence.filter((e) => e.doubleCharged);
      if (proven.length > 0) {
        const e = proven[0];
        const evFile = e.evidenceFile
          ? rel(r.repo, e.evidenceFile)
          : "";
        lines.push(
          `${label("Ledger")}: ${chalk.red(`PROVEN: ${e.summary}`)} — see ${chalk.dim(evFile)} for full request/response logs`,
        );
      } else {
        lines.push(
          `${label("Ledger")}: ${chalk.green(`${lg.endpoints.length} endpoint(s) probed`)} — 0 double-charges (idempotency holds)`,
        );
      }
    } else {
      lines.push(
        `${label("Ledger")}: ${chalk.yellow(lg.status)} — ${lg.note ?? "ledger mode aborted"}`,
      );
    }
  }

  if (r.clusters.length > 0) {
    lines.push("");
    const totalSymptoms = r.clusters.reduce((s, c) => s + c.symptoms.length, 0);
    lines.push(
      `${label("Root Causes")}: ${r.clusters.length} root cause(s) → ${totalSymptoms} symptom(s)`,
    );
    r.clusters.slice(0, 3).forEach((c, i) => {
      const rc = `${c.rootCause.severity.toUpperCase()} ${c.rootCause.type}${c.rootCause.id ? ` [${c.rootCause.id}]` : ""}`;
      const shared = c.sharedFiles.slice(0, 3).join(", ");
      lines.push(`    ${i + 1}. ${chalk.red(rc)}: ${c.rootCause.description}`);
      lines.push(
        `       → ${c.symptoms.length} symptom(s) · shared: ${chalk.dim(shared)}`,
      );
      const mem = relevantEntriesForFiles(r.repo, c.sharedFiles);
      for (const m of mem.slice(0, 3)) {
        const mc = memTypeColor(m.type);
        lines.push(
          `       ${chalk.dim("↳ recall:")} ${mc(m.type)} — ${m.summary}`,
        );
      }
    });
  }

  const dup = r.duplication;
  if (dup.status === "ok") {
    if (dup.cloneCount > 0) {
      const top = dup.clones[0];
      const files = top?.files.map((f) => rel(r.repo, f)).join(", ") ?? "";
      lines.push(
        `${label("Duplication")}: ${chalk.red(`${dup.cloneCount} clones`)} — ${files}`,
      );
    } else {
      lines.push(`${label("Duplication")}: ${chalk.green("0 clones")} — clean`);
    }
  } else {
    lines.push(
      `${label("Duplication")}: ${chalk.yellow(skippedLine(dup.status, dup.note))}`,
    );
  }

  const t = r.tests;
  if (t.status === "ok") {
    const cov = t.coverage != null ? `, ${t.coverage}% cov` : "";
    const body =
      t.failed > 0
        ? chalk.red(`${t.failed} failed`) + ` / ${t.total}`
        : chalk.green(`${t.passed}/${t.total} passed`);
    lines.push(
      `${label("Tests")}: ${body} — ${t.durationMs}ms${cov}`,
    );
  } else {
    lines.push(
      `${label("Tests")}: ${chalk.yellow(skippedLine(t.status, t.note))}`,
    );
  }

  const p = r.perf;
  if (p.status === "ok") {
    const kb = p.bundleSizeBytes != null ? (p.bundleSizeBytes / 1024).toFixed(1) : "0";
    lines.push(
      `${label("Performance")}: ${chalk.green(`build ${p.buildTimeMs}ms`)} — bundle ${kb} KB`,
    );
  } else {
    lines.push(
      `${label("Performance")}: ${chalk.yellow(skippedLine(p.status, p.note))}`,
    );
  }

  const a = r.accessibility;
  if (a.status === "ok") {
    const sev =
      a.issues.length > 0 &&
      a.issues.some((i) => i.severity === "high" || i.severity === "critical");
    const body =
      a.issues.length > 0
        ? sev
          ? chalk.red(`${a.issues.length} issues`)
          : chalk.yellow(`${a.issues.length} issues`)
        : chalk.green("clean");
    const eng = a.engine ? ` · ${a.engine}` : "";
    lines.push(`${label("Accessibility")}: ${body}${eng}`);
  } else {
    lines.push(
      `${label("Accessibility")}: ${chalk.yellow(skippedLine(a.status, a.note))}`,
    );
  }

  const reliab = r.reliability;
  if (reliab.status === "ok") {
    const flaky =
      reliab.flakyTests.length > 0
        ? chalk.red(`${reliab.flakyTests.length} flaky`)
        : chalk.green("0 flaky");
    const smells =
      reliab.raceSmells.length > 0
        ? chalk.yellow(`${reliab.raceSmells.length} race smell(s)`)
        : chalk.green("0 race smells");
    const runs = reliab.runs > 0 ? ` · ${reliab.runs} runs` : "";
    lines.push(`${label("Reliability")}: ${flaky} · ${smells}${runs}`);
  } else {
    lines.push(
      `${label("Reliability")}: ${chalk.yellow(skippedLine(reliab.status, reliab.note))}`,
    );
  }

  const dx = r.devex;
  if (dx.status === "ok") {
    const unused =
      dx.unusedExports.length > 0
        ? chalk.yellow(`${dx.unusedExports.length} unused export(s)`)
        : chalk.green("0 unused exports");
    const dups =
      dx.duplicateFunctions.length > 0
        ? chalk.yellow(`${dx.duplicateFunctions.length} dup function(s)`)
        : chalk.green("0 dup functions");
    lines.push(`${label("Devex")}: ${unused} · ${dups}`);
  } else {
    lines.push(
      `${label("Devex")}: ${chalk.yellow(skippedLine(dx.status, dx.note))}`,
    );
  }

  const content =
    lines.join("\n") +
    "\n\n  " +
    chalk.bold("Awaiting confirmation to begin autonomous fixing.");

  return boxen(content, {
    title: " PITSTOP — Repository Scan Complete ",
    titleAlignment: "center",
    borderStyle: "double",
    padding: 1,
    borderColor: "cyan",
  });
}

export interface RunScanOptions {
  ledger?: boolean;
  reliabilityRuns?: number;
  reuse?: boolean;
}

/**
 * Reuse a sealed baseline when nothing in the working tree changed since it
 * was written. Zero compute, zero model tokens: the exact previous result
 * (with its evidence chain intact) is returned.
 */
export function reuseScan(repo: string): ScanResult | null {
  const latestPath = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(latestPath)) return null;
  let latest: ScanResult;
  try {
    latest = JSON.parse(fs.readFileSync(latestPath, "utf8")) as ScanResult;
  } catch {
    return null;
  }
  const baselineMs = Date.parse(latest.timestamp ?? "");
  if (!baselineMs || Number.isNaN(baselineMs)) return null;
  const newest = newestModifiedFile(repo);
  if (!newest) return latest;
  if (newest.mtimeMs > baselineMs) return null;
  return latest;
}

/**
 * Persist a scan result into .pitstop: the timestamped history file plus the
 * live scan-latest.json, both sealed with the evidence signature (`pitstop
 * verify`/`gate` check it and flag any post-write editing as tampering).
 */
export function persistScan(repo: string, result: ScanResult): { file: string } {
  const sealed = seal(result, `pitstop scan result for ${repo}`);

  const outDir = path.join(repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `scan-${ts}.json`);
  const json = JSON.stringify(sealed, null, 2);
  fs.writeFileSync(file, json);
  fs.writeFileSync(path.join(outDir, "scan-latest.json"), json);
  return { file };
}

export async function runScan(
  repo: string,
  opts: RunScanOptions = {},
): Promise<{ result: ScanResult; file: string }> {
  const result = await runAllAnalyzers(repo, { reliabilityRuns: opts.reliabilityRuns });

  // Ledger mode is invasive (it boots the app and probes live endpoints), so it
  // never runs unless explicitly requested via `--ledger`.
  if (opts?.ledger) {
    result.ledger = await runLedgerAnalyzer(repo);
  }
  // Stable finding ids first, so clusters and scan-latest.json carry the ids
  // that `pitstop repro <id>` (and committed repro tests) reference.
  stampFindings(result);

  const { clusters } = correlate(repo, result);
  result.clusters = clusters;

  const { file } = persistScan(repo, result);
  return { result, file };
}

/**
 * Identify-and-solve: every security finding printed with its exact fix, so
 * the terminal output is a worklist, not a scare.
 */
export function renderSecurityFixes(r: ScanResult): string {
  const withFixes = r.security.issues.filter((i) => i.fix);
  if (withFixes.length === 0) return "";
  const lines: string[] = [chalk.bold("\nSecurity fixes (indicated — verify, then apply):")];
  withFixes.forEach((i, idx) => {
    const loc = i.file
      ? ` ${chalk.dim(rel(r.repo, i.file) + (i.line ? `:${i.line}` : ""))}`
      : "";
    const cat = i.category ? ` ${i.category}` : "";
    lines.push(
      `  ${idx + 1}. ${chalk.red(i.severity.toUpperCase())}${cat}${loc} — ${i.description}`,
    );
    lines.push(`     ${chalk.green("fix:")} ${i.fix}`);
  });
  return lines.join("\n");
}

export const scan = new Command("scan")
  .description("Scan a repo for dependency, security, duplication, test and performance issues")
  .argument("[repo]", "path to the repo to scan", ".")
  .option(
    "--ledger",
    "opt-in, invasive: boot the app under a nock sandbox and probe money-moving " +
      "endpoints (charge/capture/payment/transfer/refund/webhook) for missing " +
      "idempotency. Never runs unless --ledger is passed.",
  )
  .option("--json", "print the raw scan result as JSON instead of the boxed report")
  .option(
    "--reuse",
    "token-economy: if the working tree is unchanged since the last scan, return the sealed " +
      "baseline instead of re-running every analyzer (0 model credits, 0 compute).",
  )
  .option(
    "--reliability-runs <n>",
    "how many sequential times the test suite runs for flaky detection (default 2; " +
      "1 disables flaky detection, >2 costs an extra full suite run each)",
    "2",
  )
  .action(
    async (
      repoArg: string,
      options: { ledger?: boolean; json?: boolean; reliabilityRuns?: string; reuse?: boolean },
    ) => {
      const repo = path.resolve(repoArg);
      const reliabilityRuns = Math.max(1, Math.floor(Number(options.reliabilityRuns) || 2));
      if (!options.json) {
        console.log(
          chalk.cyan(
            `\nScanning ${repo}${options.ledger ? " with --ledger" : ""} ` +
              `(reliability: ${reliabilityRuns} run${reliabilityRuns > 1 ? "s" : ""}) ...\n`,
          ),
        );
      }

      // --reuse: unchanged tree → sealed baseline comes back in zero time.
      if (options.reuse) {
        const reused = reuseScan(repo);
        if (reused) {
          if (options.json) {
            console.log(JSON.stringify(reused, null, 2));
          } else {
            console.log(renderBox(reused));
            console.log(renderSecurityFixes(reused));
            console.log(
              chalk.dim(
                `\n[reuse] baseline from ${reused.timestamp} returned — sources unchanged, nothing re-ran.\n`,
              ),
            );
          }
          return;
        }
      }

      const run = async () => {
        const { result, file } = await runScan(repo, {
          ledger: options.ledger,
          reliabilityRuns,
        });
        return { result, file };
      };

      let result: ScanResult;
      let file: string;
      if (options.json) {
        ({ result, file } = await run());
      } else {
        const spin = createSpinner("Running analyzers");
        try {
          ({ result, file } = await run());
          spin.succeed("Scan complete");
        } catch (err: any) {
          spin.fail("Scan failed");
          throw err;
        }
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(renderBox(result));
      console.log(renderSecurityFixes(result));
      console.log(chalk.dim(`\nReports written to ${file}\n`));
      // Pure-CLI users get the sticky-loop card too — no agent required.
      await printNextCard(repo);
    },
  );
