/**
 * repro/pen.ts — permanent repro tests for pen findings.
 *
 * A pen repro RE-PLAYS the exact attack the pen test fired (same route, same
 * payload, same sandbox) and asserts the SAFE outcome. While the vuln exists
 * the test FAILS; after the fix it PASSES. That is the fail-first contract,
 * applied to a live penetration test.
 *
 * The test is always generated as a `node:test` ESM file (like the ledger
 * repro) because it must boot the app under the pen preload, regardless of the
 * repo's own test framework.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PenFinding } from "../pen/types.js";
import type { ReproOutcome } from "./generate.js";
import { reproSlug, type ReproFinding } from "./ids.js";

function preloadPath(): string {
  return fileURLToPath(new URL("../../templates/pen/preload.cjs", import.meta.url));
}

/**
 * Turn a pen finding into the normalized ReproFinding shape the slug generator
 * (and any future caller) expects.
 */
export function penFindingToRepro(f: PenFinding): ReproFinding {
  return {
    id: f.id,
    source: "pen",
    severity: f.severity,
    type: f.type,
    description: f.title,
    file: f.file,
    line: f.line,
    data: f,
  };
}

const J = (s: unknown): string => JSON.stringify(s);

/**
 * The assertion body for each attack type. Returns JS that must be embedded in
 * the test; `f` carries the attack + observed evidence, `marker` is a fresh
 * random marker for THIS replay.
 */
function assertionBody(f: PenFinding, marker: string): string[] {
  switch (f.type) {
    case "reflected-xss":
      return [
        `assert.ok(!res.body.includes(${J(marker)}), "the XSS payload was reflected UNESCAPED in the response — reflecting user input is live");`,
      ];
    case "path-traversal":
      return [
        `assert.ok(!res.body.includes("root:x:0:0") && !res.body.includes("[extensions]") && !res.body.includes("; for 16-bit app support"), "the traversal payload leaked a host file inside the response — arbitrary file read is live");`,
      ];
    case "command-injection":
      return [
        `await sleep(400);`,
        `const spawns = readOutbound(outboundPath).filter((e) => e.kind === "spawn" && e.cmd && e.cmd.includes(${J(marker)}));`,
        `assert.equal(spawns.length, 0, "the sandbox recorded the marker inside a child_process spawn: command injection is live: " + JSON.stringify(spawns.map((e) => e.cmd)));`,
      ];
    case "ssrf":
      return [
        `await sleep(400);`,
        `const hits = readOutbound(outboundPath).filter((e) => e.kind === "http" && e.host && e.host.includes("ssrf-canary"));`,
        `assert.equal(hits.length, 0, "the server opened an outbound connection to the canary host: SSRF is live: " + JSON.stringify(hits.map((e) => e.host)));`,
      ];
    case "sql-injection":
    case "nosql-injection":
      return [
        `assert.ok(res.status < 500, "the injection payload crashed the server (HTTP " + res.status + ") — input reaches a query raw");`,
        `assert.ok(res.status !== 200 || !/syntax|unterminated|parse|mongo|sequelize|sqlite|knex|cannot read/i.test(res.snippet), "the injection payload surfaced a DB error in the response");`,
      ];
    case "crash-on-input":
      return [
        `assert.ok(res.status < 500, "the crafted input crashed the server (HTTP " + res.status + ") — unhandled exceptions are a DoS vector");`,
      ];
    case "missing-auth":
      return [
        `assert.ok(res.status === 401 || res.status === 403, "the sensitive route answered unauthenticated with HTTP " + res.status + " — anyone can reach it");`,
      ];
    case "no-rate-limit":
      return [
        `let got429 = 0;`,
        `for (let i = 0; i < 30; i++) {`,
        `  const r = await send("POST", ${J(f.attack?.path ?? "/")}, { username: "admin", password: "x-" + i });`,
        `  if (r.status === 429) got429++;`,
        `}`,
        `assert.ok(got429 > 0, "none of the 30 rapid requests were rate-limited (no 429) — credential stuffing is unthrottled");`,
      ];
    case "info-leak-header":
      return [
        `assert.ok(!res.headers["x-powered-by"], "X-Powered-By leaked the framework — disable it");`,
      ];
    case "missing-security-headers":
      return [
        `const want = ["x-frame-options", "content-security-policy", "x-content-type-options", "strict-transport-security"];`,
        `const missing = want.filter((h) => !res.headers[h]);`,
        `assert.ok(missing.length < 2, "security headers missing: " + missing.join(", "));`,
      ];
    default:
      return [];
  }
}

/** For static secret findings: guard the exact credential string. */
function secretGuardBody(f: PenFinding, fileRel: string): string[] {
  const secretFragment = (f.description.match(/\(([^)]{4,})…\)/) || [])[1] ?? "";
  const needle = secretFragment.slice(0, 8);
  if (!needle) return [];
  return [
    `const content = readFileSync(${J(fileRel)}, "utf8");`,
    `assert.ok(!content.includes(${J(needle)}), "the committed credential fragment '" + ${J(needle)} + "' is still in " + ${J(fileRel)} + " — rotate and remove it");`,
  ];
}

