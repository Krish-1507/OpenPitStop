import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import {
  verifyAcceptance,
  sealAcceptanceResult,
  checkAcceptanceEvidence,
} from "../verify/acceptance.js";
import { addEntry } from "../memory/store.js";

const MARK = (pass: boolean | null) =>
  pass === null ? chalk.yellow("?") : pass ? chalk.green("✓") : chalk.red("✗");

export const acceptanceVerify = new Command("acceptance-verify")
  .description(
    "Requirement / acceptance verification: verify the agent satisfied the ORIGINAL TASK " +
      "requirements via a structured acceptance contract (deterministic criteria: command, http, " +
      "fileExists, fileContains) — never the agent's self-report and never an LLM judge. In-repo " +
      "contracts are hash-pinned; changes are INTEGRITY_FAILURE until re-authorized with --authorize. " +
      "With --baseline, the contract must discriminate (fail there, pass on the candidate).",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption(
    "--contract <dir|file|id>",
    "acceptance contract: a path to acceptance.json (or a dir containing it) or an id under PITSTOP_ACCEPTANCE_HOME (default ~/.openpitstop/acceptance/<id>)",
  )
  .option("--candidate <ref>", "candidate commit/ref to verify (default: HEAD)", "HEAD")
  .option("--baseline <ref>", "baseline commit/ref — criteria passing there do not count as evidence of the agent's work")
  .option("--authorize", "explicitly re-authorize a changed in-repo contract (pins the new version)")
  .option("--timeout <ms>", "per-criterion / app-boot timeout in ms")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);

    let result = await verifyAcceptance({
      repo,
      contractSpec: opts.contract,
      candidateRef: opts.candidate,
      baselineRef: opts.baseline,
      authorize: opts.authorize,
      timeoutMs: opts.timeout ? Number(opts.timeout) : undefined,
    });
    result = sealAcceptanceResult(result);

    if (opts.json) {
      console.log(JSON.stringify({
        repo: result.repo,
        contract: { id: result.contractId, path: result.contractPath, hash: result.contractHash, external: result.contractExternal },
        candidate: { ref: result.candidateRef, sha: result.candidateSha },
        baseline: { ref: result.baselineRef, sha: result.baselineSha },
        requirements: result.requirements,
        evidence: result.evidence,
        verdict: result.verdict,
        reasons: result.reasons,
        notes: result.notes,
        discriminative: result.discriminative,
        totalCriteria: result.totalCriteria,
        sealedPath: result.sealedPath,
      }, null, 2));
    } else {
      const verified = result.evidence.filter((e) => e.pass === true).length;
      const lines: string[] = [`${chalk.bold("ACCEPTANCE")}`, ""];
      for (const r of result.requirements) {
        const mark = MARK(r.satisfied);
        lines.push(`${mark} ${chalk.bold(r.id)}${r.description ? chalk.dim(` — ${r.description}`) : ""}`);
        for (const c of result.evidence.filter((e) => e.requirementId === r.id)) {
          lines.push(`    ${MARK(c.pass)} ${chalk.dim(c.criterionId)} [${c.type}]  ${chalk.dim(c.observed.slice(0, 110))}`);
        }
      }
      lines.push("");
      lines.push(`${chalk.bold("Evidence:")} ${verified}/${result.totalCriteria} criteria verified` +
        (result.baselineRef ? chalk.dim(` · ${result.discriminative} discriminate vs baseline ${result.baselineRef}`) : chalk.dim(" · no baseline supplied")));
      console.log(
        boxen(lines.join("\n"), {
          title: ` PITSTOP — ACCEPTANCE ${result.contractId} `,
          titleAlignment: "center",
          borderStyle: "round",
          padding: 1,
          borderColor: result.verdict === "SATISFIED" ? "green" : result.verdict === "NOT_SATISFIED" ? "red" : "yellow",
        }),
      );
      const color: any =
        result.verdict === "SATISFIED" ? "green" : result.verdict === "NOT_SATISFIED" ? "red" : "yellow";
      console.log(
        boxen(
          `${chalk.bold(result.verdict)}\n\n` +
            result.reasons.map((r) => `· ${r}`).join("\n") +
            (result.notes.length ? "\n\n" + result.notes.map((n) => chalk.dim(`· ${n}`)).join("\n") : "") +
            `\n\n${chalk.dim("the contract — not the agent — defines success; criteria are deterministic and observable")}`,
          { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: color },
        ),
      );
      if (result.sealedPath) {
        console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
        const ev = checkAcceptanceEvidence(result.sealedPath);
        if (ev.status !== "verified") console.log(chalk.red(`Evidence check: ${ev.status} — ${ev.reason}`));
      }
    }

    addEntry(repo, {
      type: "fix",
      summary: `acceptance-verify ${result.contractId}: ${result.verdict}`,
      context: `${result.discriminative}/${result.totalCriteria} criteria discriminate · candidate ${result.candidateRef} · baseline ${result.baselineRef ?? "none"}`,
    });

    process.exitCode =
      result.verdict === "SATISFIED" ? 0 : result.verdict === "NOT_SATISFIED" ? 1 : result.verdict === "UNPROVEN" ? 2 : 3;
  });

export default acceptanceVerify;
