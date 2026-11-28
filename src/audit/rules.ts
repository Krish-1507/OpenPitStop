import path from "node:path";
import { globMatches, type BoundaryRule } from "../understand/index.js";
import { isTestFile } from "../architecture/impact.js";
import { lineExcerpt, redact, shortHash } from "./text.js";
import type { AuditCategory, AuditFinding, AuditMode, Confirmation, FindingConfidence, FindingSeverity } from "./types.js";
import type { JsFileIndex, JsFunction, RepoIndex } from "./indexTypes.js";

/**
 * audit/rules.ts — deterministic, evidence-first engineering rules.
 *
 * Every rule must be able to answer: where, why, what would change, and what
 * could go wrong with the change. Rules that cannot do that stay out.
 */

export interface SecurityInput {
  file: string;
  line: number;
  severity: string;
  description: string;
  fix?: string;
  category?: string;
}

export interface RuleContext {
  repo: string;
  index: RepoIndex;
  mode: AuditMode;
  boundaries: BoundaryRule[];
  security?: SecurityInput[];
  warnings: string[];
  /** Categories selected for this run; unselected findings must not consume caps. */
  categories?: AuditCategory[];
}

interface FindingSpec {
  rule: string;
  category: AuditCategory;
  subcategory: string;
  title: string;
  explanation: string;
  file: string;
  line: number;
  endLine: number;
  symbol?: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  confirmation: Confirmation;
  impact: string;
  why: string;
  evidence: AuditFinding["evidence"];
  suggestion: AuditFinding["suggestion"];
  tags?: string[];
  patch?: AuditFinding["patch"];
}

const ENTRY_NAMES = new Set(["index", "main", "app", "server", "cli", "bin"]);

const HTTP_STATUS = new Set([200, 201, 202, 204, 301, 302, 304, 400, 401, 403, 404, 405, 409, 410, 422, 429, 500, 501, 502, 503, 504]);
const TIME_CONSTANTS = new Set([1000, 1024, 60, 24, 7, 12, 30, 365, 3600, 86400, 60000, 3600000]);

const SYNC_IO = /^(readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|execSync|spawnSync|openSync|copyFileSync|mkdirSync|rmSync|unlinkSync|renameSync)$/;

const UNAMBIGUOUS_DB_CALL =
  /^(findOne|findMany|findById|findFirst|find_one|find_many|find_by_id|find_first|updateOne|deleteOne|update_one|delete_one|fetch_all|fetch_one|fetchall|fetchone|execute_many|select|insert|upsert|aggregate|fetch)$/i;
const AMBIGUOUS_DB_CALL = /^(find|query|execute|save|create|update|delete|count|get|post|put|patch|request)$/i;
const DB_RECEIVER =
  /^(db|database|prisma|sequelize|knex|pool|client|connection|conn|repo|repository|collection|model|models|mongoose|supabase|firestore|dynamo|redis|cache|sql|orm|session|tx|transaction|http|https|axios|api|request|got|rest|graphql)$/i;

/**
 * `find` is an Array method and `update`/`create` are common on non-I/O
 * objects. Only treat those names as database/network calls when the receiver
 * is recognisably a database, ORM, HTTP client or repository. Unambiguous
 * methods (findMany, find_one, fetch, …) are safe on their own.
 */
function isDatabaseOrNetworkCall(name: string, object = ""): boolean {
  const method = name.split(".").pop() ?? "";
  if (!method) return false;
  if (UNAMBIGUOUS_DB_CALL.test(method)) return true;
  if (!AMBIGUOUS_DB_CALL.test(method)) return false;
  const receiver = object.toLowerCase().split(".").filter(Boolean);
  return receiver.some((segment) => DB_RECEIVER.test(segment));
}

export function analyzeRules(ctx: RuleContext): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const seen = new Set<string>();
  const contentByFile = new Map(ctx.index.files.map((file) => [file.file, file.content]));

  const push = (spec: FindingSpec): void => {
    const fingerprint = fingerprintOf(spec, contentByFile);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    const evidence = spec.evidence.map((entry) => ({
      ...entry,
      detail: redact(entry.detail),
      ...(entry.excerpt ? { excerpt: redact(entry.excerpt) } : {}),
    }));
    if (evidence.length === 0) {
      const excerpt = excerptOf(contentByFile, spec.file, spec.line);
      if (excerpt) evidence.push({ source: "source", detail: "line " + spec.line, excerpt });
    }
    findings.push({
      id: "aud-" + shortHash(fingerprint),
      fingerprint,
      rule: spec.rule,
      category: spec.category,
      subcategory: spec.subcategory,
      title: spec.title,
      explanation: spec.explanation,
      location: { file: spec.file, line: spec.line, endLine: spec.endLine },
      ...(spec.symbol ? { symbol: spec.symbol } : {}),
      severity: spec.severity,
      confidence: spec.confidence,
      confirmation: spec.confirmation,
      impact: spec.impact,
      why: spec.why,
      evidence,
      suggestion: spec.suggestion,
      lifecycle: "new",
      tags: spec.tags ?? [],
      deduction: 0,
      ...(spec.patch ? { patch: spec.patch } : {}),
    });
  };

  const excerptOf = (map: Map<string, string>, file: string, line: number): string => {
    const content = map.get(file);
    return content ? lineExcerpt(content, line) : "";
  };

  for (const file of ctx.index.files) {
    if (file.js) {
      runJsFileRules(ctx, file, file.js, push, excerptOf);
    }
    if (file.python) {
      runPythonFileRules(ctx, file, file.python, push);
    }
  }

  runDuplication(ctx, push);
  runUnusedExports(ctx, push);
  runArchitecture(ctx, push);
  runSyncIoInPaths(ctx, push);
  runRepeatedCalls(ctx, push);
  runRegexRules(ctx, push);
  runHardcoding(ctx, push);
  runSecurity(ctx, push);

  return ctx.categories ? findings.filter((finding) => ctx.categories?.includes(finding.category)) : findings;
}

/**
 * Apply the deterministic per-rule and global finding budgets. This runs after
 * category selection and suppression so an unmeasured category or a suppressed
 * finding cannot crowd out a measured, active one.
 */
export function finalizeFindings(findings: AuditFinding[], warnings: string[]): AuditFinding[] {
  // Suppressed findings are user decisions, not budget candidates: keep them
  // visible in the report and apply the budgets only to active findings.
  const suppressed = findings.filter((finding) => finding.lifecycle === "suppressed");
  const active = findings.filter((finding) => finding.lifecycle !== "suppressed");
  const ranked = [...active].sort(compareFindings);
  const { selected: capped, capsReached } = capPerRule(ranked);
  const selected = applyGlobalCap(capped, warnings);
  for (const [rule, info] of capsReached) {
    const shown = selected.filter((finding) => finding.rule === rule).length;
    warnings.push(
      "Rule cap reached for " +
        rule +
        ": " +
        info.total +
        " candidates, " +
        info.cap +
        " considered, " +
        shown +
        " shown after global selection (" +
        (info.total - shown) +
        " omitted).",
    );
  }
  return [...suppressed, ...selected].sort(compareFindings);
}

/**
 * Keep the global finding budget from erasing an entire measured category.
 * Without this, a large repository can exhaust the 250-finding budget with its
 * noisiest category and report another category as a clean 100/100 even though
 * its findings were generated and then dropped.
 */
function applyGlobalCap(findings: AuditFinding[], warnings: string[]): AuditFinding[] {
  if (findings.length <= 250) return findings;
  const representative = new Map<AuditFinding["category"], AuditFinding>();
  for (const finding of findings) {
    if (!representative.has(finding.category)) representative.set(finding.category, finding);
  }
  const reserved = new Set(representative.values());
  const remaining = findings.filter((finding) => !reserved.has(finding)).slice(0, Math.max(0, 250 - reserved.size));
  const selected = [...reserved, ...remaining];
  warnings.unshift(
    "Finding budget reached; " +
      (findings.length - selected.length) +
      " findings were omitted after reserving one finding per affected category.",
  );
  return selected.sort(compareFindings);
}

