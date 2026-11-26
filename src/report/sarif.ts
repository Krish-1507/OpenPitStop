/**
 * report/sarif.ts — SARIF 2.1.0 export for GitHub code scanning.
 *
 * The export uses the standardized finding contract: stable finding ids and
 * content fingerprints, confidence, source tool, reachability, verification
 * state, CWE/OWASP references, and scoped suppressions. A dismissed finding is
 * still exported (with a SARIF suppression) so a reviewer can see what was
 * accepted and why, while GitHub does not count it as an active alert.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadPenLatest } from "../pen/store.js";
import type { PenFinding } from "../pen/types.js";
import type { DismissedFinding, ScanIssue } from "../analyzers/types.js";
import type { ReportModel } from "./format.js";

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = packageVersion();
const INFO_URI = "https://github.com/Krish-1507/OpenPitStop";

/** Type/category -> CWE / OWASP Top 10 (2021) mapping for known classes. */
const CWE: Record<string, { id: string; name: string; owasp?: string }> = {
  "sql-injection": { id: "CWE-89", name: "SQL Injection", owasp: "A03:2021" },
  "nosql-injection": { id: "CWE-89", name: "NoSQL Injection", owasp: "A03:2021" },
  "command-injection": { id: "CWE-78", name: "OS Command Injection", owasp: "A03:2021" },
  "arbitrary-code-execution": { id: "CWE-94", name: "Code Injection", owasp: "A03:2021" },
  "path-traversal": { id: "CWE-22", name: "Path Traversal", owasp: "A01:2021" },
  ssrf: { id: "CWE-918", name: "Server-Side Request Forgery", owasp: "A10:2021" },
  xss: { id: "CWE-79", name: "Cross-Site Scripting", owasp: "A03:2021" },
  "xss-sink": { id: "CWE-79", name: "Cross-Site Scripting", owasp: "A03:2021" },
  "reflected-xss": { id: "CWE-79", name: "Reflected XSS", owasp: "A03:2021" },
  secret: { id: "CWE-798", name: "Use of Hard-coded Credentials", owasp: "A02:2021" },
  authentication: { id: "CWE-287", name: "Improper Authentication", owasp: "A07:2021" },
  authorization: { id: "CWE-285", name: "Improper Authorization", owasp: "A01:2021" },
  "missing-auth": { id: "CWE-306", name: "Missing Authentication for Critical Function", owasp: "A01:2021" },
  csrf: { id: "CWE-352", name: "Cross-Site Request Forgery", owasp: "A01:2021" },
  "prototype-pollution": { id: "CWE-1321", name: "Prototype Pollution", owasp: "A03:2021" },
  cors: { id: "CWE-942", name: "Permissive CORS", owasp: "A05:2021" },
  transport: { id: "CWE-319", name: "Cleartext Transmission", owasp: "A02:2021" },
  "missing-security-headers": { id: "CWE-693", name: "Protection Mechanism Failure", owasp: "A05:2021" },
  "info-leak-header": { id: "CWE-200", name: "Information Exposure", owasp: "A01:2021" },
  "no-rate-limit": { id: "CWE-307", name: "Improper Restriction of Excessive Auth Attempts", owasp: "A07:2021" },
  "rate-limiting": { id: "CWE-307", name: "Improper Restriction of Excessive Auth Attempts", owasp: "A07:2021" },
  database: { id: "CWE-250", name: "Execution with Unnecessary Privileges", owasp: "A04:2021" },
  "data-exposure": { id: "CWE-200", name: "Information Exposure", owasp: "A01:2021" },
  "hidden-vulnerabilities": { id: "CWE-655", name: "Insufficient Psychological Acceptability", owasp: "A04:2021" },
  jwt: { id: "CWE-347", name: "Improper Verification of Cryptographic Signature", owasp: "A02:2021" },
  "jwt-attack": { id: "CWE-347", name: "Improper Verification of Cryptographic Signature", owasp: "A02:2021" },
  xxe: { id: "CWE-611", name: "XML External Entity", owasp: "A05:2021" },
  code: { id: "CWE-94", name: "Code Injection", owasp: "A03:2021" },
  eval: { id: "CWE-94", name: "Code Injection", owasp: "A03:2021" },
  "insecure-cors": { id: "CWE-942", name: "Permissive CORS", owasp: "A05:2021" },
  "cookie-without-httponly": { id: "CWE-614", name: "Sensitive Cookie Without HttpOnly", owasp: "A05:2021" },
  "broken-access-control": { id: "CWE-285", name: "Improper Authorization", owasp: "A01:2021" },
  idor: { id: "CWE-639", name: "Authorization Bypass Through User-Controllable Key", owasp: "A01:2021" },
  "privilege-escalation": { id: "CWE-269", name: "Improper Privilege Management", owasp: "A01:2021" },
  dependency: { id: "CWE-1104", name: "Use of Unmaintained Third Party Components", owasp: "A06:2021" },
  "open-redirect": { id: "CWE-601", name: "URL Redirection to Untrusted Site", owasp: "A01:2021" },
  "insecure-deserialization": { id: "CWE-502", name: "Deserialization of Untrusted Data", owasp: "A08:2021" },
  "crypto-weakness": { id: "CWE-327", name: "Use of a Broken or Risky Cryptographic Algorithm", owasp: "A02:2021" },
  "mass-assignment": { id: "CWE-915", name: "Improperly Controlled Modification of Dynamically-Determined Object Attributes", owasp: "A01:2021" },
  "input-validation": { id: "CWE-20", name: "Improper Input Validation", owasp: "A03:2021" },
  ssti: { id: "CWE-1336", name: "Improper Neutralization of Special Elements Used in a Template Engine", owasp: "A03:2021" },
  "debug-mode": { id: "CWE-489", name: "Active Debug Code", owasp: "A05:2021" },
  a11y: { id: "CWE-other", name: "Accessibility Issue" },
  "race-condition": { id: "CWE-362", name: "Concurrent Execution Using Shared Resource with Improper Synchronization" },
  "unused-export": { id: "CWE-other", name: "Unused Export" },
};

