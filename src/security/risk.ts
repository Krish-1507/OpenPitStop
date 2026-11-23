import path from "node:path";
import { findRoutes } from "../pen/static.js";
import type { FindingRisk } from "../findings/schema.js";
import type { ScanIssue } from "../analyzers/types.js";

/**
 * Risk is a triage order, not an exploit claim. It combines severity,
 * confidence, the finding class, and one repository fact: whether the file
 * contains a discovered HTTP route. That fact only makes a finding *more
 * relevant to review*; it does not prove the vulnerable line is reachable from
 * that route.
 */

const SEVERITY_SCORE: Record<string, number> = {
  critical: 80,
  high: 65,
  medium: 45,
  low: 25,
  warning: 35,
  info: 10,
  unknown: 20,
};

const HIGH_RISK_CLASSES = new Set([
  "sql-injection", "nosql-injection", "command-injection", "arbitrary-code-execution",
  "ssrf", "path-traversal", "idor", "price-tampering", "insecure-deserialization",
  "container-privileged", "container-docker-socket", "kubernetes-privileged",
  "kubernetes-host-path", "terraform-public-acl", "ci-untrusted-interpolation",
  "ci-write-all", "config-literal-secret",
]);

function relative(repo: string, file?: string): string | undefined {
  if (!file) return undefined;
  return (path.isAbsolute(file) ? path.relative(repo, file) : file).replace(/\\/g, "/");
}

function level(score: number): FindingRisk["level"] {
  if (score >= 85) return "critical";
  if (score >= 70) return "high";
  if (score >= 50) return "medium";
  if (score >= 30) return "low";
  return "info";
}

/** Attach reachability context and a deterministic risk score to each issue. */
export function assessRisk(repoInput: string, issues: ScanIssue[]): ScanIssue[] {
  const repo = path.resolve(repoInput);
  let routeFiles = new Set<string>();
  try {
    routeFiles = new Set(
      findRoutes(repo)
        .map((route) => relative(repo, route.file))
        .filter((file): file is string => Boolean(file)),
    );
  } catch {
    /* route inventory is optional context; risk still uses severity/class */
  }

  for (const issue of issues) {
    const file = relative(repo, issue.file);
    const reachable = issue.reachability === "reachable" || Boolean(file && routeFiles.has(file));
    if (reachable) issue.reachability = "reachable";
    else if (!issue.reachability) issue.reachability = "unknown";

    const severity = (issue.severity || "unknown").toLowerCase();
    const confidence = (issue.confidence || "indicated").toLowerCase();
    const category = issue.category ?? issue.type;
    let score = SEVERITY_SCORE[severity] ?? 20;
    const reasons: string[] = [`${severity} severity`];
    if (reachable) {
      score += 15;
      reasons.push("file contains a discovered HTTP route");
    }
    if (confidence === "proven") {
      score += 10;
      reasons.push("proven by runtime or exact-match evidence");
    } else if (confidence === "heuristic") {
      score -= 8;
      reasons.push("heuristic pattern; needs review");
    }
    if (HIGH_RISK_CLASSES.has(category)) {
      score += 8;
      reasons.push(`${category} has elevated exploit impact`);
    }
    score = Math.max(0, Math.min(100, score));
    issue.risk = {
      score,
      level: level(score),
      reachable,
      reasons,
    };
  }
  return issues;
}
