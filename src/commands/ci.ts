import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { runAllAnalyzers } from "../analyzers/index.js";
import { correlate } from "../graph/correlate.js";
import { runScan } from "./scan.js";
import { safeExec } from "../analyzers/util.js";
import {
  buildModel,
  renderMarkdown,
  type VerifyReport,
} from "../report/format.js";
import { classifyRisk, deltasOf, metricsOf } from "../verify/metrics.js";
import type { ScanResult } from "../analyzers/types.js";

/**
 * `pitstop ci` — CI-mode, diagnostic-only analysis.
 *
 * Runs the same scan pipeline as `pitstop scan`, then (inside a PR, detected
 * via GITHUB_BASE_REF) diffs the current branch's metrics against the base
 * branch's snapshot, and prints ONE GitHub-flavored markdown block meant to be
 * posted as a PR comment.
 *
 * It is deliberately READ-ONLY: it never commits, never creates branches, never
 * edits files. Autonomous fixing only ever happens through the /pitstop slash
 * command in an interactive coding agent, never here.
 */
export const ci = new Command("ci")
  .description(
    "CI-mode scan: run scan + verify vs the base branch (PR) and print a markdown report for PR comments. " +
      "pitstop ci is diagnostic-only; use the /pitstop slash command locally for autonomous fixes.",
  )
  .argument("[repo]", "path to the repo to analyze (defaults to cwd)", ".")
  .action(async (repoArg: string) => {
    const repo = path.resolve(repoArg);
    const baseRef = process.env.GITHUB_BASE_REF?.trim() || "";

    console.error(`[pitstop ci] scanning ${repo}${baseRef ? ` vs base \`${baseRef}\`` : ""}`);

    let headResult: ScanResult;
    let baseResult: ScanResult | null = null;
    let baseSnapshot: string | null = null;

    try {
      const run = await runScan(repo);
      headResult = run.result;
    } catch (err: any) {
      console.error(`[pitstop ci] scan failed: ${err?.message ?? err}`);
      process.exitCode = 1;
      return;
    }

    // Verify against the base branch in a PR context (read-only, via a temp snapshot).
    if (baseRef) {
      baseSnapshot = fetchBaseSnapshot(repo, baseRef);
      if (baseSnapshot) {
        try {
          baseResult = await analyzeDir(baseSnapshot);
        } catch (err: any) {
          console.error(`[pitstop ci] base-branch analysis failed: ${err?.message ?? err}`);
          baseResult = null;
        } finally {
          try {
            fs.rmSync(baseSnapshot, { recursive: true, force: true });
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    }

    const model = buildModel(repo);
    if (baseResult) {
      const baseline = metricsOf(baseResult);
      const current = metricsOf(headResult);
      const deltas = deltasOf(baseline, current);
      const risk = classifyRisk(baseline, current, deltas);
      const verify: VerifyReport = {
        timestamp: new Date().toISOString(),
        repo,
        baselineTimestamp: baseResult.timestamp,
        risk,
        exitCode: risk === "High" ? 1 : 0,
        deltas,
        baseline,
        current,
      };
      model.latestVerify = verify;
      model.hasVerify = true;
      model.verifiesCount = Math.max(model.verifiesCount, 1);
    }

    const headerNote = buildHeaderNote(baseRef, baseResult !== null);
    const markdown = renderMarkdown(model, {
      clustersFirst: true,
      headerNote,
      title: "CI Report",
    });

    console.log(markdown);
  });

function buildHeaderNote(baseRef: string, hasBase: boolean): string {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const head = process.env.GITHUB_HEAD_REF ?? "";
  const ref = process.env.GITHUB_REF ?? "";
  const bits: string[] = [];
  if (repo) bits.push(`repo \`${repo}\``);
  if (head) bits.push(`head \`${head}\``);
  if (ref && !head) bits.push(`ref \`${ref}\``);
  if (baseRef) {
    bits.push(`base \`${baseRef}\``);
    bits.push(hasBase ? "verify: diff vs base branch" : "base snapshot unavailable — no diff");
  } else {
    bits.push("no GITHUB_BASE_REF — not a PR; scan only");
  }
  bits.push("diagnostic-only, read-only");
  return bits.join(" · ");
}

async function analyzeDir(dir: string): Promise<ScanResult> {
  const result = await runAllAnalyzers(dir);
  const { clusters } = correlate(dir, result);
  result.clusters = clusters;
  return result;
}

/**
 * Fetch a clean read-only snapshot of the base branch into a temp dir using
 * only `git` (never touches the working tree, never creates branches, and no
 * shell pipeline — `tar` is not guaranteed on Windows). The base commit is
 * fetched into a fresh repo from the already-fetched local clone, so no
 * network round trip is needed. Returns null on any failure so CI degrades to
 * a scan-only report.
 */
function fetchBaseSnapshot(repo: string, baseRef: string): string | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-ci-base-"));
  const fetch = safeExec("git", ["fetch", "--depth=1", "origin", baseRef], repo, 180000);
  if (fetch.code !== 0) {
    console.error(
      `[pitstop ci] could not fetch origin/${baseRef}: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    );
    return null;
  }
  const rev = safeExec("git", ["rev-parse", `origin/${baseRef}`], repo, 30000);
  const commit = rev.stdout.trim();
  if (!commit) {
    console.error(`[pitstop ci] could not resolve origin/${baseRef}`);
    return null;
  }
  const init = safeExec("git", ["init", "-q"], tmp, 30000);
  if (init.code !== 0) return null;
  // Fetch the exact base commit from the local repo (local transport can fetch
  // an arbitrary object id), then check it out detached — a pure-git snapshot.
  const pull = safeExec("git", ["fetch", "--depth=1", repo, commit], tmp, 180000);
  if (pull.code !== 0) {
    console.error(
      `[pitstop ci] could not extract base snapshot: ${pull.stderr.trim() || pull.stdout.trim()}`,
    );
    return null;
  }
  const co = safeExec("git", ["checkout", "-q", "FETCH_HEAD"], tmp, 60000);
  if (co.code !== 0) {
    console.error(`[pitstop ci] could not check out base snapshot: ${co.stderr.trim()}`);
    return null;
  }
  return tmp;
}