import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runAuditEval } from "../src/audit/eval.js";

test("audit evaluation suite: seeded defects, negative controls and report integrity stay green", async () => {
  const evaluation = await runAuditEval(path.resolve("."), { suiteDir: path.resolve("bench/audit") });
  const report = evaluation.report;
  assert.equal(report.pass, true, JSON.stringify(report.scenarios.filter((scenario) => !scenario.passed), null, 2));
  assert.equal(report.scenarios.length, 8);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.precision, 1);
  assert.equal(report.totals.recall, 1);
  assert.ok(report.totals.truePositives >= 10);
  assert.ok(report.scenarios.some((scenario) => scenario.negative.total > 0));
  assert.ok(report.scenarios.some((scenario) => scenario.disclosure.length > 0));
  for (const scenario of report.scenarios) {
    assert.equal(scenario.checks.reportStructure, true, scenario.name + " report");
    assert.equal(scenario.checks.evidenceComplete, true, scenario.name + " evidence");
    assert.equal(scenario.checks.deduplicated, true, scenario.name + " dedup");
    assert.equal(scenario.checks.scoreTraceable, true, scenario.name + " score trace");
    assert.equal(scenario.checks.deterministic, true, scenario.name + " determinism");
    assert.equal(scenario.checks.findingsWithinBudget, true, scenario.name + " budget");
  }
  assert.match(evaluation.markdown, /Evaluation suite/i);
  assert.match(evaluation.markdown, /Limits/i);
});
