import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ScanIssue } from "../analyzers/types.js";

/** The common contract shared by built-in analyzers and external scanners. */
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info" | "warning" | "unknown";
export type FindingConfidence = "proven" | "indicated" | "heuristic" | "unknown";
export type VerificationStatus = "verified" | "failed" | "blocked" | "unproven" | "cheat";
export type Reachability = "reachable" | "unreachable" | "unknown";

/** Deterministic triage score. It is prioritization, not an exploitability proof. */
export interface FindingRisk {
  score: number;
  level: "critical" | "high" | "medium" | "low" | "info";
  reachable: boolean;
  reasons: string[];
}

export interface FindingEvidence {
  kind: "static-match" | "scanner-result" | "runtime-observation" | "dependency-advisory";
  summary: string;
  file?: string;
  line?: number;
  reference?: string;
}

/**
 * Versioned, scanner-independent vulnerability/finding format.
 *
 * Legacy `type`, `description` and `fix` remain on ScanIssue for compatibility;
 * all persisted issues are enriched with these fields before a scan is sealed.
 */
export interface Finding {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  category: string;
  file?: string;
  line?: number;
  sourceTool: string;
  evidence: FindingEvidence[];
  reachability: Reachability;
  impact: string;
  reproduction: string;
  suggestedFix: string;
  verificationStatus: VerificationStatus;
  verification: string;
  references: string[];
  /** Present when a scan could correlate the finding with its repository context. */
  risk?: FindingRisk;
  /** Changes when the finding's rule, location or underlying code line changes. */
  fingerprint: string;
}

