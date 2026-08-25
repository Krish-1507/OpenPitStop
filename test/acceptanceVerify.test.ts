import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  verifyAcceptance,
  sealAcceptanceResult,
  checkAcceptanceEvidence,
  acceptancePinPath,
} from "../src/verify/acceptance.js";
import { gateOutcome } from "../src/commands/gate.js";
import { seal } from "../src/evidence.js";

function git(repo: string, args: string): string {
  return execSync(`git ${args}`, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
}

// Generic fixture: a tiny HTTP service with a health endpoint and a greet
// endpoint, plus a unit-testable module. Nothing about any real project.
const SERVER_GOOD = `import http from "node:http";
const port = Number(process.env.PORT || 47191);
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (u.pathname === "/greet") { res.writeHead(200); res.end("hello " + (u.searchParams.get("name") || "world")); return; }
  res.writeHead(404); res.end("nope");
}).listen(port, "127.0.0.1");
`;
const SERVER_BROKEN = SERVER_GOOD.replace('res.writeHead(200); res.end("hello " + (u.searchParams.get("name") || "world")); return;', 'res.writeHead(500); res.end("broken"); return;');
const FEATURE_GOOD = `export function greet(name) {
  return "hello " + (name || "world");
}
`;
const FEATURE_BROKEN = `export function greet(name) {
  return "broken";
}
`;
const FEATURE_TEST = `import test from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/feature.js";
test("greet", () => assert.equal(greet("ada"), "hello ada"));
`;

function initRepo(serverSrc: string, featureSrc: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-acc-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "t@t.t"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "test"));
  fs.writeFileSync(path.join(dir, "server.js"), serverSrc);
  fs.writeFileSync(path.join(dir, "src", "feature.js"), featureSrc);
  fs.writeFileSync(path.join(dir, "test", "feature.test.js"), FEATURE_TEST);
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  execSync("git add -A", { cwd: dir });
  execSync("git commit -q -m baseline", { cwd: dir });
  return dir;
}

function commit(repo: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(repo, file), content);
  execSync("git add -A", { cwd: repo });
  execSync(`git commit -q -m "${msg}" --allow-empty`, { cwd: repo });
  return git(repo, "rev-parse HEAD");
}

const PORT = 47191;

function contractJson(extra: Record<string, unknown> = {}, port = PORT): string {
  return JSON.stringify(
    {
      id: "greet-service",
      version: 1,
      description: "the greeting service must actually work end to end",
      start: { command: `node server.js`, readyUrl: `http://127.0.0.1:${port}/health`, timeoutMs: 15000 },
      requirements: [
        {
          id: "req-001",
          description: "health endpoint responds",
          criteria: [
            { id: "health-200", type: "http", url: `http://127.0.0.1:${port}/health`, expectStatus: 200, expectBodyContains: "ok" },
            { id: "feature-module-exists", type: "fileExists", path: "src/feature.js" },
          ],
        },
        {
          id: "req-002",
          description: "greeting works end to end",
          criteria: [
            { id: "greet-http", type: "http", url: `http://127.0.0.1:${port}/greet?name=ada`, expectStatus: 200, expectBodyContains: "hello ada" },
            { id: "greet-unit", type: "command", command: "node --test test/feature.test.js" },
            { id: "greet-source", type: "fileContains", path: "src/feature.js", contains: "hello " },
          ],
        },
      ],
      timeoutMs: 30000,
      ...extra,
    },
    null,
    2,
  );
}

function makeContract(dir: string, json = contractJson()): string {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-acc-c-"));
  fs.writeFileSync(path.join(suite, "acceptance.json"), json);
  void dir;
  return path.join(suite, "acceptance.json");
}

