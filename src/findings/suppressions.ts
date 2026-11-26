import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DismissedFinding, ScanIssue, ScanResult } from "../analyzers/types.js";
import { globMatches } from "../understand/index.js";
import { findingFingerprint } from "./schema.js";
import { findingIdFor } from "../repro/ids.js";

export type SuppressionKind = "false-positive" | "accepted-risk" | "suppressed";

export interface Suppression {
  id: string;
  /** Exact finding scope. Its code fingerprint must still match after later scans. */
  findingId?: string;
  fingerprint?: string;
  /** Optional rule-wide scope, which can be constrained by path globs. */
  rule?: string;
  path?: string;
  kind: SuppressionKind;
  reason: string;
  createdAt: string;
  expiresAt?: string;
}

interface SuppressionDocument {
  schemaVersion: 1;
  suppressions: Suppression[];
}

export interface SuppressionListEntry extends Suppression {
  state: "active" | "expired";
}

export function suppressionsPath(repo: string): string {
  return path.join(path.resolve(repo), ".pitstop", "suppressions.json");
}

export function loadSuppressions(repo: string): SuppressionDocument {
  const file = suppressionsPath(repo);
  if (!fs.existsSync(file)) return { schemaVersion: 1, suppressions: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`invalid suppression file ${file}: ${(error as Error).message}`);
  }
  const doc = parsed as Partial<SuppressionDocument>;
  if (doc.schemaVersion !== 1 || !Array.isArray(doc.suppressions)) {
    throw new Error(`invalid suppression file ${file}: expected schemaVersion 1 and a suppressions array`);
  }
  for (const entry of doc.suppressions) {
    if (!entry || typeof entry.id !== "string" || typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error(`invalid suppression file ${file}: every suppression needs an id and reason`);
    }
    if (!entry.findingId && !entry.rule) {
      throw new Error(`invalid suppression ${entry.id}: specify findingId or rule`);
    }
    if (!['false-positive', 'accepted-risk', 'suppressed'].includes(entry.kind)) {
      throw new Error(`invalid suppression ${entry.id}: unsupported kind`);
    }
    if (entry.expiresAt && !Number.isFinite(Date.parse(entry.expiresAt))) {
      throw new Error(`invalid suppression ${entry.id}: invalid expiresAt`);
    }
  }
  return doc as SuppressionDocument;
}

function save(repo: string, doc: SuppressionDocument): void {
  const file = suppressionsPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function isSuppressionActive(entry: Suppression, now = Date.now()): boolean {
  return !entry.expiresAt || Date.parse(entry.expiresAt) > now;
}

export function listSuppressions(repo: string): SuppressionListEntry[] {
  return loadSuppressions(repo).suppressions.map((entry) => ({
    ...entry,
    state: isSuppressionActive(entry) ? "active" : "expired",
  }));
}

export function addSuppression(
  repo: string,
  input: Omit<Suppression, "id" | "createdAt">,
): Suppression {
  if (!input.reason.trim()) throw new Error("a suppression reason is required");
  if (!input.findingId && !input.rule) throw new Error("choose a finding id or --rule");
  if (input.findingId && input.rule) throw new Error("a finding-specific suppression cannot also use --rule");
  if (input.path && !input.rule) throw new Error("--path is used together with --rule");
  if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error("--expires must be a valid ISO date or timestamp");
  }
  const doc = loadSuppressions(repo);
  const duplicate = doc.suppressions.find((entry) =>
    isSuppressionActive(entry) &&
    entry.kind === input.kind &&
    entry.findingId === input.findingId &&
    entry.fingerprint === input.fingerprint &&
    entry.rule === input.rule &&
    entry.path === input.path,
  );
  if (duplicate) throw new Error(`an active suppression already covers this scope (${duplicate.id})`);
  const entry: Suppression = {
    ...input,
    reason: input.reason.trim(),
    id: `sup-${crypto.randomBytes(4).toString("hex")}`,
    createdAt: new Date().toISOString(),
  };
  doc.suppressions.push(entry);
  save(repo, doc);
  return entry;
}

export function removeSuppression(repo: string, id: string): Suppression {
  const doc = loadSuppressions(repo);
  const index = doc.suppressions.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`suppression "${id}" was not found`);
  const [removed] = doc.suppressions.splice(index, 1);
  save(repo, doc);
  return removed;
}

interface Candidate {
  id: string;
  source: string;
  type: string;
  category?: string;
  description: string;
  file?: string;
  line?: number;
  fingerprint?: string;
  title?: string;
  confidence?: import("../findings/schema.js").FindingConfidence;
  sourceTool?: string;
  reachability?: string;
  verificationStatus?: string;
  impact?: string;
  reproduction?: string;
  suggestedFix?: string;
  verification?: string;
  references?: string[];
}

function relativeFile(repo: string, file?: string): string | undefined {
  if (!file) return undefined;
  return (path.isAbsolute(file) ? path.relative(repo, file) : file).replace(/\\/g, "/");
}

function match(repo: string, candidate: Candidate, entry: Suppression): boolean {
  if (!isSuppressionActive(entry)) return false;
  if (entry.findingId) {
    // An unchanged finding id is not enough: changed code invalidates the old
    // dismissal. Both sides are fingerprinted when Phase 1 stamps the scan.
    return Boolean(entry.fingerprint && candidate.fingerprint && entry.fingerprint === candidate.fingerprint);
  }
  const rule = candidate.category ?? candidate.type;
  if (entry.rule !== rule && entry.rule !== candidate.type) return false;
  if (!entry.path) return true;
  const file = relativeFile(repo, candidate.file);
  return Boolean(file && globMatches(entry.path, file));
}

