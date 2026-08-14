import crypto from "node:crypto";
import path from "node:path";
import type {
  ClusterFinding,
  FlakyTest,
  LedgerEvidence,
  ScanIssue,
  ScanResult,
} from "../analyzers/types.js";

/**
 * ids.ts — stable, deterministic finding ids.
 *
 * A finding id exists so that a committed repro test can link back to the exact
 * finding in `.pitstop/scan-latest.json` and survive re-scans: the same bug in
 * the same file produces the same id every time. This is the glue that lets the
 * autonomous loop demand "prove it fails first, prove it passes after".
 */

/** Normalize path separators so ids are stable across OS meanings of \ and /. */
const norm = (s?: string | null): string => (s ?? "").replace(/\\/g, "/");

/** Canonical id for a finding. `file` is the raw (absolute) file path. */
export function findingIdFor(
  source: string,
  type: string,
  file: string | undefined | null,
  description: string,
): string {
  const seed = [source, type, norm(file), description].join("|");
  return `${source}-${crypto
    .createHash("sha1")
    .update(seed)
    .digest("hex")
    .slice(0, 8)}`;
}

/** Canonical id for a ledger evidence record (stable across scans). */
export function ledgerFindingId(ev: LedgerEvidence): string {
  return findingIdFor("ledger", ev.scenario, ev.endpointFile, ev.orderId);
}

/** Canonical id for the perf baseline finding. */
export function perfFindingId(p: { buildTimeMs?: number; bundleSizeBytes?: number }): string {
  const seed = [p.buildTimeMs ?? "", p.bundleSizeBytes ?? ""].join(":");
  return `perf-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 8)}`;
}

/** Id for a readied repro finding — must match id computation in collectFindings. */
export function clusterIdFor(f: ClusterFinding): string {
  if (f.id) return f.id;
  return findingIdFor(f.source, f.type, f.files[0], f.description);
}

/** Stamp deterministic ids onto the finding-carrying parts of a scan result. */
export function stampFindings(r: ScanResult): void {
  const stamp = <T extends ScanIssue>(arr: T[], source: string) => {
    for (const i of arr) {
      i.id = findingIdFor(source, i.type, i.file, i.description);
    }
  };
  stamp(r.security.issues, "security");
  stamp(r.accessibility.issues, "a11y");
  for (const f of r.reliability.raceSmells) {
    f.id = findingIdFor("reliability", "race-condition", f.file, f.description);
  }
  for (const f of r.reliability.flakyTests as FlakyTest[]) {
    f.id = findingIdFor("reliability", "flaky-test", f.file, f.name);
  }
  stamp(r.devex.unusedExports, "devex");
  if (r.perf.status === "ok") {
    r.perf.id = perfFindingId(r.perf);
  }
  for (const ev of r.ledger?.evidence ?? []) {
    ev.id = ledgerFindingId(ev);
  }
}

/** A normalized, addressable finding record for `pitstop repro`. */
export interface ReproFinding {
  id: string;
  source: string;
  severity: string;
  type: string;
  description: string;
  file?: string;
  line?: number;
  /** Original object (LedgerEvidence for ledger, PerfResult for perf, else ScanIssue). */
  data?: unknown;
}

function pushIssues(
  out: ReproFinding[],
  issues: ScanIssue[],
  source: string,
): void {
  for (const i of issues) {
    out.push({
      id: findingIdFor(source, i.type, i.file, i.description),
      source,
      severity: i.severity,
      type: i.type,
      description: i.description,
      file: i.file,
      line: i.line,
      data: i,
    });
  }
}

/** Enumerate every finding `pitstop repro` can address. */
export function enumerateFindings(r: ScanResult): ReproFinding[] {
  const out: ReproFinding[] = [];
  pushIssues(out, r.security.issues, "security");
  pushIssues(out, r.accessibility.issues, "a11y");
  pushIssues(out, r.reliability.raceSmells, "reliability");
  for (const f of r.reliability.flakyTests) {
    out.push({
      id: findingIdFor("reliability", "flaky-test", f.file, f.name),
      source: "reliability",
      severity: "warning",
      type: "flaky-test",
      description: `flaky test (outcome changed across ${r.reliability.runs} runs): ${f.name}`,
      file: f.file,
      data: f,
    });
  }
  // Circular groups get a repro generator (`graphRepro`) that imports the cycle
  // and asserts it initializes cleanly. The id MUST match collectFindings in
  // graph/correlate.ts, which seeds on the absolute first node + relative chain.
  for (const cycle of r.dependencyGraph.circular) {
    const files = cycle.map((f) => path.relative(r.repo, f));
    out.push({
      id: findingIdFor("graph", "circular", cycle[0], files.join(" → ")),
      source: "graph",
      severity: "medium",
      type: "circular",
      description: `circular dependency: ${files.join(" → ")}`,
      file: cycle[0],
      data: { cycle },
    });
  }
  pushIssues(out, r.devex.unusedExports, "devex");
  for (const ev of r.ledger?.evidence ?? []) {
    out.push({
      id: ledgerFindingId(ev),
      source: "ledger",
      severity: "critical",
      type: ev.scenario,
      description: ev.summary,
      file: ev.endpointFile,
      data: ev,
    });
  }
  if (r.perf.status === "ok") {
    const perf = enumeratePerfFinding(r);
    if (perf) out.push(perf);
  }
  return out;
}

function enumeratePerfFinding(r: ScanResult): ReproFinding | null {
  const id = perfFindingId(r.perf);
  if (!id) return null;
  return {
    id,
    source: "perf",
    severity: "medium",
    type: "perf-regression",
    description:
      "performance budget regression guard — build/bundle must stay under the " +
      "Phase-1 baseline threshold",
    data: r.perf,
  };
}

/** Resolve a finding id to a normalized record, or null. */
export function resolveFinding(r: ScanResult, id: string): ReproFinding | null {
  const hit = enumerateFindings(r).find((f) => f.id === id);
  if (hit) return hit;

  // Fallback: a cluster root cause / symptom id (non-repro-able types, but we
  // still want a helpful "this type isn't reproducible" message).
  const clusterFinding = (r.clusters ?? [])
    .flatMap((c) => [c.rootCause, ...c.symptoms])
    .find((f) => clusterIdFor(f) === id);
  if (clusterFinding) {
    return {
      id,
      source: clusterFinding.source,
      severity: clusterFinding.severity,
      type: clusterFinding.type,
      description: clusterFinding.description,
      file: clusterFinding.files[0],
    };
  }
  return null;
}

/** Suggest a kebab-slug for a repro test file name. */
export function reproSlug(f: ReproFinding, maxWords = 6): string {
  const words = f.description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const picked = words.slice(0, maxWords);
  let slug = picked.join("-");
  if (!slug) slug = f.type.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "finding";
  slug = slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
  return `${f.source}-${slug}`;
}