function compareFindings(a: AuditFinding, b: AuditFinding): number {
  const severity = severityRank(a.severity) - severityRank(b.severity);
  if (severity !== 0) return severity;
  if (a.location.file !== b.location.file) return a.location.file < b.location.file ? -1 : 1;
  return a.location.line - b.location.line;
}

function severityRank(severity: FindingSeverity): number {
  return severity === "critical" ? 0 : severity === "high" ? 1 : severity === "medium" ? 2 : 3;
}

function fingerprintOf(spec: FindingSpec, contentByFile: Map<string, string>): string {
  const content = contentByFile.get(spec.file);
  const lines = content?.split(/\r?\n/);
  if (spec.symbol && !spec.symbol.startsWith("<")) {
    // A symbol alone collides when one function contains two instances of the
    // same rule (two sequential loops, two sync calls) or when two classes have
    // a method with the same name. Add the measured line and its occurrence so
    // both findings survive without tying identity to an absolute line number.
    const measured = lines?.[spec.line - 1]?.trim().replace(/\s+/g, " ");
    if (measured && lines) {
      const occurrence = lines
        .slice(0, Math.max(0, spec.line - 1))
        .filter((line) => line.trim().replace(/\s+/g, " ") === measured).length;
      return [
        spec.rule,
        spec.file,
        "symbol:" + spec.symbol,
        "content:" + shortHash(measured, 12) + ":" + occurrence,
      ].join("|");
    }
    return [spec.rule, spec.file, "symbol:" + spec.symbol].join("|");
  }
  const start = spec.line - 1;
  const end = Math.min(spec.endLine, lines?.length ?? 0);
  if (lines && start >= 0 && start < end) {
    const normalized = lines.map((line) => line.trim().replace(/\s+/g, " "));
    const blockLines = normalized.slice(start, end);
    const block = blockLines.join("\n");
    if (block) {
      // A line range alone breaks whenever an unrelated line is inserted above:
      // every finding below it becomes "resolved" and reappears as a regression.
      // Anchor to the measured text instead, with an occurrence index for
      // repeated identical blocks (single-line and multi-line alike).
      let occurrence = 0;
      const width = blockLines.length;
      for (let index = 0; index + width <= start; index += 1) {
        if (blockLines.every((line, offset) => normalized[index + offset] === line)) occurrence += 1;
      }
      return [spec.rule, spec.file, "content:" + shortHash(block, 12) + ":" + occurrence].join("|");
    }
  }
  return [spec.rule, spec.file, spec.line + "-" + spec.endLine].join("|");
}

function capPerRule(findings: AuditFinding[]): {
  selected: AuditFinding[];
  capsReached: Map<string, { total: number; cap: number }>;
} {
  const caps: Record<string, number> = {
    "unused-import": 60,
    "unused-export": 25,
    "any-usage": 40,
    "type-check-bypass": 40,
    "test-without-assertion": 30,
    "skipped-tests": 25,
    "magic-number": 20,
    "hardcoded-url": 20,
    "security-static": 80,
  };
  const totals = new Map<string, number>();
  for (const finding of findings) totals.set(finding.rule, (totals.get(finding.rule) ?? 0) + 1);
  const counts = new Map<string, number>();
  const out: AuditFinding[] = [];
  for (const finding of findings) {
    const count = counts.get(finding.rule) ?? 0;
    const cap = caps[finding.rule] ?? 150;
    if (count >= cap) continue;
    counts.set(finding.rule, count + 1);
    out.push(finding);
  }
  const capsReached = new Map<string, { total: number; cap: number }>();
  for (const [rule, total] of totals) {
    const cap = caps[rule] ?? 150;
    if (total > cap) capsReached.set(rule, { total, cap });
  }
  return { selected: out, capsReached };
}

