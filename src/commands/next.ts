import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import type { ScanResult, Cluster } from "../analyzers/types.js";
import { computeScore } from "../report/score.js";
import { brandBanner } from "../brand.js";

/**
 * `pitstop next` — the sticky-loop helper.
 *
 * Reads the sealed `.pitstop/` artifacts (the latest scan, plus signals that
 * pen / verify / repro have run) and prints, deterministically:
 *   1. the single best next `pitstop` command to run (with a why), and
 *   2. a "Pending before this repo is fully fixed" checklist — each item
 *      annotated with a rough effort estimate and, where possible, a
 *      `pitstop inspect <id>` deep-link to the exact finding.
 *
 * This is what the slash-command templates point the agent at after *any*
 * `pitstop` run, so the user always sees where they are and what to do next —
 * no guessing, no hallucinated suggestions.
 */

const SKIP_DIRS = new Set(["node_modules", ".git", ".pitstop", "dist", "coverage", "build", ".next"]);

/** Rough fix-time estimate (minutes) per vulnerability class. */
const EFFORT: Record<string, number> = {
  secret: 3,
  "sql-injection": 5,
  xss: 4,
  "command-injection": 5,
  cors: 2,
  authentication: 5,
  eval: 3,
  "path-traversal": 4,
  "data-exposure": 3,
  "rate-limiting": 2,
  logging: 2,
  dependency: 2,
  duplication: 3,
  accessibility: 3,
  circular: 6,
};

function effortMin(category?: string): number {
  if (!category) return 4;
  return EFFORT[category] ?? EFFORT[category.replace(/-/g, "").replace(/\s/g, "-")] ?? 4;
}

function walkFor(repo: string, re: RegExp, maxDepth = 4): boolean {
  const stack: [string, number][] = [[repo, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === ".git" || SKIP_DIRS.has(e.name)) continue;
      if (re.test(e.name)) return true;
      if (e.isDirectory() && depth < maxDepth) {
        stack.push([path.join(dir, e.name), depth + 1]);
      }
    }
  }
  return false;
}

function listDir(dir: string, re: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f));
}

function topClusterId(clusters: Cluster[] | undefined): string | undefined {
  if (!clusters || !clusters.length) return undefined;
  const rank = (s: string) => (s.toUpperCase() === "HIGH" ? 0 : s.toUpperCase() === "MEDIUM" ? 1 : 2);
  const sorted = [...clusters].sort((a, b) => rank(a.rootCause.severity) - rank(b.rootCause.severity));
  return sorted.find((c) => c.rootCause.id)?.rootCause.id;
}

export interface NextState {
  nextCommand: string;
  why: string;
  pending: string[];
  counts: Record<string, number>;
  fullyFixed: boolean;
  topId?: string;
}

