import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import {
  buildEvidenceChain,
  renderExplain,
  sealEvidenceChain,
  canonicalChain,
} from "../verify/chain.js";
import { addEntry } from "../memory/store.js";

/**
 * `pitstop explain` — the unified, explainable VERIFICATION EVIDENCE CHAIN.
 *
 * Answers "why should I trust this verdict?" by aggregating the REAL sealed
 * evidence documents in .pitstop/ into one chain. Only components that actually
 * ran appear with a real status; never-run components are NOT_CONFIGURED;
 * skipped tools are SKIPPED; tampered evidence is TAMPERED and blocks.
 */
export const explain = new Command("explain")
  .description(
    "Explain the verdict: build the unified evidence chain from every sealed verification " +
      "document in .pitstop/ (baseline, state, tests, acceptance, security, regression, " +
      "integrity, verifier health, holdout), re-verify each seal, and show exactly WHY the " +
      "verdict is VERIFIED / BLOCKED / UNPROVEN. Never fabricates a pass for a skipped check.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "machine-readable chain")
  .option("--verbose", "show per-item command, timestamps, evidence references and reasons")
  .action(async (repoArg: string, opts: { json?: boolean; verbose?: boolean }) => {
    const repo = path.resolve(repoArg);
    const chain = buildEvidenceChain(repo);
    const sealed = sealEvidenceChain(chain);

    if (opts.json) {
      console.log(JSON.stringify({
        repo: chain.repo,
        verdict: chain.verdict,
        summary: chain.summary,
        reasons: chain.reasons,
        items: chain.items,
        canonical: canonicalChain(chain),
        sealedPath: sealed.path,
        evidenceDigest: sealed.evidence.digest,
      }, null, 2));
    } else {
      console.log(
        boxen(renderExplain(chain, opts.verbose === true), {
          title: " PITSTOP — EVIDENCE CHAIN ",
          titleAlignment: "center",
          borderStyle: "double",
          padding: 1,
          borderColor: chain.verdict === "VERIFIED" ? "green" : chain.verdict === "BLOCKED" ? "red" : "yellow",
        }),
      );
      console.log(chalk.dim(`\nSealed chain written to ${sealed.path} (digest ${sealed.evidence.digest.slice(0, 12)}…)`));
      if (!opts.verbose) {
        console.log(chalk.dim("re-run with --verbose for per-item commands, timestamps, evidence digests and reasons\n"));
      }
    }

    addEntry(repo, {
      type: "fix",
      summary: `explain: ${chain.verdict} (${chain.summary.passed}/${chain.summary.total} items passed)`,
      context: chain.reasons.join("; ").slice(0, 200),
    });

    process.exitCode = chain.verdict === "VERIFIED" ? 0 : chain.verdict === "BLOCKED" ? 1 : 2;
  });

export default explain;
