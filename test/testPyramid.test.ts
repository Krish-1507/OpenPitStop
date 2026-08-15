import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverTestLayers,
  parseTestCounts,
  failingTestNames,
  runTestLayer,
} from "../src/commands/test.js";

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-pyramid-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return dir;
}

test("discovers the full pyramid from npm scripts", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({
      scripts: {
        test: "jest",
        "test:integration": "vitest run tests/integration",
        "test:e2e": "playwright test",
      },
    }),
  });
  const layers = discoverTestLayers(dir);
  assert.deepEqual(
    layers.map((l) => l.layer),
    ["unit", "integration", "e2e"],
  );
  assert.equal(layers[0].script, "test");
  assert.equal(layers[1].script, "test:integration");
  assert.equal(layers[2].script, "test:e2e");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discovers runners from configs and dependency dirs when no scripts exist", () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({
      devDependencies: { playwright: "^1.0.0", vitest: "^2.0.0" },
    }),
    "playwright.config.ts": "export default {};",
    "tests/integration/orders.test.ts": "import { test } from 'vitest';\ntest('x', () => {});",
    // bin stubs: discovery won't claim a runner that isn't installed
    "node_modules/.bin/playwright": "",
    "node_modules/.bin/vitest": "",
    "node_modules/.bin/jest": "",
  });
  const layers = discoverTestLayers(dir);
  assert.ok(layers.some((l) => l.layer === "e2e" && l.runner === "playwright"));
  assert.ok(layers.some((l) => l.layer === "integration" && l.cmd === "vitest"));
  assert.ok(
    layers.some((l) => l.layer === "unit" && l.runner === "vitest"),
    "vitest fallback discovered when no test script exists",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("discovery reports nothing for a bare repo", () => {
  const dir = tmpRepo({ "index.js": "console.log(1);" });
  assert.deepEqual(discoverTestLayers(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseTestCounts handles jest, vitest, mocha, pytest and node:test output", () => {
  assert.deepEqual(
    parseTestCounts("Tests:       42 passed, 3 failed"),
    { passed: 42, failed: 3, total: 45 },
  );
  assert.deepEqual(parseTestCounts(" Tests  12 passed (13)"), { passed: 12, failed: 0, total: 12 });
  assert.deepEqual(parseTestCounts("  7 passing\n  1 failing"), { passed: 7, failed: 1, total: 8 });
  assert.deepEqual(parseTestCounts("5 passed, 1 failed in 1.2s"), { passed: 5, failed: 1, total: 6 });
  assert.deepEqual(parseTestCounts("# pass 36\n# fail 0"), { passed: 36, failed: 0, total: 36 });
  assert.deepEqual(parseTestCounts("no summary here"), { passed: 0, failed: 0, total: 0 });
});

test("failingTestNames extracts failure lines, dedupes and caps", () => {
  const out = `
✓ one passes
✕ the flaky one
✕ the flaky one
FAIL can charge twice
not ok 1 - auth rejects bad token
1) mocha style failure
Tests: 10 passed, 4 failed
`;
  const names = failingTestNames(out);
  assert.deepEqual(names, [
    "✕ the flaky one",
    "FAIL can charge twice",
    "auth rejects bad token",
    "mocha style failure",
  ]);
});

test("runs a real node:test unit layer and counts it", async () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({
      scripts: { test: "node --test" },
    }),
    "math.test.js": `
const { test } = require("node:test");
const assert = require("node:assert");
test("adds", () => assert.equal(1 + 1, 2));
test("multiplies", () => assert.equal(2 * 3, 6));
`,
  });
  const run = await runTestLayer(dir, { layer: "unit", runner: "npm script (test)", script: "test" }, 120000);
  assert.equal(run.status, "ok");
  assert.equal(run.total, 2);
  assert.equal(run.passed, 2);
  assert.equal(run.failed, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing layer reports failed with the failing test name", async () => {
  const dir = tmpRepo({
    "package.json": JSON.stringify({
      scripts: { test: "node --test" },
    }),
    "broken.test.js": `
const { test } = require("node:test");
const assert = require("node:assert");
test("adds", () => assert.equal(1 + 1, 3));
`,
  });
  const run = await runTestLayer(dir, { layer: "unit", runner: "npm script (test)", script: "test" }, 120000);
  assert.equal(run.status, "failed");
  assert.equal(run.failed, 1);
  assert.ok(run.failing.some((n) => n.includes("adds")), `expected failing name, got ${JSON.stringify(run.failing)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
