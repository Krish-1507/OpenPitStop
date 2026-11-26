import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { runBench, strictFailures } from "../bench/run.js";
import { renderBenchMarkdown, renderBenchReport } from "../bench/report.js";

function percent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;
}

/**
 * `pitstop bench` — run the reproducible detection benchmark and publish its numbers.
 * It measures the analyzer against fixtures you can read and change; it never tunes the
 * analyzer for them, and it never turns a missed detection into a passing verdict.
 */
export const bench = new Command("bench")
  .description(
    "Run the reproducible detection benchmark: vulnerable/fixed pairs, benign near-misses, " +
      "documented misses and uncovered stacks. Reports precision, recall, false passes and runtime " +
      "for the fixtures in the benchmark directory — a measurement, not a marketing claim.",
  )
  .argument("[dir]", "benchmark directory", "bench")
  .option("--json", "machine-readable report")
  .option("--markdown", "publishable markdown tables of the same results")
  .option("--filter <text>", "only scenarios whose id, title, stack or kind contains this text")
  .option("--strict", "exit non-zero when a recorded expectation is not met")
  .action(async (dir: string, opts: { json?: boolean; markdown?: boolean; filter?: string; strict?: boolean }) => {
    const root = path.resolve(dir);
    let report;
    try {
      report = await runBench(root, { filter: opts.filter });
    } catch (error) {
      console.log(chalk.red(`could not run the benchmark: ${(error as Error).message}`));
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (opts.markdown) {
      console.log("# Detection benchmark\n");
      console.log(renderBenchMarkdown(report));
    } else {
      console.log(renderBenchReport(report));
      const summary = report.summary;
      const failures = strictFailures(report);
      const color = failures.length ? "yellow" : "green";
      console.log(
        "\n" +
          boxen(
            `${chalk.bold(`${summary.detectedFindings}/${summary.expectedFindings}`)} expected findings detected · ` +
              `precision ${chalk.bold(percent(summary.precision))} · recall ${chalk.bold(percent(summary.recall))}\n` +
              `${summary.pairs.filter((pair) => pair.status === "discriminating").length}/${summary.pairs.length} pair(s) discriminating · ` +
              `${summary.falsePasses} false pass(es) · ${summary.skipped.length} skipped\n\n` +
              chalk.dim("this measures the fixtures in the benchmark directory, not the world — read the limits"),
            { title: " BENCHMARK ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: color as any },
          ),
      );
      if (failures.length) {
        console.log(chalk.yellow(`recorded expectations not met: ${failures.join(", ")}`));
        if (opts.strict) process.exitCode = 1;
      }
    }
  });

export default bench;
