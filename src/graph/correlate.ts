import fs from "node:fs";
import path from "node:path";
import { buildEdges } from "../analyzers/dependencyGraph.js";
import type { ScanResult, Cluster, ClusterFinding } from "../analyzers/types.js";
import { findingIdFor, ledgerFindingId } from "../repro/ids.js";

/**
 * HEURISTIC (not magic):
 * We treat every Phase-1 output that points at one or more files as a flat
 * "finding". Findings are correlated when they touch the same file, or files
 * that are within 1-2 hops of each other in the dependency graph (so e.g. a
 * buggy leaf and its only caller group together). Within a correlated group we
 * guess the root cause as the highest-scoring finding, where score combines
 * severity with graph centrality: a file many other files depend on is more
 * likely to be the root cause than a leaf file. This is a best-effort guess and
 * is clearly labeled as such in the popup.
 */

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  severe: 4,
  error: 4,
  medium: 3,
  moderate: 3,
  warning: 2,
  low: 2,
  info: 1,
  unknown: 2,
};

function severityRank(s: string): number {
  return SEVERITY_RANK[s?.toLowerCase()] ?? 2;
}

/** Flatten Phase-1 results into a list of file-based findings. */
export function collectFindings(repo: string, r: ScanResult): ClusterFinding[] {
  const findings: ClusterFinding[] = [];
  // Analyzers disagree: some emit absolute paths, some emit paths relative to
  // the repo. Normalize once here — path.relative(repo, alreadyRelativePath)
  // would resolve against the CWD and break on any cross-drive scan.
  // A Windows drive prefix (e.g. `Q:/...`) must be neutralized so a
  // cross-drive absolute path still resolves to a repo-relative one on every OS.
  const stripDrive = (p: string): string => p.replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
  const relOf = (f: string | undefined): string => {
    if (!f) return "";
    if (path.isAbsolute(f) || /^[A-Za-z]:/.test(f)) {
      return path.relative(stripDrive(repo), stripDrive(f));
    }
    return path.relative(repo, path.join(repo, f));
  };

  for (const i of r.security.issues) {
    findings.push({
      id: findingIdFor("security", i.type, i.file, i.description),
      source: "security",
      severity: i.severity,
      type: i.type,
      description: i.description,
      files: relOf(i.file) ? [relOf(i.file)] : [],
    });
  }

  for (const c of r.duplication.clones) {
    findings.push({
      id: findingIdFor("duplication", "duplication", c.files[0], `${c.lines}`),
      source: "duplication",
      severity: "low",
      type: "duplication",
      description: `duplicate code (${c.lines} lines)`,
      files: c.files.map(relOf),
    });
  }

  for (const cyc of r.dependencyGraph.circular) {
    const files = cyc.map(relOf);
    findings.push({
      id: findingIdFor("graph", "circular", cyc[0], files.join(" → ")),
      source: "graph",
      severity: "medium",
      type: "circular",
      description: `circular dependency: ${files.join(" → ")}`,
      files,
    });
  }

  for (const i of r.accessibility.issues) {
    findings.push({
      id: findingIdFor("a11y", i.type, i.file, i.description),
      source: "a11y",
      severity: i.severity,
      type: "a11y",
      description: i.description,
      files: relOf(i.file) ? [relOf(i.file)] : [],
    });
  }

  for (const f of r.reliability.flakyTests) {
    findings.push({
      id: findingIdFor("reliability", "flaky-test", f.file, f.name),
      source: "reliability",
      severity: "warning",
      type: "flaky-test",
      description: `flaky test (outcome changed across ${r.reliability.runs} runs): ${f.name}`,
      files: relOf(f.file) ? [relOf(f.file)] : [],
    });
  }

  for (const i of r.reliability.raceSmells) {
    findings.push({
      id: findingIdFor("reliability", "race-condition", i.file, i.description),
      source: "reliability",
      severity: i.severity,
      type: "race-condition",
      description: i.description,
      files: relOf(i.file) ? [relOf(i.file)] : [],
    });
  }

  for (const i of r.devex.unusedExports) {
    findings.push({
      id: findingIdFor("devex", "unused-export", i.file, i.description),
      source: "devex",
      severity: i.severity,
      type: "unused-export",
      description: i.description,
      files: relOf(i.file) ? [relOf(i.file)] : [],
    });
  }

  for (const d of r.devex.duplicateFunctions) {
    findings.push({
      id: findingIdFor(
        "devex",
        "duplicate-function",
        d.files[0]?.file,
        `${d.name}@${d.files[0]?.file}`,
      ),
      source: "devex",
      severity: "medium",
      type: "duplicate-function",
      description: `near-identical function bodies (${(d.similarity * 100).toFixed(0)}% similar, ${d.lines} lines): ${d.name} in ${d.files
        .map((f) => path.basename(f.file))
        .join(" vs ")}`,
      files: d.files.map((f) => relOf(f.file)),
    });
  }

  return findings;
}

