import chalk from "chalk";
import path from "node:path";
import type { BenchReport, ScenarioResult, ScenarioVerdict } from "./run.js";
import type { BenchKind } from "./scenario.js";

const GOOD: ScenarioVerdict[] = ["detected", "clean", "as-documented", "survived"];
const WARN: ScenarioVerdict[] = ["partial", "skipped", "newly-detected", "not-reproduced"];

function glyph(verdict: ScenarioVerdict): string {
  if (GOOD.includes(verdict)) return chalk.green("✔");
  if (WARN.includes(verdict)) return chalk.yellow("•");
  return chalk.red("✖");
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

function ratio(summary: BenchReport["summary"]): string {
  const claims = summary.detectedFindings + summary.falsePositives;
  return `${summary.detectedFindings}/${claims}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function findingsLine(result: ScenarioResult): string {
  if (result.verdict === "skipped") return chalk.dim("not measured");
  if (result.verdict === "crashed") return chalk.red(result.error ?? "error");
  const shown = [...new Set(result.reported.map((finding) => finding.category))];
  return shown.length ? shown.join(", ") : chalk.dim("none");
}

export function renderBenchReport(report: BenchReport): string {
  const lines: string[] = [];
  const summary = report.summary;
  const root = path.relative(process.cwd(), report.root) || ".";
  lines.push(chalk.bold("OpenPitStop detection benchmark"));
  lines.push(chalk.dim(`${root} · ${report.coverage} · ${plural(summary.scenarios, "scenario")} · ${summary.durationMs} ms`));
  lines.push("");

  lines.push(`${chalk.bold("Vulnerable fixtures")} (${summary.pairs.length} pair(s))`);
  lines.push(`  expected ${summary.expectedFindings} · detected ${summary.detectedFindings} · missed ${summary.missedFindings}`);
  lines.push(`  precision ${chalk.bold(pct(summary.precision))} (${ratio(summary)}) · recall ${chalk.bold(pct(summary.recall))}`);
  if (summary.falsePasses) lines.push(chalk.red(`  ${plural(summary.falsePasses, "fixture")} produced no finding at all — a clean verdict on a known-vulnerable repo`));
  if (summary.partialScenarios.length) lines.push(chalk.yellow(`  partial: ${summary.partialScenarios.join(", ")}`));
  lines.push("");

  if (summary.pairs.length) {
    lines.push(chalk.bold("Pairs (vulnerable ↔ fixed)"));
    for (const pair of summary.pairs) {
      const mark =
        pair.status === "discriminating"
          ? chalk.green("✔ detected, fixed quiet")
          : pair.status === "inconclusive"
            ? chalk.yellow("inconclusive")
            : chalk.red(pair.status);
      lines.push(`  ${pair.vulnerable} ↔ ${pair.fixed} ${chalk.dim("—")} ${mark}`);
    }
    lines.push("");
  }

  lines.push(chalk.bold("Scenarios"));
  const width = Math.max(...report.scenarios.map((scenario) => scenario.id.length));
  for (const scenario of report.scenarios) {
    const verdict = `${scenario.verdict}`.padEnd(19);
    lines.push(
      `  ${glyph(scenario.verdict)} ${scenario.id.padEnd(width)}  ${verdict} ${scenario.stack.padEnd(7)} ${findingsLine(scenario)} ${chalk.dim(`${scenario.durationMs} ms`)}`,
    );
  }
  lines.push("");

  if (summary.skipped.length) {
    lines.push(chalk.bold("Not measured (skipped coverage)") + chalk.dim(` ${summary.skipped.length}`));
    for (const skipped of summary.skipped) lines.push(`  ${chalk.yellow("•")} ${skipped.id} ${chalk.dim(`(${skipped.stack})`)} ${chalk.dim(skipped.reason)}`);
    lines.push("");
  }

  if (summary.knownMisses.length || summary.outdatedKnownMisses.length) {
    lines.push(chalk.bold("Documented misses"));
    for (const miss of summary.knownMisses) lines.push(`  ${chalk.dim("·")} ${miss} ${chalk.dim("expected to be missed; recorded limit")}`);
    for (const stale of summary.outdatedKnownMisses) lines.push(`  ${chalk.yellow("!")} ${stale} ${chalk.yellow("now detected — update the fixture and this document")}`);
    lines.push("");
  }

  if (summary.knownFalsePositives.length || summary.staleFalsePositives.length) {
    lines.push(chalk.bold("Documented false positives") + chalk.dim(" (kept out of precision)"));
    for (const found of summary.knownFalsePositives) lines.push(`  ${chalk.dim("·")} ${found} ${chalk.dim("reported by design; recorded limit")}`);
    for (const stale of summary.staleFalsePositives) lines.push(`  ${chalk.yellow("!")} ${stale} ${chalk.yellow("no longer reported — the rule or fixture changed; update it")}`);
    lines.push("");
  }

  if (summary.noise) {
    const categories = [
      ...new Set(
        report.scenarios
          .filter((scenario) => scenario.kind === "fixed" || scenario.kind === "benign")
          .flatMap((scenario) => scenario.noise),
      ),
    ].sort();
    lines.push(`${chalk.bold("Other findings on clean fixtures")} ${summary.noise} ${chalk.dim(`(${categories.join(", ")} — shown, not scored)`)}`);
    lines.push("");
  }

  if (summary.crashes.length) {
    lines.push(chalk.bold(chalk.red("Crashes")));
    for (const crash of summary.crashes) lines.push(`  ${crash.id}: ${crash.error}`);
    lines.push("");
  }

  lines.push(chalk.dim("Limits:"));
  for (const limit of report.limits) lines.push(chalk.dim(`  - ${limit}`));
  return lines.join("\n");
}

function kindCounts(scenarios: ScenarioResult[]): string {
  const order: BenchKind[] = ["vulnerable", "fixed", "benign", "known-miss", "known-false-positive", "unsupported", "broken"];
  const counts = order
    .map((kind) => [kind, scenarios.filter((scenario) => scenario.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind}`);
  return counts.join(", ");
}

