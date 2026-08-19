import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSemgrep } from "../src/analyzers/security.js";
import { findingIdFor } from "../src/repro/ids.js";

test("parseSemgrep maps severity, remediation and relative paths", () => {
  const repo = path.resolve("/repo");
  const sample = JSON.stringify({
    results: [
      {
        check_id: "python.lang.security.audit.dangerous-eval",
        path: "app.py",
        start: { line: 10 },
        extra: { severity: "ERROR", message: "Use of eval", fix: "use ast.literal_eval" },
      },
      {
        check_id: "javascript.express.security.xss",
        path: "src/x.js",
        start: { line: 3 },
        extra: { severity: "WARNING", message: "reflected xss" },
      },
      {
        check_id: "generic.semgrep.info",
        path: "/repo/abs.py",
        start: { line: 1 },
        extra: { severity: "INFO", message: "something noisy" },
      },
    ],
  });

  const issues = parseSemgrep(sample, repo);
  assert.equal(issues.length, 3);

  assert.equal(issues[0].type, "code");
  assert.equal(issues[0].severity, "high"); // ERROR -> high
  assert.equal(issues[0].category, "python.lang.security.audit.dangerous-eval");
  assert.equal(issues[0].file, "app.py");
  assert.equal(issues[0].line, 10);
  assert.equal(issues[0].fix, "use ast.literal_eval");
  assert.equal(issues[0].description, "python.lang.security.audit.dangerous-eval: Use of eval");

  assert.equal(issues[1].severity, "medium"); // WARNING -> medium
  assert.match(issues[1].fix ?? "", /Review Semgrep rule/); // falls back to guidance

  assert.equal(issues[2].severity, "low"); // INFO -> low
  assert.equal(issues[2].file, "abs.py"); // absolute path normalized to repo-relative

  // Every issue must carry a stable id that `pitstop drive`'s
  // freshScanStillHas gate can recompute from (type, file, description).
  for (const i of issues) {
    assert.equal(typeof i.description, "string");
    const id = findingIdFor("security", i.type, i.file, i.description);
    assert.match(id, /^security-[0-9a-f]{8}$/);
  }
});