const IMPACTS: Record<string, string> = {
  "sql-injection": "An attacker may read or modify database records, bypass authentication, or execute database privileges available to the application.",
  "nosql-injection": "Crafted query operators may bypass filters, expose records, or modify data outside the intended operation.",
  "command-injection": "Untrusted input may execute operating-system commands with the application's privileges.",
  "arbitrary-code-execution": "Untrusted input may execute code with the application's privileges.",
  xss: "Attacker-controlled script may run in another user's browser and act with that user's session and data access.",
  "xss-sink": "Untrusted content may become executable markup in a user's browser.",
  "reflected-xss": "A crafted request may execute script in a victim's browser under the application's origin.",
  ssrf: "An attacker may make the server contact internal services, cloud metadata endpoints, or otherwise restricted destinations.",
  "path-traversal": "A crafted path may read, overwrite, or delete files outside the intended directory.",
  secret: "Exposed credentials can be copied and used outside the application. Rotate the credential; deleting the text alone does not revoke access.",
  authentication: "Attackers may impersonate users, guess credentials, or bypass the intended identity checks.",
  authorization: "A user may access records or actions belonging to another user or a more privileged role.",
  "missing-auth": "An unauthenticated caller may invoke functionality that was intended to be protected.",
  "broken-access-control": "A caller may cross tenant, user, or role boundaries and access unauthorized data or operations.",
  idor: "Changing an object identifier may expose or modify another user's record.",
  "privilege-escalation": "A less-privileged user may gain administrator or otherwise unauthorized capabilities.",
  dependency: "The affected dependency has a published advisory. Actual exploitability depends on the installed version and whether vulnerable code is reachable.",
  cors: "An untrusted website may be able to make credentialed requests or read responses in a victim's browser.",
  "insecure-cors": "An untrusted website may be able to make credentialed requests or read responses in a victim's browser.",
  "open-redirect": "Attackers may send victims through a trusted application URL to a phishing or malware destination.",
  "insecure-deserialization": "Crafted serialized input may alter application state, disclose data, or execute code depending on the deserializer.",
  "prototype-pollution": "Attacker-controlled object keys may alter shared object behavior and enable authorization bypass or code execution in affected paths.",
  "rate-limiting": "Without an effective limit, attackers may automate credential guessing, abuse expensive operations, or repeatedly trigger state changes.",
  "no-rate-limit": "Without an effective limit, attackers may automate credential guessing, abuse expensive operations, or repeatedly trigger state changes.",
  "data-exposure": "Responses or logs may disclose credentials or personal data beyond what the caller needs.",
  "info-leak-header": "Implementation details may help an attacker fingerprint the service and target known weaknesses.",
  transport: "Network observers may read or modify sensitive traffic when transport protection is absent.",
  "crypto-weakness": "Weak cryptography may allow attackers to recover protected data or forge values more easily than intended.",
  "mass-assignment": "A caller may set fields the endpoint did not intend to expose, including ownership or privilege fields.",
  "input-validation": "Malformed or malicious input may reach a sensitive operation without the constraints the application expects.",
  csrf: "A malicious site may cause a victim's browser to perform an unwanted state-changing action with the victim's credentials.",
  xxe: "A crafted XML document may disclose local files, make server-side requests, or consume excessive resources.",
  ssti: "Untrusted template source may execute server-side expressions, disclose data, or run code.",
  "debug-mode": "Debug facilities may expose source, configuration, stack traces, or interactive execution capabilities.",
  "missing-security-headers": "Browsers receive fewer defensive signals, increasing the impact of content injection, clickjacking, or transport mistakes.",
  "a11y": "Users relying on assistive technology may be unable to understand or operate this interface.",
  "race-condition": "Timing-dependent state can produce intermittent corruption, duplicate work, or authorization inconsistencies.",
  "unused-export": "Unused exports increase the maintenance surface and can obscure which module contracts are still supported.",
  "price-tampering": "A caller may change a monetary value that the server should derive itself, paying less or altering an order.",
  "container-privileged": "A privileged container can reach host devices and weaken the boundary between the workload and the host.",
  "container-docker-socket": "Access to the Docker daemon is effectively host-level control; a compromised workload can control other containers and the host.",
  "container-root-user": "A root process inside the container has more authority to modify files, install tooling, or exploit a container escape.",
  "kubernetes-privileged": "A privileged pod weakens isolation and can expose host devices or kernel capabilities.",
  "kubernetes-host-path": "A hostPath mount can expose or modify host files and is a common container-escape aid.",
  "terraform-public-acl": "Public storage or resource access can expose sensitive data without authentication.",
  "ci-untrusted-interpolation": "Attacker-controlled event text may execute shell commands with workflow credentials.",
  "ci-write-all": "A workflow with write-all permissions can modify repository contents and packages if any step is compromised.",
  "ci-secret-echo": "Printing a secret can place it in CI logs that are retained or exported.",
  "ci-pull-request-target": "A workflow with base-repository privileges can expose secrets or write access to untrusted pull-request content.",
  "ci-unpinned-action": "A mutable action ref can change the code executed by the workflow without a repository change.",
  "config-literal-secret": "A credential stored in a configuration file can be copied by anyone who can read the repository or artifact.",
  "container-secret-env": "A secret baked into a container image or deployment file can be recovered by anyone who can pull or read it.",
  "container-host-network": "Host networking removes a network boundary and may expose services that were intended to be local-only.",
  "container-published-data-port": "A published database port may be reachable beyond the developer machine and allows direct credential attacks.",
  "kubernetes-literal-secret": "A literal secret in a manifest can be read by anyone with repository or manifest access.",
  "kubernetes-host-namespace": "A host namespace weakens pod isolation and can expose host processes or network reachability.",
  "kubernetes-root-user": "Running as root increases the authority available after a container compromise.",
  "kubernetes-privilege-escalation": "An escalated process may gain capabilities the workload was not intended to have.",
  "kubernetes-unpinned-image": "A floating image tag makes deployments non-reproducible and can introduce unreviewed code.",
  "terraform-publicly-accessible": "The resource may be reachable from the public internet, expanding the attack surface.",
  "terraform-open-ingress": "Public ingress to a sensitive port enables internet-scale scanning and credential attacks.",
  "terraform-unencrypted": "Data at rest may be readable if the underlying storage or backup is exposed.",
  "terraform-wildcard-action": "A wildcard IAM action grants far more authority than the workload needs.",
  "sql-grant-all": "An application principal with all privileges can modify schema or data beyond its intended role.",
  "sql-literal-password": "A database password in a SQL file can be copied and used outside the application.",
  "dependency-floating-version": "A floating dependency can move to an unreviewed or vulnerable release without a repository change.",
  "dependency-insecure-source": "A package fetched over plain HTTP can be modified in transit.",
  "dependency-unpinned-git": "A mutable git dependency can install different code than the version reviewed.",
  "dependency-lockfile-missing": "Without a lockfile, installs and vulnerability scans are not reproducible.",
};

