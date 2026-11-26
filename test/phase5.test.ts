import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bench } from "../src/commands/bench.js";
import {
  assess,
  runBench,
  runScenario,
  strictFailures,
  summarize,
  type BenchFinding,
  type BenchReport,
  type ScenarioResult,
  type ScenarioVerdict,
} from "../src/bench/run.js";
import { discoverScenarios, loadScenario, type BenchKind, type Scenario } from "../src/bench/scenario.js";
import { renderBenchMarkdown, renderBenchReport } from "../src/bench/report.js";

const BENCH = path.resolve("bench");
const ANSI = /\u001b\[[0-9;]*m/g;

function plain(value: string): string {
  return value.replace(ANSI, "");
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-bench-"));
}

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

function scenarioDir(root: string, id: string, manifest: Record<string, unknown>, files?: Record<string, string>): string {
  const dir = path.join(root, "scenarios", id);
  put(path.join(dir, "scenario.json"), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files ?? { "package.json": '{ "name": "fx" }' })) {
    put(path.join(dir, "repo", rel), body);
  }
  return dir;
}

function manifestOf(id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: `fixture ${id}`, kind, stack: "node", expect: {}, ...extra };
}

function scenario(overrides: Partial<Scenario> & { id: string; kind: BenchKind }): Scenario {
  return {
    title: overrides.id,
    stack: "node",
    checks: ["security"],
    expect: {},
    repo: path.join(BENCH, "scenarios", overrides.id, "repo"),
    file: path.join(BENCH, "scenarios", overrides.id, "scenario.json"),
    ...overrides,
  };
}

function finding(category: string, file?: string): BenchFinding {
  return { category, file, severity: "high", title: `finding ${category}` };
}

function result(id: string, kind: BenchKind, verdict: ScenarioVerdict, extra: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    id,
    title: id,
    kind,
    stack: "node",
    check: "security",
    verdict,
    expected: [],
    reported: [],
    matched: [],
    missing: [],
    falsePositives: [],
    noise: [],
    durationMs: 1,
    ...extra,
  };
}

function reportOf(scenarios: ScenarioResult[]): BenchReport {
  return {
    schemaVersion: 1,
    root: BENCH,
    generatedAt: new Date(0).toISOString(),
    engine: [{ check: "security", description: "test" }],
    scenarios,
    summary: summarize(scenarios),
    coverage: "security",
    limits: [],
  };
}

test("bench — every shipped fixture is a valid scenario", () => {
  const scenarios = discoverScenarios(BENCH);
  assert.ok(scenarios.length >= 20, `expected a real fixture set, found ${scenarios.length}`);
  assert.deepEqual(scenarios.map((entry) => entry.id), scenarios.map((entry) => entry.id).sort());
  assert.equal(new Set(scenarios.map((entry) => entry.id)).size, scenarios.length);
  for (const entry of scenarios) {
    assert.ok(fs.statSync(entry.repo).isDirectory(), `${entry.id} has a repo directory`);
    assert.deepEqual(entry.checks, ["security"]);
  }
  const kinds = new Set(scenarios.map((entry) => entry.kind));
  for (const kind of ["vulnerable", "fixed", "benign", "known-miss", "known-false-positive", "unsupported", "broken"] as BenchKind[]) {
    assert.ok(kinds.has(kind), `the fixture set covers ${kind}`);
  }
  for (const fixed of scenarios.filter((entry) => entry.kind === "fixed")) {
    const twin = scenarios.find((entry) => entry.id === fixed.pairOf);
    assert.ok(twin, `${fixed.id} pairs with ${fixed.pairOf}`);
    assert.equal(twin?.kind, "vulnerable");
    assert.ok((twin?.checks ?? []).includes("security"));
  }
});

