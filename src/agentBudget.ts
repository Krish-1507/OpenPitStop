import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execa } from "execa";

export interface AgentLimits { maxCalls: number; maxSeconds: number; maxPromptChars: number; maxCostUsd?: number }
export const DEFAULT_AGENT_LIMITS: AgentLimits = { maxCalls: 3, maxSeconds: 600, maxPromptChars: 48000 };

export function positiveLimit(value: string | number, name: string, integer = true): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isSafeInteger(n))) throw new Error(`${name} must be a positive ${integer ? "integer" : "number"}`);
  return n;
}

/** Parse quoted argv; never interpret shell syntax or split the substituted prompt. */
export function agentArgv(command: string, prompt: string): string[] {
  const args: string[] = [];
  let token = "", quote = "", started = false;
  for (const ch of command) {
    if (quote) { if (ch === quote) quote = ""; else token += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { args.push(token); token = ""; started = false; } }
    else { token += ch; started = true; }
  }
  if (quote) throw new Error("agent command contains an unclosed quote");
  if (started) args.push(token);
  if (!args[0] || args[0].includes("{prompt}") || args.filter(a => a.includes("{prompt}")).length !== 1)
    throw new Error("agent command must contain exactly one {prompt} argument");
  return args.map(a => a.replace("{prompt}", prompt));
}

/** One shared allowance for ALL findings/rounds in a drive session. Reservations
 * happen before launch, including unsuccessful launches; they are never refunded. */
export class AgentBudget {
  readonly id = randomUUID();
  readonly startedAt: number;
  calls = 0;
  promptChars = 0;
  allocatedUsd = 0;
  private lock?: number;
  constructor(readonly repo: string, readonly limits: AgentLimits, private now = Date.now) {
    for (const [name, value] of Object.entries(limits)) if (value !== undefined) positiveLimit(value, name, name !== "maxCostUsd");
    this.startedAt = now();
  }
  remainingMs(): number { return Math.max(0, this.limits.maxSeconds * 1000 - (this.now() - this.startedAt)); }
  acquire(): void {
    if (process.env.PITSTOP_DRIVE_ACTIVE) throw new Error("nested drive is refused: the parent agent already has a shared budget");
    fs.mkdirSync(path.join(this.repo, ".pitstop"), { recursive: true });
    try { this.lock = fs.openSync(path.join(this.repo, ".pitstop", "drive.lock"), "wx"); }
    catch { throw new Error("another drive session holds .pitstop/drive.lock; inspect it before removing a stale lock"); }
    fs.writeFileSync(this.lock, JSON.stringify({ id: this.id, pid: process.pid, startedAt: this.startedAt }));
    this.save();
  }
  release(): void {
    if (this.lock === undefined) return;
    this.save();
    fs.closeSync(this.lock);
    this.lock = undefined;
    fs.unlinkSync(path.join(this.repo, ".pitstop", "drive.lock"));
  }
  reserve(command: string, prompt: string): { argv: string[]; timeoutMs: number } {
    const argv = agentArgv(command, prompt);
    if (this.calls >= this.limits.maxCalls) throw new Error("global agent call limit reached");
    const timeoutMs = this.remainingMs();
    if (!timeoutMs) throw new Error("global agent time limit reached");
    if (this.promptChars + prompt.length > this.limits.maxPromptChars) throw new Error("global agent prompt allowance exhausted");
    if (this.limits.maxCostUsd !== undefined) {
      const bin = path.basename(argv[0]).replace(/\.(exe|cmd)$/i, "").toLowerCase();
      if (bin !== "claude" || !argv.some(a => a === "-p" || a === "--print"))
        throw new Error("a dollar ceiling currently requires Claude CLI print mode; this provider cannot enforce it, so no agent was started");
      if (argv.some(a => a.startsWith("--max-budget-usd"))) throw new Error("set the dollar ceiling with Pitstop --max-cost-usd, not duplicate agent flags");
      const allocation = Math.floor(this.limits.maxCostUsd * 1e6 / this.limits.maxCalls) / 1e6;
      if (allocation <= 0) throw new Error("dollar ceiling is too small for this call allowance");
      argv.splice(1, 0, "--max-budget-usd", String(allocation));
      this.allocatedUsd += allocation;
    }
    this.calls++;
    this.promptChars += prompt.length;
    this.save();
    return { argv, timeoutMs };
  }
  private save(): void {
    if (this.lock === undefined) return;
    const usage = { id: this.id, startedAt: new Date(this.startedAt).toISOString(), limits: this.limits,
      calls: this.calls, promptChars: this.promptChars, elapsedMs: this.now() - this.startedAt,
      allocatedUsd: this.allocatedUsd, actualCostUsd: null, actualTokens: null };
    const dir = path.join(this.repo, ".pitstop");
    const tmp = path.join(dir, `agent-budget-${this.id}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(usage, null, 2));
    fs.renameSync(tmp, path.join(dir, "agent-budget-latest.json"));
  }
}

export async function runBudgetedAgent(repo: string, command: string, prompt: string, budget: AgentBudget): Promise<number> {
  const { argv: [bin, ...args], timeoutMs } = budget.reserve(command, prompt);
  if (budget.limits.maxCostUsd !== undefined) {
    const version = await execa(bin, ["--version"], { timeout: Math.min(timeoutMs, 5000), windowsHide: true });
    const match = version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    const parts = match?.slice(1).map(Number);
    if (!parts || !(parts[0] > 2 || (parts[0] === 2 && (parts[1] > 1 || (parts[1] === 1 && parts[2] >= 217)))))
      throw new Error("dollar ceilings require Claude CLI 2.1.217 or later for subagent budget enforcement");
  }
  if (!budget.remainingMs()) throw new Error("global agent time limit reached");
  const child = execa(bin, args, { cwd: repo, stdio: "inherit", reject: false, windowsHide: true,
    detached: process.platform !== "win32", env: { PITSTOP_DRIVE_ACTIVE: budget.id } });
  let timedOut = false;
  const kill = async () => {
    if (!child.pid) return;
    if (process.platform === "win32") await execa("taskkill", ["/pid", String(child.pid), "/T", "/F"], { reject: false, windowsHide: true }).catch(() => {});
    else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
  };
  const timer = setTimeout(() => { timedOut = true; void kill(); }, Math.min(timeoutMs, budget.remainingMs()));
  try { const result = await child; return timedOut ? -1 : result.exitCode ?? -1; }
  finally { clearTimeout(timer); await kill(); }
}