const SEV_NUM: Record<string, number> = {
  critical: 9.8,
  high: 8.0,
  medium: 5.0,
  low: 3.0,
  warning: 3.0,
  info: 0.0,
  unknown: 0.0,
};

function level(severity: string): "error" | "warning" | "note" | "none" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium" || severity === "warning") return "warning";
  if (severity === "low") return "note";
  return "none";
}

function prettify(value: string): string {
  return value
    .split(/[-_.\/]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

interface RawFinding {
  id: string;
  category: string;
  type: string;
  severity: string;
  description: string;
  file?: string;
  line?: number;
  confidence?: string;
  sourceTool?: string;
  reachability?: string;
  risk?: import("../findings/schema.js").FindingRisk;
  verificationStatus?: string;
  impact?: string;
  fingerprint?: string;
  suppression?: DismissedFinding["suppression"];
}

function rawFromIssue(issue: ScanIssue, source: string): RawFinding {
  const category = issue.category ?? issue.type;
  return {
    id: issue.id ?? `${source}-${category}`,
    category,
    type: issue.type,
    severity: issue.severity,
    description: issue.description,
    file: issue.file,
    line: issue.line,
    confidence: issue.confidence,
    sourceTool: issue.sourceTool ?? (source === "security" ? "static-security" : source),
    reachability: issue.reachability,
    risk: issue.risk,
    verificationStatus: issue.verificationStatus,
    impact: issue.impact,
    fingerprint: issue.fingerprint,
  };
}

function collect(repo: string, model: ReportModel): RawFinding[] {
  const out: RawFinding[] = [];
  const scan = model.latestScan;
  if (scan) {
    if (scan.security.status === "ok") {
      for (const issue of scan.security.issues) out.push(rawFromIssue(issue, "security"));
    }
    for (const issue of scan.accessibility.issues ?? []) out.push(rawFromIssue(issue, "a11y"));
    for (const issue of scan.reliability?.raceSmells ?? []) out.push(rawFromIssue(issue, "reliability"));
    for (const issue of scan.devex?.unusedExports ?? []) out.push(rawFromIssue(issue, "devex"));
    for (const dismissed of scan.dismissed ?? []) {
      out.push({
        id: dismissed.id,
        category: dismissed.category,
        type: dismissed.type,
        severity: "low",
        description: dismissed.description,
        file: dismissed.file,
        line: dismissed.line,
        confidence: dismissed.confidence ?? "unknown",
        sourceTool: dismissed.sourceTool ?? dismissed.source,
        reachability: dismissed.reachability,
        fingerprint: dismissed.fingerprint,
        suppression: dismissed.suppression,
        impact: dismissed.impact ?? "Suppressed by project policy; retained for audit visibility.",
        verificationStatus: dismissed.verificationStatus ?? "unproven",
      });
    }
    if (scan.perf.status === "ok" && scan.perf.id) {
      out.push({
        id: scan.perf.id,
        category: "performance",
        type: "perf-regression",
        severity: "medium",
        description: "Performance/bundle baseline captured",
        confidence: "indicated",
        sourceTool: "perf",
      });
    }
  }
  const pen = loadPenLatest(repo);
  if (pen) {
    for (const finding of pen.findings as PenFinding[]) {
      out.push({
        id: finding.id,
        category: finding.type,
        type: finding.type,
        severity: finding.severity,
        description: finding.description,
        file: finding.file,
        line: finding.line,
        confidence: finding.confidence,
        sourceTool: finding.source,
        reachability: finding.route ? "reachable" : "unknown",
        verificationStatus: finding.confidence === "proven" ? "failed" : "unproven",
        impact: finding.title,
      });
    }
  }

  // Security and pen can surface the same class at the same location. Keep the
  // strongest single result instead of double-counting in code scanning.
  const seen = new Set<string>();
  return out.filter((finding) => {
    const key = [finding.category, finding.file ?? "", finding.line ?? "", finding.description].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: {
    tool: { driver: { name: string; version: string; semanticVersion: string; informationUri: string; rules: unknown[] } };
    automationDetails?: { id: string };
    originalUriBaseIds?: Record<string, { uri: string }>;
    columnKind?: string;
    invocations?: unknown[];
    results: unknown[];
  }[];
}

export interface SarifOptions {
  /** Include dismissed findings with a SARIF suppression (default true). */
  includeSuppressed?: boolean;
}

export function buildSarif(repo: string, model: ReportModel, opts: SarifOptions = {}): SarifLog {
  const includeSuppressed = opts.includeSuppressed !== false;
  const findings = collect(repo, model).filter((finding) => includeSuppressed || !finding.suppression);
  const ruleMap = new Map<string, { rule: any; index: number }>();
  const results: unknown[] = [];

  for (const finding of findings) {
    const cwe = CWE[finding.category] ?? CWE[finding.type] ?? { id: "CWE-other", name: prettify(finding.category) };
    const safeCategory = finding.category.replace(/[^A-Za-z0-9_.-]+/g, "-");
    const ruleId = `openpitstop/${safeCategory}`;
    const resultLevel = level(finding.severity);
    const levelRank: Record<string, number> = { none: 4, note: 3, warning: 2, error: 1 };
    const existingRule = ruleMap.get(ruleId);
    if (existingRule) {
      if ((levelRank[resultLevel] ?? 4) < (levelRank[existingRule.rule.defaultConfiguration.level] ?? 4)) {
        existingRule.rule.defaultConfiguration.level = resultLevel;
      }
      existingRule.rule.properties["security-severity"] = Math.max(
        existingRule.rule.properties["security-severity"] ?? 0,
        SEV_NUM[finding.severity] ?? 0,
      );
    } else {
      const rule = {
        id: ruleId,
        name: cwe.name,
        shortDescription: { text: cwe.name },
        fullDescription: { text: `${cwe.name}. ${finding.impact ?? ""}`.trim() },
        help: {
          text: finding.impact ?? "Review the finding evidence and apply the smallest safe correction.",
          markdown: [
            `**${cwe.name}**`,
            "",
            finding.impact ?? "",
            "",
            `Reference: ${cwe.id}${cwe.owasp ? ` · OWASP ${cwe.owasp}` : ""}`,
          ].join("\n"),
        },
        helpUri: "https://github.com/Krish-1507/OpenPitStop#the-pen-test",
        defaultConfiguration: { level: resultLevel },
        properties: {
          tags: ["security", cwe.id, ...(cwe.owasp ? [`owasp-${cwe.owasp}`] : [])],
          category: finding.category,
          cwe: cwe.id,
          owasp: cwe.owasp,
          "security-severity": SEV_NUM[finding.severity] ?? 0,
          precision: finding.confidence === "proven" ? "very-high" : finding.confidence === "indicated" ? "medium" : "low",
        },
      };
      ruleMap.set(ruleId, { rule, index: ruleMap.size });
    }
    const uri = finding.file
      ? path.relative(repo, path.resolve(repo, finding.file)).replace(/\\/g, "/")
      : ".";
    const suppression = finding.suppression;
    results.push({
      ruleId,
      ruleIndex: ruleMap.get(ruleId)!.index,
      level: suppression ? "none" : resultLevel,
      message: { text: finding.description },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri, uriBaseId: "%SRCROOT%" },
            region: { startLine: Math.max(1, finding.line ?? 1) },
          },
        },
      ],
      partialFingerprints: {
        "openpitstopFindingId/v1": finding.id,
        ...(finding.fingerprint ? { "openpitstopContentHash/v1": finding.fingerprint } : {}),
      },
      ...(suppression
        ? {
            suppressions: [
              {
                kind: "external",
                status: "accepted",
                justification: `${suppression.kind}: ${suppression.reason}${suppression.expiresAt ? ` (expires ${suppression.expiresAt})` : ""}`,
              },
            ],
          }
        : {}),
      properties: {
        severity: finding.severity,
        confidence: finding.confidence ?? "unknown",
        sourceTool: finding.sourceTool ?? "unknown",
        reachability: finding.reachability ?? "unknown",
        verificationStatus: suppression ? "unproven" : finding.verificationStatus ?? "unproven",
        category: finding.category,
        cwe: cwe.id,
        owasp: cwe.owasp,
        "security-severity": SEV_NUM[finding.severity] ?? 0,
        suppressed: Boolean(suppression),
        suppressionKind: suppression?.kind,
        ...(finding.risk
          ? {
              riskLevel: finding.risk.level,
              riskScore: finding.risk.score,
              riskReasons: finding.risk.reasons,
            }
          : {}),
      },
    });
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "OpenPitStop",
            version: VERSION,
            semanticVersion: VERSION,
            informationUri: INFO_URI,
            rules: [...ruleMap.values()].map((entry) => entry.rule),
          },
        },
        automationDetails: { id: "openpitstop/scan" },
        originalUriBaseIds: { "%SRCROOT%": { uri: pathToFileURL(path.resolve(repo) + path.sep).href } },
        columnKind: "utf16CodeUnits",
        invocations: [
          {
            executionSuccessful: true,
            toolExecutionNotifications: [],
          },
        ],
        results,
      },
    ],
  };
}
