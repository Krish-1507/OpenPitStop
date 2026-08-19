import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { execSync } from "node:child_process";
import { loadScan, repro } from "../repro/index.js";
import { resolveFinding, findingIdFor, ledgerFindingId } from "../repro/ids.js";
import { loadPenLatest, resolvePenFinding } from "../pen/store.js";
import { analyzeSecurity } from "../analyzers/security.js";
import { analyzeAccessibility } from "../analyzers/accessibility.js";
import { analyzeDevex } from "../analyzers/devex.js";
import { analyzeDuplication } from "../analyzers/duplication.js";
import { analyzeReliability } from "../analyzers/reliability.js";
import { runLedgerAnalyzer } from "../analyzers/ledger/index.js";
import { runVerify } from "./verify.js";
import { computeNext, celebrateCard, printNextCard } from "./next.js";
import type { ScanIssue } from "../analyzers/types.js";

/**
 * `pitstop drive <finding-id>` — hand a finding to YOUR agent, then verify.
 *
 * OpenPitStop never fixes your code itself (no magic auto-edits on a repo it does
 * not own). Instead: drive builds a precise mission prompt for the agent you
 * already trust (claude/codex/opencode/...), runs it, then checks the result with
 * a hard acceptance gate (a failing-first repro that now PASSES, or a clean
 * `pitstop verify`) and reports PASS/FAIL honestly.
 *
 * **Loop Engineering:** `drive` does not stop after one attempt. It loops — each
 * failed attempt feeds the verify/repro failure back into the next mission — until
 * the finding is *verified* solved or `--max-attempts` is exhausted. With no
 * finding id, `pitstop drive` drives the whole repo: it repeatedly runs the next
 * command from `pitstop next` until the repo is fully fixed.
 *
 * The agent command comes from --agent or PITSTOP_AGENT; `{prompt}` is where the
 * mission text is inserted, e.g. `pitstop drive id --agent "claude -p \"{prompt}\""`.
 */

const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));

/**
 * Auto-detect a usable agent so `/pitstop-drive` works without manual setup.
 * Falls back to PITSTOP_AGENT, then probes common CLIs (claude, codex, opencode,
 * aider, gemini) for one that exists on PATH.
 */
