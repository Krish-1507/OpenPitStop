import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { execa } from "execa";
import { loadScan, repro } from "../repro/index.js";
import { resolveFinding } from "../repro/ids.js";
import { loadPenLatest, resolvePenFinding } from "../pen/store.js";
import { runVerify } from "./verify.js";

/**
 * `pitstop drive <finding-id>` — hand a finding to YOUR agent, then verify.
 *
 * OpenPitStop never fixes your code itself (no magic auto-edits on a repo it does
 * not own). Instead: drive builds a precise mission prompt for the agent you
 * already trust (claude/codex/opencode/...), runs it, then runs `pitstop
 * verify` on the result and reports PASS/FAIL honestly.
 *
 * The agent command comes from --agent or PITSTOP_AGENT; `{prompt}` is where
 * the mission text is inserted, e.g.:
 *   pitstop drive security-abc123 --agent "claude -p \"{prompt}\""
 */

function missionPrompt(
  repo: string,
  finding: { id: string; source: string; severity: string; type: string; description: string; file?: string; line?: number },
  reproHint: string,
  fromPen: boolean,
): string {
  return [
    `You are fixing one specific OpenPitStop finding in the repo at ${repo}.`,
    ``,
    `Finding: ${finding.id} (${finding.source}/${finding.type}, severity ${finding.severity})`,
    `Description: ${finding.description}`,
    finding.file ? `Location: ${finding.file}${finding.line ? ":" + finding.line : ""}` : "",
    ``,
    `Work like this, in order, without skipping:`,
    `1. RUN the repro first: \`npx openpitstop repro ${finding.id}\`. It MUST FAIL (the bug is live).`,
    `   If it refuses or passes, STOP and re-read the finding — do not fix blind.`,
    reproHint,
    `2. Make the smallest fix that addresses the root cause. Do not refactor unrelated code.`,
    `3. Re-run the SAME repro: it must now PASS.`,
    fromPen
      ? `4. \`npx openpitstop verify\` is a static gate — for runtime pen findings the repro PASS is the real verdict;`
      : `4. Run \`npx openpitstop verify\` — it must come back clean (no regressions, integrity intact).`,
    `5. If anything regressed, revert the smallest unit and try again.`,
    ``,
    `Finish by reporting: what was wrong, what you changed, and the exact commands you ran.`,
  ].filter(Boolean).join("\n");
}

