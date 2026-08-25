import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { buildUnderstanding, sealUnderstanding, loadUnderstanding, globMatches, ownersFor } from "../src/understand/index.js";
import { createPlan, loadLatestPlan, checkPlanScope, validatePlan } from "../src/verify/plan.js";
import { checkArchitecture, sealArchitectureResult } from "../src/verify/architecture.js";
import { runVerifyStack, diagnoseFailure, sealStackResult } from "../src/verify/stack.js";
import { runFlow } from "../src/verify/flow.js";
import { checkEvidence } from "../src/evidence.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

function initRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-arch-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m baseline", { cwd: dir });
  return dir;
}

function commit(repo: string, files: Record<string, string>, msg: string): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  execSync("git add -A", { cwd: repo });
  execSync(`git commit -q -m "${msg}"`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}

const PKG = JSON.stringify({ name: "svc", type: "module", scripts: { test: "node --test", build: "node build.js" }, devDependencies: { typescript: "^5", eslint: "^9" } });

// deterministic stack fixture: unit tests only — typecheck/lint/build honestly SKIPPED
const PKG_MIN = JSON.stringify({ name: "svc", type: "module", scripts: { test: "node --test" } });

// ---------------- repo awareness ----------------

test("understand: detects scripts, verification commands, frameworks, module map, CI", () => {
  const repo = initRepo({
    "package.json": PKG,
    "tsconfig.json": "{}",
    "src/index.js": "export const x = 1;\n",
    ".github/workflows/ci.yml": "on: [push]\njobs: {}\n",
    ".github/CODEOWNERS": "* @team-core\nsrc/auth/ @team-auth\n",
  });
  const u = buildUnderstanding(repo);
  assert.equal(u.verificationCommands.test, "npm run test");
  assert.equal(u.verificationCommands.build, "npm run build");
  assert.equal(u.verificationCommands.typecheck, "npx tsc --noEmit", "no typecheck script but tsconfig exists → npx tsc --noEmit");
  assert.ok(u.frameworks.includes("typescript"));
  assert.ok(u.frameworks.includes("eslint"));
  assert.equal(u.packageManager, "unknown");
  assert.equal(u.ci.provider, "github-actions");
  assert.ok(u.moduleMap.some((m) => m.dir === "src" && m.role === "source"));
  assert.ok(u.moduleMap.some((m) => m.dir === ".github" && m.role === "ci"));
  assert.equal(u.ownership.length, 2, "CODEOWNERS parsed");
  const authOwners = ownersFor(u.ownership, "src/auth/login.js");
  assert.deepEqual(authOwners, ["@team-auth"], "last matching CODEOWNERS pattern wins");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("understand: architecture config is loaded and validated (invalid config fails loudly)", () => {
  const repo = initRepo({ "package.json": PKG });
  const u0 = buildUnderstanding(repo);
  assert.equal(u0.architectureConfigPath, null, "no config → empty boundaries, never invented");
  fs.writeFileSync(path.join(repo, "openpitstop.architecture.json"), JSON.stringify({
    boundaries: [{ from: "src/core/**", forbidImportsFrom: ["src/ui/**"], reason: "core is UI-agnostic" }],
    protected: [{ path: "src/auth/**", reason: "authentication logic" }],
    forbidden: [{ path: "**/.env*", reason: "secrets" }],
  }));
  const u1 = buildUnderstanding(repo);
  assert.ok(u1.architectureConfigPath);
  assert.equal(u1.architecture.boundaries?.length, 1);
  const sealed = sealUnderstanding(repo, u1);
  assert.ok(sealed.sealedPath);
  const loaded = loadUnderstanding(repo);
  assert.equal(loaded?.architecture.boundaries?.length, 1);
  assert.equal(checkEvidence(JSON.parse(fs.readFileSync(sealed.sealedPath!, "utf8"))).status, "verified");
  fs.writeFileSync(path.join(repo, "openpitstop.architecture.json"), "{ invalid json");
  assert.throws(() => buildUnderstanding(repo), /invalid architecture config/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("glob matcher: ** crosses segments, * stays within a segment", () => {
  assert.ok(globMatches("src/**", "src/a/b/c.js"));
  assert.ok(globMatches("src/*.js", "src/a.js"));
  assert.ok(!globMatches("src/*.js", "src/a/b.js"));
  assert.ok(globMatches("**/.env*", "apps/api/.env.local"));
  assert.ok(globMatches(["a/**", "b/**"], "b/x"));
});

// ---------------- plan ----------------

test("plan: create → seal → load; scope check separates planned from scope creep", () => {
  const repo = initRepo({ "package.json": PKG });
  const created = createPlan(repo, {
    id: "p1", goal: "add greeting",
    steps: ["add module", "wire route"],
    expectedPaths: ["src/greet/**"],
    verification: { commands: ["node --test"] },
  });
  assert.ok(!("error" in created));
  const loaded = loadLatestPlan(repo)!;
  assert.equal(loaded.plan.id, "p1");
  assert.equal(loaded.check.status, "verified");
  const scope = checkPlanScope(loaded.plan, ["src/greet/index.js", "src/other.js"]);
  assert.deepEqual(scope.planned, ["src/greet/index.js"]);
  assert.deepEqual(scope.unplanned, ["src/other.js"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("plan: invalid plans rejected (no paths, no verification, absolute path)", () => {
  const repo = initRepo({ "placeholder.txt": "x" });
  assert.match(String((validatePlan({ id: "x", goal: "g", expectedPaths: [], verification: { commands: ["t"] } } as any))), /expectedPaths/);
  assert.match(String((validatePlan({ id: "x", goal: "g", expectedPaths: ["src/**"], verification: { commands: [] } } as any))), /verification/);
  const bad = createPlan(repo, { id: "x", goal: "g", expectedPaths: ["/abs/path"], steps: [], verification: { commands: ["t"] } });
  assert.ok("error" in bad);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------- architecture check ----------------

const ARCH_CONFIG = JSON.stringify({
  boundaries: [{ from: "src/core/**", forbidImportsFrom: ["src/ui/**"], reason: "core must be UI-agnostic" }],
  protected: [{ path: "src/auth/**", reason: "authentication logic" }],
  forbidden: [{ path: "**/.env*", reason: "secrets" }],
});

test("architecture: boundary violation detected from the diff → VIOLATIONS", async () => {
  const repo = initRepo({
    "package.json": PKG,
    "openpitstop.architecture.json": ARCH_CONFIG,
    "src/core/engine.js": "export function run(){ return 1; }\n",
    "src/ui/view.js": "export function view(){ return 2; }\n",
  });
  commit(repo, { "src/core/engine.js": "import { view } from '../ui/view.js';\nexport function run(){ return view(); }\n" }, "core imports ui — boundary violation");
  const r = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" });
  assert.equal(r.verdict, "VIOLATIONS");
  const v = r.entries.find((e) => e.kind === "boundary-violation");
  assert.ok(v, JSON.stringify(r.entries));
  assert.match(v!.detail, /src\/ui\/view\.js/);
  assert.equal(v?.reason, "core must be UI-agnostic");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("architecture: clean change conforms; protected path requires approval; --approved records it", async () => {
  const repo = initRepo({
    "package.json": PKG,
    "openpitstop.architecture.json": ARCH_CONFIG,
    "src/core/engine.js": "export function run(){ return 1; }\n",
    "src/auth/login.js": "export function login(){ return true; }\n",
  });
  commit(repo, { "src/core/engine.js": "export function run(){ return 42; }\n" }, "clean change");
  const clean = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" });
  assert.equal(clean.verdict, "CONFORMS");

  commit(repo, { "src/auth/login.js": "export function login(){ return false; }\n" }, "touches auth");
  const needs = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" });
  assert.equal(needs.verdict, "APPROVAL_REQUIRED");
  assert.ok(needs.entries.some((e) => e.kind === "protected-path" && e.file === "src/auth/login.js"));

  const approved = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD", approved: true });
  assert.equal(approved.verdict, "CONFORMS");
  assert.equal(approved.approved, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("architecture: forbidden path (secrets) is a hard violation", async () => {
  const repo = initRepo({ "package.json": PKG, "openpitstop.architecture.json": ARCH_CONFIG });
  commit(repo, { ".env.local": "SECRET=1\n" }, "commit a secret");
  const r = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" });
  assert.equal(r.verdict, "VIOLATIONS");
  assert.ok(r.entries.some((e) => e.kind === "forbidden-path"));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("architecture: plan scope — out-of-plan changes are scope creep", async () => {
  const repo = initRepo({ "package.json": PKG });
  createPlan(repo, { id: "p1", goal: "only touch greet", steps: ["add greet"], expectedPaths: ["src/greet/**"], verification: { commands: ["node --test"] } });
  commit(repo, { "src/greet/hi.js": "export const hi = 1;\n", "src/unrelated.js": "export const u = 1;\n" }, "planned + unplanned");
  const r = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD", againstPlan: true });
  assert.equal(r.verdict, "VIOLATIONS");
  const creep = r.entries.find((e) => e.kind === "scope-creep");
  assert.ok(creep);
  assert.equal(creep?.file, "src/unrelated.js");
  assert.ok(!r.entries.some((e) => e.kind === "scope-creep" && e.file === "src/greet/hi.js"), "planned path is not scope creep");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("architecture: shortcuts (integrity detectors) fire on the diff", async () => {
  const repo = initRepo({ "package.json": PKG, "src/app.js": "export function f(){ return 1; }\n" });
  // a forced exit(0) in app code = a confirmed shortcut
  commit(repo, { "src/app.js": "export function f(){ process.exit(0); }\n" }, "shortcut");
  const r = await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" });
  assert.equal(r.verdict, "VIOLATIONS");
  assert.ok(r.entries.some((e) => e.kind === "shortcut" && e.severity === "violation"), JSON.stringify(r.entries));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("architecture: sealed evidence verifies; CODEOWNERS review routing recorded", async () => {
  const repo = initRepo({
    "package.json": PKG,
    ".github/CODEOWNERS": "src/** @core-team\n",
    "src/a.js": "export const a = 1;\n",
  });
  commit(repo, { "src/a.js": "export const a = 2;\n" }, "touch owned file");
  const r = sealArchitectureResult(await checkArchitecture({ repo, from: "HEAD~1", to: "HEAD" }));
  assert.equal(r.verdict, "CONFORMS");
  assert.ok(r.entries.some((e) => e.kind === "review-required" && e.detail.includes("@core-team")));
  assert.equal(checkEvidence(JSON.parse(fs.readFileSync(r.sealedPath!, "utf8"))).status, "verified");
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------- verification stack ----------------

test("stack: runs the unit layer, skips absent layers honestly", async () => {
  const repo = initRepo({
    "package.json": PKG_MIN,
    "math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1+1, 2));\n`,
  });
  const r = await runVerifyStack({ repo, timeoutMs: 60000 });
  const unit = r.layers.find((l) => l.kind === "unit")!;
  assert.equal(unit.status, "PASS");
  assert.equal(unit.counts?.total, 1);
  const typecheck = r.layers.find((l) => l.kind === "typecheck")!;
  assert.ok(["PASS", "FAIL", "SKIPPED"].includes(typecheck.status));
  assert.ok(typecheck.skipReason || typecheck.command);
  const e2e = r.layers.find((l) => l.kind === "e2e")!;
  assert.equal(e2e.status, "SKIPPED");
  assert.match(e2e.skipReason!, /no e2e suite/);
  assert.equal(r.verdict, "STACK_PASS");
  const sealed = sealStackResult(r);
  assert.equal(checkEvidence(JSON.parse(fs.readFileSync(sealed.sealedPath!, "utf8"))).status, "verified");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("stack: failing test layer → STACK_FAIL with assertion diagnosis and failing names", async () => {
  const repo = initRepo({
    "package.json": PKG_MIN,
    "math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1+1, 3));\n`,
  });
  const r = await runVerifyStack({ repo, timeoutMs: 60000 });
  assert.equal(r.verdict, "STACK_FAIL");
  const unit = r.layers.find((l) => l.kind === "unit")!;
  assert.equal(unit.status, "FAIL");
  assert.equal(unit.diagnosis?.category, "assertion-failure");
  assert.ok((unit.failing ?? []).some((f) => f.includes("adds")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("diagnosis taxonomy is deterministic and honest", () => {
  assert.equal(diagnoseFailure("typecheck", "src/x.ts(4,5): error TS2345: Argument of type", false).category, "type-error");
  assert.equal(diagnoseFailure("build", "Cannot find module 'left-pad'", false).category, "missing-dependency");
  assert.equal(diagnoseFailure("lint", "problems (2)\n  1:1  error  semi  eslint-plugin-rules", false).category, "lint-violation");
  assert.equal(diagnoseFailure("unit", "AssertionError: expected 3", false).category, "assertion-failure");
  assert.equal(diagnoseFailure("unit", "SyntaxError: unexpected token", false).category, "syntax-error");
  assert.equal(diagnoseFailure("build", "EADDRINUSE: address in use", false).category, "environment");
  assert.equal(diagnoseFailure("unit", "", true).category, "timeout");
  const d = diagnoseFailure("build", "something weird", false);
  assert.equal(d.category, "unclassified");
  assert.match(d.summary, /read the captured output/);
});

test("stack: typecheck failure diagnosed with TS code", async () => {
  // point typecheck at THIS repo's real tsc so the layer is deterministic
  const { fileURLToPath } = await import("node:url");
  const tscBin = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "node_modules", "typescript", "bin", "tsc");
  const repo = initRepo({
    "package.json": JSON.stringify({ name: "svc", type: "module", scripts: { typecheck: `node "${tscBin}" --noEmit` } }),
    "tsconfig.json": '{"compilerOptions":{"strict":true,"noEmit":true}}',
    "bad.ts": "const n: number = 'not a number';\n",
  });
  const r = await runVerifyStack({ repo, timeoutMs: 120000 });
  const tc = r.layers.find((l) => l.kind === "typecheck")!;
  assert.equal(tc.status, "FAIL", `expected the typecheck layer to fail, got ${tc.status}: ${tc.diagnosis?.summary}`);
  assert.equal(tc.diagnosis?.category, "type-error");
  assert.match(tc.diagnosis.summary, /TS\d+/);
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------- flow ----------------

test("flow: runs understand → stack → architecture → gate; skips unconfigured stages honestly", async () => {
  const repo = initRepo({
    "package.json": PKG_MIN,
    "math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1+1, 2));\n`,
    "src/core/a.js": "export const a = 1;\n",
  });
  const flow = await runFlow({ repo, threshold: 40 });
  const byStage = new Map(flow.stages.map((s) => [s.stage, s]));
  assert.equal(byStage.get("understand")?.status, "RAN");
  assert.equal(byStage.get("verify-stack")?.status, "RAN");
  assert.equal(byStage.get("architecture")?.status, "RAN");
  assert.equal(byStage.get("contract")?.status, "SKIPPED");
  assert.equal(byStage.get("baseline")?.status, "SKIPPED");
  assert.equal(byStage.get("holdout")?.status, "SKIPPED");
  // scan-based gate needs a scan baseline; without one the flow fails honestly
  assert.equal(["FAILED", "UNPROVEN"].includes(flow.verdict), true);
  assert.equal(flow.gateExit !== 0, true);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("flow: with a scan baseline and clean tree → gate passes (VERIFIED or honest UNPROVEN)", async () => {
  const repo = initRepo({
    "package.json": PKG_MIN,
    "math.test.js": `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("adds", () => assert.equal(1+1, 2));\n`,
  });
  // create the scan baseline via the real scan command path (absolute — cwd is the fixture)
  const { execSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const cli = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "cli.js");
  execSync(`node "${cli}" scan .`, { cwd: repo, encoding: "utf8", stdio: "pipe", env: { ...process.env, FORCE_COLOR: "0" } });
  const flow = await runFlow({ repo, threshold: 10 });
  assert.equal(flow.gateExit, 0, JSON.stringify(flow.decision.reasons));
  assert.equal(["VERIFIED", "UNPROVEN"].includes(flow.verdict), true, "scan-only → honest UNPROVEN, never a fabricated VERIFIED");
  fs.rmSync(repo, { recursive: true, force: true });
});