test("bench — loadScenario rejects a directory without scenario.json", () => {
  const root = tmp();
  try {
    const dir = path.join(root, "no-manifest");
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => loadScenario(dir), /missing scenario.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bench — loadScenario rejects unknown keys and a mismatched id", () => {
  const root = tmp();
  try {
    const unknown = scenarioDir(root, "unknown-key", { ...manifestOf("unknown-key", "broken"), surprise: true });
    assert.throws(() => loadScenario(unknown), /unknown key "surprise"/);

    const mismatch = scenarioDir(root, "real-id", manifestOf("other-id", "broken"));
    assert.throws(() => loadScenario(mismatch), /must match the directory name/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bench — loadScenario enforces each kind expectation", () => {
  const cases: { name: string; manifest: Record<string, unknown>; error: RegExp }[] = [
    { name: "vulnerable-without-findings", manifest: manifestOf("vulnerable-without-findings", "vulnerable"), error: /must declare "expect.findings"/ },
    { name: "known-miss-without-findings", manifest: manifestOf("known-miss-without-findings", "known-miss"), error: /must declare "expect.findings"/ },
    { name: "benign-without-forbid", manifest: manifestOf("benign-without-forbid", "benign"), error: /must declare "expect.forbid"/ },
    { name: "known-false-positive-without-forbid", manifest: manifestOf("known-false-positive-without-forbid", "known-false-positive"), error: /must declare "expect.forbid"/ },
    { name: "fixed-with-expectation", manifest: manifestOf("fixed-with-expectation", "fixed", { pairOf: "x", expect: { findings: [{ category: "xss" }] } }), error: /derives its expectation/ },
    { name: "fixed-without-pair", manifest: manifestOf("fixed-without-pair", "fixed"), error: /must name "pairOf"/ },
    { name: "unknown-kind", manifest: manifestOf("unknown-kind", "legendary"), error: /"kind" must be one of/ },
    { name: "unknown-check", manifest: manifestOf("unknown-check", "broken", { checks: ["performance"] }), error: /unknown check "performance"/ },
    { name: "findings-and-forbid", manifest: manifestOf("findings-and-forbid", "vulnerable", { expect: { findings: [{ category: "xss" }], forbid: ["xss"] } }), error: /either findings or forbid/ },
    { name: "unsupported-with-findings", manifest: manifestOf("unsupported-with-findings", "unsupported", { expect: { findings: [{ category: "xss" }] } }), error: /do not declare findings or forbid/ },
    { name: "broken-with-forbid", manifest: manifestOf("broken-with-forbid", "broken", { expect: { forbid: ["xss"] } }), error: /do not declare findings or forbid/ },
    { name: "pair-on-vulnerable", manifest: manifestOf("pair-on-vulnerable", "vulnerable", { pairOf: "x", expect: { findings: [{ category: "xss" }] } }), error: /only valid on a fixed scenario/ },
    { name: "invalid-json", manifest: undefined as unknown as Record<string, unknown>, error: /invalid JSON/ },
  ];
  const root = tmp();
  try {
    for (const entry of cases) {
      const dir = path.join(root, "scenarios", entry.name);
      fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
      fs.writeFileSync(path.join(dir, "scenario.json"), entry.manifest === undefined ? "{ nope" : JSON.stringify(entry.manifest));
      assert.throws(() => loadScenario(dir), entry.error, entry.name);
    }

    const missingRepo = scenarioDir(root, "missing-repo", manifestOf("missing-repo", "broken"));
    fs.rmSync(path.join(missingRepo, "repo"), { recursive: true, force: true });
    assert.throws(() => loadScenario(missingRepo), /missing fixture repository/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bench — discoverScenarios requires pairs to name a vulnerable fixture", () => {
  const root = tmp();
  try {
    scenarioDir(root, "ghost-pair", manifestOf("ghost-pair", "fixed", { pairOf: "ghost" }));
    assert.throws(() => discoverScenarios(root), /names unknown scenario "ghost"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const other = tmp();
  try {
    scenarioDir(other, "fixed-twin", manifestOf("fixed-twin", "fixed", { pairOf: "not-vulnerable" }));
    scenarioDir(other, "not-vulnerable", manifestOf("not-vulnerable", "benign", { expect: { forbid: ["xss"] } }));
    assert.throws(() => discoverScenarios(other), /must name a vulnerable scenario/);
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("bench — a directory in the scenarios folder must be a scenario", () => {
  const root = tmp();
  try {
    scenarioDir(root, "valid", manifestOf("valid", "broken"));
    fs.mkdirSync(path.join(root, "scenarios", "stray"), { recursive: true });
    assert.throws(() => discoverScenarios(root), /stray[\\/]scenario\.json: missing scenario\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bench — vulnerable verdicts are detected, partial or missed", () => {
  const vulnerable = scenario({
    id: "v",
    kind: "vulnerable",
    expect: { findings: [{ category: "sql-injection", file: "src/db.js" }, { category: "xss", file: "src/ui.js" }] },
  });
  assert.equal(assess(vulnerable, [finding("sql-injection", "src/db.js"), finding("xss", "src/ui.js")]).verdict, "detected");

  const partial = assess(vulnerable, [finding("sql-injection", "src/db.js")]);
  assert.equal(partial.verdict, "partial");
  assert.deepEqual(partial.matched, ["sql-injection @ src/db.js"]);
  assert.deepEqual(partial.missing, ["xss @ src/ui.js"]);

  const wrongFile = assess(vulnerable, [finding("sql-injection", "src/other.js"), finding("xss", "src/ui.js")]);
  assert.equal(wrongFile.verdict, "partial");
  assert.deepEqual(wrongFile.missing, ["sql-injection @ src/db.js"]);

  const missed = assess(vulnerable, []);
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.matched.length, 0);
});

test("bench — a fixed fixture compares the paired defect with file precision", () => {
  const twin = scenario({ id: "twin", kind: "vulnerable", expect: { findings: [{ category: "authentication", file: "src/auth.js" }] } });
  const fixed = scenario({ id: "fixed", kind: "fixed", pairOf: "twin" });

  const sameCategory = assess(fixed, [finding("authentication")], twin);
  assert.equal(sameCategory.verdict, "clean");
  assert.deepEqual(sameCategory.falsePositives, []);
  assert.deepEqual(sameCategory.noise, ["authentication"]);

  const sameDefect = assess(fixed, [finding("authentication", "src/auth.js")], twin);
  assert.equal(sameDefect.verdict, "noisy");
  assert.deepEqual(sameDefect.falsePositives, ["authentication @ src/auth.js"]);

  const otherFile = assess(fixed, [finding("authentication", "src/session.js")], twin);
  assert.equal(otherFile.verdict, "clean");
  assert.deepEqual(otherFile.noise, ["authentication"]);
});

test("bench — a benign fixture forbids a category anywhere", () => {
  const benign = scenario({ id: "benign", kind: "benign", expect: { forbid: ["input-validation"] } });
  const noisy = assess(benign, [finding("input-validation", "src/api/orders.js")]);
  assert.equal(noisy.verdict, "noisy");
  assert.deepEqual(noisy.falsePositives, ["input-validation"]);
  assert.equal(assess(benign, []).verdict, "clean");
});

test("bench — documented misses and false positives are reported, not scored", () => {
  const miss = scenario({ id: "miss", kind: "known-miss", expect: { findings: [{ category: "sql-injection", file: "src/db.js" }] } });
  assert.equal(assess(miss, []).verdict, "as-documented");
  assert.equal(assess(miss, [finding("sql-injection", "src/db.js")]).verdict, "newly-detected");

  const documented = scenario({ id: "documented", kind: "known-false-positive", expect: { forbid: ["xss"] } });
  assert.equal(assess(documented, [finding("xss")]).verdict, "as-documented");
  assert.equal(assess(documented, []).verdict, "not-reproduced");

  const report = reportOf([assess(miss, [finding("sql-injection", "src/db.js")]), assess(documented, [])]);
  assert.deepEqual(strictFailures(report), ["miss: newly-detected", "documented: not-reproduced"]);
});

test("bench — runScenario skips a stack the check cannot read", async () => {
  const scenarios = discoverScenarios(BENCH);
  const rust = scenarios.find((entry) => entry.id === "unsupported-rust-service");
  assert.ok(rust);
  const result = await runScenario(rust as Scenario);
  assert.equal(result.verdict, "skipped");
  assert.match(result.skippedReason ?? "", /does not read rust/);
});

test("bench — an unsupported fixture on a covered stack is flagged", async () => {
  const scenarios = discoverScenarios(BENCH);
  const node = scenarios.find((entry) => entry.id === "xss-innerhtml");
  assert.ok(node);
  const result = await runScenario({ ...(node as Scenario), kind: "unsupported", expect: {} });
  assert.equal(result.verdict, "unexpected-coverage");
});

test("bench — a throwing check is a crash, not a skip", async () => {
  const vulnerable = scenario({
    id: "boom",
    kind: "vulnerable",
    repo: path.join(BENCH, "scenarios", "xss-innerhtml", "repo"),
    expect: { findings: [{ category: "xss" }] },
  });
  const result = await runScenario(vulnerable, undefined, () => {
    throw new Error("boom");
  });
  assert.equal(result.verdict, "crashed");
  assert.equal(result.error, "boom");
  assert.deepEqual(strictFailures(reportOf([result])), ["boom: crashed"]);
});

test("bench — summarize states precision and recall from scored fixtures", () => {
  const vulnerable = scenario({ id: "v1", kind: "vulnerable", expect: { findings: [{ category: "a" }, { category: "b" }] } });
  const other = scenario({ id: "v2", kind: "vulnerable", expect: { findings: [{ category: "c" }] } });
  const fixed = scenario({ id: "f1", kind: "fixed", pairOf: "v1" });
  const summary = summarize([assess(vulnerable, [finding("a")]), assess(other, []), assess(fixed, [finding("a")], vulnerable)]);

  assert.equal(summary.expectedFindings, 3);
  assert.equal(summary.detectedFindings, 1);
  assert.equal(summary.missedFindings, 2);
  assert.equal(summary.falsePositives, 1);
  assert.equal(summary.precision, 0.5);
  assert.equal(summary.recall, 1 / 3);
  assert.deepEqual(summary.missedScenarios, ["v2"]);
  assert.equal(summary.falsePasses, 1);
  assert.deepEqual(summary.noisyScenarios, ["f1"]);
});

test("bench — summarize pairs a vulnerable fixture with its fixed twin", () => {
  const make = (id: string, detected: boolean, noisy: boolean): ScenarioResult[] => {
    const twin = scenario({ id: `v-${id}`, kind: "vulnerable", expect: { findings: [{ category: "xss" }] } });
    const fixed = scenario({ id: `f-${id}`, kind: "fixed", pairOf: `v-${id}` });
    return [
      assess(twin, detected ? [finding("xss")] : []),
      assess(fixed, noisy ? [finding("xss")] : [], twin),
    ];
  };
  const summary = summarize([...make("good", true, false), ...make("missed", false, false), ...make("noisy", true, true), ...make("both", false, true)]);
  assert.deepEqual(
    summary.pairs.map((pair) => `${pair.vulnerable}:${pair.status}`),
    ["v-good:discriminating", "v-missed:vulnerable-missed", "v-noisy:fixed-noisy", "v-both:both"],
  );
  assert.equal(summarize([...make("crashed", true, false), result("f-crashed-extra", "fixed", "crashed", { pairOf: "v-crashed" })]).pairs.find((pair) => pair.fixed === "f-crashed-extra")?.status, "inconclusive");
});

test("bench — skipped and crashed fixtures stay out of the ratios", () => {
  const summary = summarize([
    result("skip", "vulnerable", "skipped", { expected: ["a"], missing: [] }),
    result("crash", "fixed", "crashed", { pairOf: "skip" }),
    result("ok", "vulnerable", "detected", { expected: ["b"], matched: ["b"] }),
  ]);
  assert.equal(summary.expectedFindings, 1);
  assert.equal(summary.detectedFindings, 1);
  assert.equal(summary.recall, 1);
  assert.equal(summary.skipped.length, 1);
  assert.equal(summary.crashes.length, 1);
});

test("bench — the shipped fixtures all meet their recorded expectations", async () => {
  const report = await runBench(BENCH);
  const failed = report.scenarios.filter((entry) =>
    !["detected", "clean", "as-documented", "survived", "skipped"].includes(entry.verdict),
  );
  assert.deepEqual(failed.map((entry) => `${entry.id}: ${entry.verdict}`), []);
  assert.deepEqual(report.summary.crashes, []);
  assert.equal(report.summary.precision, 1);
  assert.equal(report.summary.recall, 1);
  assert.equal(report.summary.falsePasses, 0);
  assert.ok(report.summary.pairs.length >= 8);
  assert.ok(report.summary.pairs.every((pair) => pair.status === "discriminating"));
  assert.ok(report.summary.knownMisses.length >= 2);
  assert.ok(report.summary.knownFalsePositives.length >= 1);
  assert.deepEqual(report.summary.skipped.map((entry) => entry.id), ["unsupported-rust-service"]);
  assert.deepEqual(strictFailures(report), []);
});

test("bench — a run writes nothing into the fixtures", async () => {
  const tree = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        out.push(path.relative(dir, target).replace(/\\/g, "/"));
        if (entry.isDirectory()) walk(target);
      }
    };
    walk(dir);
    return out.sort();
  };
  const before = tree(BENCH);
  await runBench(BENCH);
  assert.deepEqual(tree(BENCH), before);
});

test("bench — a filter narrows the run and keeps the pair beside it", async () => {
  const report = await runBench(BENCH, { filter: "python" });
  assert.deepEqual(report.scenarios.map((entry) => entry.id), ["python-command-injection", "python-command-injection-fixed"]);
  assert.equal(report.summary.expectedFindings, 1);
  assert.equal(report.summary.detectedFindings, 1);
  assert.deepEqual(report.summary.pairs.map((pair) => pair.status), ["discriminating"]);
});

test("bench — an unmatched filter is an error, not an empty pass", async () => {
  await assert.rejects(() => runBench(BENCH, { filter: "no-such-fixture" }), /no benchmark scenario matches/);
});

test("bench — reports render for a terminal and for publication", async () => {
  const report = await runBench(BENCH);
  const text = plain(renderBenchReport(report));
  assert.match(text, /OpenPitStop detection benchmark/);
  assert.match(text, /precision 100%/);
  assert.match(text, /Pairs \(vulnerable ↔ fixed\)/);
  assert.match(text, /Not measured \(skipped coverage\)/);
  assert.match(text, /Documented misses/);
  assert.match(text, /Documented false positives/);
  assert.match(text, /Limits:/);

  const markdown = renderBenchMarkdown(report);
  assert.match(markdown, /## Measured result/);
  assert.match(markdown, /\| Scenario \| Kind \| Stack \| Verdict \| Findings \| ms \|/);
  assert.match(markdown, /### Pairs/);
  assert.match(markdown, /### Not measured/);
  assert.match(markdown, /### Documented misses/);
  assert.match(markdown, /### Limits/);
  assert.match(markdown, /\*\*Precision\*\*: 100%/);
});

test("bench — the command exposes the documented flags", () => {
  assert.deepEqual(bench.options.map((option) => option.long), ["--json", "--markdown", "--filter", "--strict"]);
  assert.equal(bench.options.find((option) => option.long === "--filter")?.flags, "--filter <text>");
});