/**
 * Generate (and optionally write) the repro test file for a pen finding.
 */
export function generatePenRepro(repo: string, f: PenFinding): ReproOutcome {
  const isDynamic = f.source === "pen-dynamic" || (f.runtimeProof === "proven" && !!f.attack);
  const isStaticSecret = f.type === "hardcoded-secret" && f.file;

  if (!isDynamic && !isStaticSecret) {
    return {
      ok: false,
      reason:
        "this pen finding is a static heuristic / config observation — there is no live attack to replay. " +
        "Fix it and re-run `pitstop pen`; the dynamic phase produces replayable repros for live bugs.",
    };
  }

  const r = penFindingToRepro(f);
  const slug = reproSlug(r);
  const file = `pitstop-repro-${slug}.test.mjs`;

  if (isStaticSecret) {
    const fileRel = path.relative(repo, f.file as string).replace(/\\/g, "/");
    const header = [
      `// OpenPitStop permanent repro test — finding ${f.id}`,
      `// Linked from .pitstop/pen-latest.json.`,
      `//`,
      `// A committed credential guard: while the secret fragment below is present`,
      `// in the file, this test FAILS. Rotate the secret, remove it, and it PASSES.`,
    ].join("\n");
    const body = secretGuardBody(f, fileRel);
    if (body.length === 0) {
      return { ok: false, reason: "cannot derive a stable credential fragment from this secret finding" };
    }
    const content = [
      header,
      ``,
      `import { test } from "node:test";`,
      `import assert from "node:assert/strict";`,
      `import { readFileSync } from "node:fs";`,
      ``,
      `test("pitstop repro ${f.id}: no committed secret in ${fileRel}", () => {`,
      `  ${body.join("\n  ")}`,
      `});`,
      ``,
    ].join("\n");
    fs.writeFileSync(path.join(repo, file), content, "utf8");
    return { ok: true, file };
  }

  // Dynamic: replay the exact attack under the sandbox and assert the safe outcome.
  const attack = f.attack;
  if (!attack) {
    return {
      ok: false,
      reason: "dynamic finding carries no recorded attack to replay (evidence missing from pen-latest.json)",
    };
  }
  // Runtime-proven static findings assert the attack class that proved them
  // (e.g. a proven xss-sink asserts reflected-xss behavior), not the pattern.
  const assertFinding = f.proofType ? { ...f, type: f.proofType } : f;

  const bodyLines: string[] = [];
  // The marker lives inside the ORIGINAL attack payload/path (e.g. gpn12345678).
  // Reuse it so the replay's proof matches what the pen test observed.
  const attackSource = JSON.stringify([attack.path, attack.payload ?? null]);
  const marker = attackSource.match(/gpn\d{7,}/)?.[0] ?? `gpn${Math.floor(Math.random() * 1e8)}`;

  const isHammer = f.type === "no-rate-limit";

  const NODE_BASED = [
    "node", "node.exe", "nodejs", "npm", "npm.cmd", "npx", "npx.cmd",
    "yarn", "yarn.cmd", "pnpm", "pnpm.cmd", "tsx", "ts-node", "babel-node", "ojs", "vitest", "jest",
  ].map((s) => J(s)).join(", ");

  const prelude = [
    `const REPO = process.cwd();`,
    `const PRELOAD = process.env.PITSTOP_PEN_PRELOAD;`,
    `let BASE_URL = null;`,
    `const NODE_BASED = new Set([${NODE_BASED}]);`,
    ``,
    `import { test } from "node:test";`,
    `import assert from "node:assert/strict";`,
    `import { spawn } from "node:child_process";`,
    `import { readFileSync, mkdirSync, existsSync } from "node:fs";`,
    `import net from "node:net";`,
    `import path from "node:path";`,
    ``,
    `function freePort() {`,
    `  return new Promise((resolve, reject) => {`,
    `    const s = net.createServer();`,
    `    s.unref();`,
    `    s.on("error", reject);`,
    `    s.listen(0, () => {`,
    `      const p = s.address().port;`,
    `      s.close(() => resolve(p));`,
    `    });`,
    `  });`,
    `}`,
    `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
    ``,
    `function resolveStart() {`,
    `  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));`,
    `  const start = (pkg.scripts && pkg.scripts.start) || "";`,
    `  if (!start) throw new Error("no start script in package.json");`,
    `  const tokens = start.trim().split(/\\s+/);`,
    `  if (!NODE_BASED.has(tokens[0])) {`,
    `    throw new Error("start script runs " + tokens[0] + ", which is not Node-based — refusing");`,
    `  }`,
    `  return { cmd: tokens[0], args: tokens.slice(1) };`,
    `}`,
    ``,
    `function controlHas(controlPath, needle) {`,
    `  if (!existsSync(controlPath)) return false;`,
    `  try {`,
    `    return readFileSync(controlPath, "utf8").split(/\\r?\\n/).some((l) => l.includes(needle));`,
    `  } catch {`,
    `    return false;`,
    `  }`,
    `}`,
    ``,
    `function readOutbound(p) {`,
    `  if (!existsSync(p)) return [];`,
    `  return readFileSync(p, "utf8").split(/\\r?\\n/).filter(Boolean).map((l) => {`,
    `    try { return JSON.parse(l); } catch { return null; }`,
    `  }).filter(Boolean);`,
    `}`,
    ``,
    `async function send(method, p, body) {`,
    `  try {`,
    `    const res = await fetch(BASE_URL + p, {`,
    `      method,`,
    `      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,`,
    `      body: body !== undefined ? JSON.stringify(body) : undefined,`,
    `      redirect: "manual",`,
    `      signal: AbortSignal.timeout(6000),`,
    `    });`,
    `    const text = await res.text().catch(() => "");`,
    `    const headers = {};`,
    `    res.headers.forEach((v, k) => { headers[k] = v; });`,
    `    return { status: res.status, body: text, snippet: text.slice(0, 300), headers };`,
    `  } catch (e) {`,
    `    return { status: 0, body: "", snippet: "", headers: {} };`,
    `  }`,
    `}`,
    ``,
    `test("pitstop repro ${f.id}: ${assertFinding.type} blocked on ${attack.path}", async () => {`,
    `  assert.ok(PRELOAD, "PITSTOP_PEN_PRELOAD not set — run this via \`npx openpitstop repro ${f.id}\`");`,
    ``,
    `  const start = resolveStart();`,
    `  const runDir = path.join(REPO, ".pitstop", "repro", new Date().toISOString().replace(/[:.]/g, "-"));`,
    `  mkdirSync(runDir, { recursive: true });`,
    `  const controlPath = path.join(runDir, "control.jsonl");`,
    `  const outboundPath = path.join(runDir, "outbound.jsonl");`,
    `  const port = await freePort();`,
    `  BASE_URL = "http://127.0.0.1:" + port;`,
    ``,
  ];

  const boot = [
    `  const env = {`,
    `    ...process.env,`,
    `    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require=" + PRELOAD].filter(Boolean).join(" "),`,
    `    PORT: String(port),`,
    `    PITSTOP_PEN_CONTROL: controlPath,`,
    `    PITSTOP_PEN_OUTBOUND: outboundPath,`,
    `    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || "rzp_test_pitstop000000",`,
    `    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || "pitstop_fake_secret",`,
    `    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_pitstop_fake",`,
    `    NODE_ENV: process.env.NODE_ENV || "test",`,
    `  };`,
    `  const child = spawn(start.cmd, start.args, { cwd: REPO, env, stdio: ["ignore", "ignore", "inherit"] });`,
    `  try {`,
    `    const deadline = Date.now() + 25000;`,
    `    let up = false;`,
    `    while (Date.now() < deadline) {`,
    `      if (child.exitCode !== null) break;`,
    `      if (controlHas(controlPath, '"event":"armed"')) {`,
    `        try {`,
    `          await fetch(BASE_URL + "/__pitstop_pen_probe__");`,
    `          up = true;`,
    `          break;`,
    `        } catch {}`,
    `      }`,
    `      await sleep(150);`,
    `    }`,
    `    assert.ok(up, "app did not come up under the sandbox within 25s");`,
  ];

  const attackCode = isHammer
    ? []
    : [
        `    const res = await send(${J(attack.method)}, ${J(attack.path)}, ${attack.payload !== undefined ? J(attack.payload) : "undefined"});`,
      ];

  const close = [
    `  } finally {`,
    `    try { child.kill(); } catch {}`,
    `  }`,
    `});`,
  ];

  const assertCode = isHammer
    ? assertionBody(assertFinding, marker)
    : assertionBody(assertFinding, marker).map((l) => `    ` + l);

  // header for the test file
  const headerLines = [
    `// OpenPitStop permanent repro test — finding ${f.id}`,
    `// Linked from .pitstop/pen-latest.json.`,
    `//`,
    `// REPLAYS the exact attack the pen test fired: ${attack.method} ${attack.path}`,
    `// and asserts the SAFE outcome. This test MUST FAIL while the vulnerability`,
    `// exists and MUST PASS only after the fix.`,
  ];

  bodyLines.push(
    ...prelude,
    ...boot,
    ...attackCode,
    ...assertCode,
    ...close,
  );

  const content = [headerLines.join("\n"), "", ...bodyLines, ""].join("\n");
  fs.writeFileSync(path.join(repo, file), content, "utf8");
  return { ok: true, file };
}

/** Absolute path of the pen sandbox preload (for run.ts). */
export function penPreloadPath(): string {
  return preloadPath();
}
