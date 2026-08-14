import path from "node:path";
import fs from "node:fs";
import { runTestFile, detectTestFramework, frameworkLabel } from "./framework.js";
import { preloadPath } from "./generate.js";
import { penPreloadPath } from "./pen.js";

export interface ReproRunResult {
  ran: boolean;
  passed?: boolean;
  /** Relative path of the test file that ran. */
  file?: string;
  /** Exit code from the runner. */
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  framework?: string;
}

/**
 * run.ts — execute a generated repro test against the repo's own test
 * framework, feeding it everything it needs (e.g. the absolute path to the
 * ledger sandbox preload, set so the committed test stays runnable in CI).
 */
export function runRepro(repo: string, file: string): Promise<ReproRunResult> {
  const abs = path.join(repo, file);
  if (!fs.existsSync(abs)) {
    return Promise.resolve({
      ran: false,
      stdout: "",
      stderr: `repro test file not found: ${abs}`,
    });
  }
  const framework = detectTestFramework(repo);
  const extra: Record<string, string> = {
    PITSTOP_LEDGER_PRELOAD: preloadPath(),
    PITSTOP_PEN_PRELOAD: penPreloadPath(),
  };
  return runTestFile(repo, abs, extra, 150000).then((r) => ({
    ran: true,
    passed: r.timedOut ? false : r.code === 0,
    file,
    exitCode: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
    timedOut: r.timedOut,
    framework: frameworkLabel(framework),
  }));
}