export function correlate(
  repo: string,
  r: ScanResult,
): { clusters: Cluster[]; findings: ClusterFinding[] } {
  const findings = collectFindings(repo, r);
  const built = buildEdges(repo);
  const edges = built?.edges ?? new Map<string, Set<string>>();

  // Centrality = in-degree in the dependency graph.
  const inDegree = new Map<string, number>();
  for (const deps of edges.values()) {
    for (const d of deps) inDegree.set(d, (inDegree.get(d) ?? 0) + 1);
  }

  // Undirected adjacency for hop-distance checks.
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const [u, deps] of edges) {
    link(u, u);
    for (const v of deps) {
      link(u, v);
      link(v, u);
    }
  }

  const resolve = (f: string) => path.resolve(repo, f);
  const distance = (a: string, b: string): number => {
    if (!adj.has(a) || !adj.has(b)) return Infinity;
    if (a === b) return 0;
    const q: [string, number][] = [[a, 0]];
    const seen = new Set([a]);
    while (q.length) {
      const [n, d] = q.shift() as [string, number];
      for (const nb of adj.get(n) ?? []) {
        if (nb === b) return d + 1;
        if (!seen.has(nb)) {
          seen.add(nb);
          q.push([nb, d + 1]);
        }
      }
    }
    return Infinity;
  };

  const centrality = (f: ClusterFinding): number =>
    Math.max(0, ...f.files.map((fl) => inDegree.get(resolve(fl)) ?? 0));

  const score = (f: ClusterFinding): number =>
    severityRank(f.severity) * 10 + centrality(f);

  const correlated = (a: ClusterFinding, b: ClusterFinding): boolean => {
    if (a.files.some((f) => b.files.includes(f))) return true;
    for (const fa of a.files) {
      for (const fb of b.files) {
        if (distance(resolve(fa), resolve(fb)) <= 2) return true;
      }
    }
    return false;
  };

  // Union-find clustering over the findings.
  const parent = findings.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (correlated(findings[i], findings[j])) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: Cluster[] = [];
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const group = idxs.map((i) => findings[i]);
    // Root cause = highest score (severity + centrality). Ties broken by order.
    let root = group[0];
    for (const f of group) if (score(f) > score(root)) root = f;
    const symptoms = group.filter((f) => f !== root);
    const sharedFiles = [...new Set(group.flatMap((f) => f.files))];
    clusters.push({ rootCause: root, symptoms, sharedFiles, size: group.length });
  }

  clusters.sort((a, b) => b.size - a.size);

  // A PROVEN double-charge from ledger mode is always the top-ranked cluster.
  // Ledger findings are never merged into the heuristic clusters: they are
  // observed facts (the mocked gateway was actually hit twice), not guesses, so
  // they lead the report unconditionally.
  const ledgerClusters = buildLedgerClusters(repo, r);
  if (ledgerClusters.length > 0) clusters.unshift(...ledgerClusters);

  return { clusters, findings };
}

function buildLedgerClusters(repo: string, r: ScanResult): Cluster[] {
  if (!r.ledger || r.ledger.evidence.length === 0) return [];
  return r.ledger.evidence.map((ev) => {
    const files = ev.endpointFile ? [ev.endpointFile] : [];
    const rootCause: ClusterFinding = {
      id: ledgerFindingId(ev),
      source: "ledger",
      severity: "critical",
      type: "proven-double-charge",
      description: ev.summary,
      files,
    };
    return {
      rootCause,
      symptoms: [],
      sharedFiles: files,
      size: 1,
    };
  });
}
