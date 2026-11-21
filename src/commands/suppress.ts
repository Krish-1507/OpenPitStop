import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import type { ScanIssue, ScanResult } from "../analyzers/types.js";
import { enumerateFindings } from "../repro/ids.js";
import { findingFingerprint } from "../findings/schema.js";
import {
  addSuppression,
  flakyTestFingerprint,
  listSuppressions,
  removeSuppression,
  type SuppressionKind,
} from "../findings/suppressions.js";

const KINDS = new Set<SuppressionKind>(["false-positive", "accepted-risk", "suppressed"]);

function latestScan(repo: string): ScanResult | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, ".pitstop", "scan-latest.json"), "utf8").replace(/^\uFEFF/, "")) as ScanResult;
  } catch {
    return null;
  }
}

export const suppress = new Command("suppress")
  .description("Scope a finding dismissal with a reason and optional expiry; expired or changed-code dismissals stop applying")
  .argument("[id]", "finding id from pitstop scan/inspect")
  .option("--repo <path>", "repository containing the finding", ".")
  .option("--kind <kind>", "false-positive, accepted-risk, or suppressed", "suppressed")
  .option("--reason <text>", "required explanation recorded with the dismissal")
  .option("--rule <name>", "dismiss a rule/category instead of one finding")
  .option("--path <glob>", "restrict a rule dismissal to a repository path glob")
  .option("--expires <date>", "ISO date/timestamp after which the dismissal no longer applies")
  .option("--remove <suppression-id>", "remove a suppression by its sup-… id")
  .option("--list", "list active and expired suppressions")
  .option("--json", "machine-readable output")
  .action((id: string | undefined, opts: {
    repo: string; kind: string; reason?: string; rule?: string; path?: string;
    expires?: string; remove?: string; list?: boolean; json?: boolean;
  }) => {
    try {
      const repo = path.resolve(opts.repo);
      if (opts.list) {
        const entries = listSuppressions(repo);
        if (opts.json) console.log(JSON.stringify(entries, null, 2));
        else if (entries.length === 0) console.log(chalk.dim("No suppressions configured."));
        else for (const entry of entries) {
          const scope = entry.findingId ?? `${entry.rule}${entry.path ? ` @ ${entry.path}` : ""}`;
          console.log(`${entry.state === "active" ? chalk.green("active") : chalk.yellow("expired")} ${chalk.bold(entry.id)} ${entry.kind} ${scope}`);
          console.log(`  reason: ${entry.reason}${entry.expiresAt ? ` · expires: ${entry.expiresAt}` : ""}`);
        }
        return;
      }
      if (opts.remove) {
        const removed = removeSuppression(repo, opts.remove);
        console.log(opts.json ? JSON.stringify(removed, null, 2) : chalk.green(`Removed ${removed.id}. Run the check again to restore matching active findings.`));
        return;
      }
      if (!KINDS.has(opts.kind as SuppressionKind)) throw new Error("--kind must be false-positive, accepted-risk, or suppressed");
      if (!opts.reason?.trim()) throw new Error("--reason is required; dismissals must be explainable");

      let findingId: string | undefined;
      let fingerprint: string | undefined;
      if (opts.rule) {
        if (id) throw new Error("use either a finding id or --rule, not both");
      } else {
        if (!id) throw new Error("provide a finding id, or use --rule <name>");
        const scan = latestScan(repo);
        if (!scan) throw new Error("no scan found; run `pitstop check` or `pitstop scan` first");
        const finding = enumerateFindings(scan).find((candidate) => candidate.id === id);
        if (!finding) throw new Error(`finding "${id}" was not found in the latest active scan`);
        findingId = finding.id;
        const issue = finding.data as ScanIssue | undefined;
        if (finding.source === "graph" || finding.source === "ledger") {
          // These findings are identified by their evidence record, not a code line.
          fingerprint = finding.id;
        } else if (finding.source === "reliability" && finding.type === "flaky-test") {
          const flake = finding.data as { file?: string; name?: string } | undefined;
          fingerprint = flakyTestFingerprint(repo, flake?.file, flake?.name ?? finding.description);
        } else {
          fingerprint = issue?.fingerprint ?? (issue
            ? findingFingerprint(repo, issue, finding.source)
            : finding.id);
        }
      }
      const entry = addSuppression(repo, {
        findingId,
        fingerprint,
        rule: opts.rule,
        path: opts.path,
        kind: opts.kind as SuppressionKind,
        reason: opts.reason,
        expiresAt: opts.expires,
      });
      if (opts.json) console.log(JSON.stringify(entry, null, 2));
      else {
        console.log(chalk.green(`Recorded ${entry.kind} suppression ${entry.id}.`));
        console.log(`Scope: ${entry.findingId ?? `${entry.rule}${entry.path ? ` @ ${entry.path}` : ""}`}`);
        console.log(chalk.dim("Run the check again. Accepted/suppressed findings remain visible in scan history and reports."));
      }
    } catch (error) {
      if (opts.json) console.log(JSON.stringify({ ok: false, error: (error as Error).message }));
      else console.error(chalk.red((error as Error).message));
      process.exitCode = 1;
    }
  });

export default suppress;