function commandExists(bin: string): boolean {
  try {
    if (process.platform === "win32") execSync(`where ${bin}`, { stdio: "ignore" });
    else execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const AGENT_CANDIDATES: { bin: string; cmd: string }[] = [
  { bin: "claude", cmd: 'claude -p "{prompt}"' },
  { bin: "codex", cmd: 'codex exec -- "{prompt}"' },
  { bin: "opencode", cmd: 'opencode run "{prompt}"' },
  { bin: "aider", cmd: 'aider --message "{prompt}"' },
  { bin: "gemini", cmd: 'gemini -p "{prompt}"' },
];

function resolveAgentCmd(provided?: string): { cmd: string; detected?: string } {
  if (provided) return { cmd: provided };
  const env = process.env.PITSTOP_AGENT;
  if (env) return { cmd: env };
  for (const c of AGENT_CANDIDATES) {
    if (commandExists(c.bin)) return { cmd: c.cmd, detected: c.bin };
  }
  return { cmd: "" };
}

/**
 * Re-run the analyzer that owns `finding`'s source and confirm the finding id is
 * gone. Returns true (present), false (confirmed absent), or null (no applicable
 * analyzer — fall back to the repro gate). This is what lets `drive` verify fixes
 * for a11y / devex / security findings, not just runtime repro-able ones.
 */
async function freshScanStillHas(repo: string, finding: Finding): Promise<boolean | null> {
  try {
    if (finding.source === "security") {
      const r = await analyzeSecurity(repo);
      return (r.issues ?? []).some((i) => findingIdFor("security", i.type, i.file, i.description) === finding.id);
    }
    if (finding.source === "a11y") {
      const r = analyzeAccessibility(repo);
      return (r.issues ?? []).some((i) => findingIdFor("a11y", i.type, i.file, i.description) === finding.id);
    }
    if (finding.source === "devex") {
      const r = analyzeDevex(repo);
      return (r.unusedExports ?? []).some((i) => findingIdFor("devex", i.type, i.file, i.description) === finding.id);
    }
    if (finding.source === "duplication") {
      const r = analyzeDuplication(repo);
      return (r.clones ?? []).some(
        (c) => findingIdFor("duplication", "duplication", c.files[0], `${c.lines}`) === finding.id,
      );
    }
    if (finding.source === "reliability") {
      // runs:1 keeps the acceptance re-check cheap; race-smell greps still run.
      const r = await analyzeReliability(repo, { runs: 1 });
      const flaky = (r.flakyTests ?? []).some((f) => findingIdFor("reliability", "flaky-test", f.file, f.name) === finding.id);
      const race = (r.raceSmells ?? []).some(
        (i) => findingIdFor("reliability", "race-condition", i.file, i.description) === finding.id,
      );
      return flaky || race;
    }
    if (finding.source === "ledger") {
      // Ledger analysis boots the app and fires live traffic — only re-run it when the
      // user already opted in via `pitstop scan --ledger` (a ledger baseline exists).
      const base = loadScan(repo);
      if (!base?.ledger?.evidence?.length) return null;
      const r = await runLedgerAnalyzer(repo);
      return (r.evidence ?? []).some((e) => ledgerFindingId(e) === finding.id);
    }
  } catch {
    return null;
  }
  return null;
}

const DRIVEN_PATH = (repo: string) => path.join(repo, ".pitstop", "driven.json");

function loadDriven(repo: string): Set<string> {
  try {
    const raw = fs.readFileSync(DRIVEN_PATH(repo), "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function markDriven(repo: string, id: string): void {
  const set = loadDriven(repo);
  set.add(id);
  fs.mkdirSync(path.dirname(DRIVEN_PATH(repo)), { recursive: true });
  fs.writeFileSync(DRIVEN_PATH(repo), JSON.stringify([...set], null, 2));
}

type Finding = {
  id: string;
  source: string;
  severity: string;
  type: string;
  description: string;
  file?: string;
  line?: number;
  fix?: string;
  category?: string;
};

function missionPrompt(
  repo: string,
  finding: Finding,
  reproHint: string,
  fromPen: boolean,
  loop?: { attempt: number; maxAttempts: number; lastFailure?: string },
): string {
  const loopSection = loop
    ? `
## Loop context (attempt ${loop.attempt} of ${loop.maxAttempts})
${
  loop.lastFailure
    ? `The previous attempt did NOT pass the acceptance gate:\n  ${loop.lastFailure}\nRe-read that evidence. Do NOT repeat the same change — try a different minimal fix that addresses the actual root cause.`
    : `This is the first attempt.`
}
`
    : "";

  return [
    `You are fixing one specific OpenPitStop finding in the repo at ${repo}.`,
    ``,
    `Finding: ${finding.id} (${finding.source}/${finding.type}, severity ${finding.severity})`,
    `Description: ${finding.description}`,
    finding.category ? `Category: ${finding.category}` : "",
    finding.fix ? `Recommended fix: ${finding.fix}` : "",
    finding.file ? `Location: ${finding.file}${finding.line ? ":" + finding.line : ""}` : "",
    loopSection,
    ``,
    `## Loop Engineering Principles (follow on EVERY attempt)`,
    `- Repro-first: RUN the repro first — \`npx openpitstop repro ${finding.id}\` MUST FAIL (the bug is live) before you change anything. If it passes/refuses, STOP and re-read the finding; do not fix blind.`,
    `- Minimal: change the smallest unit that addresses the root cause. No unrelated refactors.`,
    `- Verify-each-iteration: after each change, re-run the SAME repro; it must now PASS.`,
    `- No faking: never claim success without a passing repro or a clean \`pitstop verify\`.`,
    `- Revert-on-regression: if you caused a regression, revert the smallest unit and try a different minimal fix.`,
    `- Stop ONLY when the acceptance gate below is green.`,
    ``,
    `Work in this exact order:`,
    `1. RUN the repro first: \`npx openpitstop repro ${finding.id}\`. It MUST FAIL.`,
    reproHint,
    `2. Make the smallest fix that addresses the root cause. Do not refactor unrelated code.`,
    `3. Re-run the SAME repro: it must now PASS.`,
    fromPen
      ? `4. For runtime pen findings the repro PASS is the real verdict; \`npx openpitstop verify\` is a static gate for context.`
      : `4. Run \`npx openpitstop verify\` — it must come back clean (no regressions, integrity intact).`,
    `5. If anything regressed, revert the smallest unit and try again.`,
    ``,
    `Finish by reporting: what was wrong, what you changed, and the exact commands you ran.`,
  ]
    .filter(Boolean)
    .join("\n");
}

async function runAgent(repo: string, agentCmd: string, prompt: string): Promise<number> {
  const tokens = agentCmd.split(/\s+/).map((t) => (t.includes("{prompt}") ? prompt : t)).filter(Boolean);
  const [cmd, ...args] = tokens;
  const finalArgs = args.map((a) => a.replace("{prompt}", prompt));
  try {
    const sub = execa(cmd, finalArgs, {
      cwd: repo,
      stdout: "inherit",
      stderr: "inherit",
      reject: false,
      timeout: 30 * 60 * 1000,
      windowsHide: true,
    });
    return (await sub).exitCode ?? -1;
  } catch (err: any) {
    console.log(chalk.red(`agent could not be started: ${(err as Error).message}`));
    return -1;
  }
}

interface DriveResult {
  solved: boolean;
  attempts: number;
  lastFailure?: string;
  trajectory: string[];
}

/**
 * Loop the agent + acceptance gate on a single finding until it is verified solved
 * or attempts run out. Each failed attempt's evidence is fed back into the next
 * mission so the agent converges instead of repeating itself.
 */
async function loopDriveFinding(
  repo: string,
  finding: Finding,
  fromPen: boolean,
  reproHint: string,
  agentCmd: string,
  maxAttempts: number,
): Promise<DriveResult> {
  const trajectory: string[] = [];
  let lastFailure: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      chalk.cyan(
        `\n[attempt ${attempt}/${maxAttempts}] driving ${finding.id} → agent (its own credits; OpenPitStop verifies)\n`,
      ),
    );
    const prompt = missionPrompt(repo, finding, reproHint, fromPen, { attempt, maxAttempts, lastFailure });
    const agentCode = await runAgent(repo, agentCmd, prompt);

    // Acceptance gate: the bug must actually be gone, not merely "no regression".
    //  1) a failing-first repro that now PASSES (gold standard), or
    //  2) the owning analyzer's fresh re-scan no longer contains this finding id.
    const r = await repro(repo, finding.id);
    const ran = r.status === "generated-and-ran";
    const reproPassed = ran && r.ran?.passed === true;

    const still = await freshScanStillHas(repo, finding);
    const freshScanGone = still === false; // confirmed absent by the relevant analyzer

    let accepted = reproPassed || freshScanGone;
    if (accepted) {
      trajectory.push(`attempt ${attempt}: agent exited ${agentCode} → ACCEPTED (${reproPassed ? "repro PASSES" : "finding gone from re-scan"})`);
      markDriven(repo, finding.id);
      return { solved: true, attempts: attempt, trajectory };
    }

    const v = await runVerify(repo);
    const stillTxt =
      still === null ? "re-scan n/a for this source" : still ? "finding still present in re-scan" : "finding gone from re-scan";
    lastFailure =
      `repro ${ran ? (r.ran?.passed ? "passed" : "still FAILS") : "unavailable (" + (r.reason ?? r.status) + ")"}${still ? "; " + stillTxt : ""}` +
      ` · pitstop verify exited ${v.exitCode} (risk ${v.risk}, integrity ${v.integrity.verdict})`;
    trajectory.push(`attempt ${attempt}: agent exited ${agentCode} → ${lastFailure}`);
    console.log(chalk.yellow(`  ${lastFailure}\n  feeding evidence back into the next attempt…\n`));
  }
  return { solved: false, attempts: maxAttempts, lastFailure, trajectory };
}

function resolveById(
  repo: string,
  findingId: string,
): { finding: Finding; fromPen: boolean; reproHint: string } | null {
  const scan = loadScan(repo);
  const pen = loadPenLatest(repo);
  if (scan) {
    const hit = resolveFinding(scan, findingId);
    if (hit) {
      return {
        finding: {
          id: hit.id,
          source: hit.source,
          severity: hit.severity,
          type: hit.type,
          description: hit.description,
          file: hit.file,
          line: hit.line,
          fix: (hit.data as ScanIssue | undefined)?.fix,
          category: (hit.data as ScanIssue | undefined)?.category,
        },
        fromPen: false,
        reproHint: `The repro generator exists for ${hit.source}/${hit.type} — use it as your contract.`,
      };
    }
  }
  if (pen) {
    const pf = resolvePenFinding(pen, findingId);
    if (pf) {
      return {
        finding: {
          id: pf.id,
          source: pf.source,
          severity: pf.severity,
          type: pf.type,
          description: pf.title,
          file: pf.file,
          line: pf.line,
        },
        fromPen: true,
        reproHint: pf.attack
          ? `Replay the attack if needed: ${pf.attack.method} ${pf.attack.path}`
          : `This is a static observation — apply the fix guidance, then re-run \`npx openpitstop pen\` for this finding.`,
      };
    }
  }
  return null;
}

async function runPitstop(repo: string, args: string[]): Promise<number> {
  try {
    const sub = execa(process.execPath, [cliPath, ...args], {
      cwd: repo,
      stdout: "inherit",
      stderr: "inherit",
      reject: false,
      timeout: 30 * 60 * 1000,
      windowsHide: true,
    });
    return (await sub).exitCode ?? -1;
  } catch (err: any) {
    console.log(chalk.red(`pitstop could not be started: ${(err as Error).message}`));
    return -1;
  }
}

/**
 * No-id mode: drive the entire repo to fully-fixed. Repeatedly run the next command
 * from `pitstop next`, looping each `pitstop drive <id>` until verified, until the
 * repo is fully fixed or the round cap is hit.
 */
async function driveRepoLoop(repo: string, agentCmd: string, maxAttempts: number): Promise<boolean> {
  const MAX_ROUNDS = 24;
  const paint = (ok: boolean) => (ok ? chalk.green : chalk.red);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const s = computeNext(repo);
    if (s.fullyFixed) {
      await celebrateCard();
      return true;
    }
    const actionable = s.plan.filter(
      (p) =>
        p.command.startsWith("pitstop drive") ||
        p.command.startsWith("pitstop pen") ||
        p.command.startsWith("pitstop lockfile"),
    );
    if (actionable.length === 0) {
      // Only verify/gate/report remain — refresh the baseline so the score reflects
      // the fixes, then re-evaluate (avoids acting on a stale scan).
      console.log(chalk.cyan(`\n[round ${round + 1}] no fixable steps left in plan — refreshing baseline (pitstop scan)…\n`));
      await runPitstop(repo, ["scan", repo]);
      const s2 = computeNext(repo);
      if (s2.fullyFixed) {
        await celebrateCard();
        return true;
      }
      const stillNoFix = s2.plan.every(
        (p) =>
          !p.command.startsWith("pitstop drive") &&
          !p.command.startsWith("pitstop pen") &&
          !p.command.startsWith("pitstop lockfile"),
      );
      if (stillNoFix) {
        console.log(chalk.yellow(`\nNo auto-fixable steps remain — running verify, then handing back to you.\n`));
        await runPitstop(repo, ["verify", repo]);
        await printNextCard(repo);
        return false;
      }
      continue;
    }

    const step = actionable[0];
    if (step.command.startsWith("pitstop drive")) {
      const id = step.findingId ?? step.command.split(/\s+/)[2];
      if (!id) continue;
      const resolved = resolveById(repo, id);
      if (!resolved) {
        console.log(chalk.yellow(`finding "${id}" not found — skipping.\n`));
        markDriven(repo, id);
        continue;
      }
      const res = await loopDriveFinding(repo, resolved.finding, resolved.fromPen, resolved.reproHint, agentCmd, maxAttempts);
      const ok = res.solved;
      console.log(
        boxen(
          `${paint(ok)("DRIVE " + (ok ? "SOLVED" : "NOT SOLVED"))} — ${resolved.finding.id}\n\n` +
            res.trajectory.map((t) => `  ${t}`).join("\n") +
            (ok ? "" : `\n\nnext: re-run \`pitstop drive ${resolved.finding.id}\` or fix by hand.`),
          {
            title: ` PITSTOP — Drive ${resolved.finding.id} `,
            titleAlignment: "center",
            borderStyle: "round",
            padding: 1,
            borderColor: ok ? "green" : "red",
          },
        ),
      );
      if (!ok) {
        process.exitCode = 1;
        return false;
      }
    } else if (step.command.startsWith("pitstop pen")) {
      console.log(chalk.cyan(`\n[round ${round + 1}] ${step.command}\n`));
      await runPitstop(repo, ["pen", "--fix", repo]);
    } else if (step.command.startsWith("pitstop lockfile")) {
      console.log(chalk.cyan(`\n[round ${round + 1}] ${step.command}\n`));
      await runPitstop(repo, ["lockfile", repo]);
    }
  }
  console.log(chalk.yellow(`\nReached round cap without a fully-fixed repo — review the remaining plan:\n`));
  await printNextCard(repo);
  return false;
}

export const drive = new Command("drive")
  .description(
    "Hand a finding to YOUR own agent (claude/codex/opencode/...), then VERIFY in a loop until it's actually solved. " +
      "With no id, drives the whole repo to fully-fixed. OpenPitStop never auto-edits your code.",
  )
  .argument("[finding-id]", "finding id from scan-latest.json or pen-latest.json (omit to drive the whole repo)")
  .argument("[repo]", "path to the repo", ".")
  .option("--agent <cmd>", "agent command with {prompt} placeholder (or set PITSTOP_AGENT)")
  .option("--max-attempts <n>", "max drive loop attempts per finding", "5")
  .action(
    async (
      findingId: string | undefined,
      repoArg: string,
      options: { agent?: string; maxAttempts?: string },
    ) => {
      const repo = path.resolve(repoArg);
      const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts) || 5));
      const agent = resolveAgentCmd(options.agent);
      const agentCmd = agent.cmd;

      if (!agentCmd) {
        console.log(
          boxen(
            `pitstop drive${findingId ? " " + findingId : ""}\n\n` +
              `${chalk.yellow("no agent command configured")}\n\n` +
              `OpenPitStop auto-looked for claude / codex / opencode / aider / gemini on your PATH and found none.\n` +
              `Pass one with --agent (use {prompt} as the placeholder) or export PITSTOP_AGENT.\n\n` +
              `Examples:\n` +
              `  --agent 'claude -p "{prompt}"'\n` +
              `  --agent 'codex exec -- "{prompt}"'\n` +
              `  --agent 'opencode run "{prompt}"'`,
            {
              title: " PITSTOP — Drive ",
              titleAlignment: "center",
              borderStyle: "round",
              padding: 1,
              borderColor: "yellow",
            },
          ),
        );
        return;
      }
      if (agent.detected) console.log(chalk.dim(`(auto-detected agent: ${agent.detected})\n`));

      // No id → drive the whole repo to fully-fixed.
      if (!findingId) {
        const ok = await driveRepoLoop(repo, agentCmd, maxAttempts);
        process.exitCode = ok ? 0 : 1;
        return;
      }

      const resolved = resolveById(repo, findingId);
      if (!resolved) {
        console.log(chalk.yellow(`\nfinding "${findingId}" not found in scan-latest.json or pen-latest.json\n`));
        return;
      }

      const res = await loopDriveFinding(
        repo,
        resolved.finding,
        resolved.fromPen,
        resolved.reproHint,
        agentCmd,
        maxAttempts,
      );
      const ok = res.solved;
      const paint = ok ? chalk.green : chalk.red;
      console.log(
        boxen(
          `${paint(ok ? "VERIFIED — finding solved" : "NOT VERIFIED — finding still live")}\n\n` +
            res.trajectory.map((t) => `  ${t}`).join("\n") +
            (ok
              ? "\n\nthe repro now passes (or verify is clean) — the fix holds."
              : `\n\nnext: re-run \`pitstop drive ${findingId}\` (it loops) or fix by hand.`),
          {
            title: ` PITSTOP — Drive ${findingId} `,
            titleAlignment: "center",
            borderStyle: "round",
            padding: 1,
            borderColor: ok ? "green" : "red",
          },
        ),
      );
      process.exitCode = ok ? 0 : 1;
    },
  );

export default drive;
