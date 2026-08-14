import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { loadHistory } from "../report/format.js";
import { computeScore, gradeColor } from "../report/score.js";
import type { ScanResult } from "../analyzers/types.js";

/**
 * `pitstop trends` — turn the .pitstop/scan-*.json history into sparklines.
 * Every scan is persisted, so this shows the loop actually improving things.
 */

const BLOCKS = "▁▂▃▄▅▆▇█";

function sparkline(values: (number | null)[]): string {
  const pts = values.filter((v): v is number => v != null);
  if (pts.length === 0) return chalk.dim("no data");
  if (pts.length === 1) return chalk.dim(String(pts[0]));
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const chars = values.map((v) => {
    if (v == null) return " ";
    const idx = Math.min(7, Math.floor(((v - min) / span) * 7.999));
    return BLOCKS[idx];
  });
  const improving = (pts[pts.length - 1] as number) < (pts[0] as number);
  const paint = pts.length < 2 ? chalk.dim : improving ? chalk.green : chalk.yellow;
  return paint(chars.join(""));
}

function num(v: number | null | undefined): number | null {
  return v == null ? null : v;
}

/** Show the last N values only — keeps the box readable on long histories. */
const WINDOW = 10;
function windowed(vals: (number | null)[]): { window: (number | null)[]; truncated: boolean } {
  if (vals.length <= WINDOW) return { window: vals, truncated: false };
  return { window: vals.slice(-WINDOW), truncated: true };
}

export const trends = new Command("trends")
  .description("Show how key metrics moved across every recorded scan, as sparklines")
  .argument("[repo]", "path to the repo to trend (defaults to cwd)", ".")
  .action((repoArg: string) => {
    const repo = path.resolve(repoArg);
    const hist = loadHistory(repo);
    const scans = hist.scans;

    if (scans.length === 0) {
      console.log(
        chalk.yellow(`no scan history found in ${path.join(repo, ".pitstop")} — run \`pitstop scan\` a few times first.`),
      );
      return;
    }

    const rows: { label: string; values: (number | null)[]; fmt: (v: number) => string }[] = [];
    const sec = scans.map((s) => (s.security.status === "ok" ? num(s.security.issues.length) : null));
    rows.push({ label: "Security issues", values: sec, fmt: (v) => (v > 0 ? chalk.red(String(v)) : chalk.green(String(v))) });
    const circ = scans.map((s) => (s.dependencyGraph.status === "ok" ? num(s.dependencyGraph.circular.length) : null));
    rows.push({ label: "Circular imports", values: circ, fmt: (v) => (v > 0 ? chalk.yellow(String(v)) : chalk.green(String(v))) });
    const clones = scans.map((s) => (s.duplication.status === "ok" ? num(s.duplication.cloneCount) : null));
    rows.push({ label: "Duplication clones", values: clones, fmt: (v) => (v > 0 ? chalk.yellow(String(v)) : chalk.green(String(v))) });
    const failed = scans.map((s) => (s.tests.status === "ok" ? num(s.tests.failed) : null));
    rows.push({ label: "Failed tests", values: failed, fmt: (v) => (v > 0 ? chalk.red(String(v)) : chalk.green(String(v))) });
    const cov = scans.map((s) => (s.tests.status === "ok" ? num(s.tests.coverage) : null));
    rows.push({ label: "Coverage %", values: cov, fmt: (v) => (v >= 80 ? chalk.green(String(v)) : chalk.yellow(String(v))) });
    const flaky = scans.map((s) => (s.reliability.status === "ok" ? num(s.reliability.flakyTests.length) : null));
    rows.push({ label: "Flaky tests", values: flaky, fmt: (v) => (v > 0 ? chalk.yellow(String(v)) : chalk.green(String(v))) });
    const unused = scans.map((s) => (s.devex.status === "ok" ? num(s.devex.unusedExports.length) : null));
    rows.push({ label: "Unused exports", values: unused, fmt: (v) => (v > 0 ? chalk.yellow(String(v)) : chalk.green(String(v))) });

    const scores = scans.map((s) => computeScore(s));
    const last = scores[scores.length - 1];
    const first = scores[0];
    const gradeColorFn = (g: string): (t: string) => string =>
      gradeColor(g) === "green" ? chalk.green : gradeColor(g) === "yellow" ? chalk.yellow : chalk.red;

    const lines: string[] = [];
    lines.push(
      `${chalk.bold("OpenPitStop Score".padEnd(24))}: ${gradeColorFn(last.grade)(
        chalk.bold(`${last.score}/100 (${last.grade})`),
      )} ${first.score !== last.score ? chalk.dim(`(was ${first.score}/100 ${first.grade})`) : ""}${scores.length > 1 ? " " + sparkline(scores.map((s) => s.score)) : ""}`,
    );
    lines.push("");

    for (const row of rows) {
      const { window, truncated } = windowed(row.values);
      const vals = window.map((v) => (v == null ? "·" : row.fmt(v))).join(" ");
      const prefix = truncated ? chalk.dim("… ") : "";
      lines.push(
        `${chalk.bold(row.label.padEnd(24))}: ${sparkline(window)}  ${prefix}${chalk.dim(vals)}`,
      );
    }

    lines.push("", chalk.dim(`scan history: ${scans.length} scan(s) · oldest ${scans[0].timestamp.slice(0, 19).replace("T", " ")} · newest ${scans[scans.length - 1].timestamp.slice(0, 19).replace("T", " ")}`));

    if (hist.verifies.length > 0) {
      lines.push("", chalk.bold("Verify history:"));
      for (const v of hist.verifies) {
        const risk = v.risk === "High" ? chalk.red(v.risk) : v.risk === "Medium" ? chalk.yellow(v.risk) : chalk.green(v.risk);
        const s = v.score;
        const sc = s
          ? ` · ${gradeColorFn(s.grade)(`${s.current}/100 ${s.grade}${s.delta !== 0 ? `, ${s.delta > 0 ? "+" : ""}${s.delta}` : ""}`)}`
          : "";
        const integ = v.integrity
          ? ` · integrity ${v.integrity.verdict === "CLEAN" ? chalk.green("CLEAN") : v.integrity.verdict === "SUSPICIOUS" ? chalk.yellow("SUSPICIOUS") : chalk.red("CONFIRMED_CHEAT")}`
          : "";
        lines.push(
          `  ${chalk.dim(v.timestamp.slice(0, 19).replace("T", " "))} ${risk}${sc}${integ}`,
        );
      }
    }

    console.log(
      boxen(lines.join("\n"), {
        title: " PITSTOP — Trends ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: "cyan",
      }),
    );
  });
