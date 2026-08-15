import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { collectFindings } from "../src/graph/correlate.js";
import type { ScanResult } from "../src/analyzers/types.js";

function resultWithSecurityFiles(files: string[]): ScanResult {
  return {
    timestamp: "t",
    repo: "",
    language: "js",
    dependencyGraph: { circular: [], mostDependedOn: [], orphans: [] },
    security: {
      issues: files.map((file, i) => ({
        type: "code",
        severity: "high",
        description: `finding-${i}`,
        file,
        line: 1,
      })),
      summary: "",
    },
    duplication: { clones: [], summary: "" },
    tests: { summary: "", failed: 0, total: 0 },
    perf: { summary: "", status: "skipped" },
    accessibility: { issues: [], summary: "" },
    reliability: { flakyTests: [], raceSmells: [], summary: "" },
    devex: { unusedExports: [], duplicateFunctions: [], summary: "" },
    clusters: [],
  } as unknown as ScanResult;
}

test("collectFindings normalizes both relative and absolute finding paths to repo-relative", () => {
  const repo = path.join("Q:", "repos", "axios");
  const relative = path.join("tests", "http2.smoke.test.cjs");
  const absolute = path.join(repo, "src", "auth.py");
  const r = resultWithSecurityFiles([relative, absolute]);

  const findings = collectFindings(repo, r);

  assert.equal(findings.length, 2);
  for (const f of findings) {
    assert.equal(f.files.length, 1);
    assert.ok(!path.isAbsolute(f.files[0]), `expected repo-relative path, got ${f.files[0]}`);
    assert.ok(
      !f.files[0].includes("Q:"),
      `expected no drive prefix leaked from the CWD, got ${f.files[0]}`,
    );
  }
  assert.equal(findings[0].files[0], relative);
  assert.equal(findings[1].files[0], path.join("src", "auth.py"));
});
