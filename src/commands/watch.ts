import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { newestModifiedFile } from "../analyzers/util.js";
import { tryScan } from "./try.js";
import { persistScan } from "./scan.js";
import { stampFindings } from "../repro/ids.js";
import { correlate } from "../graph/correlate.js";
import { computeScore } from "../report/score.js";

/**
 * `pitstop watch` — the live shield.
 *
 * Polls the working tree; the moment a file changes it runs the fast static
 * pass and prints the score delta + any new security issues. A dev server's
 * worth of feedback with a `try`-scan's worth of cost. Ctrl+C stops it.
 */
export const watch = new Command("watch")
  .description(
    "Live shield: poll the repo and re-run the fast static pass whenever a file changes, " +
      "printing the score delta and any new security issues. Ctrl+C stops.",
  )
  .argument("[repo]", "path to the repo to watch (default: current dir)", ".")
  .option("--interval <ms>", "poll interval in ms (default 10000)", "10000")
  .action(async (repoArg: string, options: { interval?: string }) => {
    const repo = path.resolve(repoArg);
    const interval = Math.max(2000, Math.floor(Number(options.interval) || 10000));

    let lastMtime = newestModifiedFile(repo)?.mtimeMs ?? 0;
    let lastScore: number | null = null;
    let lastSecrets = 0;

    console.log(
      chalk.cyan(`\nWatching ${repo} (every ${interval}ms — Ctrl+C to stop)\n`),
    );

    const tick = async () => {
      const now = newestModifiedFile(repo);
      if (!now || now.mtimeMs === lastMtime) return;
      lastMtime = now.mtimeMs;
      const changed = path.relative(repo, now.file).replace(/\\/g, "/");

      const t0 = performance.now();
      let line: string;
      try {
        const result = await tryScan(repo);
        stampFindings(result);
        result.clusters = correlate(repo, result).clusters;
        persistScan(repo, result);

        const sc = computeScore(result);
        const secrets = result.security.status === "ok" ? result.security.issues.length : 0;
        const newSecrets = secrets > lastSecrets ? ` · ${chalk.red(`+${secrets - lastSecrets} security`)}` : "";
        const delta =
          lastScore != null
            ? sc.score - lastScore >= 0
              ? chalk.green(`(+${sc.score - lastScore})`)
              : chalk.red(`(${sc.score - lastScore})`)
            : "";
        line = `${new Date().toISOString().slice(11, 19)} score ${sc.score}/100 (${sc.grade})${delta} · security ${secrets}${newSecrets} · changed ${changed} · ${Math.round(performance.now() - t0)}ms`;
        lastScore = sc.score;
        lastSecrets = secrets;
      } catch (err: any) {
        line = `${new Date().toISOString().slice(11, 19)} scan failed on ${changed}: ${(err as Error).message}`;
      }
      console.log(line);
    };

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => void tick(), interval);
      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log(chalk.dim("\nwatch stopped — baseline refreshed with every change."));
        resolve();
      });
    });
  });

export default watch;