function dismiss(repo: string, candidate: Candidate, entry: Suppression, severity: string): DismissedFinding {
  return {
    id: candidate.id,
    source: candidate.source,
    type: candidate.type,
    category: candidate.category ?? candidate.type,
    description: candidate.description,
    severity,
    file: candidate.file,
    line: candidate.line,
    fingerprint: candidate.fingerprint,
    title: candidate.title,
    confidence: candidate.confidence,
    sourceTool: candidate.sourceTool,
    reachability: candidate.reachability,
    verificationStatus: candidate.verificationStatus,
    impact: candidate.impact,
    reproduction: candidate.reproduction,
    suggestedFix: candidate.suggestedFix,
    verification: candidate.verification,
    references: candidate.references,
    suppression: entry,
  };
}

/** Fingerprint for a flaky-test finding: whole test file content. */
export function flakyTestFingerprint(repo: string, file: string | undefined, name: string): string {
  return findingFingerprint(
    repo,
    { type: "flaky-test", severity: "warning", description: name, file },
    "reliability",
  );
}

/**
 * Active-only view for callers that measure issues without building a full
 * ScanResult (`pitstop verify` / gate). Dismissed findings stay excluded.
 */
export function filterSuppressedIssues(
  repoInput: string,
  issues: ScanIssue[],
  source: string,
): ScanIssue[] {
  const repo = path.resolve(repoInput);
  const entries = loadSuppressions(repo).suppressions;
  if (entries.length === 0) return issues;
  return issues.filter((issue) => {
    const id = issue.id ?? findingIdFor(source, issue.type, issue.file, issue.description);
    const fingerprint = issue.fingerprint ?? findingFingerprint(repo, issue, source);
    return !entries.some((entry) => match(repo, {
      id,
      source,
      type: issue.type,
      category: issue.category,
      description: issue.description,
      file: issue.file,
      line: issue.line,
      fingerprint,
    }, entry));
  });
}

/** Apply scoped dismissals without mutating any analyzer implementations. */
export function applySuppressions(repoInput: string, result: ScanResult): ScanResult {
  const repo = path.resolve(repoInput);
  const entries = loadSuppressions(repo).suppressions;
  result.dismissed = [];
  if (entries.length === 0) return result;

  const filterIssues = (issues: ScanIssue[], source: string): ScanIssue[] => issues.filter((issue) => {
    if (!issue.id) return true;
    issue.fingerprint = issue.fingerprint ?? findingFingerprint(repo, issue, source);
    const entry = entries.find((candidate) => match(repo, {
      id: issue.id!, source, type: issue.type, category: issue.category,
      description: issue.description, file: issue.file, line: issue.line,
      fingerprint: issue.fingerprint,
    }, candidate));
    if (!entry) return true;
    result.dismissed!.push(dismiss(repo, {
      id: issue.id!, source, type: issue.type, category: issue.category,
      description: issue.description, file: issue.file, line: issue.line,
      fingerprint: issue.fingerprint, title: issue.title, confidence: issue.confidence,
      sourceTool: issue.sourceTool, reachability: issue.reachability,
      verificationStatus: issue.verificationStatus, impact: issue.impact,
      reproduction: issue.reproduction, suggestedFix: issue.suggestedFix,
      verification: issue.verification, references: issue.references,
    }, entry, issue.severity));
    return false;
  });

  result.security.issues = filterIssues(result.security.issues, "security");
  result.accessibility.issues = filterIssues(result.accessibility.issues, "a11y");
  result.reliability.raceSmells = filterIssues(result.reliability.raceSmells, "reliability");
  result.devex.unusedExports = filterIssues(result.devex.unusedExports, "devex");

  result.reliability.flakyTests = result.reliability.flakyTests.filter((flake) => {
    if (!flake.id) return true;
    const description = `flaky test (outcome changed across ${result.reliability.runs} runs): ${flake.name}`;
    const fingerprint = flakyTestFingerprint(repo, flake.file, flake.name);
    const entry = entries.find((candidate) => match(repo, {
      id: flake.id!, source: "reliability", type: "flaky-test", description,
      file: flake.file, fingerprint,
    }, candidate));
    if (!entry) return true;
    result.dismissed!.push(dismiss(repo, {
      id: flake.id!, source: "reliability", type: "flaky-test", description, file: flake.file, fingerprint,
    }, entry, "warning"));
    return false;
  });

  result.dependencyGraph.circular = result.dependencyGraph.circular.filter((cycle) => {
    const files = cycle.map((file) => relativeFile(repo, file) ?? file);
    const id = `graph-${crypto.createHash("sha1").update(["graph", "circular", cycle[0], files.join(" → ")].join("|")).digest("hex").slice(0, 8)}`;
    const entry = entries.find((candidate) => match(repo, {
      id, source: "graph", type: "circular", description: `circular dependency: ${files.join(" → ")}`,
      file: cycle[0], fingerprint: id,
    }, candidate));
    if (!entry) return true;
    result.dismissed!.push(dismiss(repo, {
      id, source: "graph", type: "circular", description: `circular dependency: ${files.join(" → ")}`, file: cycle[0], fingerprint: id,
    }, entry, "medium"));
    return false;
  });

  if (result.ledger) {
    result.ledger.evidence = result.ledger.evidence.filter((evidence) => {
      if (!evidence.id) return true;
      const entry = entries.find((candidate) => match(repo, {
        id: evidence.id!, source: "ledger", type: evidence.scenario, description: evidence.summary,
        file: evidence.endpointFile, fingerprint: evidence.id,
      }, candidate));
      if (!entry) return true;
      result.dismissed!.push(dismiss(repo, {
        id: evidence.id!, source: "ledger", type: evidence.scenario, description: evidence.summary,
        file: evidence.endpointFile, fingerprint: evidence.id,
      }, entry, "critical"));
      return false;
    });
  }

  return result;
}
