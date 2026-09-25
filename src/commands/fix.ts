import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { runScan } from "./scan.js";
import { runPen, penExitCode } from "./pen.js";
import { persistPen } from "../pen/store.js";
import { runFixes, type PenFixOutcome } from "../pen/fix.js";
import { buildUnderstanding, sealUnderstanding, globMatches } from "../understand/index.js";
import { createPlan, loadLatestPlan, checkPlanScope } from "../verify/plan.js";
import { runFlow, renderFlowStages } from "../verify/flow.js";
import { renderGateMatrix } from "../verify/gateMatrix.js";
import { printNextCard } from "./next.js";

/** Only apply patches returned by THIS run, never old files in pen-patches/. */
export function applyCurrentPatches(repo: string, patches: PenFixOutcome["patches"]): { applied: number; refused: string[] } {
  const understanding = buildUnderstanding(repo);
  const plan = loadLatestPlan(repo);
  let applied = 0;
  const refused: string[] = [];
  for (const patch of patches) {
    const absolute = path.resolve(repo, patch.file);
    const relative = path.relative(repo, absolute).replace(/\\/g, "/");
    const sensitive = /(^|\/)(auth|authentication|deploy|infra|\.github)(\/|\.)|(^|\/)\.env|(^|\/)(package(-lock)?\.json|.*lock.*)$/i;
    const declared = [...(understanding.architecture.protected ?? []), ...(understanding.architecture.forbidden ?? [])];
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || sensitive.test(relative) || declared.some((r) => globMatches(r.path, relative))) {
      refused.push(`${patch.file}: protected, forbidden or outside the repository; review the patch manually`);
      continue;
    }
    if (!plan || plan.check.status !== "verified" || checkPlanScope(plan.plan, [relative]).unplanned.length) {
      refused.push(`${patch.file}: no trusted plan authorizes this path`);
      continue;
    }
    const diff = path.resolve(repo, patch.diffPath);
    const patchRoot = path.join(repo, ".pitstop", "pen-patches") + path.sep;
    if (!diff.startsWith(patchRoot)) { refused.push(`${patch.file}: patch outside generated patch directory`); continue; }
    try {
      execFileSync("git", ["apply", "--check", "--", diff], { cwd: repo, stdio: "pipe", windowsHide: true });
      execFileSync("git", ["apply", "--whitespace=nowarn", "--", diff], { cwd: repo, stdio: "pipe", windowsHide: true });
      applied++;
    } catch { refused.push(`${patch.file}: patch did not apply; left for manual review`); }
  }
  return { applied, refused };
}

export function fixExitCode(gateExit: number, securityExit: number, refused: number): number {
  return gateExit === 2 ? 2 : gateExit !== 0 || securityExit !== 0 || refused > 0 ? 1 : 0;
}

export const fix = new Command("fix")
  .description("Understand → scan → generate supported fixes → plan → apply → recheck security → verification stack and gate. No LLM calls.")
  .argument("[repo]", "path to the repo", ".")
  .option("--score <n>", "gate threshold from 0 to 100", "60")
  .option("--no-apply", "write repro tests and patches for review without applying source patches")
  .action(async (repoArg: string, options: { score: string; apply: boolean }) => {
    const repo = path.resolve(repoArg);
    const threshold = Number(options.score);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error("--score must be a number from 0 to 100");

    // Refuse to mix automatic edits into an existing change. No reset/stash/commit.
    if (options.apply) {
      let status: string;
      try {
        status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repo, encoding: "utf8", stdio: "pipe", windowsHide: true });
      } catch { throw new Error("Automatic patching needs a git repository. Use --no-apply to generate patches for review."); }
      if (status.trim()) throw new Error("Automatic patching needs a clean working tree. Commit or stash your changes yourself, or use --no-apply.");
      // Isolate patches from the current branch; never commit or push automatically.
      const branch = `pitstop/fix-${Date.now()}`;
      execFileSync("git", ["switch", "-c", branch], { cwd: repo, stdio: "pipe", windowsHide: true });
      console.log(chalk.dim(`Working on ${branch}`));
    }

    console.log(chalk.cyan("1/5  Understanding the repository and measuring the baseline…"));
    sealUnderstanding(repo, buildUnderstanding(repo));
    await runScan(repo, { reliabilityRuns: 1 });

    console.log(chalk.cyan("2/5  Testing security and generating supported repros and patches…"));
    const before = await runPen(repo, {});
    persistPen(repo, before);
    const fixes = runFixes(repo, before, before.packages);
    fs.writeFileSync(path.join(repo, "PITSTOP_PEN_FIXES.md"), fixes.fixesMd);

    const expected = [...new Set([...fixes.patches.map((p) => p.file), ...fixes.repros.map((r) => path.isAbsolute(r.file) ? path.relative(repo, r.file).replace(/\\/g, "/") : r.file), "PITSTOP_*.md", ".pitstop/**"])];
    if (!loadLatestPlan(repo)) {
      const plan = createPlan(repo, { id: `fix-${Date.now()}`, goal: "Apply supported security patches and independently recheck the result",
        steps: ["Generate repros and review patch scope", "Apply supported patches", "Re-run security and the verification stack"],
        expectedPaths: expected, verification: { commands: ["pitstop pen", "pitstop flow --require stack,architecture,security"] } });
      if ("error" in plan) throw new Error(plan.error);
    }

    console.log(chalk.cyan(`3/5  ${options.apply ? "Applying planned patches" : "Keeping patches for review"}…`));
    const applied = options.apply ? applyCurrentPatches(repo, fixes.patches) : { applied: 0, refused: [] };
    console.log(`${fixes.repros.length} repro(s), ${fixes.patches.length} patch(es), ${applied.applied} applied.`);
    for (const refusal of applied.refused) console.log(chalk.yellow(refusal));

    console.log(chalk.cyan("4/5  Rechecking security after the change…"));
    const after = applied.applied > 0 ? await runPen(repo, {}) : before;
    if (after !== before) persistPen(repo, after);

    console.log(chalk.cyan("5/5  Running tests, types, lint, build, architecture and the evidence gate…"));
    const flow = await runFlow({ repo, threshold, planScope: true, require: ["stack", "architecture", "security"] });
    console.log(renderFlowStages(flow.stages));
    console.log(renderGateMatrix(flow.decision));
    process.exitCode = fixExitCode(flow.gateExit, penExitCode(after), applied.refused.length);
    console.log(chalk.bold(`Result: ${flow.verdict}. ${process.exitCode === 0 ? "Configured checks passed; review the evidence and remaining findings." : "Open issues remain; do not ship this state."}`));
    await printNextCard(repo);
  });

export default fix;