function titleOf(category: string): string {
  return category
    .split(/[._/-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || "OpenPitStop finding";
}

function confidenceOf(issue: ScanIssue): FindingConfidence {
  if (issue.confidence) return issue.confidence;
  if (/\[proven\]/i.test(issue.description)) return "proven";
  if (/\[indicated\]/i.test(issue.description) || issue.type === "code") return "indicated";
  return "unknown";
}

function sourceToolOf(issue: ScanIssue, source: string): string {
  if (issue.sourceTool) return issue.sourceTool;
  return source === "security" ? "static-security" : source;
}

function normalizeRelative(repo: string, file: string): string {
  return (path.isAbsolute(file) ? path.relative(repo, file) : file).replace(/\\/g, "/");
}

function codeLineDigest(repo: string, issue: ScanIssue): string {
  if (!issue.file) return "no-file";
  const file = path.isAbsolute(issue.file) ? issue.file : path.resolve(repo, issue.file);
  try {
    const text = fs.readFileSync(file, "utf8");
    if (issue.line == null) return crypto.createHash("sha256").update(text).digest("hex");
    const line = text.split(/\r?\n/)[issue.line - 1] ?? "";
    return crypto.createHash("sha256").update(line.trim()).digest("hex");
  } catch {
    return "unreadable";
  }
}

export function findingFingerprint(repo: string, issue: ScanIssue, source: string): string {
  const category = issue.category ?? issue.type;
  const file = issue.file ? normalizeRelative(repo, issue.file) : "";
  const seed = [source, category, file, issue.line ?? "", codeLineDigest(repo, issue)].join("|");
  return crypto.createHash("sha256").update(seed).digest("hex");
}

export function impactFor(issue: ScanIssue): string {
  const category = issue.category ?? issue.type;
  return IMPACTS[category] ??
    (issue.type === "dependency" ? IMPACTS.dependency : undefined) ??
    issue.impact ??
    "This finding identifies a potential engineering or security weakness. Review the evidence and reachable behavior before assigning an exploitability conclusion.";
}

/** Enrich one legacy issue in place while retaining its stable legacy id. */
export function normalizeScanIssue(repo: string, issue: ScanIssue, source: string, id: string): ScanIssue {
  const category = issue.category ?? issue.type;
  const confidence = confidenceOf(issue);
  const sourceTool = sourceToolOf(issue, source);
  issue.id = id;
  issue.schemaVersion = 1;
  issue.title = issue.title ?? titleOf(category);
  issue.confidence = confidence;
  issue.sourceTool = sourceTool;
  issue.reachability = issue.reachability ?? "unknown";
  issue.evidence = issue.evidence ?? [{
    kind: issue.type === "dependency" ? "dependency-advisory" : sourceTool === "static-security" ? "static-match" : "scanner-result",
    summary: issue.description.replace(/^\[(?:indicated|proven|heuristic)\]\s*/i, ""),
    file: issue.file,
    line: issue.line,
  }];
  issue.impact = issue.impact ?? impactFor(issue);
  issue.reproduction = issue.reproduction ??
    `Run \`pitstop inspect ${id}\` to review the evidence. Where supported, run \`pitstop repro ${id}\` to create a failing-first reproduction; a static match alone is not exploit proof.`;
  issue.suggestedFix = issue.suggestedFix ?? issue.fix ?? "Review the affected code and apply a minimal fix that preserves existing behavior.";
  issue.fix = issue.fix ?? issue.suggestedFix;
  issue.verificationStatus = issue.verificationStatus ?? (confidence === "proven" ? "failed" : "unproven");
  issue.verification = issue.verification ??
    `Apply the smallest appropriate correction, then run \`pitstop scan\` and \`pitstop inspect ${id}\`. A clean result is evidence only for checks that actually ran; skipped checks remain unverified.`;
  issue.references = issue.references ?? [];
  issue.fingerprint = issue.fingerprint ?? findingFingerprint(repo, issue, source);
  return issue;
}
