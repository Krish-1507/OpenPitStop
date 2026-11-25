import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createMcpHandler, type McpTool } from "../src/mcp/protocol.js";
import { mcpTools } from "../src/mcp/tools.js";

const FIXTURE_SRC = path.resolve("bench/scenarios/sql-injection-concat/repo");

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-mcp-"));
}

function put(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** Send one JSON-RPC line and parse the response (or null for notifications). */
async function rpc(handle: (line: string) => Promise<string | null>, message: unknown) {
  const raw = await handle(JSON.stringify(message));
  return raw ? JSON.parse(raw) : null;
}

function handlerWithTools(fallbackRepo: string) {
  return createMcpHandler({
    serverInfo: { name: "openpitstop", version: "test" },
    tools: mcpTools(fallbackRepo),
  });
}

test("mcp — initialize echoes the requested protocol version and advertises tools", async () => {
  const handle = handlerWithTools(process.cwd());
  const response = await rpc(handle, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "0" } },
  });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, "2025-06-18");
  assert.deepEqual(response.result.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result.serverInfo.name, "openpitstop");
  assert.match(response.result.instructions, /never accept a verdict|sealed/);
});

test("mcp — notifications get no response; ping does", async () => {
  const handle = handlerWithTools(process.cwd());
  assert.equal(await handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  const pong = await rpc(handle, { jsonrpc: "2.0", id: "p", method: "ping" });
  assert.deepEqual(pong.result, {});
});

test("mcp — malformed input is a parse error with a null id", async () => {
  const handle = handlerWithTools(process.cwd());
  const raw = await handle("{ nope");
  assert.ok(raw, "a parse error still gets a response");
  const response = JSON.parse(raw);
  assert.equal(response.id, null);
  assert.equal(response.error.code, -32700);
});

test("mcp — an unknown method is method-not-found", async () => {
  const handle = handlerWithTools(process.cwd());
  const response = await rpc(handle, { jsonrpc: "2.0", id: 7, method: "sampling/createMessage" });
  assert.equal(response.error.code, -32601);
});

test("mcp — tools/list exposes the documented read-only tool set", async () => {
  const handle = handlerWithTools(process.cwd());
  const response = await rpc(handle, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = response.result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(names, [
    "pitstop_understand",
    "pitstop_map",
    "pitstop_scan",
    "pitstop_release_gate",
    "pitstop_reproduce",
    "pitstop_bench",
  ]);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.match(tool.description, /\S/);
  }
  // The gate tool must state the independence rule in its own description.
  const gate = response.result.tools.find((tool: { name: string }) => tool.name === "pitstop_release_gate");
  assert.match(gate.description, /never from the calling agent|NEVER from/);
});

test("mcp — an unknown tool is invalid params, and a throwing tool is an isError result", async () => {
  const handle = handlerWithTools(process.cwd());

  const unknown = await rpc(handle, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pitstop_delete_everything" } });
  assert.equal(unknown.error.code, -32602);
  assert.match(unknown.error.message, /Unknown tool/);

  const boom: McpTool = {
    name: "boom",
    description: "always throws",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      throw new Error("boom");
    },
  };
  const boomHandle = createMcpHandler({ serverInfo: { name: "openpitstop", version: "test" }, tools: [boom] });
  const boomRaw = await boomHandle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "boom" } }));
  const result = JSON.parse(boomRaw!);
  assert.equal(result.error, undefined);
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /OpenPitStop tool error: boom/);
});

test("mcp — pitstop_understand reports support levels without inferring verification", async () => {
  const handle = handlerWithTools(FIXTURE_SRC);
  const response = await rpc(handle, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pitstop_understand", arguments: {} } });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.primaryLanguage, "js");
  const js = value.support.find((entry: { id: string }) => entry.id === "js");
  assert.ok(js);
  assert.equal(js.verification.status, "unproven");
  assert.ok(value.tools.some((tool: { tool: string }) => tool.tool === "semgrep"));
});

test("mcp — pitstop_map returns route leads and an explicit limits list", async () => {
  const handle = handlerWithTools(process.cwd());
  const response = await rpc(handle, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "pitstop_map", arguments: { repo: "src" } } });
  const value = JSON.parse(response.result.content[0].text);
  assert.ok(Array.isArray(value.routes));
  assert.ok(Array.isArray(value.limits) && value.limits.length > 0);

  const architecture = await rpc(handle, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "pitstop_map", arguments: { repo: "src", architecture: true } },
  });
  const modules = JSON.parse(architecture.result.content[0].text);
  assert.ok(Array.isArray(modules.modules) && modules.modules.length > 0);
  assert.ok(Array.isArray(modules.cycles));
});

