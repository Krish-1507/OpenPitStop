/**
 * report/sarif.ts — GitHub code-scanning export.
 *
 * `pitstop report --sarif` writes a SARIF 2.1.0 log so every OpenPitStop
 * security/pen finding shows up natively in the GitHub Security tab — the one
 * place Strix's OSS CLI does not land. Each result is keyed by CWE/OWASP and
 * carries a `security-severity` so code-scanning can filter and gate on it.
 *
 * This is the "we prove, and we plug into DevSecOps" half of the Strix wedge:
 * Strix reports to its own platform; OpenPitStop speaks the format GitHub
 * already understands, for free, with no Docker and no LLM bill.
 */

import path from "node:path";
import { loadPenLatest } from "../pen/store.js";
import type { PenFinding } from "../pen/types.js";
import type { ScanIssue } from "../analyzers/types.js";
import type { ReportModel } from "./format.js";

const VERSION = "1.5.0";
const INFO_URI = "https://github.com/Krish-1507/OpenPitStop";

/** Type -> CWE / OWASP Top 10 (2021) mapping for the common pen/scan classes. */
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
};

const SEV_NUM: Record<string, number> = {
  critical: 9.8,
  high: 8.0,
  medium: 5.0,
  low: 3.0,
  info: 0.0,
};

function level(sev: string): "error" | "warning" | "note" | "none" {
  if (sev === "critical" || sev === "high") return "error";
  if (sev === "medium") return "warning";
  if (sev === "low") return "note";
  return "none";
}

function prettify(type: string): string {
  return type
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface RawFinding {
  type: string;
  severity: string;
  description: string;
  file?: string;
  line?: number;
  confidence?: string;
}

function collect(repo: string, model: ReportModel): RawFinding[] {
  const out: RawFinding[] = [];
  const scan = model.latestScan;
  if (scan && scan.security.status === "ok") {
    for (const i of scan.security.issues as ScanIssue[]) {
      out.push({
        type: i.type,
        severity: i.severity,
        description: i.description,
        file: i.file,
        line: i.line,
      });
    }
  }
  const pen = loadPenLatest(repo);
  if (pen) {
    for (const f of pen.findings as PenFinding[]) {
      out.push({
        type: f.type,
        severity: f.severity,
        description: f.description,
        file: f.file,
        line: f.line,
        confidence: f.confidence,
      });
    }
  }
  return out;
}

export interface SarifLog {
  $schema: string;
  version: string;
  runs: {
    tool: { driver: { name: string; version: string; informationUri: string; rules: unknown[] } };
    results: unknown[];
  }[];
}

export function buildSarif(repo: string, model: ReportModel): SarifLog {
  const findings = collect(repo, model);
  const ruleMap = new Map<string, unknown>();
  const results: unknown[] = [];

  for (const f of findings) {
    const cwe = CWE[f.type] ?? { id: "CWE-other", name: prettify(f.type) };
    const ruleId = `openpitstop/${f.type}`;
    if (!ruleMap.has(ruleId)) {
      ruleMap.set(ruleId, {
        id: ruleId,
        name: cwe.name,
        shortDescription: { text: cwe.name },
        helpUri: "https://github.com/Krish-1507/OpenPitStop#the-pen-test",
        properties: { category: f.type, cwe: cwe.id, owasp: cwe.owasp },
      });
    }
    const uri = f.file ? path.relative(repo, f.file).replace(/\\/g, "/") : ".";
    results.push({
      ruleId,
      level: level(f.severity),
      message: { text: f.description },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri },
            region: { startLine: f.line ?? 1 },
          },
        },
      ],
      properties: {
        severity: f.severity,
        confidence: f.confidence ?? "proven",
        "security-severity": SEV_NUM[f.severity] ?? 0,
        cwe: cwe.id,
        owasp: cwe.owasp,
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
            informationUri: INFO_URI,
            rules: [...ruleMap.values()],
          },
        },
        results,
      },
    ],
  };
}
