import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArchitectureMap } from "../src/architecture/map.js";
import { computeImpact, isTestFile, testStem, needsApprovalOrForbidden } from "../src/architecture/impact.js";
import { createPlan, loadLatestPlan, checkPlanScope, validatePlan, type PlanImpact } from "../src/verify/plan.js";

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-p4-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return dir;
}

const PACKAGE = JSON.stringify({ name: "fx", version: "0.0.0", scripts: { test: "node --test", build: "tsc -p ." } }, null, 2);
const ARCH = JSON.stringify(
  {
    boundaries: [{ from: "src/api/**", forbidImportsFrom: ["src/db/**"], reason: "api must not read storage directly" }],
    protected: [{ path: "src/core/**", reason: "shared core, reviewed by the platform team" }],
  },
  null,
  2,
);

/** A small checkout: math <- config <- app <- route, with a test and a db leaf. */
function chainRepo(): string {
  return mkRepo({
    "package.json": PACKAGE,
    "openpitstop.architecture.json": ARCH,
    "src/core/math.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "src/core/config.js": "import { add } from \"./math.js\";\nexport const limit = add(1, 1);\n",
    "src/api/app.js": "import { limit } from \"../core/config.js\";\nexport const app = { limit };\n",
    "src/routes/login.js": "import { app } from \"../api/app.js\";\nexport function handler(req, res) {}\nrouter.get(\"/login\", handler);\n",
    "src/db/user.js": "export const users = [];\n",
    "test/math.test.js": "import { add } from \"../src/core/math.js\";\n",
  });
}

