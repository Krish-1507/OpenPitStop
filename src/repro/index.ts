import fs from "node:fs";
import path from "node:path";
import type { ScanResult } from "../analyzers/types.js";
import { resolveFinding, enumerateFindings } from "./ids.js";
import { generateRepro, type ReproOutcome } from "./generate.js";
import { generatePenRepro } from "./pen.js";
import { runRepro, type ReproRunResult } from "./run.js";
import { loadPenLatest, resolvePenFinding } from "../pen/store.js";

/**
 * repro/index.ts — `pitstop repro <finding-id>`:
 *
 *   1. load `.pitstop/scan-latest.json`,
 *   2. resolve the finding id to a real finding,
 *   3. generate a committed repro test that genuinely attempts to reproduce the bug,
 *   4. run it through the repo's own test framework and report PASS/FAIL.
 *
 * The repo has its own hypotheses-failing contract: a repro that does NOT fail is
 * evidence the hypothesis is wrong, not a green-light to fix blind.
 */

export interface ReproResult {
  status: "generated-and-ran" | "generated" | "refused" | "not-found" | "no-scan";
  findingId?: string;
  file?: string;
  reason?: string;
  ran?: ReproRunResult;
}

export function loadScan(repo: string): ScanResult | null {
  const p = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ScanResult;
  } catch {
    return null;
  }
}

export async function repro(
  repo: string,
  findingId: string,
  opts: { writeOnly?: boolean } = {},
): Promise<ReproResult> {
  const scan = loadScan(repo);
  const pen = loadPenLatest(repo);
  if (!scan && !pen) {
    return {
      status: "no-scan",
      reason: "no .pitstop/scan-latest.json or pen-latest.json — run `pitstop scan` or `pitstop pen` first",
    };
  }

  const finding = scan ? resolveFinding(scan, findingId) : null;
  const penFinding = !finding && pen ? resolvePenFinding(pen, findingId) : null;

  if (penFinding) {
    const outcome: ReproOutcome = generatePenRepro(repo, penFinding);
    if (!outcome.ok || !outcome.file) {
      return { status: "refused", findingId, reason: outcome.reason ?? "generator produced no test file" };
    }
    if (opts.writeOnly) {
      return { status: "generated", findingId, file: outcome.file };
    }
    const ran = await runRepro(repo, outcome.file);
    return { status: "generated-and-ran", findingId, file: outcome.file, ran };
  }

  if (!finding) {
    const available = [
      ...(scan ? enumerateFindings(scan) : []),
      ...(pen ? pen.findings ?? [] : []),
    ]
      .slice(0, 25)
      .map((f: any) => `  ${f.id}  ${f.source} — ${f.title ?? f.description}`)
      .join("\n");
    return {
      status: "not-found",
      reason:
        `no finding with id "${findingId}" in scan-latest.json or pen-latest.json. ` +
        (available ? `\nRepro-able finding ids:\n${available}` : ""),
    };
  }

  const outcome: ReproOutcome = generateRepro(repo, scan as ScanResult, finding);
  if (!outcome.ok || !outcome.file) {
    return {
      status: "refused",
      findingId,
      reason: outcome.reason ?? "generator produced no test file",
    };
  }

  if (opts.writeOnly) {
    return { status: "generated", findingId, file: outcome.file };
  }

  const ran = await runRepro(repo, outcome.file);
  return { status: "generated-and-ran", findingId, file: outcome.file, ran };
}