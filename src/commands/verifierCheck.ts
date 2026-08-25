import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import {
  checkVerifier,
  sealVerifierResult,
  checkVerifierEvidence,
  parseMutateWrite,
  parseMutateInline,
  parseMutateDelete,
  type Mutation,
  type VerifierCaseResult,
  type VerifierHealth,
} from "../verify/verifier.js";
import { addEntry } from "../memory/store.js";

const MARK = (expected: string, actual: string) =>
  expected === actual ? chalk.green("✓") : chalk.red("✗");

function renderCase(c: VerifierCaseResult): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold(c.label + ":")}`);
  lines.push(`  state: ${chalk.cyan(c.source)}`);
  if (c.commitSha) lines.push(`  commit: ${chalk.dim(c.commitSha.slice(0, 12))}…`);
  if (c.mutations && c.mutations.length > 0) {
    lines.push(`  ${chalk.bold("mutation(s) applied:")}`);
    for (const m of c.mutations) {
      lines.push(
        `    · ${m.op} ${chalk.cyan(m.path)}${m.contentHash ? chalk.dim(` (content ${m.contentHash.slice(0, 10)}…)`) : ""}`,
      );
    }
  }
  lines.push(`  expected: ${chalk.dim(c.expected)}   actual: ${MARK(c.expected, c.actual) + " " + (c.actual === c.expected ? chalk.green(c.actual) : chalk.red(c.actual))}`);
  if (c.exitCode !== null) lines.push(`  exit code: ${c.exitCode}`);
  const tail = (c.actual !== c.expected ? c.stderr || c.stdout : "").trim();
  if (tail) {
    const excerpt = tail.split(/\r?\n/).filter(Boolean).slice(0, 3).join("\n    ");
    lines.push(chalk.dim(`  output (excerpt):\n    ${excerpt}`));
  }
  return lines.join("\n");
}

export const verifierCheck = new Command("verifier-check")
  .description(
    "Verifier self-test (falsifiability): prove a verification can actually say NO. Runs the " +
      "verification on a KNOWN-GOOD state (must PASS) and a KNOWN-BAD state (must FAIL) in isolated " +
      "temp worktrees. VERIFIER_VALID = falsifiable; VERIFIER_WEAK = known-bad also passes; " +
      "VERIFIER_BROKEN = known-good fails. The user's working tree is never mutated.",
  )
  .argument("[repo]", "path to the repo", ".")
  .requiredOption("--command <cmd>", "the verification command to validate (run inside the worktree)")
  .option("--id <id>", "verifier identifier (default: derived from command)", "")
  .option("--good-ref <ref>", "ref the verification should PASS on", "HEAD")
  .option("--bad-ref <ref>", "explicit known-bad ref (alternative to --mutate-*)")
  .option("--mutate-write <path>=<fixture-file>", "known-bad mutation: write fixture content to path (repeatable)", collect, [])
  .option("--mutate <path>=<inline-content>", "known-bad mutation: write inline content to path (repeatable)", collect, [])
  .option("--mutate-delete <path>", "known-bad mutation: delete path (repeatable)", collect, [])
  .option("--test-file <file>", "verification identity file (repeatable)", collect, [])
  .option("--config <file>", "verification config file (repeatable)", collect, [])
  .option("--timeout <ms>", "per-run timeout in ms", "120000")
  .option("--json", "machine-readable output")
  .action(
    async (
      repoArg: string,
      opts: {
        command: string;
        id?: string;
        goodRef?: string;
        badRef?: string;
        mutateWrite: string[];
        mutate: string[];
        mutateDelete: string[];
        testFile: string[];
        config: string[];
        timeout?: string;
        json?: boolean;
      },
    ) => {
      const repo = path.resolve(repoArg);
      const mutations: Mutation[] = [];
      let invalid: string | null = null;
      for (const spec of opts.mutateWrite) {
        const m = parseMutateWrite(spec, process.cwd());
        if (!m) {
          invalid = `--mutate-write "${spec}" — fixture file not readable (expected path=fixture-file)`;
          break;
        }
        mutations.push(m);
      }
      if (!invalid) {
        for (const spec of opts.mutate) {
          const m = parseMutateInline(spec);
          if (!m) {
            invalid = `--mutate "${spec}" — expected path=content`;
            break;
          }
          mutations.push(m);
        }
      }
      if (!invalid) {
        for (const p of opts.mutateDelete) mutations.push(parseMutateDelete(p));
      }
      if (invalid) {
        console.log(chalk.red(`invalid fixture: ${invalid}`));
        process.exitCode = 1;
        return;
      }

      let result = await checkVerifier({
        repo,
        def: {
          id: opts.id || `cmd:${opts.command.slice(0, 48)}`,
          command: opts.command,
          goodRef: opts.goodRef,
          badRef: opts.badRef,
          mutations,
          testFiles: opts.testFile.length ? opts.testFile : undefined,
          configFiles: opts.config.length ? opts.config : undefined,
          timeoutMs: Number(opts.timeout) || 120000,
        },
      });
      result = sealVerifierResult(result);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              repo: result.repo,
              commitSha: result.commitSha,
              verifier: result.verifier,
              verdict: result.verdict,
              reasons: result.reasons,
              notes: result.notes,
              good: result.good,
              bad: result.bad,
              sealedPath: result.sealedPath,
            },
            null,
            2,
          ),
        );
      } else {
        if (result.good) {
          const ok = result.good.actual === result.good.expected;
          console.log(
            boxen(renderCase(result.good), {
              title: ` KNOWN-GOOD ${ok ? "PASS ✓" : "UNEXPECTED"} `,
              titleAlignment: "center",
              borderStyle: "round",
              padding: 1,
              borderColor: ok ? "green" : "red",
            }),
          );
        }
        if (result.bad) {
          const ok = result.bad.actual === result.bad.expected;
          console.log(
            boxen(renderCase(result.bad), {
              title: ` KNOWN-BAD ${ok ? "FAIL ✓" : "NOT DETECTED"} `,
              titleAlignment: "center",
              borderStyle: "round",
              padding: 1,
              borderColor: ok ? "green" : "red",
            }),
          );
        }
        if (result.verdict === "INTEGRITY_FAILURE") {
          console.log(
            boxen(
              `${chalk.bold("INTEGRITY_FAILURE")}\n\n${result.reasons.map((r) => `· ${r}`).join("\n")}`,
              { title: " VERIFIER CHECK ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: "red" },
            ),
          );
        } else {
          const color: any =
            result.verdict === "VERIFIER_VALID" ? "green" : result.verdict === "VERIFIER_WEAK" ? "yellow" : "red";
          console.log(
            boxen(
              `${chalk.bold(result.verdict)}\n\n` +
                `known-good: ${result.good!.expected} expected → ${result.good!.actual} actual\n` +
                `known-bad:  ${result.bad!.expected} expected → ${result.bad!.actual} actual\n\n` +
                result.reasons.map((r) => `· ${r}`).join("\n") +
                (result.notes.length ? "\n\n" + result.notes.map((n) => chalk.dim(`· ${n}`)).join("\n") : "") +
                `\n\n${chalk.dim("falsifiable = the verifier CAN say NO; this proves the harness, not full coverage")}`,
              { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: color },
            ),
          );
        }
        if (result.sealedPath) {
          console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
          const ev = checkVerifierEvidence(result.sealedPath);
          if (ev.status !== "verified") console.log(chalk.red(`Evidence check: ${ev.status} — ${ev.reason}`));
        }
      }

      addEntry(repo, {
        type: "fix",
        summary: `verifier-check ${result.verifier.id}: ${result.verdict}`,
        context: result.reasons.join("; ").slice(0, 200),
      });

      process.exitCode =
        result.verdict === "VERIFIER_VALID" ? 0 : result.verdict === "VERIFIER_WEAK" ? 1 : result.verdict === "VERIFIER_BROKEN" ? 1 : 3;
    },
  );

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export default verifierCheck;