test("impact — dependents are ordered by import distance and every hop is explained", () => {
  const repo = chainRepo();
  try {
    const impact = computeImpact(repo, [{ file: "src/core/math.js" }]);
    assert.equal(impact.engine, "regex");
    assert.deepEqual(impact.changed.map((c) => c.file), ["src/core/math.js"]);
    assert.deepEqual(impact.directDependents, ["src/core/config.js", "test/math.test.js"]);
    assert.deepEqual(
      impact.dependents.map((d) => `${d.file}@${d.distance}`),
      ["src/core/config.js@1", "test/math.test.js@1", "src/api/app.js@2", "src/routes/login.js@3"],
    );
    // via names the closest importer, so a transitive hit is auditable
    assert.equal(impact.dependents.find((d) => d.file === "src/routes/login.js")?.via, "src/api/app.js");
    assert.deepEqual(
      impact.affectedModules.map((m) => `${m.module}(${m.files})`),
      ["src/core(2)", "src/api(1)", "src/routes(1)", "test(1)"],
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("impact — routes, tests and declared constraints travel with the change", () => {
  const repo = chainRepo();
  try {
    const impact = computeImpact(repo, [{ file: "src/core/math.js" }]);
    assert.deepEqual(impact.routes.map((r) => `${r.method} ${r.path}`), ["GET /login"]);
    assert.deepEqual(impact.tests.map((t) => `${t.file}:${t.reason}`), ["test/math.test.js:imports-affected-file"]);
    assert.deepEqual(impact.constraints.map((c) => `${c.kind}:${c.rule}`), ["protected:src/core/**"]);
    assert.deepEqual(needsApprovalOrForbidden(impact), { approval: true, forbidden: false });
    assert.deepEqual(impact.recommended.map((r) => r.command), [
      "pitstop architecture-check --against-plan",
      "pitstop verify-stack",
      "pitstop test",
      "pitstop pen --static",
      "pitstop regression-check",
      "pitstop gate --strict --require stack,architecture,regression,security",
    ]);
    for (const recommendation of impact.recommended) assert.ok(recommendation.why.length > 0, "every step says why");
    assert.equal(impact.summary.dependents, 4);
    assert.equal(impact.summary.modules, 4);
    assert.ok(impact.limits.some((l) => l.includes("not a runtime call graph")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("impact — a repo with no import graph says so instead of implying safety", () => {
  const repo = mkRepo({ "Gemfile": "source \"https://rubygems.org\"\n", "app/models/user.rb": "class User\nend\n" });
  try {
    const impact = computeImpact(repo, [{ file: "app/models/user.rb" }]);
    assert.equal(impact.engine, null);
    assert.equal(impact.summary.dependents, 0);
    assert.ok(impact.limits.some((l) => l.includes("import graph is unavailable")));
    assert.equal(impact.recommended[0].command, "pitstop architecture-check --against-plan");
    assert.ok(impact.recommended.at(-1)!.command.startsWith("pitstop gate --strict --require stack,architecture"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("impact — test files are recognized by directory and by runner convention", () => {
  assert.equal(isTestFile("test/login.test.ts"), true);
  assert.equal(isTestFile("src/auth/login.spec.ts"), true);
  assert.equal(isTestFile("pkg/auth/login_test.go"), true);
  assert.equal(isTestFile("tests/test_login.py"), true);
  assert.equal(isTestFile("src/auth/login.ts"), false);
  assert.equal(testStem("src/auth/login.ts"), "login");
  assert.equal(testStem("test/login.test.ts"), "login");
  assert.equal(testStem("tests/test_login.py"), "login");
  assert.equal(testStem("pkg/auth/login_test.go"), "login");
});

test("architecture map — modules, cross-module dependencies, cycles and boundary violations", async () => {
  const repo = mkRepo({
    "package.json": PACKAGE,
    "openpitstop.architecture.json": ARCH,
    "src/core/cycle-a.js": "import { b } from \"./cycle-b.js\";\nexport const a = b;\n",
    "src/core/cycle-b.js": "import { a } from \"./cycle-a.js\";\nexport const b = 1;\nexport const pair = () => a + b;\n",
    "src/api/handler.js": "import { users } from \"../db/user.js\";\nexport const handler = () => users;\n",
    "src/routes/orders.js": "import { users } from \"../db/user.js\";\nexport const orders = users;\nrouter.post(\"/orders\", orders);\n",
    "src/db/user.js": "export const users = [];\n",
    "prisma/schema.prisma": [
      "model Post {",
      "  id     String @id",
      "  userId String",
      "  author User   @relation(fields: [authorId], references: [id])",
      "}",
      "",
      "model User {",
      "  id String @id",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const map = await buildArchitectureMap(repo);
    assert.equal(map.engine, "regex");
    const modules = map.modules.map((m) => `${m.path}(${m.files})`);
    assert.ok(modules.includes("src/core(2)"), modules.join(", "));
    assert.ok(modules.includes("src/api(1)"), modules.join(", "));
    const cross = map.dependencies.map((d) => `${d.from}->${d.to}`);
    assert.ok(cross.includes("src/api->src/db"), cross.join(", "));
    assert.ok(cross.includes("src/routes->src/db"), cross.join(", "));
    // src/core is internal only — an intra-module import is not a dependency
    assert.ok(!cross.some((d) => d.startsWith("src/core->")), cross.join(", "));
    assert.equal(map.cycles.length, 1);
    // findCycles repeats the entry node to close the loop; the set is the cycle
    assert.deepEqual([...new Set(map.cycles[0])].sort(), ["src/core/cycle-a.js", "src/core/cycle-b.js"]);
    assert.equal(map.boundaries.configured, 1);
    assert.deepEqual(map.boundaries.violations.map((v) => `${v.from}->${v.to}`), ["src/api/handler.js->src/db/user.js"]);
    assert.equal(map.boundaries.violations[0].rule, "src/api/**");
    assert.equal(map.boundaries.violations[0].reason, "api must not read storage directly");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("architecture map — schema scalar types are not data relationships", async () => {
  const repo = mkRepo({
    "package.json": PACKAGE,
    "src/db/user.js": "export const users = [];\n",
    "prisma/schema.prisma": [
      "model Post {",
      "  id     String @id",
      "  userId String",
      "  author User   @relation(fields: [authorId], references: [id])",
      "}",
      "",
      "model User {",
      "  id String @id",
      "}",
      "",
    ].join("\n"),
  });
  try {
    const map = await buildArchitectureMap(repo);
    assert.deepEqual(map.dataRelationships.map((r) => `${r.from}->${r.to}`), ["Post->User"]);
    assert.ok(!map.dataRelationships.some((r) => r.to === "String"), "a `userId String` column is a scalar, not a relation");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("plan — impact recorded at planning time is sealed and survives a reload", () => {
  const repo = chainRepo();
  try {
    const impact = computeImpact(repo, [{ file: "src/core/math.js" }]);
    const recorded: PlanImpact = {
      files: impact.changed.map((c) => c.file),
      dependents: impact.summary.dependents,
      directDependents: impact.directDependents.length,
      modules: impact.affectedModules.map((m) => m.module),
      routes: impact.routes.map((r) => `${r.method} ${r.path}`),
      tests: impact.tests.map((t) => t.file),
      constraints: impact.constraints.map((c) => `${c.kind}: ${c.rule}`),
      recommended: impact.recommended.map((r) => r.command),
    };
    const created = createPlan(repo, {
      id: "p4-plan",
      goal: "change the shared math helper",
      steps: ["edit src/core/math.js"],
      expectedPaths: ["src/core/math.js"],
      verification: { commands: ["npm run test"] },
      impact: recorded,
    });
    assert.ok(!("error" in created), "a valid plan is written");
    const loaded = loadLatestPlan(repo);
    assert.ok(loaded, "the plan is reloadable");
    assert.equal(loaded.check.status, "verified", "the plan is sealed at creation");
    assert.deepEqual(loaded.plan.impact, recorded);
    const scope = checkPlanScope(loaded.plan, ["src/core/math.js", ".pitstop/plan-latest.json", "src/api/app.js"]);
    assert.deepEqual(scope.planned, ["src/core/math.js", ".pitstop/plan-latest.json"]);
    assert.deepEqual(scope.unplanned, ["src/api/app.js"]);
    assert.equal(validatePlan({ ...loaded.plan, expectedPaths: [] }), "plan needs expectedPaths — a plan that does not declare what it may touch is not a plan");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