test("mcp — pitstop_scan finds the seeded injection, seals a baseline and writes nothing outside .pitstop", async () => {
  const repo = tmp();
  try {
    fs.cpSync(FIXTURE_SRC, repo, { recursive: true });
    const before = tree(repo);
    const handle = handlerWithTools(repo);
    const response = await rpc(handle, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "pitstop_scan", arguments: {} } });
    const value = JSON.parse(response.result.content[0].text);
    assert.equal(value.mode, "quick-static");
    assert.ok(value.findingCount >= 1, "expected the seeded sql-injection to be found");
    assert.ok(value.findings.some((finding: { category?: string }) => finding.category === "sql-injection"));
    assert.ok(value.findings.every((finding: { id: string }) => typeof finding.id === "string" && finding.id.length > 0));
    assert.ok(value.notRun.some((note: string) => /tests/.test(note)));
    assert.match(value.note, /not a security verdict/);

    const after = tree(repo);
    const added = after.filter((entry) => !before.includes(entry));
    assert.ok(added.length > 0, "the scan seals its baseline");
    assert.ok(added.every((entry) => entry === ".pitstop" || entry.startsWith(".pitstop/")), `only .pitstop/ may change: ${added.join(", ")}`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  function tree(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const target = path.join(current, entry.name);
        out.push(path.relative(dir, target).replace(/\\/g, "/"));
        if (entry.isDirectory()) walk(target);
      }
    };
    walk(dir);
    return out.sort();
  }
});

test("mcp — pitstop_release_gate fails honestly without a baseline and reads sealed layers when present", async () => {
  const repo = tmp();
  try {
    put(path.join(repo, "package.json"), '{ "name": "gate-fixture", "version": "1.0.0" }');
    const handle = handlerWithTools(repo);

    const noBaseline = await rpc(handle, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "pitstop_release_gate", arguments: {} } });
    const value = JSON.parse(noBaseline.result.content[0].text);
    assert.equal(value.verdict, "FAILED");
    assert.equal(value.pass, false);
    assert.equal(value.exitCode, 1);
    assert.match(value.note, /not over the calling agent's claim/);

    const badArgs = await rpc(handle, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "pitstop_release_gate", arguments: { threshold: 200 } },
    });
    assert.equal(badArgs.error, undefined, "a bad argument is a tool result, not a protocol error");
    assert.equal(badArgs.result.isError, true);
    assert.match(badArgs.result.content[0].text, /threshold must be a number from 0 to 100/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("mcp — pitstop_reproduce refuses honestly when no scan exists", async () => {
  const repo = tmp();
  try {
    const handle = handlerWithTools(repo);
    const response = await rpc(handle, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "pitstop_reproduce", arguments: { findingId: "security-deadbeef" } },
    });
    const value = JSON.parse(response.result.content[0].text);
    assert.equal(value.status, "no-scan");
    assert.match(value.reason, /scan-latest|pen-latest/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("mcp — pitstop_bench returns the published summary with denominators", async () => {
  const handle = handlerWithTools(process.cwd());
  const response = await rpc(handle, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "pitstop_bench", arguments: { filter: "python" } },
  });
  const value = JSON.parse(response.result.content[0].text);
  assert.equal(value.summary.expectedFindings, 1);
  assert.equal(value.summary.detectedFindings, 1);
  assert.equal(value.summary.precision, 1);
  assert.ok(value.limits.length >= 5);
  assert.deepEqual(value.scenarios.map((entry: { id: string }) => entry.id), ["python-command-injection", "python-command-injection-fixed"]);

  const badFilter = await rpc(handle, { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "pitstop_bench", arguments: { filter: "no-such" } } });
  assert.equal(badFilter.error, undefined, "an unmatched filter is a tool error, not a protocol error");
  assert.equal(badFilter.result.isError, true);
  assert.match(badFilter.result.content[0].text, /no benchmark scenario matches/);
});

test("mcp — the stdio transport answers each request line and stays silent on notifications", async () => {
  const { serveStdio } = await import("../src/mcp/stdio.js");
  const handle = createMcpHandler({ serverInfo: { name: "openpitstop", version: "test" }, tools: [] });
  const requests = [
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  ];
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = { write: (chunk: string) => chunks.push(chunk) };
  const serving = serveStdio(handle, input, output);
  for (const request of requests) input.write(request + "\n");
  input.end();
  await serving;
  assert.equal(chunks.length, 1, "one response for one request; notifications stay silent");
  const response = JSON.parse(chunks[0].trim());
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, "openpitstop");
});
