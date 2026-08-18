import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { runScan } from "./scan.js";
import { runPen } from "./pen.js";
import { runVerify } from "./verify.js";
import { gateOutcome, renderGateBox } from "./gate.js";
import { printNextCard, celebrateCard } from "./next.js";
import { brandBanner } from "../brand.js";

/**
 * `pitstop fix` — the one-command autopilot.
 *
 * Chains scan → pen --fix (writes failing-first repro tests + deterministic
 * patches, then `git apply`s the safe ones) → verify → gate, printing the
 * `pitstop next` card between hops so the user always sees where they are.
 * Every step writes a sealed `.pitstop/` artifact — the fix is evidenced, not
 * asserted. If the gate passes clean, it finishes with the celebration card.
 */
function applyPatches(repo: string): number {
  const dir = path.join(repo, ".pitstop", "pen-patches");
  if (!fs.existsSync(dir)) return 0;
  const diffs = fs.readdirSync(dir).filter((f) => f.endsWith(".diff"));
  let applied = 0;
  for (const d of diffs) {
    try {
      execFileSync("git", ["apply", "--whitespace=nowarn", path.join(dir, d)], {
        cwd: repo,
        stdio: "ignore",
      });
      applied++;
    } catch {
      /* leave for the agent / human to apply manually */
    }
  }
  return applied;
}

const SKIP = new Set(["node_modules", ".git", ".pitstop", "dist", "coverage", "build", ".next"]);

function countRepros(repo: string): number {
  let n = 0;
  const stack = [repo];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name === ".git" || SKIP.has(e.name)) continue;
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (/pitstop-repro-.*\.test\./.test(e.name)) n++;
    }
  }
  return n;
}

export const fix = new Command("fix")
  .description(
    "Autopilot: scan → pen --fix (applies safe patches) → verify → gate, with the next card driving " +
      "each hop. Fully evidenced — every step writes a sealed .pitstop/ artifact.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--score <n>", "gate threshold (default 60)", "60")
  .option("--no-apply", "write repro tests + patches but don't git apply them", false)
  .action(async (repoArg: string, options: { score?: string; apply?: boolean }) => {
    const repo = path.resolve(repoArg);
    const threshold = Math.max(0, Math.min(100, Math.floor(Number(options.score) || 60)));
    const apply = options.apply !== false;

    console.log(brandBanner());
    console.log(chalk.cyan.bold("\nAutopilot engaged — scan → pen --fix → verify → gate\n"));

    // 1/4 scan
    console.log(chalk.bold.cyan("1/4  Scanning baseline…"));
    const { result } = await runScan(repo, { reliabilityRuns: 1 });
    console.log(
      `    ${chalk.bold("Score")} ${result.security?.issues?.length ? chalk.yellow(result.security.issues.length + " security") : chalk.green("no security")} · ` +
        `${result.clusters?.length ?? 0} cluster(s) · ${result.tests?.failed ?? 0} failing test(s)`,
    );

    // 2/4 pen --fix
    console.log(chalk.bold.cyan("\n2/4  Pen-testing & writing fixes…"));
    await runPen(repo, { fix: true } as any);
    const penDir = path.join(repo, ".pitstop", "pen-patches");
    const patchCount = fs.existsSync(penDir)
      ? fs.readdirSync(penDir).filter((f) => f.endsWith(".diff")).length
      : 0;
    const reproCount = countRepros(repo);
    let applied = 0;
    if (apply) {
      applied = applyPatches(repo);
      console.log(
        `    wrote ${reproCount} repro test(s), ${patchCount} patch(es)` +
          (patchCount ? ` · git-applied ${applied}/${patchCount}` : ""),
      );
    } else {
      console.log(`    wrote ${reproCount} repro test(s), ${patchCount} patch(es) (--no-apply)`);
    }

    // 3/4 verify
    console.log(chalk.bold.cyan("\n3/4  Verifying the fix…"));
    const v = await runVerify(repo);
    if (v.missingBaseline) {
      console.log(chalk.yellow("    no baseline to verify against — run `pitstop scan` first."));
    } else {
      console.log(
        `    risk ${v.risk} · score ${v.currentScore.score}/100 (${v.currentScore.grade}) · integrity ${v.integrity.verdict}`,
      );
    }

    // 4/4 gate
    console.log(chalk.bold.cyan("\n4/4  Gating (score >= " + threshold + "/100)…"));
    if (v.missingBaseline) {
      console.log(chalk.yellow("    skipped — no baseline."));
    } else {
      const g = gateOutcome(v, threshold);
      console.log(renderGateBox(v, g, threshold));
    }

    // Finish: celebrate if clean, else hand off with the next card.
    const clean =
      !v.missingBaseline &&
      gateOutcome(v, threshold).pass &&
      (v.currentScore.score ?? 0) >= threshold &&
      v.risk !== "High";
    console.log("");
    if (clean) {
      await celebrateCard();
    } else {
      console.log(chalk.dim("Autopilot done for this pass — here's what's still open:\n"));
      await printNextCard(repo);
    }
  });

export default fix;