function runJsFileRules(
  ctx: RuleContext,
  file: { file: string; content: string },
  js: JsFileIndex,
  push: (spec: FindingSpec) => void,
  excerptOf: (map: Map<string, string>, file: string, line: number) => string,
): void {
  const testFile = isTestFile(file.file);
  const contentMap = new Map([[file.file, file.content]]);

  for (const fn of js.functions) {
    if (fn.loc >= 80) {
      const severity: FindingSeverity = fn.loc >= 140 ? "high" : fn.loc >= 110 ? "medium" : "low";
      push({
        rule: "function-too-long",
        category: "maintainability",
        subcategory: "long-function",
        title: "Function is " + fn.loc + " lines long",
        explanation:
          "Long functions concentrate responsibilities and make every change harder to review and test. The measured length is " +
          fn.loc +
          " lines for " +
          fn.name +
          ".",
        file: file.file,
        line: fn.line,
        endLine: fn.endLine,
        symbol: fn.name,
        severity,
        confidence: "high",
        confirmation: "confirmed",
        impact: "Higher review cost and more ways for a change to affect unrelated behaviour.",
        why: "The body crosses the project's 80-line readability threshold; this is a measured property, not a style preference.",
        evidence: [
          { source: "ast", detail: "function " + fn.name + " spans lines " + fn.line + "-" + fn.endLine + " (" + fn.loc + " lines)" },
          { source: "source", detail: "signature line", excerpt: excerptOf(contentMap, file.file, fn.line) },
        ],
        suggestion: {
          summary: "Extract cohesive steps into named helpers, keeping the public signature stable.",
          change:
            "Identify the 1-3 distinct phases in the body (validation, transformation, persistence) and move each behind a name that explains intent. Keep error handling at the original boundary.",
          tradeoffs: "Extraction adds indirection and can hide ordering assumptions; do it only where the phases are independently testable.",
          effort: "medium",
          autoFixable: false,
        },
        tags: ["size"],
      });
    }

    if (fn.cyclomatic >= 15) {
      const severity: FindingSeverity = fn.cyclomatic >= 25 ? "high" : fn.cyclomatic >= 19 ? "medium" : "low";
      push({
        rule: "function-too-complex",
        category: "maintainability",
        subcategory: "complexity",
        title: "Cyclomatic complexity is " + fn.cyclomatic,
        explanation:
          fn.name +
          " has " +
          fn.cyclomatic +
          " independent decision paths. The audit threshold is 15. This is a count of branch points (if, loop, case, catch, ternary, logical operator), not a judgement about naming.",
        file: file.file,
        line: fn.line,
        endLine: fn.endLine,
        symbol: fn.name,
        severity,
        confidence: "high",
        confirmation: "confirmed",
        impact: "More paths mean more cases a test suite or reviewer has to cover; defects cluster in high-complexity code.",
        why: "The branch count exceeds the configured threshold by a measured margin.",
        evidence: [{ source: "ast", detail: "cyclomatic=" + fn.cyclomatic + ", depth=" + fn.maxDepth + ", lines=" + fn.loc }],
        suggestion: {
          summary: "Flatten with early returns or extract branches into focused functions.",
          change: "Replace nested conditionals with guard clauses first; only then extract cohesive branches.",
          tradeoffs: "Splitting can scatter related rules; keep a single place that documents the decision table.",
          effort: "medium",
          autoFixable: false,
        },
        tags: ["complexity"],
      });
    }

    if (fn.maxDepth >= 5) {
      push({
        rule: "deeply-nested-code",
        category: "maintainability",
        subcategory: "nesting",
        title: "Control flow nests " + fn.maxDepth + " levels deep",
        explanation:
          "The body of " + fn.name + " nests conditionals and loops to depth " + fn.maxDepth + ". Deep nesting hides the happy path and makes the exit conditions hard to reason about.",
        file: file.file,
        line: fn.line,
        endLine: fn.endLine,
        symbol: fn.name,
        severity: "medium",
        confidence: "high",
        confirmation: "confirmed",
        impact: "Higher chance of missed edge cases and harder reviews.",
        why: "Measured statement nesting exceeds the depth-4 threshold.",
        evidence: [{ source: "ast", detail: "max nesting depth " + fn.maxDepth }],
        suggestion: {
          summary: "Use guard clauses and extract the inner block.",
          change: "Invert the outer condition and return early where possible; if the inner loop is an independent operation, give it a name.",
          tradeoffs: "Guard clauses can change resource-cleanup order; keep try/finally boundaries intact.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["nesting"],
      });
    }

    for (const loop of fn.loops) {
      if (loop.awaits > 0) {
        push({
          rule: "await-in-loop",
          category: "performance",
          subcategory: "sequential-io",
          title: "Loop awaits I/O " + loop.awaits + " time(s) sequentially",
          explanation:
            "Each iteration waits for the previous one. With N iterations the wall-clock cost is the sum of latencies, not the maximum. This is a structural sequential-await pattern; the size of the impact depends on iteration count and remote latency.",
          file: file.file,
          line: loop.line,
          endLine: loop.endLine,
          symbol: fn.name,
          severity: "medium",
          confidence: "high",
          confirmation: "potential",
          impact: "Latency grows linearly with the number of items.",
          why: "The loop body contains await expressions that are not part of a known batch call.",
          evidence: [
            { source: "ast", detail: "loop " + loop.kind + " at line " + loop.line + " contains " + loop.awaits + " await(s)" },
            { source: "source", detail: "loop header", excerpt: excerptOf(contentMap, file.file, loop.line) },
          ],
          suggestion: {
            summary: "Batch the operation or run independent iterations with Promise.all while respecting rate limits.",
            change: "If calls are independent, collect inputs and use a bounded concurrency helper (for example Promise.all over chunks); if the API supports a batch endpoint, prefer it.",
            tradeoffs: "Parallel calls can overload a dependency and lose deterministic ordering; keep a concurrency cap and preserve error aggregation.",
            effort: "medium",
            autoFixable: false,
          },
          tags: ["io", "n+1"],
        });
      }

      const query = loop.calls.find((call) =>
        isDatabaseOrNetworkCall(call.name, call.object ?? ""),
      );
      if (query) {
        push({
          rule: "database-or-network-call-in-loop",
          category: "performance",
          subcategory: "n+1",
          title: "Database or network call inside a loop",
          explanation:
            "The loop calls " +
            (query.object ? query.object + "." : "") +
            query.name +
            " once per iteration. This is the classic N+1 shape. It is a potential N+1 rather than a proven one: the call may be in-memory, cached, or deliberately sequential.",
          file: file.file,
          line: loop.line,
          endLine: loop.endLine,
          symbol: fn.name,
          severity: "high",
          confidence: "medium",
          confirmation: "potential",
          impact: "Round trips scale with data size; p95 latency and dependency load grow accordingly.",
          why: "A call whose name matches a database or HTTP operation appears inside a loop body.",
          evidence: [
            { source: "ast", detail: "loop at line " + loop.line + " calls " + query.name + " at line " + query.line },
            { source: "source", detail: "call site", excerpt: excerptOf(contentMap, file.file, query.line) },
          ],
          suggestion: {
            summary: "Hoist the lookup: fetch the set once, index it, then map in memory.",
            change: "Collect ids first, issue one query with an IN/batch clause, and build a Map for the loop body. If the dependency has no batch API, cache repeated keys explicitly.",
            tradeoffs: "Batching changes error semantics (all-or-nothing) and memory use; very large id sets may need chunking.",
            effort: "medium",
            autoFixable: false,
          },
          tags: ["n+1", "database"],
        });
      }
    }
  }

  for (const entry of js.imports) {
    for (const binding of entry.bindings) {
      if (js.usedNames.includes(binding.local)) continue;
      const statement = file.content.slice(entry.start, entry.end);
      const singleLine = !statement.includes("\n");
      const patch =
        entry.bindings.length === 1 && singleLine
          ? {
              file: file.file,
              startLine: entry.line,
              endLine: entry.line,
              before: file.content.split(/\r?\n/)[entry.line - 1] ?? "",
              after: "",
            }
          : undefined;
      push({
        rule: "unused-import",
        category: "maintainability",
        subcategory: "dead-code",
        title: "Unused import " + binding.local,
        explanation:
          "The binding " +
          binding.local +
          " is declared by the import on line " +
          entry.line +
          " but is never referenced in this file. Removing it reduces dead surface and avoids accidental coupling.",
        file: file.file,
        line: entry.line,
        endLine: entry.line,
        symbol: binding.local,
        severity: "low",
        confidence: "high",
        confirmation: "confirmed",
        impact: "Dead dependencies survive refactors and can make the module graph look more coupled than it is.",
        why: "A full-file identifier reference scan found zero uses of the imported binding.",
        evidence: [
          { source: "ast", detail: "import " + binding.local + " from " + entry.specifier },
          { source: "source", detail: "import statement", excerpt: excerptOf(contentMap, file.file, entry.line) },
        ],
        suggestion: {
          summary: patch ? "Remove the unused import line." : "Remove the unused binding from the import list.",
          change: patch
            ? "Delete the import statement. A deterministic patch is attached; it is applied only through the approval workflow."
            : "Delete the binding from the import specifier. The statement imports other bindings, so the edit is left to a human or formatter.",
          tradeoffs: "If a tool injects the binding through a transform, verify the build after removal.",
          effort: "small",
          autoFixable: Boolean(patch),
        },
        ...(patch ? { patch } : {}),
        tags: ["dead-code"],
      });
    }
  }

  for (const entry of js.catches) {
    if (entry.empty) {
      push({
        rule: "empty-catch",
        category: "correctness",
        subcategory: "error-handling",
        title: "Empty catch block",
        explanation:
          "The catch block on line " +
          entry.line +
          " contains no statements. Failures are silently discarded, so callers cannot distinguish success from a swallowed exception.",
        file: file.file,
        line: entry.line,
        endLine: entry.endLine,
        severity: "medium",
        confidence: "high",
        confirmation: "confirmed",
        impact: "Data loss or partial writes can look successful; debugging starts much later.",
        why: "The catch body is syntactically empty.",
        evidence: [
          { source: "ast", detail: "catch body has 0 statements" },
          { source: "source", detail: "catch site", excerpt: excerptOf(contentMap, file.file, entry.line) },
        ],
        suggestion: {
          summary: "Handle, wrap, or rethrow the error; if it is intentionally ignored, say so and scope it.",
          change: "Prefer rethrowing with context; for best-effort cleanup, log a structured warning with the operation name and a comment that explains why continuing is safe.",
          tradeoffs: "Rethrowing may surface failures that were previously ignored; check callers and tests before changing behaviour.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["exceptions"],
      });
    } else if (entry.onlyLogs) {
      push({
        rule: "swallowed-error",
        category: "correctness",
        subcategory: "error-handling",
        title: "Catch logs the error and continues",
        explanation:
          "The catch block on line " +
          entry.line +
          " only writes to the console. Logging is not handling: the caller still sees success and the failure is invisible to program logic.",
        file: file.file,
        line: entry.line,
        endLine: entry.endLine,
        severity: "low",
        confidence: "medium",
        confirmation: "potential",
        impact: "Silent partial failure; monitoring may not treat a console line as an incident.",
        why: "The catch body consists solely of console calls and does not rethrow, return an error, or record structured state.",
        evidence: [{ source: "ast", detail: "catch body contains only console logging" }],
        suggestion: {
          summary: "Decide the failure contract: rethrow, return an error, or record a structured outcome.",
          change: "If the operation is optional, return an explicit result; otherwise rethrow after adding context. Keep logging but do not rely on it as the control flow.",
          tradeoffs: "Changing the contract can affect callers that currently assume the operation always succeeds.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["exceptions"],
      });
    }
  }

  const asyncNames = new Set(js.functions.filter((fn) => fn.async).map((fn) => fn.name));
  for (const fn of js.functions) {
    const seenCalls = new Set<string>();
    for (const call of fn.calls) {
      if (!call.statement || call.awaited || call.object) continue;
      if (!asyncNames.has(call.name) || call.name === fn.name) continue;
      const key = call.name + ":" + call.line;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      push({
        rule: "floating-async-call",
        category: "correctness",
        subcategory: "promises",
        title: "Async call is not awaited",
        explanation:
          fn.name +
          " calls async function " +
          call.name +
          " as a statement and never awaits or attaches a rejection handler. A rejection becomes an unhandled promise rejection.",
        file: file.file,
        line: call.line,
        endLine: call.endLine,
        symbol: fn.name,
        severity: "medium",
        confidence: "medium",
        confirmation: "potential",
        impact: "Unhandled rejection, missing error propagation and races with the following statements.",
        why: "The callee is async in this file and the call expression is a statement, not awaited or chained.",
        evidence: [
          { source: "ast", detail: call.name + " is async; call is a bare statement" },
          { source: "source", detail: "call site", excerpt: excerptOf(contentMap, file.file, call.line) },
        ],
        suggestion: {
          summary: "Await the call or handle its rejection explicitly.",
          change: "Add await when the caller should wait; use void with an explicit .catch only when the work is intentionally fire-and-forget.",
          tradeoffs: "Awaiting changes ordering and timing; a fire-and-forget path needs its own error reporting.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["async"],
      });
    }
  }

  if (js.anyCount > 0) {
    push({
      rule: "any-usage",
      category: "type-safety",
      subcategory: "any",
      title: "TypeScript any appears " + js.anyCount + " time(s)",
      explanation:
        "Explicit any (annotations or casts) disables checking at the boundary where it appears. This file uses it " +
        js.anyCount +
        " time(s) on " +
        (js.anyLines.length === 1 ? "line " : "lines ") +
        js.anyLines.slice(0, 8).join(", ") +
        (js.anyLines.length > 8 ? ", ..." : "") +
        ".",
      file: file.file,
      line: js.anyLines[0] ?? 1,
      endLine: js.anyLines[0] ?? 1,
      severity: "low",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Values crossing the cast are unchecked; errors move from compile time to runtime.",
      why: "The AST contains explicit any nodes. Counts are structural, not a claim that each one is avoidable.",
      evidence: [{ source: "ast", detail: js.anyCount + " any node(s)" }],
      suggestion: {
        summary: "Replace any with unknown at input boundaries and narrow explicitly.",
        change: "Parse external data into a validated shape (schema or type guard) and keep any only in compatibility shims with a comment and an expiry.",
        tradeoffs: "unknown forces validation work; in a large migration, fix the highest-risk boundary first.",
        effort: "medium",
        autoFixable: false,
      },
      tags: ["types"],
    });
  }

  if (js.typeIgnoreLines.length > 0) {
    push({
      rule: "type-check-bypass",
      category: "type-safety",
      subcategory: "suppression",
      title: "Type checking is bypassed on " + js.typeIgnoreLines.length + " line(s)",
      explanation:
        "The file suppresses the type checker with ts-ignore/ts-expect-error/ts-nocheck on line(s) " +
        js.typeIgnoreLines.slice(0, 8).join(", ") +
        ". Each suppression hides a contract mismatch from the compiler.",
      file: file.file,
      line: js.typeIgnoreLines[0],
      endLine: js.typeIgnoreLines[0],
      severity: "low",
      confidence: "high",
      confirmation: "confirmed",
      impact: "The compiler no longer protects this path; refactors can break it silently.",
      why: "Comment directives were found by exact pattern.",
      evidence: [{ source: "source", detail: js.typeIgnoreLines.length + " suppression directive(s)" }],
      suggestion: {
        summary: "Fix the underlying type or localise the suppression with ts-expect-error and a reason.",
        change: "Prefer expect-error (it fails when the error disappears) and link the issue that removes the workaround.",
        tradeoffs: "Fixing types may require changes in callers; do it incrementally.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["types"],
    });
  }

  if (js.nonNullCount >= 3) {
    push({
      rule: "non-null-assertions",
      category: "type-safety",
      subcategory: "assertion",
      title: "Non-null assertions used " + js.nonNullCount + " time(s)",
      explanation:
        "The file asserts non-null " +
        js.nonNullCount +
        " times. Each assertion is a promise to the compiler that is not checked at runtime.",
      file: file.file,
      line: js.nonNullLines[0] ?? 1,
      endLine: js.nonNullLines[0] ?? 1,
      severity: "low",
      confidence: "medium",
      confirmation: "potential",
      impact: "A null/undefined value becomes a runtime TypeError instead of a compile-time complaint.",
      why: "Multiple postfix non-null assertions were found; the threshold avoids flagging a single idiomatic case.",
      evidence: [{ source: "ast", detail: js.nonNullCount + " non-null assertion(s)" }],
      suggestion: {
        summary: "Narrow with an explicit check or make the optionality part of the type.",
        change: "Replace x! with a guard that returns or throws a descriptive error; if the invariant is real, encode it in the function contract.",
        tradeoffs: "Guards add code; for values validated far away, centralise the invariant instead of duplicating checks.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["types"],
    });
  }

  if (js.looseEquality.length > 0) {
    push({
      rule: "loose-equality",
      category: "type-safety",
      subcategory: "coercion",
      title: "Loose equality used " + js.looseEquality.length + " time(s)",
      explanation:
        "The file uses == or != (excluding null checks) " +
        js.looseEquality.length +
        " time(s), which performs coercion rules that are easy to misread.",
      file: file.file,
      line: js.looseEquality[0].line,
      endLine: js.looseEquality[0].line,
      severity: "low",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Coercion can make different values compare equal (for example 0 == '').",
      why: "Equality operators were found with operands that are not null/undefined literals.",
      evidence: [{ source: "ast", detail: js.looseEquality.length + " non-null loose comparison(s)" }],
      suggestion: {
        summary: "Use === / !==; keep == null only where it intentionally covers both null and undefined.",
        change: "Replace operators and fix any resulting type errors, which usually expose a real assumption.",
        tradeoffs: "Coercion may be intentional when comparing untrusted input; normalise the input first instead.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["coercion"],
    });
  }

  for (const test of js.tests) {
    if (test.skipped || test.name === "describe") continue;
    if (!test.hasAssertion) {
      push({
        rule: "test-without-assertion",
        category: "testing",
        subcategory: "assertions",
        title: "Test has no recognised assertion",
        explanation:
          "The test '" +
          test.name +
          "' (line " +
          test.line +
          ") contains no expect/assert-style call in its callback. A test that only executes code cannot fail when the behaviour is wrong.",
        file: file.file,
        line: test.line,
        endLine: test.endLine,
        symbol: test.name,
        severity: "low",
        confidence: "medium",
        confirmation: "potential",
        impact: "False confidence: the suite stays green while the assertion is missing.",
        why: "No known assertion helper was found in the test callback. Custom helpers are not recognised, so this is potential.",
        evidence: [{ source: "ast", detail: "test callback has no expect/assert call" }],
        suggestion: {
          summary: "Assert the observable outcome, or mark the test as a TODO with a tracker.",
          change: "Add an assertion on the returned value, thrown error, or side effect. If the test is a placeholder, use test.todo so the gap is visible.",
          tradeoffs: "Snapshot-only tests may still be weak; assert the contract, not the whole shape.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["tests"],
      });
    }
  }

  const skipped = js.tests.filter((test) => test.skipped);
  if (skipped.length > 0) {
    push({
      rule: "skipped-tests",
      category: "testing",
      subcategory: "skipped",
      title: skipped.length + " skipped test(s) in this file",
      explanation:
        "Skipped tests are counted as test coverage by some tools but prove nothing. Examples: " +
        skipped.slice(0, 3).map((test) => test.name).join(", ") +
        ".",
      file: file.file,
      line: skipped[0].line,
      endLine: skipped[0].endLine,
      severity: "low",
      confidence: "high",
      confirmation: "confirmed",
      impact: "A skipped regression test can hide a broken behaviour indefinitely.",
      why: "Test declarations use skip/todo modifiers.",
      evidence: [{ source: "ast", detail: skipped.length + " skipped test declaration(s)" }],
      suggestion: {
        summary: "Fix and re-enable, or delete with a linked reason.",
        change: "Treat skipped tests like TODOs: add an owner and date, and make the skip visible in the test report.",
        tradeoffs: "Some skips are environment-specific; mark those with an explicit condition instead of a blanket skip.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["tests"],
    });
  }

  if (testFile && js.functions.length > 0 && js.functions.every((fn) => fn.tokens.length < 4)) {
    ctx.warnings.push("Test file " + file.file + " could not be analysed structurally.");
  }
}

function runPythonFileRules(
  ctx: RuleContext,
  file: { file: string; content: string },
  python: NonNullable<import("./indexTypes.js").AuditSourceFile["python"]>,
  push: (spec: FindingSpec) => void,
): void {
  const testFile = isTestFile(file.file);
  for (const fn of python.functions) {
    if (fn.loc >= 80) {
      push({
        rule: "function-too-long",
        category: "maintainability",
        subcategory: "long-function",
        title: "Function is " + fn.loc + " lines long",
        explanation:
          fn.name + " spans " + fn.loc + " lines. The measurement comes from an indentation scan, not a Python AST.",
        file: file.file,
        line: fn.line,
        endLine: fn.endLine,
        symbol: fn.name,
        severity: fn.loc >= 140 ? "high" : fn.loc >= 110 ? "medium" : "low",
        confidence: "medium",
        confirmation: "confirmed",
        impact: "Harder to review and test; responsibilities are mixed.",
        why: "The function body exceeds the 80-line threshold.",
        evidence: [{ source: "indentation-scan", detail: "def " + fn.name + " lines " + fn.line + "-" + fn.endLine }],
        suggestion: {
          summary: "Extract cohesive steps into helpers with explicit inputs.",
          change: "Separate validation, transformation and I/O; keep database transactions around the smallest correct unit.",
          tradeoffs: "Python call overhead is low, but over-splitting hides the transaction boundary.",
          effort: "medium",
          autoFixable: false,
        },
        tags: ["size"],
      });
    }
    if (fn.cyclomatic >= 15) {
      push({
        rule: "function-too-complex",
        category: "maintainability",
        subcategory: "complexity",
        title: "Estimated cyclomatic complexity is " + fn.cyclomatic,
        explanation:
          fn.name +
          " has an estimated " +
          fn.cyclomatic +
          " decision paths from a keyword count. This is a lead for review, not a precise AST metric.",
        file: file.file,
        line: fn.line,
        endLine: fn.endLine,
        symbol: fn.name,
        severity: fn.cyclomatic >= 25 ? "high" : "medium",
        confidence: "low",
        confirmation: "potential",
        impact: "Likely hard to test exhaustively.",
        why: "The lexical decision count crosses the threshold; comments and strings are excluded but branch semantics are approximated.",
        evidence: [{ source: "lexical", detail: "keywords counted: if/elif/for/while/except/and/or" }],
        suggestion: {
          summary: "Review for branch extraction; confirm with a real complexity tool before refactoring.",
          change: "Flatten nested conditionals and extract independent policy branches.",
          tradeoffs: "Keyword counting is approximate; the suggestion is only worth acting on after reading the function.",
          effort: "medium",
          autoFixable: false,
        },
        tags: ["complexity"],
      });
    }
    for (const call of fn.inLoopCalls) {
      const receiver = call.name.split(".").slice(0, -1).join(".");
      if (!isDatabaseOrNetworkCall(call.name, receiver)) continue;
      push({
        rule: "database-or-network-call-in-loop",
        category: "performance",
        subcategory: "n+1",
        title: "Database call inside a loop",
        explanation:
          "The loop in " + fn.name + " calls " + call.name + " per iteration. Detected lexically, so confirm that the callee performs I/O.",
        file: file.file,
        line: call.line,
        endLine: call.line,
        symbol: fn.name,
        severity: "high",
        confidence: "medium",
        confirmation: "potential",
        impact: "Round trips scale with the number of items.",
        why: "A DB-shaped call name appears in a loop body in the indentation scan.",
        evidence: [{ source: "lexical", detail: "loop calls " + call.name + " at line " + call.line }],
        suggestion: {
          summary: "Batch the lookup and index the result in memory.",
          change: "Collect keys, query once with an IN clause, then map results back to the loop items.",
          tradeoffs: "Batching changes failure atomicity; very large key sets need chunking.",
          effort: "medium",
          autoFixable: false,
        },
        tags: ["n+1"],
      });
    }
  }

  for (const entry of python.broadExcept) {
    push({
      rule: "empty-catch",
      category: "correctness",
      subcategory: "error-handling",
      title: "Broad except swallows the error",
      explanation:
        "The except block on line " +
        entry.line +
        " catches a broad exception type and does nothing or passes. Failures are discarded.",
      file: file.file,
      line: entry.line,
      endLine: entry.endLine,
      severity: "medium",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Silent failure and hard-to-diagnose partial state.",
      why: "The indentation scan found an except (bare, Exception or BaseException) with an empty/pass body.",
      evidence: [{ source: "indentation-scan", detail: "except body is empty/pass" }],
      suggestion: {
        summary: "Catch the specific exception and handle or re-raise it.",
        change: "Narrow the exception class, log structured context at the boundary, and re-raise when the caller cannot proceed.",
        tradeoffs: "Narrowing can expose errors previously hidden; verify callers and tests.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["exceptions"],
    });
  }

  for (const test of python.tests) {
    if (test.skipped || test.hasAssertion) continue;
    if (testFile || file.file.includes("test")) {
      push({
        rule: "test-without-assertion",
        category: "testing",
        subcategory: "assertions",
        title: "Test has no assertion",
        explanation: test.name + " executes code but contains no assert or pytest.raises.",
        file: file.file,
        line: test.line,
        endLine: test.line,
        symbol: test.name,
        severity: "low",
        confidence: "medium",
        confirmation: "potential",
        impact: "The test cannot fail on a behaviour regression.",
        why: "No assert/pytest.raises was found in the test body by the lexical scan.",
        evidence: [{ source: "lexical", detail: "no assertion keyword in test body" }],
        suggestion: {
          summary: "Assert the outcome or convert to a documented TODO.",
          change: "Add an assert on the return value, exception or side effect.",
          tradeoffs: "Custom assertion helpers may be missed by this heuristic.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["tests"],
      });
    }
  }
}

function runDuplication(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  const candidates = ctx.index.functions.filter((fn) => fn.tokens.length >= 24 && fn.tokens.length <= 380 && !isTestFile(fn.file));
  if (candidates.length < 2) return;
  const limit = ctx.mode === "quick" ? 500 : 2200;
  if (candidates.length > limit) {
    ctx.warnings.push("Duplication scan compared the first " + limit + " of " + candidates.length + " functions.");
  }
  const selected = candidates.slice(0, limit);
  const byHead = new Map<string, (JsFunction & { file: string })[]>();
  for (const fn of selected) {
    // Declaration keywords differ between equivalent bodies (async/export/function);
    // bucket on the body's first meaningful tokens so those still meet.
    const head = fn.tokens.filter((token) => token !== "async" && token !== "export" && token !== "function").slice(0, 5);
    const key = (head.length >= 3 ? head : fn.tokens.slice(0, 5)).join(" ");
    const bucket = byHead.get(key) ?? [];
    bucket.push(fn);
    byHead.set(key, bucket);
  }

  const pairs: { a: JsFunction & { file: string }; b: JsFunction & { file: string }; score: number }[] = [];
  for (const bucket of byHead.values()) {
    if (bucket.length < 2) continue;
    const capped = bucket.slice(0, 120);
    for (let i = 0; i < capped.length; i++) {
      for (let j = i + 1; j < capped.length; j++) {
        const a = capped[i];
        const b = capped[j];
        if (a.file === b.file && a.name === b.name) continue;
        if (Math.abs(a.tokens.length - b.tokens.length) > 60) continue;
        const score = dice(a.tokens, b.tokens);
        if (score >= 0.9) pairs.push({ a, b, score });
      }
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const seenFiles = new Set<string>();
  for (const pair of pairs.slice(0, 12)) {
    const key = [pair.a.file, pair.a.name, pair.b.file, pair.b.name].sort().join("|");
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    const identical = pair.score >= 0.98;
    push({
      rule: "duplicate-function",
      category: "maintainability",
      subcategory: "duplication",
      title: "Near-duplicate function bodies (" + Math.round(pair.score * 100) + "% token overlap)",
      explanation:
        pair.a.name +
        " in " +
        pair.a.file +
        " and " +
        pair.b.name +
        " in " +
        pair.b.file +
        " share most of their normalised token sequence. Two copies of the same logic drift apart when one is fixed.",
      file: pair.a.file,
      line: pair.a.line,
      endLine: pair.a.endLine,
      symbol: pair.a.name,
      severity: identical && pair.a.tokens.length >= 40 ? "medium" : "low",
      confidence: pair.score >= 0.95 ? "high" : "medium",
      confirmation: "potential",
      impact: "A fix applied to one copy may miss the other; tests usually cover only one path.",
      why: "Token-sequence similarity (Dice coefficient) is above 0.90; this is structural similarity, not proof of identical intent.",
      evidence: [
        { source: "tokens", detail: "similarity " + pair.score.toFixed(3) + " over " + pair.a.tokens.length + "/" + pair.b.tokens.length + " tokens" },
        { source: "location", detail: pair.b.name + " at " + pair.b.file + ":" + pair.b.line },
      ],
      suggestion: {
        summary: "Extract the shared behaviour once, parameterise the differences.",
        change: "Move the common sequence into a helper with an explicit contract; pass the genuinely different pieces as arguments.",
        tradeoffs: "Premature abstraction can couple unrelated callers. Confirm the copies must evolve together before merging.",
        effort: "medium",
        autoFixable: false,
      },
      tags: ["duplication"],
    });
  }
}

function dice(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  let intersection = 0;
  for (const token of b) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(token, count - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

function runUnusedExports(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  if (ctx.index.files.length < 4) return;
  const consumers = new Map<string, Set<string>>();
  const starReExports = new Set<string>();
  for (const file of ctx.index.files) {
    if (!file.js) continue;
    for (const entry of file.js.imports) {
      const resolved = ctx.index.imports.find(
        (candidate) => candidate.file === file.file && candidate.line === entry.line && candidate.specifier === entry.specifier,
      )?.resolved;
      if (!resolved) continue;
      if (entry.reExport === "star") {
        // The barrel forwards names this audit cannot enumerate locally.
        // Treat every export of the target as publicly reachable instead of
        // claiming each one has no consumers.
        starReExports.add(resolved);
        continue;
      }
      const set = consumers.get(resolved) ?? new Set<string>();
      // An unused import is not a consumer. Counting it would hide a real
      // unused export and, worse, removing the unused import would then look
      // like a new regression in the fix workflow. A named re-export is a
      // real consumer even though it has no local runtime use.
      for (const binding of entry.bindings) {
        if (binding.imported === "*") {
          // `import * as ns` can reach any export through a property this
          // audit does not enumerate. If the namespace is used at all,
          // every target export is potentially consumed.
          if (file.js.usedNames.includes(binding.local)) starReExports.add(resolved);
          continue;
        }
        if (entry.reExport === "named" || file.js.usedNames.includes(binding.local)) {
          set.add(binding.imported);
        }
      }
      consumers.set(resolved, set);
    }
  }

  for (const file of ctx.index.files) {
    if (!file.js || isTestFile(file.file)) continue;
    if (starReExports.has(file.file)) continue;
    const base = path.posix.basename(file.file).replace(/\.[^.]+$/, "").toLowerCase();
    if (ENTRY_NAMES.has(base)) continue;
    const used = consumers.get(file.file) ?? new Set<string>();
    const exported = file.js.exports.filter((entry) => !entry.isDefault && entry.name !== "default");
    for (const entry of exported) {
      if (used.has(entry.name)) continue;
      push({
        rule: "unused-export",
        category: "maintainability",
        subcategory: "dead-code",
        title: "Export " + entry.name + " has no consumers in the audited file set",
        explanation:
          "No indexed file imports " +
          entry.name +
          " from " +
          file.file +
          " in this audit. This is a consumer count, not proof of dead code: the symbol may be part of a published API, loaded dynamically, or used by tests outside the audited set.",
        file: file.file,
        line: entry.line,
        endLine: entry.line,
        symbol: entry.name,
        severity: "low",
        confidence: "low",
        confirmation: "unproven",
        impact: "Unused public surface increases the API contract you must keep compatible.",
        why: "Zero imports of this name across " + ctx.index.files.length + " indexed files; external consumers are unknowable locally.",
        evidence: [{ source: "import-graph", detail: "0 consumers among " + ctx.index.files.length + " indexed files" }],
        suggestion: {
          summary: "Confirm the boundary: remove if internal, document if public.",
          change: "Check package exports, dynamic imports and downstream consumers; if internal, remove it or mark it private; if public, add a doc comment and test.",
          tradeoffs: "Removing a published export is a breaking change; deprecate first when the package is consumed externally.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["dead-code", "public-api"],
      });
    }
  }
}

function runArchitecture(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  for (const cycle of ctx.index.cycles.slice(0, 20)) {
    const files = cycle.filter((entry, index) => cycle.indexOf(entry) === index);
    if (files.length < 2) continue;
    const first = files[0];
    const importEntry = ctx.index.imports.find((entry) => entry.file === first && entry.resolved === files[1]);
    push({
      rule: "import-cycle",
      category: "architecture",
      subcategory: "cycles",
      title: "Import cycle across " + files.length + " modules",
      explanation:
        "The resolved import graph contains a cycle: " +
        cycle.join(" -> ") +
        ". Cycles make initialisation order significant and prevent either module from being understood alone.",
      file: first,
      line: importEntry?.line ?? 1,
      endLine: importEntry?.line ?? 1,
      severity: files.length >= 4 ? "high" : "medium",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Fragile load order, harder isolated testing, and circular type/runtime dependencies.",
      why: "Tarjan-style DFS found a back edge in the resolved relative-import graph.",
      evidence: [{ source: "import-graph", detail: "cycle: " + cycle.join(" -> ") }],
      suggestion: {
        summary: "Break the cycle by moving the shared contract into a third module.",
        change: "Extract the types/interfaces both sides need into a leaf module, or invert one direction with dependency injection.",
        tradeoffs: "Extraction can create a new 'shared' dumping ground; keep the leaf module small and stable.",
        effort: "medium",
        autoFixable: false,
      },
      tags: ["cycle"],
    });
  }

  for (const boundary of ctx.boundaries) {
    const fromPatterns = Array.isArray(boundary.from) ? boundary.from : [boundary.from];
    for (const file of ctx.index.files) {
      if (!globMatches(fromPatterns, file.file)) continue;
      for (const entry of ctx.index.imports) {
        if (entry.file !== file.file || !entry.resolved) continue;
        if (!globMatches(boundary.forbidImportsFrom, entry.resolved)) continue;
        push({
          rule: "boundary-violation",
          category: "architecture",
          subcategory: "boundaries",
          title: "Import crosses an architecture boundary",
          explanation:
            file.file +
            " imports " +
            entry.resolved +
            ", which the repository's architecture configuration forbids." +
            (boundary.reason ? " Rule reason: " + boundary.reason : ""),
          file: file.file,
          line: entry.line,
          endLine: entry.line,
          severity: "high",
          confidence: "high",
          confirmation: "confirmed",
          impact: "Layer boundaries erode silently; the forbidden dependency becomes hard to remove later.",
          why: "The import resolves to a path matched by forbidImportsFrom in .pitstop architecture configuration.",
          evidence: [{ source: "architecture-config", detail: "boundary from " + fromPatterns.join(", ") + " forbids " + boundary.forbidImportsFrom.join(", ") }],
          suggestion: {
            summary: "Depend on an interface owned by the allowed layer.",
            change: "Move the shared contract to the permitted layer and inject the implementation, or use an event instead of a direct import.",
            tradeoffs: "Indirection adds a seam; document the allowed direction so the next change does not re-cross it.",
            effort: "medium",
            autoFixable: false,
          },
          tags: ["boundaries"],
        });
      }
    }
  }
}

function runSyncIoInPaths(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  const byFunction = new Map<string, JsFunction & { file: string }>();
  for (const fn of ctx.index.functions) byFunction.set(fn.file + "#" + fn.name + "@" + fn.line, fn);
  const reported = new Set<string>();
  for (const execution of ctx.index.executionPaths) {
    for (const step of execution.steps) {
      const fn = byFunction.get(step.file + "#" + step.name + "@" + step.line);
      if (!fn) continue;
      for (const call of fn.calls) {
        if (!SYNC_IO.test(call.name)) continue;
        const key = step.file + ":" + call.line;
        if (reported.has(key)) continue;
        reported.add(key);
        push({
          rule: "sync-io-on-request-path",
          category: "performance",
          subcategory: "blocking-io",
          title: "Synchronous " + call.name + " on a request path",
          explanation:
            "The request path " +
            execution.route +
            " reaches " +
            fn.name +
            ", which calls blocking " +
            call.name +
            ". While this runs, the event loop cannot serve other requests.",
          file: step.file,
          line: call.line,
          endLine: call.endLine,
          symbol: fn.name,
          severity: "medium",
          confidence: "medium",
          confirmation: "potential",
          impact: "Throughput collapses under concurrency; p99 latency spikes.",
          why: "A synchronous filesystem/process call is reachable from a detected route through resolved call edges.",
          evidence: [
            { source: "call-graph", detail: execution.route + " -> " + execution.steps.map((s) => s.name).join(" -> ") },
            { source: "source", detail: "line " + call.line },
          ],
          suggestion: {
            summary: "Use the asynchronous API and await it at the boundary.",
            change: "Replace with fs.promises / execFile and propagate async through the call chain; if the value is static, load it once at startup.",
            tradeoffs: "Going async can require signature changes; loading at startup changes freshness guarantees.",
            effort: "small",
            autoFixable: false,
          },
          tags: ["blocking", "io"],
        });
      }
    }
  }
}

function runRepeatedCalls(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  for (const fn of ctx.index.functions) {
    const groups = new Map<string, { name: string; lines: number[]; object?: string }>();
    for (const call of fn.calls) {
      if (call.inLoop || call.args.length === 0) continue;
      if (!/^(get|find|fetch|read|load|query|parse|compute|resolve|check|lookup)/i.test(call.name)) continue;
      if (call.object === "console") continue;
      const key = (call.object ?? "") + "." + call.name + "(" + call.args.join(",") + ")";
      const group = groups.get(key) ?? { name: call.name, lines: [], ...(call.object ? { object: call.object } : {}) };
      group.lines.push(call.line);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.lines.length < 2) continue;
      push({
        rule: "repeated-identical-call",
        category: "performance",
        subcategory: "repeated-work",
        title: "Identical " + group.name + " call repeated in one function",
        explanation:
          (group.object ? group.object + "." : "") +
          group.name +
          " is called " +
          group.lines.length +
          " times with the same arguments on lines " +
          group.lines.join(", ") +
          ". Unless the value changes between calls, the second call repeats work.",
        file: fn.file,
        line: group.lines[0],
        endLine: group.lines[group.lines.length - 1],
        symbol: fn.name,
        severity: "low",
        confidence: "medium",
        confirmation: "potential",
        impact: "Extra I/O or CPU; two calls can also observe different state and disagree.",
        why: "Call name and literal argument text match; the callee may be intentionally non-idempotent.",
        evidence: [{ source: "ast", detail: group.lines.length + " identical call(s) in " + fn.name }],
        suggestion: {
          summary: "Store the first result in a local when the value is stable.",
          change: "Assign the first call to a well-named variable and reuse it; if freshness matters, document why the second call is required.",
          tradeoffs: "Caching can hide updates made between calls; only hoist when the function owns the consistency window.",
          effort: "small",
          autoFixable: false,
        },
        tags: ["repeated-work"],
      });
    }
  }
}

function runRegexRules(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  for (const file of ctx.index.files) {
    if (!file.js) continue;
    for (const regex of file.js.regexes) {
      if (regex.dynamic) {
        if (/escape|escaped|sanitiz|quote/i.test(regex.pattern)) continue;
        push({
          rule: "dynamic-regexp",
          category: "security",
          subcategory: "regex-injection",
          title: "RegExp is built from a non-literal expression",
          explanation:
            "new RegExp(" +
            regex.pattern +
            ") builds a pattern at runtime. If any part of that expression is user-controlled, an attacker can change the pattern or trigger catastrophic backtracking.",
          file: file.file,
          line: regex.line,
          endLine: regex.line,
          severity: "low",
          confidence: "low",
          confirmation: "potential",
          impact: "Pattern injection or ReDoS if the input is untrusted.",
          why: "The constructor argument is not a string literal; provenance is not tracked, so this is potential.",
          evidence: [{ source: "ast", detail: "dynamic RegExp argument" }],
          suggestion: {
            summary: "Escape untrusted fragments and prefer literal patterns.",
            change: "Use a literal regex where possible; otherwise escape the interpolated fragment with a well-tested escaper and cap input length.",
            tradeoffs: "Escaping changes matching semantics; keep a test for the intended user input.",
            effort: "small",
            autoFixable: false,
          },
          tags: ["regex", "security"],
        });
        continue;
      }
      if (riskyRegex(regex.pattern)) {
        push({
          rule: "regex-backtracking",
          category: "security",
          subcategory: "redos",
          title: "Regex has a nested quantifier",
          explanation:
            "Pattern /" +
            regex.pattern +
            "/" +
            regex.flags +
            " contains a quantified group that is itself quantified. On crafted input this shape can backtrack exponentially.",
          file: file.file,
          line: regex.line,
          endLine: regex.line,
          severity: "medium",
          confidence: "medium",
          confirmation: "potential",
          impact: "A single request can pin a CPU core (ReDoS).",
          why: "The nested-quantifier shape is present; whether it is exploitable depends on where the pattern is applied and input length.",
          evidence: [{ source: "ast", detail: "pattern: " + regex.pattern.slice(0, 120) }],
          suggestion: {
            summary: "Bound the repetition or replace the nested quantifier with an unambiguous form.",
            change: "Use explicit bounds (for example {1,64}), anchor the pattern, cap input length, or move to a linear-time engine.",
            tradeoffs: "Tightening bounds can reject valid input; add tests with the longest real input.",
            effort: "small",
            autoFixable: false,
          },
          tags: ["regex", "redos"],
        });
      }
    }
  }
}

function riskyRegex(pattern: string): boolean {
  if (pattern.length > 2000) return false;
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*]/.test(pattern) || /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\{\d+,\d*\}/.test(pattern);
}

function runHardcoding(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  const urls = new Map<string, { file: string; line: number }[]>();
  const paths: { file: string; line: number; value: string }[] = [];
  const numbers = new Map<number, { file: string; line: number }[]>();
  const contentByFile = new Map(ctx.index.files.map((file) => [file.file, file.content]));

  for (const file of ctx.index.files) {
    if (isTestFile(file.file)) continue;
    const strings = file.js?.strings ?? file.python?.strings ?? [];
    for (const entry of strings) {
      if (!entry.inFunction) continue;
      if (/^https?:\/\//.test(entry.value)) {
        if (/localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org)|schema\.|w3\.org|json-schema/.test(entry.value)) continue;
        const list = urls.get(entry.value) ?? [];
        list.push({ file: file.file, line: entry.line });
        urls.set(entry.value, list);
      }
      if (/^[A-Za-z]:\\/.test(entry.value) || /^\/(?:home|Users|var\/www)\//.test(entry.value) || /^\\\\/.test(entry.value)) {
        paths.push({ file: file.file, line: entry.line, value: entry.value });
      }
    }
    const numeric = file.js?.numbers ?? file.python?.numbers ?? [];
    for (const entry of numeric) {
      if (!entry.inFunction) continue;
      if (!Number.isFinite(entry.value) || Math.abs(entry.value) < 100) continue;
      if (HTTP_STATUS.has(entry.value) || TIME_CONSTANTS.has(entry.value)) continue;
      if (!Number.isInteger(entry.value)) continue;
      const line = contentByFile.get(file.file)?.split(/\r?\n/)[entry.line - 1] ?? "";
      if (/^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=/.test(line)) continue;
      const list = numbers.get(entry.value) ?? [];
      list.push({ file: file.file, line: entry.line });
      numbers.set(entry.value, list);
    }
  }

  for (const [url, occurrences] of urls) {
    const files = new Set(occurrences.map((entry) => entry.file));
    if (files.size < 2) continue;
    push({
      rule: "hardcoded-url",
      category: "maintainability",
      subcategory: "hardcoding",
      title: "Environment URL is duplicated across " + files.size + " files",
      explanation:
        "The literal " +
        redact(url) +
        " appears in " +
        files.size +
        " files. Environment endpoints should have one source of truth; duplicated literals drift when the environment changes.",
      file: occurrences[0].file,
      line: occurrences[0].line,
      endLine: occurrences[0].line,
      severity: "medium",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Staging/production changes require edits in several places; one missed copy sends traffic to the wrong host.",
      why: "The same absolute URL literal occurs in function bodies in multiple files.",
      evidence: occurrences.slice(0, 5).map((entry) => ({ source: "literal", detail: entry.file + ":" + entry.line })),
      suggestion: {
        summary: "Move the base URL into configuration with a documented default.",
        change: "Read it from an environment variable validated at startup; keep a single constant for the default development value.",
        tradeoffs: "Configuration adds a failure mode when missing; validate early and fail with a clear message.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["config", "hardcoding"],
    });
  }

  for (const entry of paths.slice(0, 10)) {
    push({
      rule: "hardcoded-absolute-path",
      category: "readability",
      subcategory: "environment-coupling",
      title: "Hardcoded absolute filesystem path",
      explanation: "The code embeds the machine-specific path " + entry.value.slice(0, 100) + ". It will fail on another machine or in CI.",
      file: entry.file,
      line: entry.line,
      endLine: entry.line,
      severity: "medium",
      confidence: "high",
      confirmation: "confirmed",
      impact: "Portability failure and accidental writes outside the workspace.",
      why: "A string literal starts with a drive letter, home directory, or UNC prefix.",
      evidence: [{ source: "literal", detail: entry.value.slice(0, 120) }],
      suggestion: {
        summary: "Resolve paths from configuration or the module location.",
        change: "Use path.resolve with a configured root (process.cwd(), import.meta.dirname, or an environment variable) and validate that the result stays inside the intended root.",
        tradeoffs: "Relative resolution depends on the working directory; make the base explicit.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["portability"],
    });
  }

  for (const [value, occurrences] of numbers) {
    const files = new Set(occurrences.map((entry) => entry.file));
    if (occurrences.length < 3 || files.size < 2) continue;
    push({
      rule: "magic-number",
      category: "readability",
      subcategory: "magic-values",
      title: "Magic number " + value + " repeats across " + files.size + " files",
      explanation:
        value +
        " appears " +
        occurrences.length +
        " times in executable code in " +
        files.size +
        " files. Repeated raw numbers hide the unit and the reason for the value.",
      file: occurrences[0].file,
      line: occurrences[0].line,
      endLine: occurrences[0].line,
      severity: "low",
      confidence: "medium",
      confirmation: "potential",
      impact: "Changing a policy value requires finding every copy; unit mistakes are easy.",
      why: "The same numeric literal occurs repeatedly in function bodies and is not declared as a named constant on its own line.",
      evidence: occurrences.slice(0, 5).map((entry) => ({ source: "literal", detail: entry.file + ":" + entry.line + " -> " + value })),
      suggestion: {
        summary: "Name the value once where its unit is clear.",
        change: "Declare a constant such as RETRY_LIMIT or CACHE_TTL_MS in the module that owns the policy; do not create a global constant dump.",
        tradeoffs: "Some numbers are self-explanatory in context; naming every one adds noise. Prioritise values that encode policy or units.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["magic-values"],
    });
  }
}

function runSecurity(ctx: RuleContext, push: (spec: FindingSpec) => void): void {
  for (const issue of ctx.security ?? []) {
    const description = redact(issue.description.replace(/^\[indicated\]\s*/i, "")) || "Static security pattern";
    const severity = issue.severity === "critical" || issue.severity === "high" || issue.severity === "medium" ? issue.severity : "low";
    push({
      rule: "security-static",
      category: "security",
      subcategory: issue.category ?? "static",
      title: description,
      explanation:
        "The repository's static security scanner indicated this pattern. Static analysis points at a class of bug; it does not prove exploitability. Treat it as a review lead with a concrete fix.",
      file: issue.file,
      line: issue.line,
      endLine: issue.line,
      severity,
      confidence: "medium",
      confirmation: "potential",
      impact: "Depends on exposure and input control; unvalidated input on a reachable path raises it.",
      why: "A high-confidence static security rule matched this line.",
      evidence: [{ source: "security-static", detail: issue.category ?? "security pattern" }],
      suggestion: {
        summary: redact(issue.fix ?? "Validate input and use the safe API for this operation."),
        change: redact(issue.fix ?? "Apply the parameterised/validated form of the operation and add a regression test."),
        tradeoffs: "Security fixes can change API contracts; verify callers and add a test that fails before the fix.",
        effort: "small",
        autoFixable: false,
      },
      tags: ["security"],
    });
  }
}

export function ruleCatalogue(): { rule: string; category: AuditCategory; summary: string }[] {
  return [
    { rule: "function-too-long", category: "maintainability", summary: "Function over 80 lines." },
    { rule: "function-too-complex", category: "maintainability", summary: "Cyclomatic complexity at or above 15." },
    { rule: "deeply-nested-code", category: "maintainability", summary: "Control flow nested five or more levels." },
    { rule: "duplicate-function", category: "maintainability", summary: "Token-similar function bodies across files." },
    { rule: "unused-import", category: "maintainability", summary: "Imported binding never referenced." },
    { rule: "unused-export", category: "maintainability", summary: "Export with no in-repo consumer (unproven public API)." },
    { rule: "empty-catch", category: "correctness", summary: "Empty catch / broad empty except." },
    { rule: "swallowed-error", category: "correctness", summary: "Catch logs and continues without handling." },
    { rule: "floating-async-call", category: "correctness", summary: "Async call neither awaited nor caught." },
    { rule: "await-in-loop", category: "performance", summary: "Sequential awaits inside a loop." },
    { rule: "database-or-network-call-in-loop", category: "performance", summary: "N+1-shaped call inside a loop." },
    { rule: "sync-io-on-request-path", category: "performance", summary: "Blocking I/O reachable from a route." },
    { rule: "repeated-identical-call", category: "performance", summary: "Same call with same arguments repeated." },
    { rule: "hardcoded-url", category: "maintainability", summary: "Environment URL duplicated across files." },
    { rule: "hardcoded-absolute-path", category: "readability", summary: "Machine-specific absolute path." },
    { rule: "magic-number", category: "readability", summary: "Repeated raw numeric literal." },
    { rule: "regex-backtracking", category: "security", summary: "Nested quantifier with catastrophic backtracking shape." },
    { rule: "dynamic-regexp", category: "security", summary: "RegExp constructed from a non-literal." },
    { rule: "any-usage", category: "type-safety", summary: "Explicit any in a file." },
    { rule: "type-check-bypass", category: "type-safety", summary: "ts-ignore / ts-expect-error / ts-nocheck." },
    { rule: "non-null-assertions", category: "type-safety", summary: "Repeated non-null assertions." },
    { rule: "loose-equality", category: "type-safety", summary: "Non-null loose equality." },
    { rule: "test-without-assertion", category: "testing", summary: "Test callback has no known assertion." },
    { rule: "skipped-tests", category: "testing", summary: "Skipped or todo tests." },
    { rule: "import-cycle", category: "architecture", summary: "Cycle in the resolved import graph." },
    { rule: "boundary-violation", category: "architecture", summary: "Import forbidden by architecture config." },
    { rule: "security-static", category: "security", summary: "Indicated finding from the static security scanner." },
  ];
}
