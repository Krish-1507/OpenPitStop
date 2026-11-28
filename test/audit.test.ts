import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsFile } from "../src/audit/jsParser.js";
import { parsePythonFile } from "../src/audit/pythonIndex.js";
import { runAudit } from "../src/audit/run.js";
import { renderAuditSummary, renderMarkdown } from "../src/audit/report.js";
import { grade, scoreFindings } from "../src/audit/score.js";
import { finalizeFindings } from "../src/audit/rules.js";
import { checkEvidence } from "../src/evidence.js";
import { contentDigestValid } from "../src/audit/integrity.js";
import { applyFixPlan, applyPatchToContent, createFixPlan } from "../src/audit/fixes.js";
import { commandExists, safeExec } from "../src/analyzers/util.js";
import { redact } from "../src/audit/text.js";
import type { AuditCategory, AuditFinding } from "../src/audit/types.js";

const seeded = path.resolve("bench/audit/js-seeded-quality/repo");
const unsupported = path.resolve("bench/audit/unsupported-language/repo");

function tempCopy(source: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-"));
  fs.cpSync(source, dir, { recursive: true });
  return dir;
}

test("audit redaction: credential shapes are masked in evidence and excerpts", () => {
  const text = [
    'const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz";',
    'const db = "postgres://user:password@example.test/app";',
    'const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345";',
    "const aws = 'AKIAIOSFODNN7EXAMPLE';",
    'const header = "authorization: Bearer abcdefghijklmnop tail";',
    'const password = "correct horse battery staple";',
    'const env = "AWS_SECRET_ACCESS_KEY=abcdefghijklmnop";',
    "const shortToken = 'token: ab';",
  ].join("\n");
  const redacted = redact(text);
  assert.doesNotMatch(redacted, /sk-proj-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(redacted, /user:password@/);
  assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(redacted, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
  assert.doesNotMatch(redacted, / tail/);
  assert.doesNotMatch(redacted, /correct horse battery staple/);
  assert.doesNotMatch(redacted, /AWS_SECRET_ACCESS_KEY=abcdefghijklmnop/);
  assert.doesNotMatch(redacted, /token: ab/);
  assert.match(redacted, /\[redacted/);
});

test("audit cap: the global finding budget cannot erase an entire measured category", () => {
  const categories: AuditCategory[] = ["maintainability", "type-safety", "readability"];
  const rules = ["synthetic-a", "synthetic-b", "synthetic-c"];
  const findings: AuditFinding[] = Array.from({ length: 300 }, (_, index) => ({
    id: "aud-" + index,
    fingerprint: "synthetic-" + index,
    rule: rules[index % rules.length]!,
    category: categories[index % categories.length]!,
    subcategory: "synthetic",
    title: "Synthetic finding",
    explanation: "",
    location: { file: "src/" + String(index).padStart(3, "0") + ".ts", line: 1, endLine: 1 },
    severity: "high",
    confidence: "medium",
    confirmation: "potential",
    impact: "",
    why: "",
    evidence: [],
    suggestion: {
      summary: "",
      change: "",
      tradeoffs: "",
      effort: "small",
      autoFixable: false,
    },
    lifecycle: "new",
    tags: [],
    deduction: 0,
  }));
  const warnings: string[] = [];
  const selected = finalizeFindings(findings, warnings);
  assert.equal(selected.length, 250);
  for (const category of categories) {
    assert.ok(selected.some((finding) => finding.category === category), "category disappeared: " + category);
  }
  assert.match(warnings.join(" "), /finding budget reached/i);
});

test("audit parser: exported declarations are indexed, including their calls and types", () => {
  const parsed = parseJsFile(
    "src/service.ts",
    [
      "import { readFileSync } from \"node:fs\";",
      "import { helper } from \"./other.js\";",
      "export { helper };",
      "export async function load(req: any) {",
      "  await helper();",
      "  const raw = readFileSync(\"/var/data/config.json\", \"utf8\");",
      "  const matches = /config/.test(raw);",
      "  if (raw == null || !matches) return [];",
      "  return raw as any;",
      "}",
    ].join("\n"),
  );
  assert.equal(parsed.functions.length, 1);
  assert.equal(parsed.functions[0]?.name, "load");
  assert.equal(parsed.functions[0]?.async, true);
  assert.equal(parsed.anyCount, 2);
  assert.equal(parsed.catches.length, 0);
  assert.equal(parsed.tests.length, 0, "a regex .test() call is not a test declaration");
  assert.ok(parsed.usedNames.includes("helper"));
  assert.ok(parsed.usedNames.includes("readFileSync"));
  assert.deepEqual(
    parsed.imports.map((entry) => entry.specifier),
    ["node:fs", "./other.js"],
  );
});

test("audit parser: a type-only import used in a signature is not called unused", () => {
  const parsed = parseJsFile(
    "src/service.ts",
    [
      "import type { Config, Result } from \"./types.js\";",
      "export interface Loader {",
      "  load(config: Config): Promise<Result[]>;",
      "}",
      "export function run(config: Config): Result[] {",
      "  void config;",
      "  return [];",
      "}",
    ].join("\n"),
  );
  assert.ok(parsed.usedNames.includes("Config"));
  assert.ok(parsed.usedNames.includes("Result"));
});

test("audit parser: named and star re-exports are recorded as consumer edges", () => {
  const parsed = parseJsFile(
    "src/barrel.ts",
    [
      'export * from "./all.js";',
      'export * as ns from "./namespace.js";',
      'export { Foo as Bar, type Baz } from "./named.js";',
    ].join("\n"),
  );
  const star = parsed.imports.filter((entry) => entry.reExport === "star");
  assert.deepEqual(star.map((entry) => entry.specifier).sort(), ["./all.js", "./namespace.js"]);
  const named = parsed.imports.find((entry) => entry.reExport === "named");
  assert.ok(named);
  assert.deepEqual(named.bindings.map((binding) => binding.imported), ["Foo", "Baz"]);
  assert.equal(named.bindings[1]?.typeOnly, true);
});

test("audit unused exports: a barrel re-export is a consumer, but an orphan export is not", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-reexport-"));
  try {
    fs.writeFileSync(
      path.join(repo, "types.ts"),
      [
        "export interface Shared { id: string }",
        "export function sharedValue(): number { return 1; }",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(repo, "named.ts"), "export interface Named { name: string }\n");
    fs.writeFileSync(path.join(repo, "orphan.ts"), "export interface Orphan { value: string }\n");
    fs.writeFileSync(path.join(repo, "namespace.ts"), "export interface Namespaced { id: string }\n");
    fs.writeFileSync(
      path.join(repo, "index.ts"),
      ['export * from "./types.js";', 'export { Named } from "./named.js";'].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(repo, "app.ts"),
      [
        'import { Shared, sharedValue } from "./index.js";',
        'import { Named } from "./index.js";',
        'import * as Namespace from "./namespace.js";',
        "const shared: Shared = { id: String(sharedValue()) };",
        'const named: Named = { name: "x" };',
        'const namespaced: Namespace.Namespaced = { id: "y" };',
        "console.log(shared, named, namespaced);",
      ].join("\n") + "\n",
    );
    const result = await runAudit(repo, {
      mode: "deep",
      scope: [],
      useCache: false,
      persist: false,
    });
    const unusedExports = result.report.findings.filter((finding) => finding.rule === "unused-export");
    assert.equal(unusedExports.some((finding) => finding.location.file === "types.ts"), false);
    assert.equal(unusedExports.some((finding) => finding.location.file === "named.ts"), false);
    assert.equal(unusedExports.some((finding) => finding.location.file === "namespace.ts"), false);
    assert.ok(unusedExports.some((finding) => finding.location.file === "orphan.ts" && finding.title.includes("Orphan")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit parser: a local re-export is a use of the imported binding", () => {
  const parsed = parseJsFile(
    "src/barrel.ts",
    ['import { helper } from "./helper.js";', "export { helper };"].join("\n"),
  );
  assert.ok(parsed.usedNames.includes("helper"));
});

test("audit python index: broad except and loop calls are recorded, but not called an AST", () => {
  const parsed = parsePythonFile(
    "py/app.py",
    ["def load(items):", "    for item in items:", "        db.find_many(item)", "    try:", "        risky()", "    except Exception:", "        pass", ""].join("\n"),
  );
  assert.equal(parsed.broadExcept.length, 1);
  assert.ok(parsed.functions[0]?.inLoopCalls.some((call) => call.name === "db.find_many"));
});

test("audit deep: seeded defects are found with evidence, a score and 15 report sections", async () => {
  const result = await runAudit(seeded, { mode: "deep", scope: [], useCache: false, persist: false });
  const rules = new Set(result.report.findings.map((finding) => finding.rule));
  for (const rule of ["empty-catch", "database-or-network-call-in-loop", "hardcoded-absolute-path", "unused-import", "duplicate-function", "test-without-assertion", "skipped-tests"]) {
    assert.ok(rules.has(rule), "missing rule " + rule);
  }
  assert.equal(result.report.findings.some((finding) => finding.location.file === "src/clean.ts" && finding.severity === "high"), false);
  assert.ok(result.report.score.overall > 40 && result.report.score.overall < 96);
  assert.equal(result.report.coverage.wholeRepository, true);
  assert.equal(result.report.findings.filter((finding) => finding.evidence.length === 0).length, 0);
  assert.equal(contentDigestValid(result.report), true);
  const tampered = structuredClone(result.report);
  const withEvidence = tampered.findings.find((finding) => finding.evidence.length > 0);
  assert.ok(withEvidence);
  withEvidence.evidence[0].detail += " edited";
  assert.equal(checkEvidence(tampered).status, "verified", "the shared seal excludes nested evidence by design");
  assert.equal(contentDigestValid(tampered), false, "the audit content digest detects nested evidence edits");
  assert.equal(result.report.evidence?.scheme, "pitstop-canonical-sha256-v1");
  assert.equal(renderMarkdown(result.report).match(/^## \d+\. /gm)?.length, 15);
  assert.match(renderAuditSummary(result.report), new RegExp("\\b" + grade(result.report.score.overall) + "\\b"));
  assert.equal(checkEvidence(result.report).status, "verified");
});

test("audit fingerprints: repeated rule occurrences inside one function stay distinct", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-fingerprint-"));
  try {
    fs.writeFileSync(
      path.join(repo, "service.js"),
      [
        "export async function load(db, items) {",
        "  for (const item of items) { await db.find(item.id); }",
        "  for (const item of items) { await db.find(item.id); }",
        "}",
      ].join("\n") + "\n",
    );
    const result = await runAudit(repo, {
      mode: "deep",
      scope: [],
      useCache: false,
      persist: false,
    });
    const nPlusOne = result.report.findings.filter(
      (finding) => finding.rule === "database-or-network-call-in-loop",
    );
    assert.equal(nPlusOne.length, 2);
    assert.equal(new Set(nPlusOne.map((finding) => finding.fingerprint)).size, 2);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit loop calls: an Array.find is not a database call, but db.find still is", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-loop-call-"));
  try {
    fs.writeFileSync(
      path.join(repo, "service.js"),
      [
        "export function scan(items) {",
        "  for (const item of items) {",
        "    const hit = items.find((candidate) => candidate.id === item.id);",
        "    if (hit) console.log(hit);",
        "  }",
        "}",
        "export function load(db, ids) {",
        "  for (const id of ids) {",
        "    db.find(id);",
        "  }",
        "}",
      ].join("\n") + "\n",
    );
    const result = await runAudit(repo, {
      mode: "deep",
      scope: [],
      useCache: false,
      persist: false,
    });
    const nPlusOne = result.report.findings.filter(
      (finding) => finding.rule === "database-or-network-call-in-loop",
    );
    assert.equal(nPlusOne.length, 1);
    assert.equal(nPlusOne[0]?.location.line, 8);
    const evidenceText = nPlusOne[0]?.evidence
      .map((entry) => entry.detail + " " + (entry.excerpt ?? ""))
      .join(" ");
    assert.match(evidenceText, /db\.find/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit coverage: unsupported languages are disclosed as semantic none and never invented", async () => {
  const result = await runAudit(unsupported, { mode: "deep", scope: [], useCache: false, persist: false });
  const go = result.report.coverage.languages.find((language) => language.language === "go");
  assert.ok(go);
  assert.equal(go.semantic, "none");
  assert.equal(result.report.findings.filter((finding) => finding.location.file.endsWith(".go")).length, 0);
});

test("audit scope and file budget are honest about what was skipped", async () => {
  const result = await runAudit(seeded, { mode: "deep", scope: ["src"], useCache: false, persist: false, maxFiles: 1 });
  assert.equal(result.report.coverage.indexed, 1);
  assert.deepEqual(result.report.coverage.scope, ["src"]);
  assert.equal(result.report.coverage.wholeRepository, false);
  assert.match(result.report.coverage.wholeRepositoryReason ?? "", /scoped run/);
  for (const finding of result.report.findings) {
    assert.ok(finding.location.file.startsWith("src/"), "a scoped audit cannot report evidence outside the scope");
  }
  assert.equal(result.report.coverage.budget, 1);
  assert.ok(result.report.coverage.skipped > 0);
  assert.match(result.report.limits.join(" "), /budget skipped/i);
  const scopedMarkdown = renderMarkdown(result.report);
  assert.match(scopedMarkdown, /\| Scope \| src \|/);
  assert.match(scopedMarkdown, /--scope "src"/);
  assert.match(scopedMarkdown, /--max-files 1/);
  const rootScoped = await runAudit(seeded, { mode: "deep", scope: ["."], useCache: false, persist: false });
  assert.deepEqual(rootScoped.report.coverage.scope, [], "the repository root means no scope filter");
  assert.equal(rootScoped.report.coverage.wholeRepository, true);
  await assert.rejects(
    () => runAudit(seeded, { mode: "deep", scope: ["../escape"], useCache: false, persist: false }),
    /inside the repository/,
  );
  await assert.rejects(
    () => runAudit(seeded, { mode: "deep", scope: ["src/does-not-exist"], useCache: false, persist: false }),
    /does not exist/,
  );
  await assert.rejects(
    () => runAudit(seeded, { mode: "quick", scope: [], categories: ["security"], useCache: false, persist: false }),
    /cannot measure security/,
  );
});

test("audit completeness: a truncated duplication scan blocks a clean whole-repository claim", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-dup-"));
  try {
    const body = Array.from(
      { length: 501 },
      (_, index) =>
        "function f" +
        index +
        '(value) { const first = value + 1; const second = first * 2; const third = second - 3; const label = "item"; return first + second + third + label.length; }',
    ).join("\n");
    fs.writeFileSync(path.join(repo, "functions.js"), body + "\n");
    const result = await runAudit(repo, { mode: "quick", scope: [], useCache: false, persist: false });
    assert.match(result.warnings.join(" "), /Duplication scan compared the first 500 of 501/);
    assert.equal(result.report.coverage.wholeRepository, false);
    assert.match(result.report.coverage.wholeRepositoryReason ?? "", /duplication scan truncated/);
    assert.equal(
      result.report.strengths.some((strength) => /near-duplicate/i.test(strength.title)),
      false,
      "an incomplete duplication scan must not claim there are no duplicates",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit large mixed repository: budget is enforced and unsupported files are counted", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-large-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      const name = "file-" + String(index).padStart(2, "0") + ".ts";
      fs.writeFileSync(
        path.join(repo, "src", name),
        "export function f" + index + "(value: any) {\n  try { throw new Error(\"x\"); } catch {}\n  return value;\n}\n",
      );
    }
    for (let index = 0; index < 5; index += 1) {
      fs.writeFileSync(path.join(repo, "src", "a-service-" + index + ".go"), "package main\n");
    }
    const result = await runAudit(repo, {
      mode: "deep",
      scope: [],
      maxFiles: 10,
      useCache: false,
      persist: false,
    });
    assert.equal(result.report.coverage.sourceFiles, 35);
    assert.equal(result.report.coverage.indexed, 10);
    assert.equal(result.report.coverage.skipped, 25);
    assert.equal(result.report.coverage.wholeRepository, false);
    assert.match(result.report.coverage.wholeRepositoryReason ?? "", /25 file\(s\) skipped by budget/);
    assert.ok(result.report.findings.every((finding) => finding.location.file.endsWith(".ts")));
    const go = result.report.coverage.languages.find((language) => language.language === "go");
    assert.ok(go);
    assert.equal(go.semantic, "none");
    assert.equal(go.files, 5);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit categories: unselected findings do not enter the report or consume budgets", async () => {
  const repo = tempCopy(seeded);
  try {
    const result = await runAudit(repo, {
      mode: "deep",
      scope: [],
      categories: ["correctness"],
      useCache: false,
      persist: false,
    });
    assert.ok(result.report.findings.length > 0);
    assert.ok(result.report.findings.every((finding) => finding.category === "correctness"));
    assert.deepEqual(result.report.coverage.categoriesMeasured, ["correctness"]);
    assert.equal(result.report.coverage.categoriesNotMeasured.length, 7);
    assert.equal(result.report.coverage.tools.find((tool) => tool.name === "static security rules")?.used, false);
    assert.doesNotMatch(result.warnings.join(" "), /Rule cap reached for any-usage|Rule cap reached for security-static/);
    const markdown = renderMarkdown(result.report);
    assert.match(markdown, /This area was not measured in this run \(category not selected\)/);
    assert.match(markdown, /Testing was not measured in this run/);
    assert.doesNotMatch(markdown, /No testing findings were produced/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit caps: an unselected category cannot trigger a measured category's finding cap", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-audit-caps-"));
  try {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    for (let index = 0; index < 70; index += 1) {
      fs.writeFileSync(
        path.join(repo, "src", "file-" + index + ".ts"),
        'import fs from "node:fs";\nexport const value = ' + index + ";\n",
      );
    }
    const maintainability = await runAudit(repo, {
      mode: "deep",
      scope: [],
      categories: ["maintainability"],
      useCache: false,
      persist: false,
    });
    assert.match(maintainability.warnings.join(" "), /Rule cap reached for unused-import/);
    assert.equal(maintainability.report.coverage.wholeRepository, false);
    assert.match(maintainability.report.coverage.wholeRepositoryReason ?? "", /per-rule finding caps/i);

    const testing = await runAudit(repo, {
      mode: "deep",
      scope: [],
      categories: ["testing"],
      useCache: false,
      persist: false,
    });
    assert.doesNotMatch(testing.warnings.join(" "), /Rule cap reached for unused-import/);
    assert.equal(testing.report.coverage.wholeRepository, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit suppression: a suppressed finding stays visible but leaves the score", async () => {
  const repo = tempCopy(seeded);
  try {
    const first = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    const target = first.report.findings.find((finding) => finding.rule === "empty-catch");
    assert.ok(target);
    fs.mkdirSync(path.join(repo, ".pitstop"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".pitstop", "audit-suppress.json"),
      JSON.stringify({ suppressions: [{ fingerprint: target.fingerprint, reason: "test fixture", expires: "2099-01-01" }] }, null, 2),
    );
    const second = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    const suppressed = second.report.findings.find((finding) => finding.fingerprint === target.fingerprint);
    assert.equal(suppressed?.lifecycle, "suppressed");
    assert.equal(suppressed?.suppression?.reason, "test fixture");
    const suppressionReport = renderMarkdown(second.report);
    assert.match(suppressionReport, /Suppressed findings \(visible here, excluded from the score\)/);
    assert.ok(suppressionReport.includes(target.id));
    assert.equal(second.report.recommendations.some((entry) => entry.findingIds.includes(target.id)), false);
    assert.ok(second.report.score.overall >= first.report.score.overall);

    fs.writeFileSync(
      path.join(repo, ".pitstop", "audit-suppress.json"),
      JSON.stringify({ suppressions: [{ fingerprint: target.fingerprint, reason: "bad date", expires: "not-a-date" }] }),
    );
    const invalidExpiry = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.match(invalidExpiry.warnings.join(" "), /invalid expiry/i);
    assert.notEqual(
      invalidExpiry.report.findings.find((finding) => finding.fingerprint === target.fingerprint)?.lifecycle,
      "suppressed",
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: unchanged findings are existing and a fixed finding becomes resolved", async () => {
  const repo = tempCopy(seeded);
  try {
    const first = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    const skipped = first.report.findings.find((finding) => finding.rule === "skipped-tests");
    const assertion = first.report.findings.find((finding) => finding.rule === "test-without-assertion");
    assert.ok(skipped);
    assert.ok(assertion);
    const testFile = path.join(repo, "test/service.test.ts");
    const source = fs.readFileSync(testFile, "utf8");
    fs.writeFileSync(testFile, source.slice(0, source.indexOf("it.skip")));

    const second = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.equal(second.report.findings.find((finding) => finding.fingerprint === assertion.fingerprint)?.lifecycle, "existing");
    assert.ok(second.report.resolved.some((finding) => finding.fingerprint === skipped.fingerprint));
    assert.ok(renderMarkdown(second.report).includes(skipped.id));

    const latest = path.join(repo, ".pitstop", "audit-latest.json");
    const sealedBaseline = JSON.parse(fs.readFileSync(latest, "utf8")) as { score: { overall: number } };
    sealedBaseline.score.overall = 100;
    fs.writeFileSync(latest, JSON.stringify(sealedBaseline, null, 2));
    const tampered = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.match(tampered.warnings.join(" "), /evidence check/i);
    assert.ok(tampered.report.findings.every((finding) => finding.lifecycle === "new"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: an unrelated line insertion keeps finding identities", async () => {
  const repo = tempCopy(seeded);
  try {
    const first = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    const lineFinding = first.report.findings.find(
      (finding) => finding.rule === "hardcoded-absolute-path" || finding.rule === "empty-catch",
    );
    assert.ok(lineFinding, "expected a line-anchored finding in the fixture");
    const file = path.join(repo, lineFinding.location.file);
    fs.writeFileSync(file, "// an unrelated comment inserted above the finding\n" + fs.readFileSync(file, "utf8"));
    const second = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.equal(second.report.findings.find((finding) => finding.fingerprint === lineFinding.fingerprint)?.lifecycle, "existing");
    assert.equal(second.report.resolved.some((finding) => finding.fingerprint === lineFinding.fingerprint), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: nested evidence tampering is detected by the content digest", async () => {
  const repo = tempCopy(seeded);
  try {
    await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    const latest = path.join(repo, ".pitstop", "audit-latest.json");
    const baseline = JSON.parse(fs.readFileSync(latest, "utf8")) as {
      findings: { evidence: { detail: string }[] }[];
    };
    const finding = baseline.findings.find((entry) => entry.evidence.length > 0);
    assert.ok(finding);
    finding.evidence[0]!.detail += " edited after sealing";
    fs.writeFileSync(latest, JSON.stringify(baseline, null, 2));
    const next = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.match(next.warnings.join(" "), /nested content digest/i);
    assert.ok(next.report.findings.every((entry) => entry.lifecycle === "new"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: a scoped artifact is not trusted for a later full audit", async () => {
  const repo = tempCopy(seeded);
  try {
    const scoped = await runAudit(repo, { mode: "deep", scope: ["src"], useCache: false, persist: true });
    assert.equal(scoped.report.coverage.wholeRepository, false);
    const firstFinding = scoped.report.findings[0];
    assert.ok(firstFinding);
    const full = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    assert.match(full.warnings.join(" "), /previous audit artifact was scoped/i);
    assert.equal(full.report.findings.find((finding) => finding.fingerprint === firstFinding.fingerprint)?.lifecycle, "new");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: a category not measured in quick mode is never called resolved", async () => {
  const repo = tempCopy(seeded);
  try {
    fs.writeFileSync(
      path.join(repo, "src", "dynamic-security.ts"),
      "export function compile(input: string): RegExp {\n  return new RegExp(input);\n}\n",
    );
    const first = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    assert.equal(first.report.coverage.wholeRepository, true);
    const security = first.report.findings.find((finding) => finding.category === "security");
    assert.ok(security);
    const quick = await runAudit(repo, { mode: "quick", scope: [], useCache: false, persist: false });
    assert.equal(quick.report.coverage.wholeRepository, true);
    assert.ok(quick.report.resolved.every((finding) => finding.category !== "security"));
    assert.equal(quick.report.resolved.some((finding) => finding.fingerprint === security.fingerprint), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit baseline: a scoped run never resolves findings outside the files it examined", async () => {
  const repo = tempCopy(seeded);
  try {
    const first = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    assert.ok(first.report.findings.length > 0);
    const scoped = await runAudit(repo, {
      mode: "deep",
      scope: ["src/service.ts"],
      useCache: false,
      persist: false,
    });
    assert.ok(scoped.report.coverage.indexed < first.report.coverage.indexed);
    assert.equal(scoped.report.resolved.length, 0, "unexamined files cannot be called resolved");
    assert.match(scoped.warnings.join(" "), /Lifecycle resolution was skipped/i);
    assert.ok(scoped.report.findings.every((finding) => finding.lifecycle === "new"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit fix plan: sealed, read-only, tamper-evident and blocked outside git", async () => {
  const repo = tempCopy(seeded);
  try {
    const audit = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: false });
    const planned = createFixPlan(repo, audit.report);
    assert.ok(planned.plan.patches.length > 0);
    assert.equal(checkEvidence(planned.plan).status, "verified");

    const blocked = await applyFixPlan(repo, planned.file, { confirmed: true });
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.note, /not a git repository|git/i);

    const tampered = JSON.parse(fs.readFileSync(planned.file, "utf8")) as { patches: { before: string }[] };
    tampered.patches[0]!.before = "tampered";
    fs.writeFileSync(planned.file, JSON.stringify(tampered, null, 2));
    await assert.rejects(() => applyFixPlan(repo, planned.file, { confirmed: true }));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit fix apply: an isolated worktree is verified and the source tree is untouched", async () => {
  if (!commandExists("git")) return;
  const repo = tempCopy(seeded);
  try {
    const git = (args: string[]): void => {
      const result = safeExec("git", ["-C", repo, ...args], repo, 30000);
      assert.equal(result.code, 0, result.stderr);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "audit-test@example.test"]);
    git(["config", "user.name", "Audit Test"]);
    git(["add", "-A"]);
    git(["commit", "-qm", "seed"]);

    const audit = await runAudit(repo, { mode: "deep", scope: [], useCache: false, persist: true });
    const planned = createFixPlan(repo, audit.report);
    assert.ok(planned.plan.patches.length > 0);
    const applied = await applyFixPlan(repo, planned.file, { confirmed: true });
    assert.ok(["verified", "applied"].includes(applied.status), applied.note);
    assert.ok(applied.applied.length > 0);
    assert.equal(applied.regressions.length, 0);
    assert.ok(applied.beforeScore !== undefined);
    assert.ok(applied.afterScore !== undefined);
    const diff = safeExec("git", ["-C", repo, "diff", "--quiet"], repo, 30000);
    assert.equal(diff.code, 0, "the original working tree must not be edited");
    const commits = safeExec("git", ["-C", repo, "rev-list", "--count", "HEAD"], repo, 30000);
    assert.equal(commits.stdout.trim(), "1", "the fix workflow must not commit");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("audit fix patch: exact line content and the original line endings are preserved", () => {
  const patch = {
    findingId: "aud-test",
    rule: "unused-import",
    file: "src/a.ts",
    startLine: 1,
    endLine: 1,
    before: 'import path from "node:path";',
    after: "",
    summary: "Remove the unused import line.",
  };
  const result = applyPatchToContent('import path from "node:path";\r\nconst value = 1;\r\n', patch);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.content, "const value = 1;\r\n");
  const changed = applyPatchToContent('import path from "node:path";\nconst value = 2;\n', { ...patch, before: 'import unused from "x";' });
  assert.equal(changed.ok, false);
  const reindented = applyPatchToContent('  import path from "node:path";\nconst value = 1;\n', patch);
  assert.equal(reindented.ok, false);
});

test("audit score: traceable deductions and a disclosed severity cap", () => {
  const base = (overrides: Partial<AuditFinding>): AuditFinding => ({
    id: "aud-test",
    fingerprint: "rule|src/x.ts|1",
    rule: "test",
    category: "correctness",
    subcategory: "test",
    title: "Test finding",
    explanation: "test",
    location: { file: "src/x.ts", line: 1, endLine: 1 },
    severity: "medium",
    confidence: "high",
    confirmation: "confirmed",
    impact: "test",
    why: "test",
    evidence: [{ source: "ast", detail: "test" }],
    suggestion: { summary: "a", change: "b", tradeoffs: "c", effort: "small", autoFixable: false },
    lifecycle: "new",
    tags: [],
    deduction: 0,
    ...overrides,
  });
  const critical = scoreFindings({
    findings: [base({ id: "aud-critical", severity: "critical", category: "correctness" })],
    measured: ["correctness", "maintainability", "architecture", "performance", "readability", "type-safety", "security", "testing"],
    mode: "deep",
  });
  assert.equal(critical.overall, 79);
  assert.ok(critical.cap);
  assert.equal(critical.deductions[0]?.points, 30);
  assert.equal(critical.deductions[0]?.rawPoints, 30);

  const high = scoreFindings({
    findings: [base({ id: "aud-high", severity: "high", category: "performance" })],
    measured: ["performance"],
    mode: "deep",
  });
  assert.equal(high.overall, 82);

  const empty = scoreFindings({ findings: [], measured: ["correctness", "testing"], mode: "deep" });
  assert.equal(empty.overall, 100);
  assert.equal(empty.deductions.length, 0);
});
