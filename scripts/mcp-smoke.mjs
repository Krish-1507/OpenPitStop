#!/usr/bin/env node
/**
 * End-to-end guard for `pitstop mcp`: spawns the built CLI over real stdio and
 * asserts that stdout carries JSON-RPC and nothing else, that every request
 * gets exactly one response, and that scan + gate return real evidence.
 *
 * This runs a subprocess on purpose. The unit tests drive the handler and the
 * transport in-process; this is the only check that proves the *binary* keeps
 * its protocol channel clean when a tool actually runs (spinners, dependency
 * probes and test runners all write somewhere — they must not write here).
 *
 * Usage: node scripts/mcp-smoke.mjs [path/to/cli.js]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(here, "..", "dist", "cli.js");
const fixture = path.resolve(here, "..", "bench", "scenarios", "sql-injection-concat", "repo");

function fail(message) {
  console.error(`mcp smoke FAILED: ${message}`);
  process.exitCode = 1;
}

for (const [label, file] of [["CLI", cli], ["fixture repo", fixture]]) {
  if (!fs.existsSync(file)) {
    console.error(`mcp smoke cannot start: ${label} not found at ${file}`);
    if (label === "CLI") console.error("Run `npm run build` first.");
    process.exit(1);
  }
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-mcp-smoke-"));
fs.cpSync(fixture, repo, { recursive: true });

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-smoke", version: "0" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pitstop_scan", arguments: { repo } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pitstop_release_gate", arguments: { repo } } },
];
const expectedResponses = requests.filter((request) => "id" in request).length;

const child = spawn(process.execPath, [cli, "mcp"], {
  cwd: repo,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

const stdout = [];
const stderr = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));

const timeout = setTimeout(() => {
  child.kill();
  fail("the server did not exit within 120s");
}, 120_000);

const exitCode = await new Promise((resolve) => {
  child.on("error", (error) => {
    fail(`could not spawn ${process.execPath}: ${error.message}`);
    resolve(-1);
  });
  child.on("close", (code) => resolve(code));
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
});
clearTimeout(timeout);

const rawLines = stdout.join("").split("\n");
const lines = rawLines.filter((line) => line.trim() !== "");
const responses = [];

if (rawLines.length > 1 && lines.length === 0) fail("stdout was blank");
for (const line of lines) {
  // Anything that is not a JSON-RPC object here would corrupt a real host's
  // stream, so the failure names the offending line rather than only a count.
  try {
    const parsed = JSON.parse(line);
    if (!parsed || parsed.jsonrpc !== "2.0") {
      fail(`stdout line is JSON but not JSON-RPC: ${line.slice(0, 300)}`);
      continue;
    }
    responses.push(parsed);
  } catch {
    fail(`stdout line is not JSON: ${line.slice(0, 300)}`);
  }
}

if (responses.length !== expectedResponses) {
  fail(`${responses.length} response(s) for ${expectedResponses} request(s) (notifications must be silent)`);
}
if (exitCode !== 0) fail(`the server exited with code ${exitCode}`);

const byId = new Map(responses.map((response) => [response.id, response]));
const initialize = byId.get(1);
const list = byId.get(2);
const scan = byId.get(3);
const gate = byId.get(4);

function toolValue(response) {
  const text = response?.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

if (initialize?.result) {
  const version = initialize.result.protocolVersion;
  if (!["2024-11-05", "2025-03-26", "2025-06-18"].includes(version)) fail(`unexpected protocolVersion ${version}`);
  if (initialize.result.serverInfo?.name !== "openpitstop") fail("serverInfo.name is not openpitstop");
} else {
  fail("initialize produced no result");
}

const tools = list?.result?.tools ?? [];
if (tools.length !== 6) fail(`tools/list returned ${tools.length} tools, expected 6`);
for (const name of [
  "pitstop_understand",
  "pitstop_map",
  "pitstop_scan",
  "pitstop_release_gate",
  "pitstop_reproduce",
  "pitstop_bench",
]) {
  if (!tools.some((tool) => tool.name === name)) fail(`tools/list is missing ${name}`);
}

const scanValue = toolValue(scan);
if (scan?.result?.isError) fail(`pitstop_scan failed: ${scan.result.content[0].text}`);
if (!scanValue) {
  fail("pitstop_scan returned no parseable value");
} else {
  const findings = Array.isArray(scanValue.findings) ? scanValue.findings : [];
  if (findings.length === 0) fail("pitstop_scan found the seeded SQL injection in zero findings");
  if (!/sql/i.test(JSON.stringify(findings))) fail("pitstop_scan findings do not mention SQL");
  if (!fs.existsSync(path.join(repo, ".pitstop", "scan-latest.json"))) {
    fail("pitstop_scan did not seal a baseline under .pitstop/");
  }
}

const gateValue = toolValue(gate);
if (gate?.result?.isError) fail(`pitstop_release_gate failed: ${gate.result.content[0].text}`);
if (!gateValue) {
  fail("pitstop_release_gate returned no parseable value");
} else {
  if (!["VERIFIED", "FAILED", "BLOCKED", "UNPROVEN", "CHEAT"].includes(gateValue.verdict)) {
    fail(`unexpected gate verdict ${gateValue.verdict}`);
  }
  if (gateValue.pass !== false) fail("the gate passed a repo with an unresolved injected finding");
  if (!Array.isArray(gateValue.layers) || gateValue.layers.length === 0) fail("the gate reported no layers");
}

fs.rmSync(repo, { recursive: true, force: true });

if (!process.exitCode) {
  const scanFindings = toolValue(scan)?.findings?.length ?? 0;
  console.log(
    `mcp smoke OK — ${responses.length} JSON-RPC responses, 0 stray stdout bytes, ` +
      `${scanFindings} finding(s) sealed, gate verdict ${toolValue(gate)?.verdict}`,
  );
} else if (stderr.length) {
  console.error(`server stderr (${stderr.join("").length} bytes, first 2000):\n${stderr.join("").slice(0, 2000)}`);
}
