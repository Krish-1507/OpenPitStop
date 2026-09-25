import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentBudget, agentArgv, positiveLimit, runBudgetedAgent } from "../src/agentBudget.js";

test("global reservations apply across findings, failed launches, time and prompt volume", () => {
  let now = 0;
  const b = new AgentBudget(".", { maxCalls: 2, maxSeconds: 1, maxPromptChars: 10 }, () => now);
  b.reserve('agent -p "{prompt}"', "first");
  b.reserve('agent -p "{prompt}"', "next");
  assert.throws(() => b.reserve('agent -p "{prompt}"', "x"), /call limit/);
  const chars = new AgentBudget(".", { maxCalls: 5, maxSeconds: 1, maxPromptChars: 2 }, () => now);
  assert.throws(() => chars.reserve('agent -p "{prompt}"', "long"), /prompt allowance/);
  assert.equal(chars.calls, 0);
  now = 1001;
  assert.throws(() => chars.reserve('agent -p "{prompt}"', "x"), /time limit/);
  for (const invalid of ["NaN", "Infinity", "-1", "1.5", "0"]) assert.throws(() => positiveLimit(invalid, "test"));
});

test("quoted executable paths and prompts remain literal argv", () => {
  const text = 'fix "quotes"; $(touch no)\nnever a shell';
  assert.deepEqual(agentArgv('"C:\\Program Files\\agent.exe" -p "{prompt}"', text), ['C:\\Program Files\\agent.exe', "-p", text]);
  assert.throws(() => agentArgv('agent "{prompt}', text), /unclosed/);
});

test("dollar allocations cannot multiply across findings; unsupported providers fail before launching", () => {
  const b = new AgentBudget(".", { maxCalls: 3, maxSeconds: 5, maxPromptChars: 100, maxCostUsd: 1 });
  assert.throws(() => b.reserve('codex exec "{prompt}"', "fix"), /cannot enforce/);
  assert.equal(b.calls, 0);
  for (let i = 0; i < 3; i++) assert.ok(b.reserve('claude -p "{prompt}"', "fix").argv.includes("--max-budget-usd"));
  assert.ok(b.allocatedUsd <= 1);
  assert.throws(() => b.reserve('claude -p "{prompt}"', "fix"), /call limit/);
});

test("concurrent sessions are blocked, reservations persist, and a timed-out agent is stopped", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-budget-"));
  const b = new AgentBudget(repo, { maxCalls: 1, maxSeconds: 1, maxPromptChars: 100 });
  try {
    b.acquire();
    const other = new AgentBudget(repo, b.limits);
    assert.throws(() => other.acquire(), /another drive/);
    fs.writeFileSync(path.join(repo, "agent.cjs"), "setInterval(() => {}, 100);");
    const code = await runBudgetedAgent(repo, `"${process.execPath}" agent.cjs "{prompt}"`, "fix", b);
    assert.equal(code, -1);
    const usage = JSON.parse(fs.readFileSync(path.join(repo, ".pitstop", "agent-budget-latest.json"), "utf8"));
    assert.equal(usage.calls, 1);
    assert.equal(usage.actualCostUsd, null);
  } finally { b.release(); fs.rmSync(repo, { recursive: true, force: true }); }
});