export const drive = new Command("drive")
  .description(
    "Hand a finding to YOUR own agent (claude/codex/opencode/...), then verify the result. " +
      "Mission: repro FAILS first → fix → repro PASSES → `pitstop verify` clean. OpenPitStop never auto-edits your code.",
  )
  .argument("<finding-id>", "finding id from scan-latest.json or pen-latest.json")
  .argument("[repo]", "path to the repo", ".")
  .option("--agent <cmd>", "agent command with {prompt} placeholder (or set PITSTOP_AGENT)")
  .action(
    async (findingId: string, repoArg: string, options: { agent?: string }) => {
      const repo = path.resolve(repoArg);

      const scan = loadScan(repo);
      const pen = loadPenLatest(repo);
      let finding: { id: string; source: string; severity: string; type: string; description: string; file?: string; line?: number } | null = null;
      let reproHint = "";
      let fromPen = false;

      const scanHit = scan ? resolveFinding(scan, findingId) : null;
      if (scanHit) {
        finding = {
          id: scanHit.id,
          source: scanHit.source,
          severity: scanHit.severity,
          type: scanHit.type,
          description: scanHit.description,
          file: scanHit.file,
          line: scanHit.line,
        };
        reproHint = `The repro generator exists for ${scanHit.source}/${scanHit.type} — use it as your contract.`;
      } else if (pen) {
        const pf = resolvePenFinding(pen, findingId);
        if (pf) {
          fromPen = true;
          finding = {
            id: pf.id,
            source: pf.source,
            severity: pf.severity,
            type: pf.type,
            description: pf.title,
            file: pf.file,
            line: pf.line,
          };
          reproHint = pf.attack
            ? `Replay the attack if needed: ${pf.attack.method} ${pf.attack.path}`
            : `This is a static observation — apply the fix guidance, then re-run \`npx openpitstop pen\` for this finding.`;
        }
      }

      if (!finding) {
        console.log(chalk.yellow(`\nfinding "${findingId}" not found in scan-latest.json or pen-latest.json\n`));
        return;
      }

      const agentCmd = options.agent ?? process.env.PITSTOP_AGENT ?? "";
      if (!agentCmd) {
        console.log(
          boxen(
            `pitstop drive ${findingId}\n\n` +
              `${chalk.yellow("no agent command configured")}\n\n` +
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

      const prompt = missionPrompt(repo, finding, reproHint, fromPen);
      const tokens = agentCmd.split(/\s+/).map((t) => (t.includes("{prompt}") ? prompt : t)).filter(Boolean);
      const [cmd, ...args] = tokens;
      const finalArgs = args.map((a) => a.replace("{prompt}", prompt));

      console.log(chalk.cyan(`\nDriving ${findingId} → ${cmd} (agent's own credits; OpenPitStop verifies the result)\n`));
      console.log(chalk.dim(prompt.split("\n").slice(0, 4).join("\n") + "\n"));

      let agentCode = -1;
      try {
        const sub = execa(cmd, finalArgs, {
          cwd: repo,
          stdout: "inherit",
          stderr: "inherit",
          reject: false,
          timeout: 30 * 60 * 1000,
          windowsHide: true,
        });
        agentCode = (await sub).exitCode ?? -1;
      } catch (err: any) {
        console.log(chalk.red(`agent could not be started: ${(err as Error).message}`));
        return;
      }

      console.log(chalk.dim(`\nagent exited with code ${agentCode} — verifying the result...\n`));

      if (fromPen) {
        const r = await repro(repo, findingId);
        const pass = r.status === "generated-and-ran" && r.ran?.passed === true;
        const paint = pass ? chalk.green : chalk.red;
        const why = pass
          ? "repro now PASSES — the runtime hypothesis is unproven, the fix holds."
          : r.status === "generated-and-ran"
            ? "repro still FAILS — the bug is live; the agent did not address it."
            : `repro could not run: ${r.reason ?? r.status}`;
        const v = await runVerify(repo);
        console.log(
          boxen(
            `${paint(pass ? "VERIFIED — repro now PASSES (bug addressed)" : "NOT VERIFIED — repro still FAILS (bug live)")}\n\n` +
              `${why}\n\n` +
              `test: ${r.file ?? "?"} · ${pass ? "PASS" : "FAIL"}\n` +
              `verify (static gate, context only): score ${v.currentScore.score}/100 (${v.currentScore.grade}) vs baseline ${v.baselineScore.score}/100 (${v.baselineScore.grade}) · delta ${v.scoreDelta >= 0 ? "+" : ""}${v.scoreDelta} · integrity ${v.integrity.verdict}`,
            {
              title: ` PITSTOP — Drive ${findingId} `,
              titleAlignment: "center",
              borderStyle: "round",
              padding: 1,
              borderColor: pass ? "green" : "red",
            },
          ),
        );
        process.exitCode = pass ? 0 : 1;
        return;
      }

      const v = await runVerify(repo);
      const paint = v.exitCode === 0 ? chalk.green : chalk.red;
      console.log(
        boxen(
          `${paint(v.exitCode === 0 ? "VERIFIED — pitstop verify is clean" : `NOT VERIFIED — pitstop verify exited ${v.exitCode}`)}\n\n` +
            `score: ${v.currentScore.score}/100 (${v.currentScore.grade}) vs baseline ${v.baselineScore.score}/100 (${v.baselineScore.grade}) · delta ${v.scoreDelta >= 0 ? "+" : ""}${v.scoreDelta}\n` +
            `integrity: ${v.integrity.verdict} · stale baseline: ${v.stale ? "yes" : "no"}\n` +
            (v.exitCode !== 0 ? `\nnext: \`pitstop verify\` shows the failing categories — drive it again or fix by hand.` : ""),
          {
            title: ` PITSTOP — Drive ${findingId} `,
            titleAlignment: "center",
            borderStyle: "round",
            padding: 1,
            borderColor: v.exitCode === 0 ? "green" : "red",
          },
        ),
      );
      process.exitCode = v.exitCode === 0 ? 0 : 1;
    },
  );

export default drive;