export function computeNext(repo: string): NextState {
  const scanPath = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(scanPath)) {
    return {
      nextCommand: "pitstop scan",
      why: "no baseline yet — measure the repo so OpenPitStop knows what to fix",
      pending: ["establish a baseline with `pitstop scan`"],
      counts: {},
      fullyFixed: false,
    };
  }

  let scan: ScanResult;
  try {
    scan = JSON.parse(fs.readFileSync(scanPath, "utf8")) as ScanResult;
  } catch {
    return {
      nextCommand: "pitstop scan",
      why: "scan-latest.json is unreadable — re-run the scan to rebuild the baseline",
      pending: ["rebuild the baseline with `pitstop scan`"],
      counts: {},
      fullyFixed: false,
    };
  }

  const security = scan.security?.issues?.length ?? 0;
  const clusters = scan.clusters?.length ?? 0;
  const circular = scan.dependencyGraph?.circular?.length ?? 0;
  const testFailed = scan.tests?.failed ?? 0;
  const dup = scan.duplication?.cloneCount ?? 0;
  const a11y = scan.accessibility?.issues?.length ?? 0;
  const devex = scan.devex?.unusedExports?.length ?? 0;

  const penDone = fs.existsSync(path.join(repo, ".pitstop", "pen-latest.json"));
  const verifyDone = listDir(path.join(repo, ".pitstop"), /^verify-.*\.json$/).length > 0;
  const reproDone = walkFor(repo, /pitstop-repro-.*\.test\./);

  const openIssues =
    security > 0 || clusters > 0 || circular > 0 || testFailed > 0 || dup > 0 || a11y > 0 || devex > 0;

  const score = (() => {
    try {
      return computeScore(scan).score;
    } catch {
      return 0;
    }
  })();
  // "Fully fixed" means no open issues AND a healthy score — an empty repo
  // scores 0/100 with zero findings, which is not a clean bill of health.
  const fullyFixed = !openIssues && score >= 60;

  const topId =
    topClusterId(scan.clusters) ?? scan.security?.issues?.find((i) => i.id)?.id;
  const topCategory =
    scan.security?.issues?.find((i) => i.id)?.category ??
    scan.clusters?.[0]?.rootCause.type;

  let nextCommand: string;
  let why: string;

  const hasHigh = (scan.security?.issues ?? []).some(
    (i) => (i.severity ?? "").toUpperCase() === "HIGH" || (i.severity ?? "").toUpperCase() === "CRITICAL",
  );
  const needsFix = clusters > 0 || hasHigh;

  if (security > 0 && needsFix) {
    if (!penDone) {
      if (topId) {
        nextCommand = `pitstop drive ${topId}`;
        why = `a confirmed root cause (${topId}) is still unfixed — drive the agent to fix it with a tamper-evident mission`;
      } else {
        nextCommand = "pitstop pen --fix";
        why = "confirmed vulnerabilities exist — boot the app and write failing-first repro tests + safe patches";
      }
    } else if (!verifyDone) {
      nextCommand = "pitstop verify";
      why = "repro tests exist but the fix isn't verified against the sealed baseline yet";
    } else {
      nextCommand = "pitstop gate --score 60";
      why = "findings are driven + verified — lock the win with a one-number CI gate";
    }
  } else if (security > 0) {
    nextCommand = "pitstop gate --score 60";
    why = "only moderate/low advisories remain (no root-cause clusters) — lock the repo with a CI gate, then `pitstop report`";
  } else if (testFailed > 0) {
    if (!penDone) {
      nextCommand = "pitstop pen --fix";
      why = "tests are red — capture them as failing-first repro tests so a fix can't fake passing";
    } else if (!verifyDone) {
      nextCommand = "pitstop verify";
      why = "repro tests exist; verify them against the sealed baseline";
    } else {
      nextCommand = "pitstop gate --score 60";
      why = "tests captured + verified — add the CI gate";
    }
  } else {
    nextCommand = "pitstop gate --score 60";
    why = openIssues
      ? "non-security items remain — add the gate, then share the scorecard"
      : "repo looks clean — lock it with a CI gate and share the scorecard";
  }

  const pending: string[] = [];
  if (security > 0) {
    const est = effortMin(topCategory);
    const link = topId ? ` · inspect: \`pitstop inspect ${topId}\`` : "";
    pending.push(
      `${security} security finding(s) open (~${est} min)${link} — ${
        penDone ? (verifyDone ? "verified; add the gate" : "run `pitstop verify`") : "run `pitstop pen --fix` or `pitstop drive <id>`"
      }`,
    );
  }
  if (clusters > 0) {
    const id = topClusterId(scan.clusters);
    const link = id ? ` · \`pitstop inspect ${id}\`` : "";
    pending.push(`${clusters} root-cause cluster(s) to fix (~6 min)${link}`);
  }
  if (circular > 0) pending.push(`${circular} circular dependenc(ies) to break (~6 min)`);
  if (testFailed > 0) {
    pending.push(`${testFailed} failing test(s) to make pass (~5 min)${reproDone ? " (repro captured)" : ""}`);
  }
  if (dup > 0) pending.push(`${dup} duplicated block(s) to de-duplicate (~3 min)`);
  if (a11y > 0) pending.push(`${a11y} accessibility issue(s) to fix (~3 min)`);
  if (devex > 0) pending.push(`${devex} unused export(s) to clean (~2 min)`);
  if (!verifyDone && (penDone || security > 0 || testFailed > 0)) {
    pending.push("verification not run — `pitstop verify`");
  }
  if (pending.length === 0) {
    if (fullyFixed) pending.push("nothing open — repo is fully fixed ✓");
    else pending.push(`repo scores ${score}/100 — add real source and re-scan for a meaningful read`);
  }

  return {
    nextCommand,
    why,
    pending,
    counts: { security, clusters, circular, testFailed, dup, a11y, devex },
    fullyFixed,
    topId,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function celebrateCard(): Promise<void> {
  const canAnim = process.stdout.isTTY && !process.env.PITSTOP_NO_ANIM;
  if (canAnim) {
    const bar = ["▱▱▱▱▱▱▱▱", "▰▱▱▱▱▱▱▱", "▰▰▱▱▱▱▱▱", "▰▰▰▱▱▱▱▱", "▰▰▰▰▱▱▱▱", "▰▰▰▰▰▱▱▱", "▰▰▰▰▰▰▱▱", "▰▰▰▰▰▰▰▱", "▰▰▰▰▰▰▰▰"];
    for (const f of bar) {
      process.stdout.write(`\r  ${chalk.green.bold(f)} ${chalk.dim("verifying the fix…")}`);
      await sleep(110);
    }
    process.stdout.write("\r  " + " ".repeat(40) + "\r");
  }
  const body =
    brandBanner() +
    "\n\n" +
    chalk.green.bold("REPO FULLY FIXED") +
    "\n" +
    chalk.dim("Every number is backed by sealed evidence — no guessing, no faking.\n") +
    "\n" +
    chalk.bold("Share the win:") +
    "\n  " +
    chalk.cyan("pitstop report") +
    "   — shareable HTML/markdown scorecard\n  " +
    chalk.cyan("pitstop honesty") +
    "  — trace every figure to its evidence\n  " +
    chalk.cyan("pitstop gate --score 60") +
    " — lock it in CI / pre-commit";
  console.log(
    boxen(body, {
      title: " PITSTOP — DONE ",
      titleAlignment: "center",
      borderStyle: "double",
      padding: 1,
      borderColor: "green",
    }),
  );
}

export async function printNextCard(repo: string): Promise<void> {
  const s = computeNext(repo);
  if (s.fullyFixed) {
    await celebrateCard();
    return;
  }

  const pendingLines = s.pending.map((p) => chalk.yellow(`  ☐ ${p}`)).join("\n");
  const body =
    chalk.green(`▶ Next: `) +
    chalk.bold.cyan(s.nextCommand) +
    "\n" +
    chalk.dim(`  ${s.why}\n\n`) +
    chalk.bold("Pending before this repo is fully fixed:") +
    "\n" +
    pendingLines;

  console.log(
    boxen(body, {
      title: " PITSTOP — Next ",
      titleAlignment: "center",
      borderStyle: "round",
      padding: 1,
      borderColor: "cyan",
    }),
  );
  // Copy-paste "Run it" block — terminals/chat UIs that support fenced bash
  // render this as a one-click-runnable command.
  console.log(chalk.dim("Run it:") + "\n```bash\n" + s.nextCommand + "\n```");
}

export const nextCmd = new Command("next")
  .description(
    "Show the best next pitstop command to run and everything still pending before the repo is fully fixed. " +
      "Reads the sealed .pitstop/ artifacts — no guessing.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--json", "print machine-readable JSON")
  .action(async (repoArg: string, options: { json?: boolean }) => {
    const repo = path.resolve(repoArg);
    if (options.json) {
      console.log(JSON.stringify({ repo, ...computeNext(repo) }, null, 2));
      return;
    }
    await printNextCard(repo);
  });
