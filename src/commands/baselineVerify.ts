import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { baselineAwareVerify, checkBaselineEvidence } from "../verify/baseline.js";
import type { VerificationDef } from "../verify/baseline.js";
import { addEntry } from "../memory/store.js";

export const baselineVerify = new Command("baseline-verify")
  .description(
    "Baseline-aware verification: run the SAME verification against a known baseline " +
      "commit (must FAIL) and a candidate commit (must PASS), with tamper-evident evidence. " +
      "Establishes that the verification actually detects the original failure.",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption("--baseline <ref>", "baseline commit/ref that must demonstrate the expected failure")
  .option("--candidate <ref>", "candidate commit/ref to verify (default: HEAD)", "HEAD")
  .requiredOption("--command <cmd>", "verification command to run (e.g. 'npm test -- test/foo.test.js')")
  .option("--id <id>", "verification identifier (default: hash of command)", "")
  .option("--test-file <file>", "participating verification file (repeatable)", collect, [])
  .option("--config <file>", "participating config file (repeatable)", collect, [])
  .option("--timeout <ms>", "verification timeout in ms", "120000")
  .option("--expected-exit <code>", "expected baseline exit code (default: any non-zero)")
  .option("--expected-stdout <str>", "substring that must appear in baseline stdout")
  .option("--expected-stderr <str>", "substring that must appear in baseline stderr")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);
    const id = opts.id || `cmd:${opts.command.slice(0, 40)}`;
    const verification: VerificationDef = {
      id,
      command: opts.command,
      testFiles: opts.testFile?.length ? opts.testFile : undefined,
      configFiles: opts.config?.length ? opts.config : undefined,
      timeoutMs: Number(opts.timeout) || 120000,
      expectedFailure:
        opts.expectedExit != null || opts.expectedStdout || opts.expectedStderr
          ? {
              exitCode: opts.expectedExit != null ? Number(opts.expectedExit) : undefined,
              stdoutContains: opts.expectedStdout,
              stderrContains: opts.expectedStderr,
            }
          : undefined,
    };

    const result = await baselineAwareVerify({
      repo,
      baselineRef: opts.baseline,
      candidateRef: opts.candidate,
      verification,
    });

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repo,
            verification,
            baseline: result.baseline
              ? {
                  sha: result.baseline.commitSha,
                  exitCode: result.baseline.exitCode,
                  hash: result.baseline.verificationHash,
                }
              : null,
            candidate: result.candidate
              ? {
                  sha: result.candidate.commitSha,
                  exitCode: result.candidate.exitCode,
                  hash: result.candidate.verificationHash,
                }
              : null,
            integrity: result.integrity,
            verdict: result.verdict,
            reasons: result.reasons,
            sealedPath: result.sealedPath,
          },
          null,
          2,
        ),
      );
    } else {
      const baselineBox =
        result.baseline == null
          ? chalk.red("baseline checkout/execution failed")
          : `commit: ${chalk.cyan(result.baseline.commitSha.slice(0, 12))} (${opts.baseline})\n` +
            `verification: ${chalk.cyan(result.baseline.verificationId)}\n` +
            `command: ${chalk.dim(result.baseline.command)}\n` +
            `result: ${result.baseline.exitCode !== 0 ? chalk.red(`FAIL (exit ${result.baseline.exitCode})`) : chalk.green(`PASS (exit ${result.baseline.exitCode})`)}\n` +
            `hash: ${chalk.dim(result.baseline.verificationHash.slice(0, 12))}…\n` +
            `evidence: ${result.evidence.baseline?.status === "verified" ? chalk.green("SEALED") : chalk.red(result.evidence.baseline?.status ?? "missing")}`;

      const candidateBox =
        result.candidate == null
          ? chalk.red("candidate checkout/execution failed")
          : `commit: ${chalk.cyan(result.candidate.commitSha.slice(0, 12))} (${opts.candidate})\n` +
            `verification: ${chalk.cyan(result.candidate.verificationId)}\n` +
            `command: ${chalk.dim(result.candidate.command)}\n` +
            `result: ${result.candidate.exitCode === 0 ? chalk.green(`PASS (exit ${result.candidate.exitCode})`) : chalk.red(`FAIL (exit ${result.candidate.exitCode})`)}\n` +
            `hash: ${chalk.dim(result.candidate.verificationHash.slice(0, 12))}…\n` +
            `evidence: ${result.evidence.candidate?.status === "verified" ? chalk.green("SEALED") : chalk.red(result.evidence.candidate?.status ?? "missing")}`;

      const comparisonBox =
        `baseline: ${result.baseline ? (result.baseline.exitCode !== 0 ? chalk.red("FAIL") : chalk.green("PASS")) : chalk.dim("n/a")}\n` +
        `candidate: ${result.candidate ? (result.candidate.exitCode === 0 ? chalk.green("PASS") : chalk.red("FAIL")) : chalk.dim("n/a")}\n` +
        `verification identity: ${result.integrity.verificationIdentityUnchanged ? chalk.green("PASS") : chalk.red("MISMATCH")}\n` +
        `verification files changed: ${result.integrity.verificationFilesChanged ? chalk.red("YES") : chalk.green("no")}\n` +
        `changed files: ${result.integrity.changedFiles.length ? result.integrity.changedFiles.join(", ") : chalk.dim("none")}\n` +
        `integrity report: ${result.integrity.report ? result.integrity.report.verdict : chalk.dim("n/a")}`;

      const verdictColor =
        result.verdict === "VERIFIED"
          ? "green"
          : result.verdict === "FAILED"
            ? "red"
            : result.verdict === "UNPROVEN"
              ? "yellow"
              : "red";

      console.log(
        boxen(baselineBox, { title: " BASELINE ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: result.baseline?.exitCode !== 0 ? "yellow" : "red" }),
      );
      console.log(
        boxen(candidateBox, { title: " CANDIDATE ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: result.candidate?.exitCode === 0 ? "green" : "red" }),
      );
      console.log(
        boxen(comparisonBox, { title: " COMPARISON ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: result.integrity.verificationIdentityUnchanged ? "green" : "red" }),
      );
      console.log(
        boxen(
          `${chalk.bold(result.verdict)}${result.reasons.length ? "\n\n" + result.reasons.map((r) => `· ${r}`).join("\n") : ""}`,
          { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: verdictColor as any },
        ),
      );

      if (result.sealedPath) {
        console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
        const ev = checkBaselineEvidence(result.sealedPath);
        if (ev.status !== "verified") console.log(chalk.red(`Evidence check: ${ev.status} — ${ev.reason}`));
      }
    }

    // memory
    addEntry(repo, {
      type: "fix",
      summary: `baseline-verify ${verification.id}: ${result.verdict}`,
      context: `baseline ${opts.baseline} → ${result.baseline?.exitCode}, candidate ${opts.candidate} → ${result.candidate?.exitCode}, verdict ${result.verdict}`,
    });

    const code = result.verdict === "VERIFIED" ? 0 : result.verdict === "FAILED" ? 1 : result.verdict === "UNPROVEN" ? 2 : 3;
    process.exitCode = code;
  });

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export default baselineVerify;
