import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import {
  verifyStateClaims,
  sealStateResult,
  writeStateSnapshot,
  readStateSnapshot,
  checkStateEvidence,
  parseClaim,
  type StateClaim,
  type ClaimVerification,
} from "../verify/state.js";
import { addEntry } from "../memory/store.js";

const CHECK = (ok: boolean | null) =>
  ok === null ? chalk.dim("n/a") : ok ? chalk.green("✓") : chalk.red("✗");

function renderClaim(c: ClaimVerification): string {
  const lines: string[] = [];
  lines.push(`${chalk.bold("claim:")}`);
  lines.push(`  ${c.claim.op} ${chalk.cyan(c.claim.path)}`);
  lines.push(`${chalk.bold("observed:")}`);
  for (const s of c.signals) {
    const pad = " ".repeat(Math.max(1, 18 - s.name.length));
    lines.push(`  ${s.name}${pad}${CHECK(s.ok)}${s.note ? chalk.dim(`  (${s.note})`) : ""}`);
  }
  if (c.beforeKnown && c.before) {
    lines.push(
      chalk.dim(
        `  before: ${c.before.exists ? `hash ${c.before.hash?.slice(0, 12)}… · ${c.before.lineCount} lines` : "absent"}`,
      ),
    );
  } else {
    lines.push(chalk.dim("  before: unknown (no snapshot, not tracked at HEAD)"));
  }
  if (c.after.exists) {
    lines.push(
      chalk.dim(
        `  after:  hash ${c.after.hash?.slice(0, 12) ?? "n/a (too large)"}… · ${c.after.lineCount} lines`,
      ),
    );
  } else {
    lines.push(chalk.dim("  after:  absent"));
  }
  const paint =
    c.status === "OK" ? chalk.green : c.status === "MISMATCH" ? chalk.red : chalk.yellow;
  lines.push(`  ${chalk.bold("result:")} ${paint(c.status)}`);
  for (const r of c.reasons) lines.push(chalk.red(`    · ${r}`));
  for (const n of c.notes) lines.push(chalk.dim(`    · ${n}`));
  return lines.join("\n");
}

export const stateVerify = new Command("state-verify")
  .description(
    "Independent EXTERNAL STATE verification: do NOT trust the agent's claim — inspect the actual " +
      "filesystem + git state. Verifies structured claims (created/modified/deleted:<path>) against " +
      "disk content hashes, git status and HEAD. Proves THAT a change occurred, not that the code is correct.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--claim <op:path>", "claim to verify, e.g. modified:src/auth.ts (repeatable)", collect, [])
  .option("--path <file>", "path to snapshot in --snapshot mode (repeatable)", collect, [])
  .option("--before <file>", "sealed snapshot file (.pitstop/state-snapshot-*.json) as the before-state")
  .option("--snapshot", "write a sealed before-snapshot of --path files instead of verifying")
  .option("--json", "machine-readable output")
  .action(
    async (
      repoArg: string,
      opts: { claim: string[]; path: string[]; before?: string; snapshot?: boolean; json?: boolean },
    ) => {
      const repo = path.resolve(repoArg);

      // ---- snapshot mode: capture BEFORE state, seal it, done.
      if (opts.snapshot) {
        const paths = opts.path;
        if (paths.length === 0) {
          console.log(chalk.red("no --path given — nothing to snapshot"));
          process.exitCode = 1;
          return;
        }
        const { file } = writeStateSnapshot(repo, paths);
        if (opts.json) {
          console.log(JSON.stringify({ snapshot: file, paths }, null, 2));
        } else {
          console.log(
            boxen(
              `sealed BEFORE snapshot for:\n${paths.map((p) => `  · ${chalk.cyan(p)}`).join("\n")}\n\n${chalk.dim(file)}`,
              { title: " PITSTOP — State Snapshot ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "cyan" },
            ),
          );
        }
        return;
      }

      // ---- verify mode
      const claims: StateClaim[] = [];
      for (const raw of opts.claim) {
        const c = parseClaim(raw);
        if (!c) {
          console.log(
            chalk.red(`invalid claim "${raw}" — expected created:<path> | modified:<path> | deleted:<path>`),
          );
          process.exitCode = 1;
          return;
        }
        claims.push(c);
      }
      if (claims.length === 0) {
        console.log(chalk.red("no --claim given — e.g. --claim modified:src/auth.ts"));
        process.exitCode = 1;
        return;
      }

      const before = opts.before ? (readStateSnapshot(opts.before) ?? undefined) : undefined;
      if (opts.before && !before) {
        console.log(
          chalk.yellow(`⚠ supplied --before snapshot is missing or TAMPERED — falling back to git HEAD as before-state`),
        );
      }

      let result = verifyStateClaims(repo, claims, { before });
      result = sealStateResult(result);

      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              repo: result.repo,
              verdict: result.verdict,
              reasons: result.reasons,
              otherChangedFiles: result.otherChangedFiles,
              results: result.results.map((r) => ({
                claim: r.claim,
                status: r.status,
                before: r.beforeKnown ? r.before : null,
                after: r.after,
                signals: r.signals,
                reasons: r.reasons,
                notes: r.notes,
              })),
              sealedPath: result.sealedPath,
            },
            null,
            2,
          ),
        );
      } else {
        for (const r of result.results) {
          const border = r.status === "OK" ? "green" : r.status === "MISMATCH" ? "red" : "yellow";
          console.log(
            boxen(renderClaim(r), {
              title: " STATE CHECK ",
              titleAlignment: "center",
              borderStyle: "round",
              padding: 1,
              borderColor: border as any,
            }),
          );
        }
        const verdictColor =
          result.verdict === "STATE_VERIFIED"
            ? "green"
            : result.verdict === "STATE_MISMATCH"
              ? "red"
              : result.verdict === "UNPROVEN"
                ? "yellow"
                : "red";
        const extra =
          result.otherChangedFiles.length > 0
            ? `\n\n${chalk.dim("other working-tree changes: ")}${result.otherChangedFiles.slice(0, 8).join(", ")}${result.otherChangedFiles.length > 8 ? ", …" : ""}`
            : "";
        console.log(
          boxen(
            `${chalk.bold(result.verdict)}${result.reasons.length ? "\n\n" + result.reasons.map((r) => `· ${r}`).join("\n") : ""}${extra}\n\n${chalk.dim("this proves the state change occurred — NOT that the code is correct")}`,
            { title: " VERDICT ", titleAlignment: "center", borderStyle: "double", padding: 1, borderColor: verdictColor as any },
          ),
        );
        if (result.sealedPath) {
          console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
          const ev = checkStateEvidence(result.sealedPath);
          if (ev.status !== "verified") console.log(chalk.red(`Evidence check: ${ev.status} — ${ev.reason}`));
        }
      }

      addEntry(repo, {
        type: "fix",
        summary: `state-verify: ${result.verdict} (${claims.length} claim${claims.length === 1 ? "" : "s"})`,
        context: result.reasons.join("; ").slice(0, 200),
      });

      process.exitCode =
        result.verdict === "STATE_VERIFIED"
          ? 0
          : result.verdict === "STATE_MISMATCH"
            ? 1
            : result.verdict === "UNPROVEN"
              ? 2
              : 3;
    },
  );

function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

export default stateVerify;
