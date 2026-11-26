import path from "node:path";
import { analyzeStatic } from "../pen/static.js";
import type { ScanIssue } from "../analyzers/types.js";

/**
 * Business-logic and access-control findings already proven useful by the pen
 * static pass. The scan keeps the same rules instead of reimplementing them;
 * only the classes that are not already covered by `securityStatic` are
 * promoted, so users do not see two copies of the same issue.
 */
const PROMOTED = new Set(["idor", "price-tampering", "jwt-weak-secret"]);

export function analyzeAdvancedSecurity(repo: string): ScanIssue[] {
  let outcome: ReturnType<typeof analyzeStatic>;
  try {
    outcome = analyzeStatic(repo);
  } catch {
    return [];
  }
  return outcome.findings.flatMap((finding) => {
    if (!PROMOTED.has(finding.type)) return [];
    return [{
      type: "code",
      category: finding.type,
      severity: finding.severity,
      title: finding.title,
      file: finding.file ? path.relative(repo, finding.file).replace(/\\/g, "/") : undefined,
      line: finding.line,
      description: finding.description,
      fix: finding.fix,
      sourceTool: "pen-static",
      confidence: finding.confidence,
      reproduction: finding.repro ?? `Open the cited file and review the access-control or business-logic path.`,
    } satisfies ScanIssue];
  });
}
