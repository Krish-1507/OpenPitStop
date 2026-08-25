import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import {
  runHoldoutSuite,
  sealHoldoutResults,
  checkHoldoutEvidence,
} from "../verify/holdout.js";
import { addEntry } from "../memory/store.js";

/**
 * `pitstop holdout-verify` — FINAL holdout verification (anti-overfitting).
 *
 * AGENT-VISIBILITY CONTRACT for this command's output:
 *   visible   — suite id/hash, per-check ids, per-check verdicts, overall verdict
 *   REDACTED  — holdout commands, expected values, stdout/stderr, injection paths
 * Full unredacted evidence is sealed OUTSIDE the repo (next to the holdout
 * suite), where an iterating agent receives no feedback from it.
 */
export const holdoutVerify = new Command("holdout-verify")
  .description(
    "Final HOLDOUT verification (anti-overfitting): run a hidden verification suite — defined " +
      "OUTSIDE the repository — against a fresh isolated worktree of the candidate commit. The " +
      "agent never sees the holdout during iteration and cannot modify it; output is redacted to " +
      "ids + verdicts. With --baseline, the suite must FAIL there and PASS on the candidate.",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption(
    "--suite <dir-or-id>",
    "holdout suite: a directory containing holdout.json, or an id under PITSTOP_HOLDOUT_HOME (default ~/.openpitstop/holdouts/<id>)",
  )
  .option("--candidate <ref>", "candidate commit/ref to verify (default: HEAD)", "HEAD")
  .option("--baseline <ref>", "baseline commit/ref that must FAIL the holdout (proves the suite can discriminate)")
  .option("--timeout <ms>", "per-check timeout override in ms")
  .option("--evidence-out <dir>", "where full unredacted evidence is sealed (default: <suite>/evidence)")
  .option("--json", "machine-readable REDACTED output (still no holdout contents)")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    const result = await runHoldoutSuite({
      repo,
      suiteSpec: opts.suite,
      candidateRef: opts.candidate,
      baselineRef: opts.baseline,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    });

    // seal BEFORE printing: summary into .pitstop (redacted), full evidence outside the repo
    let fullEvidencePath = result.fullEvidencePath;
    if (result.suiteDir) {
      const sealed = sealHoldoutResults(result);
      fullEvidencePath = sealed.fullEvidencePath;
      if (opts.evidenceOut) {
        // move the full evidence file into the requested directory
        const destDir = path.resolve(opts.evidenceOut);
        fs.mkdirSync(destDir, { recursive: true });
        const dest = path.join(destDir, path.basename(sealed.fullEvidencePath));
        fs.renameSync(sealed.fullEvidencePath, dest);
        result.fullEvidencePath = dest;
        fullEvidencePath = dest;
      }
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            repo: result.repo,
            suite: { id: result.suiteId, hash: result.suiteHash },
            candidate: { ref: result.candidateRef, sha: result.candidateSha },
            baseline: { ref: result.baselineRef, sha: result.baselineSha, discriminative: result.baselineDiscriminative },
            checks: result.checks.map((c) => ({
              id: c.id,
              severity: c.severity,
              candidatePass: c.candidate.pass,
              baselineFail: c.baseline ? !c.baseline.pass : null,
            })),
            verdict: result.verdict,
            reasons: result.reasons,
            notes: result.notes,
            summaryPath: result.summaryPath,
            fullEvidencePath,
          },
          null,
          2,
        ),
      );
    } else {
      const paint =
        result.verdict === "HOLDOUT_PASS"
          ? chalk.green
          : result.verdict === "HOLDOUT_FAIL"
            ? chalk.red
            : result.verdict === "HOLDOUT_UNPROVEN"
              ? chalk.yellow
              : chalk.red;

      console.log(
        boxen(
          `${chalk.bold("suite:")} ${chalk.cyan(result.suiteId)}${result.suiteHash ? chalk.dim(`  (hash ${result.suiteHash.slice(0, 12)}…)`) : ""}\n` +
            `${chalk.bold("candidate:")} ${result.candidateRef} @ ${chalk.dim(result.candidateSha.slice(0, 12))}…  ` +
            `${chalk.bold("baseline:")} ${result.baselineRef ?? chalk.dim("none")}` +
            (result.baselineSha ? chalk.dim(` @ ${result.baselineSha.slice(0, 12)}…`) : "") +
            "\n\n" +
            `${chalk.bold("holdout checks (redacted — details are sealed, not shown):")}\n` +
            result.checks
              .map((c) => {
                const mark = c.candidate.pass ? chalk.green("PASS ✓") : chalk.red("FAIL ✗");
                const base = c.baseline ? (c.baseline.pass ? chalk.dim("  baseline: PASS") : chalk.dim("  baseline: FAIL")) : "";
                return `  · ${c.id} [${c.severity}]  ${mark}${base}`;
              })
              .join("\n"),
          { title: " HOLDOUT — FINAL VERIFICATION ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: result.verdict === "HOLDOUT_PASS" ? "green" : "yellow" },
        ),
      );

      console.log(
        boxen(
          `${paint(chalk.bold(result.verdict))}\n\n` +
            result.reasons.map((r) => `· ${r}`).join("\n") +
            (result.notes.length ? "\n\n" + result.notes.map((n) => chalk.dim(`· ${n}`)).join("\n") : "") +
            `\n\n${chalk.dim("visible checks passing ≠ requirement satisfied — the holdout was hidden from the agent")}`,
          {
            title: " VERDICT ",
            titleAlignment: "center",
            borderStyle: "double",
            padding: 1,
            borderColor:
              result.verdict === "HOLDOUT_PASS" ? "green" : result.verdict === "HOLDOUT_UNPROVEN" ? "yellow" : "red",
          },
        ),
      );

      if (result.summaryPath) {
        console.log(chalk.dim(`\nRedacted sealed summary (agent-visible): ${result.summaryPath}`));
        console.log(chalk.dim(`Full unredacted evidence (outside the repo): ${fullEvidencePath ?? "n/a"}\n`));
        const ev = checkHoldoutEvidence(result.summaryPath);
        if (ev.status !== "verified") console.log(chalk.red(`Summary evidence check: ${ev.status} — ${ev.reason}`));
      }
    }

    addEntry(repo, {
      type: "fix",
      summary: `holdout-verify ${result.suiteId}: ${result.verdict}`,
      context: `suite ${result.suiteHash.slice(0, 12)} · candidate ${result.candidateRef} · baseline ${result.baselineRef ?? "none"}`,
    });

    process.exitCode =
      result.verdict === "HOLDOUT_PASS"
        ? 0
        : result.verdict === "HOLDOUT_FAIL"
          ? 1
          : result.verdict === "HOLDOUT_UNPROVEN"
            ? 2
            : 3;
  });

export default holdoutVerify;