export function renderBenchMarkdown(report: BenchReport): string {
  const summary = report.summary;
  const root = path.relative(process.cwd(), report.root) || ".";
  const lines: string[] = [];
  lines.push("## Measured result", "");
  lines.push(`- **Fixtures**: ${summary.scenarios} — ${kindCounts(report.scenarios)}`);
  lines.push(`- **Expected findings**: ${summary.expectedFindings}; detected ${summary.detectedFindings}; missed ${summary.missedFindings}`);
  const claims = summary.detectedFindings + summary.falsePositives;
  lines.push(`- **Precision**: ${pct(summary.precision)} (${summary.detectedFindings} detected / ${claims} claim${claims === 1 ? "" : "s"} on scored fixtures)`);
  lines.push(`- **Recall**: ${pct(summary.recall)} (${summary.detectedFindings} / ${summary.expectedFindings} expected findings)`);
  lines.push(`- **False passes**: ${summary.falsePasses} (a vulnerable fixture that produced no finding at all)`);
  lines.push(`- **Runtime**: ${summary.durationMs} ms for the whole set, in-process`);
  lines.push(`- **Coverage**: ${report.coverage}; other stacks are reported as skipped`);
  lines.push("- **Reproduce**: `pitstop bench` — fixtures live in `" + root + "/scenarios/<id>/`");
  lines.push("");

  lines.push("### Scenarios", "");
  lines.push("| Scenario | Kind | Stack | Verdict | Findings | ms |");
  lines.push("|---|---|---|---|---|---|");
  for (const scenario of report.scenarios) {
    const findings = [...new Set(scenario.reported.map((finding) => finding.category))].join(", ") || (scenario.verdict === "skipped" ? "not measured" : "none");
    lines.push(`| ${scenario.id} | ${scenario.kind} | ${scenario.stack} | ${scenario.verdict} | ${findings} | ${scenario.durationMs} |`);
  }
  lines.push("");

  if (summary.pairs.length) {
    lines.push("### Pairs", "");
    lines.push("| Vulnerable fixture | Fixed fixture | Result |");
    lines.push("|---|---|---|");
    for (const pair of summary.pairs) lines.push(`| ${pair.vulnerable} | ${pair.fixed} | ${pair.status} |`);
    lines.push("");
  }

  lines.push("### Not measured", "");
  if (!summary.skipped.length) lines.push("None: every fixture ran against a covered stack.");
  else {
    lines.push("| Fixture | Stack | Why |");
    lines.push("|---|---|---|");
    for (const skipped of summary.skipped) lines.push(`| ${skipped.id} | ${skipped.stack} | ${skipped.reason} |`);
  }
  lines.push("");

  if (summary.knownMisses.length || summary.outdatedKnownMisses.length) {
    lines.push("### Documented misses", "");
    for (const miss of summary.knownMisses) lines.push(`- \`${miss}\` — expected to be missed; this is a recorded limit, not a pass.`);
    for (const stale of summary.outdatedKnownMisses) lines.push(`- \`${stale}\` — now detected; update the fixture and this document.`);
    lines.push("");
  }

  if (summary.knownFalsePositives.length || summary.staleFalsePositives.length) {
    lines.push("### Documented false positives", "");
    for (const found of summary.knownFalsePositives) lines.push(`- \`${found}\` — reported by design; kept out of precision rather than hidden.`);
    for (const stale of summary.staleFalsePositives) lines.push(`- \`${stale}\` — no longer reported; the rule or fixture changed, update it.`);
    lines.push("");
  }

  lines.push("### Limits", "");
  for (const limit of report.limits) lines.push(`- ${limit}`);
  lines.push("");
  return lines.join("\n");
}