test("1+7 — all criteria pass (baseline discriminates) → SATISFIED", async () => {
  const repo = initRepo(SERVER_BROKEN, FEATURE_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "server.js", SERVER_GOOD, "fix server");
  commit(repo, "src/feature.js", FEATURE_GOOD, "fix feature");
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract, baselineRef: baseline });
  assert.equal(r.verdict, "SATISFIED", r.reasons.join("; "));
  assert.equal(r.totalCriteria, 5);
  assert.ok(r.discriminative >= 1, "at least one criterion must discriminate");
  assert.ok(r.requirements.every((x) => x.satisfied === true));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("2+8 — one criterion fails (greet broken end to end) → NOT_SATISFIED", async () => {
  const repo = initRepo(SERVER_BROKEN, FEATURE_BROKEN);
  const baseline = git(repo, "rev-parse HEAD");
  // agent fixes the unit but NOT the real endpoint — plausible diff, green unit, broken flow
  commit(repo, "src/feature.js", FEATURE_GOOD, "fix unit only");
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract, baselineRef: baseline });
  assert.equal(r.verdict, "NOT_SATISFIED");
  const greetHttp = r.evidence.find((e) => e.criterionId === "greet-http");
  assert.equal(greetHttp?.pass, false);
  const greetUnit = r.evidence.find((e) => e.criterionId === "greet-unit");
  assert.equal(greetUnit?.pass, true, "the visible unit test passes — that is the failure mode");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("3 — missing evidence: http endpoint unreachable → UNPROVEN, not satisfied", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  // contract points at a port nothing listens on and boots nothing
  const contract = makeContract(
    repo,
    JSON.stringify({
      id: "dead-port",
      requirements: [
        {
          id: "req-001",
          criteria: [{ id: "http-never", type: "http", url: "http://127.0.0.1:47199/health", expectStatus: 200 }],
        },
      ],
    }),
  );
  const r = await verifyAcceptance({ repo, contractSpec: contract });
  assert.equal(r.verdict, "UNPROVEN");
  assert.equal(r.evidence[0].pass, null);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("3b — http criteria with a booted app: start command + readiness probe", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract });
  const health = r.evidence.find((e) => e.criterionId === "health-200");
  assert.equal(health?.pass, true, health?.observed);
  assert.equal((health?.detail as any)?.status, 200);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("4 — modified criteria: in-repo contract change → INTEGRITY_FAILURE until --authorize", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  // in-repo contract (the agent CAN touch this one — that is the point of the pin)
  const inRepo = path.join(repo, "acceptance.json");
  fs.writeFileSync(inRepo, contractJson());
  const first = await verifyAcceptance({ repo, contractSpec: inRepo });
  assert.equal(first.verdict, "SATISFIED", first.reasons.join("; "));
  assert.ok(first.notes.some((n) => n.includes("pinned for the first time")));
  assert.ok(fs.existsSync(acceptancePinPath(repo)));

  // the agent quietly redefines success (weakens the criterion so anything passes)
  fs.writeFileSync(inRepo, contractJson().replace('"expectBodyContains": "hello ada"', '"expectBodyContains": "hello"'));
  const second = await verifyAcceptance({ repo, contractSpec: inRepo });
  assert.equal(second.verdict, "INTEGRITY_FAILURE");
  assert.ok(second.reasons.some((x) => x.includes("CHANGED after authorization")));

  // explicit human re-authorization accepts the new version — which now runs
  const third = await verifyAcceptance({ repo, contractSpec: inRepo, authorize: true });
  assert.equal(third.verdict, "SATISFIED", third.reasons.join("; "));
  assert.ok(third.notes.some((n) => n.includes("re-authorized")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("5 — invalid contracts → INTEGRITY_FAILURE", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  const missingReqs = makeContract(repo, JSON.stringify({ id: "x", requirements: [] }));
  const r1 = await verifyAcceptance({ repo, contractSpec: missingReqs });
  assert.equal(r1.verdict, "INTEGRITY_FAILURE");
  assert.ok(r1.reasons.some((x) => x.includes("non-empty array")));

  const badType = makeContract(repo, JSON.stringify({
    id: "x",
    requirements: [{ id: "r1", criteria: [{ id: "c1", type: "vibes", prompt: "is it good?" }] }],
  }));
  const r2 = await verifyAcceptance({ repo, contractSpec: badType });
  assert.equal(r2.verdict, "INTEGRITY_FAILURE");
  assert.ok(r2.reasons.some((x) => x.includes("unknown type")), "LLM-judge-style criteria are rejected, not improvised");

  const r3 = await verifyAcceptance({ repo, contractSpec: "no-such-contract-xyz" });
  assert.equal(r3.verdict, "INTEGRITY_FAILURE");

  const r4 = await verifyAcceptance({ repo: fs.mkdtempSync(path.join(os.tmpdir(), "acc-nogit-")), contractSpec: makeContract(repo) });
  assert.equal(r4.verdict, "INTEGRITY_FAILURE");
  fs.rmSync(repo, { recursive: true, force: true });
  for (const c of [missingReqs, badType]) fs.rmSync(path.dirname(c), { recursive: true, force: true });
  fs.rmSync(path.dirname(makeContract(repo)), { recursive: true, force: true });
});

test("6 — baseline passes everything (contract does not discriminate) → UNPROVEN", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  const baseline = git(repo, "rev-parse HEAD");
  commit(repo, "README.md", "# notes\n", "unrelated change");
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract, baselineRef: baseline });
  assert.equal(r.verdict, "UNPROVEN");
  assert.ok(r.reasons.some((x) => x.includes("does not discriminate")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("9 — malformed (tampered) evidence → tampered", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  const contract = makeContract(repo);
  const r = sealAcceptanceResult(await verifyAcceptance({ repo, contractSpec: contract }));
  assert.equal(checkAcceptanceEvidence(r.sealedPath!).status, "verified");
  const doc = JSON.parse(fs.readFileSync(r.sealedPath!, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(r.sealedPath!, JSON.stringify(doc, null, 2));
  assert.equal(checkAcceptanceEvidence(r.sealedPath!).status, "tampered");
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("10 — deterministic repeated runs → same verdict", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  const contract = makeContract(repo);
  const a = await verifyAcceptance({ repo, contractSpec: contract });
  const b = await verifyAcceptance({ repo, contractSpec: contract });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.contractHash, b.contractHash);
  assert.deepEqual(a.evidence.map((e) => e.pass), b.evidence.map((e) => e.pass));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("11 — fresh checkout: dirty working tree untouched, uncommitted changes not verified", async () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  fs.writeFileSync(path.join(repo, "uncommitted.txt"), "mine\n");
  fs.appendFileSync(path.join(repo, "src", "feature.js"), "\n// uncommitted junk\n");
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract });
  assert.equal(r.verdict, "SATISFIED", "runs against the committed candidate");
  assert.ok(fs.existsSync(path.join(repo, "uncommitted.txt")));
  assert.ok(fs.readFileSync(path.join(repo, "src", "feature.js"), "utf8").includes("uncommitted junk"));
  assert.ok(!fs.existsSync(path.join(repo, "server.pid")));
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

test("12 — evidence carries expected vs observed per criterion", async () => {
  const repo = initRepo(SERVER_BROKEN, FEATURE_BROKEN);
  const contract = makeContract(repo);
  const r = await verifyAcceptance({ repo, contractSpec: contract });
  for (const e of r.evidence) {
    assert.ok(e.expected.length > 0, "every criterion records what was expected");
    assert.ok(e.observed.length > 0, "every criterion records what was observed");
    assert.ok(e.timestamp);
  }
  const greetHttp = r.evidence.find((e) => e.criterionId === "greet-http")!;
  assert.match(greetHttp.observed, /status 500/);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(path.dirname(contract), { recursive: true, force: true });
});

// ---- gate integration

function fakeOutcome(repo: string): any {
  return {
    repo,
    missingBaseline: false,
    stale: false,
    risk: "Low",
    blocked: false,
    integrity: { verdict: "CLEAN", findings: [], summary: { confirmed: 0, suspicious: 0, total: 0 } },
    evidence: { status: "verified", digest: "x" },
    current: { tests: { total: 1, passed: 1, failed: 0, durationMs: 1 }, perf: {}, securityCount: 0, duplicationCount: 0 },
    baseline: { tests: { total: 1, passed: 1, failed: 0, durationMs: 1 }, perf: {}, securityCount: 0, duplicationCount: 0 },
    deltas: {},
    baselineScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    currentScore: { score: 100, grade: "A", categories: [], analyzed: 1, total: 1 },
    scoreDelta: 0,
    exitCode: 0,
  };
}

function writeAcceptanceReport(repo: string, verdict: string): string {
  const dir = path.join(repo, ".pitstop");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "acceptance-test.json");
  fs.writeFileSync(
    file,
    JSON.stringify(seal({ timestamp: new Date().toISOString(), repo, verdict, reasons: [] }, `acceptance ${repo}`), null, 2),
  );
  return file;
}

test("13 — gate: NOT_SATISFIED hard-blocks; UNPROVEN surfaces; tampered blocks; absent = unchanged", () => {
  const repo = initRepo(SERVER_GOOD, FEATURE_GOOD);
  writeAcceptanceReport(repo, "NOT_SATISFIED");
  const g1 = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(g1.reasons.some((r) => r.includes("NOT_SATISFIED")));
  assert.equal(g1.exitCode, 1);

  writeAcceptanceReport(repo, "UNPROVEN");
  const g2 = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(g2.reasons.some((r) => r.includes("UNPROVEN")));
  assert.equal(g2.exitCode, 0);

  const file = writeAcceptanceReport(repo, "SATISFIED");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.verdict = "FAKE";
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const g3 = gateOutcome(fakeOutcome(repo), 60);
  assert.ok(g3.reasons.some((r) => r.includes("TAMPERED")));
  assert.equal(g3.exitCode, 1);

  fs.rmSync(path.join(repo, ".pitstop"), { recursive: true, force: true });
  const g4 = gateOutcome(fakeOutcome(repo), 60);
  assert.equal(g4.exitCode, 0);
  assert.equal(g4.reasons.length, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});
