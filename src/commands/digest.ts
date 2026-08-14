import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { buildModel, collectIntegrity, loadHistory, loadProofs } from "../report/format.js";
import { computeScore, gradeColor } from "../report/score.js";
import { enumerateFindings } from "../repro/ids.js";
import type { ScanResult } from "../analyzers/types.js";

const BLOCKS = "▁▂▃▄▅▆▇█";

function sparkline(values: number[]): string {
  if (values.length === 0) return "·";
  if (values.length === 1) return chalk.dim(String(values[0]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const chars = values.map((v) => BLOCKS[Math.min(7, Math.floor(((v - min) / span) * 7.999))]);
  const improving = values[values.length - 1] >= values[0];
  return (improving ? chalk.green : chalk.yellow)(chars.join(""));
}

interface Window {
  scans: ScanResult[];
  verifies: ReturnType<typeof loadHistory>["verifies"];
}

function windowOf(repo: string, days: number | null): Window {
  const hist = loadHistory(repo);
  if (!days) return { scans: hist.scans, verifies: hist.verifies };
  const cut = Date.now() - days * 86_400_000;
  return {
    scans: hist.scans.filter((s) => Date.parse(s.timestamp) >= cut),
    verifies: hist.verifies.filter((v) => Date.parse(v.timestamp) >= cut),
  };
}

/**
 * `pitstop digest` — the shareable progress story. Reads the `.pitstop`
 * history and answers "what happened to this repo since <window>?" for humans:
 * score movement, what got fixed, verifies/gates run, cheat attempts caught,
 * flakiest tests, and what's still open.
 */
export const digest = new Command("digest")
  .description(
    "Progress digest over the .pitstop history: score movement, what got fixed, gate results, " +
      "cheat catches, flaky tests and open findings. --md writes a shareable markdown file.",
  )
  .argument("[repo]", "path to the repo (default: current dir)", ".")
  .option("--days <n>", "only look at the last n days (default: all history)")
  .option("-m, --md [file]", "also write a markdown digest (default PITSTOP_DIGEST.md)")
  .action((repoArg: string, options: { days?: string; md?: string | boolean }) => {
    const repo = path.resolve(repoArg);
    const days = options.days ? Math.max(1, Math.floor(Number(options.days) || 7)) : null;
    const { scans, verifies } = windowOf(repo, days);

    if (scans.length === 0) {
      console.log(
        chalk.yellow(
          `no scans ${days ? `in the last ${days} day(s) ` : ""}in ${path.join(repo, ".pitstop")} — run \`pitstop scan\` (or \`pitstop try\`) a few times first.`,
        ),
      );
      return;
    }

    const model = buildModel(repo);
    const integ = collectIntegrity(repo);
    const windowInteg = integ
      ? {
          ...integ,
          events: integ.events.filter(
            (e) => !days || Date.parse(e.timestamp) >= Date.now() - days * 86_400_000,
          ),
        }
      : undefined;

    const firstScore = computeScore(scans[0]);
    const lastScore = computeScore(scans[scans.length - 1]);
    const scores = scans.map((s) => computeScore(s).score);
    const delta = lastScore.score - firstScore.score;

    const metric = (
      label: string,
      get: (s: ScanResult) => number | null,
      worse: (d: number) => boolean,
    ): { label: string; a: number; b: number; changed: boolean } | null => {
      const a = get(scans[0]);
      const b = get(scans[scans.length - 1]);
      if (a == null || b == null) return null;
      return { label, a, b, changed: worse(b - a) };
    };

    const metrics = [
      metric("security", (s) => (s.security.status === "ok" ? s.security.issues.length : null), (d) => d > 0),
      metric("circular imports", (s) => (s.dependencyGraph.status === "ok" ? s.dependencyGraph.circular.length : null), (d) => d > 0),
      metric("clones", (s) => (s.duplication.status === "ok" ? s.duplication.cloneCount : null), (d) => d > 0),
      metric("failed tests", (s) => (s.tests.status === "ok" ? s.tests.failed : null), (d) => d > 0),
      metric("coverage %", (s) => (s.tests.status === "ok" ? s.tests.coverage ?? null : null), (d) => d < 0),
      metric("flaky tests", (s) => (s.reliability.status === "ok" ? s.reliability.flakyTests.length : null), (d) => d > 0),
    ].filter((m): m is NonNullable<typeof m> => m != null);

    const fixed: string[] = [];
    const regressed: string[] = [];
    for (const m of metrics) {
      if (m.a === m.b) continue;
      const d = m.b - m.a;
      if (m.changed) regressed.push(`${m.label} ${m.a} → ${m.b}`);
      else fixed.push(`${m.label} ${m.a} → ${m.b}`);
    }

    const flakyTally = new Map<string, { name: string; count: number }>();
    for (const s of scans) {
      if (s.reliability.status !== "ok") continue;
      for (const f of s.reliability.flakyTests) {
        const hit = flakyTally.get(f.name);
        if (hit) hit.count++;
        else flakyTally.set(f.name, { name: f.name, count: 1 });
      }
    }
    const flakyTop = [...flakyTally.values()].sort((a, b) => b.count - a.count).slice(0, 3);

    const failedChecks = verifies.filter((v) => (v.exitCode ?? 0) >= 1);
    const catches = (windowInteg?.events ?? []).filter((e) => e.verdict !== "CLEAN").length;

    const latest = scans[scans.length - 1];
    const open = enumerateFindings(latest)
      .sort((a, b) => (a.severity === "critical" || a.severity === "high" ? -1 : 1))
      .slice(0, 3);

    const lines: string[] = [];
    lines.push(
      `${chalk.bold("OpenPitStop Score".padEnd(20))}: ${gradeColorFn(lastScore.grade)(
        chalk.bold(`${lastScore.score}/100 (${lastScore.grade})`),
      )} ${delta !== 0 ? chalk.dim(`was ${firstScore.score}/100 (${firstScore.grade}) · ${delta > 0 ? chalk.green(`+${delta}`) : chalk.red(delta)}`) : chalk.dim(`unchanged from ${firstScore.score}/100`)}`,
    );
    lines.push(`${chalk.bold("Trend".padEnd(20))}: ${sparkline(scores)}`);
    lines.push("");

    lines.push(chalk.bold("What changed:"));
    if (fixed.length === 0 && regressed.length === 0) lines.push(`  ${chalk.dim("no measurable change across scans")}`);
    for (const f of fixed) lines.push(`  ${chalk.green("✓ " + f)}`);
    for (const r of regressed) lines.push(`  ${chalk.red("✗ " + r)}`);
    lines.push("");

    lines.push(chalk.bold("Gate activity:"));
    lines.push(
      `  ${verifies.length} verify(ies) in window · ${failedChecks.length} failed gate(s) · ${catches} integrity catch(es)${windowInteg?.selfCorrected ? `, ${windowInteg.selfCorrected} self-corrected` : ""}`,
    );
    if (flakyTop.length > 0) {
      lines.push(
        `  flakiest: ${flakyTop.map((f) => `${chalk.yellow(f.name)} (${f.count}×)`).join(", ")}`,
      );
    }
    lines.push("");

    const proofs = loadProofs(repo);
    lines.push(chalk.bold("Permanent proof:"));
    lines.push(
      proofs.length > 0
        ? `  ${chalk.green(`${proofs.length} committed repro test(s)`)} — every fix proven failing-then-passing`
        : `  ${chalk.yellow("none committed yet")}`,
    );

    lines.push("");
    lines.push(chalk.bold("Still open:"));
    if (open.length === 0) lines.push(`  ${chalk.green("nothing — latest scan is clean")}`);
    for (const f of open) {
      lines.push(`  ${chalk.red(`${f.severity.toUpperCase()} ${f.type}`)}: ${f.description} [${chalk.dim(f.id)}]`);
    }
    lines.push("");
    lines.push(
      chalk.dim(
        `${scans.length} scan(s) · ${verifies.length} verify(ies) · oldest ${scans[0].timestamp.slice(0, 19).replace("T", " ")} · newest ${scans[scans.length - 1].timestamp.slice(0, 19).replace("T", " ")}${days ? ` · last ${days} day(s)` : ""}`,
      ),
    );

    console.log(
      boxen(lines.join("\n"), {
        title: ` PITSTOP — Digest `,
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: delta < 0 ? "red" : "green",
      }),
    );

    if (options.md) {
      const mdPath =
        typeof options.md === "string" && options.md.length > 0
          ? path.resolve(options.md)
          : path.join(repo, "PITSTOP_DIGEST.md");
      const md = [
        `# PITSTOP — Digest`,
        ``,
        `_Repo: \`${repo}\` · ${scans.length} scan(s) in ${days ? `the last ${days} day(s)` : "all history"}_  `,
        ``,
        `## OpenPitStop Score: **${lastScore.score}/100 (${lastScore.grade})**${delta !== 0 ? ` (was ${firstScore.score}/100, ${delta > 0 ? "+" : ""}${delta})` : ""}`,
        ``,
        `## What changed`,
        ``,
        ...(fixed.length === 0 && regressed.length === 0 ? ["No measurable change across scans.", ""] : []),
        ...fixed.map((f) => `- ✅ ${f}`),
        ...regressed.map((r) => `- ❌ ${r}`),
        ``,
        `## Gate activity`,
        ``,
        `- ${verifies.length} verify(ies) · ${failedChecks.length} failed gate(s) · ${catches} integrity catch(es)`,
        ...(flakyTop.length > 0 ? [`- Flakiest: ${flakyTop.map((f) => `${f.name} (${f.count}×)`).join(", ")}`] : []),
        ``,
        `## Permanent proof`,
        ``,
        proofs.length > 0
          ? `- ${proofs.length} committed repro test(s) — every fix proven failing-then-passing`
          : `- None committed yet.`,
        ``,
        `## Still open`,
        ``,
        ...(open.length === 0 ? ["- Nothing — latest scan is clean.", ""] : open.map((f) => `- **${f.severity.toUpperCase()} ${f.type}** — ${f.description} (\`${f.id}\`)`)),
        ``,
      ].join("\n");
      fs.writeFileSync(mdPath, md);
      console.log(chalk.dim(`\nMarkdown digest written to ${mdPath}\n`));
    }
  });

function gradeColorFn(g: string) {
  const c = gradeColor(g);
  return c === "green" ? chalk.green : c === "yellow" ? chalk.yellow : chalk.red;
}