import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import type { ScanResult, Cluster, ScanIssue } from "../analyzers/types.js";
import { computeScore } from "../report/score.js";
import { brandBanner } from "../brand.js";

/**
 * `pitstop next` — the sticky-loop helper.
 *
 * Reads the sealed `.pitstop/` artifacts (the latest scan, plus signals that
 * pen / verify / repro have run) and prints, deterministically:
 *   1. the single best next `pitstop` command to run (with a why), and
 *   2. a repo-aware, prioritized **remediation plan** — every command the user
 *      should run, in order, to get the repo fully fixed, and
 *   3. a "Pending before this repo is fully fixed" checklist.
 *
 * The recommendation is *not* random: it inspects the actual repo (language,
 * package manager, frameworks, test runner, CI, env files) from the filesystem
 * and from the scan, then maps each real finding to the exact command that
 * solves it — with a rationale that references this repo's stack.
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

/** Vulnerability classes that have a reproducible runtime exploit path. */
const REPROABLE = [
  "sql-injection",
  "xss",
  "command-injection",
  "path-traversal",
  "authentication",
  "authorization",
  "csrf",
  "idor",
  "ssrf",
  "prototype-pollution",
  "eval",
  "code-injection",
  "rate-limiting",
  "data-exposure",
];

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

/** Findings the user has already driven to a verified fix (so we don't re-recommend them). */
function loadDriven(repo: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(repo, ".pitstop", "driven.json"), "utf8");
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function topClusterId(clusters: Cluster[] | undefined): string | undefined {
  if (!clusters || !clusters.length) return undefined;
  const rank = (s: string) => (s.toUpperCase() === "HIGH" ? 0 : s.toUpperCase() === "MEDIUM" ? 1 : 2);
  const sorted = [...clusters].sort((a, b) => rank(a.rootCause.severity) - rank(b.rootCause.severity));
  return sorted.find((c) => c.rootCause.id)?.rootCause.id;
}

/* ------------------------------------------------------------------ */
/* Repo-context detection — what kind of repo are we actually in?      */
/* ------------------------------------------------------------------ */

export interface RepoContext {
  language: string;
  packageManager?: string;
  frameworks: string[];
  testFramework?: string;
  hasCI: boolean;
  hasEnv: boolean;
  isWeb: boolean;
  isApi: boolean;
  stackSummary: string;
}

function readJSON(p: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inspect the working tree (not just the scan) so the recommendation is accurate
 * for *this* repo — language, package manager, frameworks, test runner, CI, env.
 */
export function detectRepoContext(repo: string): RepoContext {
  const ctx: RepoContext = {
    language: "",
    frameworks: [],
    hasCI: false,
    hasEnv: false,
    isWeb: false,
    isApi: false,
    stackSummary: "unknown stack",
  };

  const pkg = readJSON(path.join(repo, "package.json"));
  if (pkg && typeof pkg === "object") {
    ctx.language = "JavaScript/TypeScript";
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    const has = (...names: string[]) => names.some((n) => deps[n] !== undefined);
    const add = (...names: string[]) => ctx.frameworks.push(...names);

    if (has("next")) add("Next.js");
    if (has("react")) add("React");
    if (has("vue")) add("Vue");
    if (has("@angular/core")) add("Angular");
    if (has("nuxt")) add("Nuxt");
    if (has("svelte") || has("@sveltejs/kit")) add("Svelte");
    if (has("express")) add("Express"), (ctx.isApi = true);
    if (has("fastify")) add("Fastify"), (ctx.isApi = true);
    if (has("koa")) add("Koa"), (ctx.isApi = true);
    if (has("@nestjs/core")) add("NestJS"), (ctx.isApi = true);
    if (has("hapi")) add("Hapi"), (ctx.isApi = true);
    if (has("@remix-run/react")) add("Remix"), (ctx.isWeb = true);
    if (has("react") || has("vue") || has("next") || has("nuxt") || has("svelte") || has("@angular/core"))
      ctx.isWeb = true;

    if (has("jest")) ctx.testFramework = "Jest";
    else if (has("vitest")) ctx.testFramework = "Vitest";
    else if (has("mocha")) ctx.testFramework = "Mocha";
    else if (has("@playwright/test") || has("cypress")) ctx.testFramework = "Playwright/Cypress (e2e)";

    // Package manager from the lockfile actually present.
    if (exists(path.join(repo, "package-lock.json"))) ctx.packageManager = "npm";
    else if (exists(path.join(repo, "yarn.lock"))) ctx.packageManager = "Yarn";
    else if (exists(path.join(repo, "pnpm-lock.yaml"))) ctx.packageManager = "pnpm";
    else if (exists(path.join(repo, "bun.lockb")) || exists(path.join(repo, "bun.lock")))
      ctx.packageManager = "Bun";
    else ctx.packageManager = "npm";
  }

  if (exists(path.join(repo, "requirements.txt")) || exists(path.join(repo, "pyproject.toml")) || exists(path.join(repo, "setup.py"))) {
    ctx.language = ctx.language ? `${ctx.language} + Python` : "Python";
    const req = readJSON(path.join(repo, "requirements.txt")); // usually not JSON, returns null
    const reqTxt = req ? "" : safeRead(path.join(repo, "requirements.txt"));
    if (/django/i.test(reqTxt ?? "")) ctx.frameworks.push("Django"), (ctx.isWeb = true), (ctx.isApi = true);
    if (/flask/i.test(reqTxt ?? "")) ctx.frameworks.push("Flask"), (ctx.isApi = true);
    if (/fastapi/i.test(reqTxt ?? "")) ctx.frameworks.push("FastAPI"), (ctx.isApi = true);
    if (/pytest/i.test(reqTxt ?? "")) ctx.testFramework = "pytest";
    ctx.packageManager = ctx.packageManager ?? "pip";
  }

  if (exists(path.join(repo, "Gemfile"))) {
    ctx.language = ctx.language ? `${ctx.language} + Ruby` : "Ruby";
    ctx.frameworks.push("Rails");
    ctx.isWeb = true;
    ctx.isApi = true;
    ctx.packageManager = ctx.packageManager ?? "bundler";
  }
  if (exists(path.join(repo, "go.mod"))) {
    ctx.language = ctx.language ? `${ctx.language} + Go` : "Go";
    ctx.packageManager = ctx.packageManager ?? "go mod";
  }
  if (exists(path.join(repo, "Cargo.toml"))) {
    ctx.language = ctx.language ? `${ctx.language} + Rust` : "Rust";
    ctx.packageManager = ctx.packageManager ?? "cargo";
  }
  if (exists(path.join(repo, "pom.xml")) || exists(path.join(repo, "build.gradle"))) {
    ctx.language = ctx.language ? `${ctx.language} + Java` : "Java";
    ctx.packageManager = ctx.packageManager ?? "maven/gradle";
  }
  if (exists(path.join(repo, "composer.json"))) {
    ctx.language = ctx.language ? `${ctx.language} + PHP` : "PHP";
    ctx.packageManager = ctx.packageManager ?? "composer";
  }

  ctx.hasCI =
    exists(path.join(repo, ".github", "workflows")) ||
    exists(path.join(repo, ".gitlab-ci.yml")) ||
    exists(path.join(repo, ".circleci")) ||
    exists(path.join(repo, "Jenkinsfile")) ||
    exists(path.join(repo, "azure-pipelines.yml")) ||
    exists(path.join(repo, "bitbucket-pipelines.yml"));

  ctx.hasEnv = walkFor(repo, /^\.env(\..+)?$/, 2);

  const parts: string[] = [];
  if (ctx.language) parts.push(ctx.language);
  if (ctx.packageManager && ctx.packageManager !== "npm") parts.push(`(${ctx.packageManager})`);
  if (ctx.frameworks.length) parts.push("· " + ctx.frameworks.join(" + "));
  ctx.stackSummary = parts.length ? parts.join(" ") : "unknown stack";
  return ctx;
}

function safeRead(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */

export interface PlanStep {
  command: string;
  why: string;
  priority: number;
  findingId?: string;
}

const P_BASELINE = 0;
const P_DRIVE = 10;
const P_PEN = 20;
const P_LOCKFILE = 25;
const P_VERIFY = 40;
const P_GATE = 50;
const P_REPORT = 60;

function catOf(i: ScanIssue): string {
  return ((i.category ?? i.type ?? "") + "").toLowerCase();
}

function locOf(repo: string, i: ScanIssue): string {
  if (!i.file) return "";
  const rel = path.relative(repo, i.file) || i.file;
  return `${rel}${i.line ? ":" + i.line : ""}`;
}

function buildPlan(
  repo: string,
  scan: ScanResult,
  ctx: RepoContext,
  signals: { penDone: boolean; verifyDone: boolean },
  driven: Set<string>,
): PlanStep[] {
  const steps: PlanStep[] = [];

  const add = (s: PlanStep) => {
    const dup = steps.find((x) => x.command === s.command);
    if (dup) {
      if (s.priority < dup.priority) dup.priority = s.priority;
      if (!dup.why.includes(s.why)) dup.why = `${dup.why} ${s.why}`;
      return;
    }
    steps.push(s);
  };

  const entry = ctx.isApi ? "reachable through the API" : ctx.isWeb ? "rendered to users" : "in the affected module";
  const reach = ctx.hasEnv ? `${entry} (and secrets live in .env here)` : entry;

  // Individual security findings, highest severity first.
  const issues = [...(scan.security?.issues ?? [])];
  const sevRank = (s: string) =>
    s.toUpperCase() === "CRITICAL" ? 0 : s.toUpperCase() === "HIGH" ? 1 : s.toUpperCase() === "MEDIUM" ? 2 : 3;
  issues.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  let staticFindings = 0;
  for (const i of issues) {
    if (!i.id || driven.has(i.id)) continue;
    const cat = catOf(i);
    const loc = locOf(repo, i);
    const reproable = REPROABLE.some((c) => cat.includes(c));
    if (reproable) {
      add({
        command: `pitstop drive ${i.id}`,
        priority: P_DRIVE,
        findingId: i.id,
        why:
          `${ctx.stackSummary}: the ${cat || i.type} at ${loc || "this repo"} is a confirmed, exploitable root cause (${reach}). ` +
          `Drive the agent to fix it behind a failing-first repro so the patch can't be faked.`,
      });
    } else {
      // Non-runtime findings (secrets, misconfig) aren't reproducible — they get a
      // single consolidated note on the verify step rather than N noisy steps.
      staticFindings++;
    }
  }

  // Root-cause clusters (shared root cause behind several symptoms).
  for (const c of scan.clusters ?? []) {
    const id = c.rootCause.id;
    if (!id || driven.has(id)) continue;
    add({
      command: `pitstop drive ${id}`,
      priority: P_DRIVE,
      findingId: id,
      why:
        `${ctx.stackSummary}: root-cause cluster "${c.rootCause.description}" (${c.symptoms.length} symptom(s) across ` +
        `${c.sharedFiles.length} file(s)). Drive the agent to fix the shared root cause once.`,
    });
  }

  // Red tests → capture them as failing-first repro so a fix can't fake green.
  if ((scan.tests?.failed ?? 0) > 0) {
    if (!signals.penDone) {
      add({
        command: `pitstop pen --fix`,
        priority: P_PEN,
        why: `${ctx.stackSummary}: ${scan.tests!.failed} test(s) are red — capture them as failing-first repro tests before fixing.`,
      });
    }
  }

  // Accessibility → capture a repro + apply the fix.
  if ((scan.accessibility?.issues?.length ?? 0) > 0 && !signals.penDone) {
    add({
      command: `pitstop pen --fix`,
      priority: P_PEN,
      why: `${ctx.stackSummary}: ${scan.accessibility!.issues!.length} accessibility issue(s) — capture a repro and apply the fix.`,
    });
  }

  // Proactive catch: if the static scan found no security issues and no red tests,
  // adversarially red-team the running app to surface runtime bugs the static
  // analyzers cannot see (authz bypasses, race conditions, logic flaws).
  if (
    (scan.security?.issues?.length ?? 0) === 0 &&
    (scan.tests?.failed ?? 0) === 0 &&
    !signals.penDone
  ) {
    add({
      command: `pitstop pen`,
      priority: P_PEN,
      why: `${ctx.stackSummary}: no static issues caught — adversarially red-team the app with pitstop pen to find runtime/authorization bugs the scan can't see.`,
    });
  }

  // Dependency / circular / orphan graph problems → supply-chain hardening.
  const circular = scan.dependencyGraph?.circular?.length ?? 0;
  const orphans = scan.dependencyGraph?.orphans?.length ?? 0;
  const depAdvisory = (scan.security?.issues ?? []).some((i) => catOf(i).includes("dependency"));
  if (circular > 0 || orphans > 0 || depAdvisory) {
    add({
      command: `pitstop lockfile`,
      priority: P_LOCKFILE,
      why:
        `${ctx.packageManager ?? "dependency"} supply-chain: ` +
        (circular ? `${circular} circular dependenc(ies), ` : "") +
        (orphans ? `${orphans} orphan(s), ` : "") +
        (depAdvisory ? "an open dependency advisory, " : "") +
        `break cycles and verify lockfile integrity with pitstop lockfile.`,
    });
  }

  // Always: prove the fix is real, then lock it in, then share.
  if (!signals.verifyDone) {
    add({
      command: `pitstop verify`,
      priority: P_VERIFY,
      why:
        `prove the fix is real against the sealed baseline (PoVF + proof coverage) — no vibes.` +
        (staticFindings > 0
          ? ` Also resolve ${staticFindings} non-runtime finding(s) (e.g. rotate any exposed secret, fix misconfig).`
          : ""),
    });
  }
  add({
    command: `pitstop gate --score 60`,
    priority: P_GATE,
    why: `lock the win with a one-number CI / pre-commit gate at score 60.`,
  });
  add({
    command: `pitstop report`,
    priority: P_REPORT,
    why: `share the scorecard (HTML/MD) with sealed evidence.`,
  });

  steps.sort((a, b) => a.priority - b.priority);
  return steps;
}

function buildDonePlan(ctx: RepoContext): PlanStep[] {
  return [
    {
      command: `pitstop report`,
      priority: P_REPORT,
      why: `repo is clean (${ctx.stackSummary}) — share the scorecard with sealed evidence.`,
    },
    { command: `pitstop honesty`, priority: P_REPORT + 1, why: `trace every figure back to its evidence.` },
    { command: `pitstop share`, priority: P_REPORT + 2, why: `export a tamper-evident proof artifact.` },
  ];
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface NextState {
  nextCommand: string;
  why: string;
  pending: string[];
  counts: Record<string, number>;
  fullyFixed: boolean;
  topId?: string;
  plan: PlanStep[];
  repoContext: RepoContext;
  confidence: "high" | "medium" | "low";
}

export function computeNext(repo: string): NextState {
  const scanPath = path.join(repo, ".pitstop", "scan-latest.json");
  const baselineState = (why: string, pending: string[]): NextState => ({
    nextCommand: "pitstop scan",
    why,
    pending,
    counts: {},
    fullyFixed: false,
    plan: [{ command: "pitstop scan", priority: P_BASELINE, why }],
    repoContext: detectRepoContext(repo),
    confidence: "low",
  });

  if (!fs.existsSync(scanPath)) {
    return baselineState(
      "no baseline yet — measure the repo so OpenPitStop knows what to fix",
      ["establish a baseline with `pitstop scan`"],
    );
  }

  let scan: ScanResult;
  try {
    scan = JSON.parse(fs.readFileSync(scanPath, "utf8")) as ScanResult;
  } catch {
    return baselineState(
      "scan-latest.json is unreadable — re-run the scan to rebuild the baseline",
      ["rebuild the baseline with `pitstop scan`"],
    );
  }

  const ctx = detectRepoContext(repo);

  const driven = loadDriven(repo);
  const security =
    (scan.security?.issues ?? []).filter((i) => i.id && !driven.has(i.id)).length;
  const clusters = (scan.clusters ?? []).filter((c) => c.rootCause.id && !driven.has(c.rootCause.id)).length;
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
  const fullyFixed = !openIssues && score >= 60;

  const topId =
    topClusterId(scan.clusters?.filter((c) => c.rootCause.id && !driven.has(c.rootCause.id))) ??
    scan.security?.issues?.find((i) => i.id && !driven.has(i.id))?.id;
  const topCategory =
    scan.security?.issues?.find((i) => i.id)?.category ?? scan.clusters?.[0]?.rootCause.type;

  let plan: PlanStep[];
  let nextCommand: string;
  let why: string;

  if (!openIssues) {
    if (fullyFixed) {
      plan = buildDonePlan(ctx);
      nextCommand = plan[0].command;
      why = plan[0].why;
    } else {
      // No findings but score < 60 → essentially an empty repo. Re-scan with real source.
      plan = [
        {
          command: "pitstop scan",
          priority: P_BASELINE,
          why: `repo is empty — add real source and re-scan for a meaningful read (score is ${score}/100 with zero findings, which is not a clean bill of health).`,
        },
      ];
      nextCommand = "pitstop scan";
      why = plan[0].why;
    }
  } else {
    plan = buildPlan(repo, scan, ctx, { penDone, verifyDone }, driven);
    nextCommand = plan[0]?.command ?? "pitstop scan";
    why = plan[0]?.why ?? "run the next step in the plan below";
  }

  const pending: string[] = [];
  if (security > 0) {
    const est = effortMin(topCategory);
    const link = topId ? ` · inspect: \`pitstop inspect ${topId}\`` : "";
    const nextForSec = plan.find((s) => s.findingId === topId)?.command ?? "pitstop pen --fix";
    pending.push(
      `${security} security finding(s) open (~${est} min)${link} — next: \`${nextForSec}\``,
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
    else pending.push(`no open findings but repo scores ${score}/100 — add real source and re-scan`);
  }

  const confidence: NextState["confidence"] =
    plan.length <= 1 ? "high" : plan.length <= 3 ? "medium" : "medium";

  return {
    nextCommand,
    why,
    pending,
    counts: { security, clusters, circular, testFailed, dup, a11y, devex },
    fullyFixed,
    topId,
    plan,
    repoContext: ctx,
    confidence,
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

function renderPlan(plan: PlanStep[], current = 0): string {
  return plan
    .map((s, i) => {
      const marker = i === current ? chalk.green.bold("▶") : chalk.dim("•");
      const cmd = i === current ? chalk.bold.cyan(s.command) : chalk.cyan(s.command);
      return `  ${marker} ${cmd}\n     ${chalk.dim(s.why)}`;
    })
    .join("\n");
}

export async function printNextCard(repo: string): Promise<void> {
  const s = computeNext(repo);
  if (s.fullyFixed) {
    await celebrateCard();
    return;
  }

  const idx = Math.max(0, s.plan.findIndex((p) => p.command === s.nextCommand));
  const planBlock = s.plan.length > 1 ? "\n\n" + chalk.bold("Full remediation plan:") + "\n" + renderPlan(s.plan, idx) : "";

  const pendingLines = s.pending.map((p) => chalk.yellow(`  ☐ ${p}`)).join("\n");
  const body =
    chalk.green(`▶ Next: `) +
    chalk.bold.cyan(s.nextCommand) +
    "\n" +
    chalk.dim(`  ${s.why}\n\n`) +
    chalk.bold("Pending before this repo is fully fixed:") +
    "\n" +
    pendingLines +
    planBlock +
    (s.repoContext.stackSummary !== "unknown stack"
      ? "\n\n" + chalk.dim(`repo: ${s.repoContext.stackSummary} · CI: ${s.repoContext.hasCI ? "yes" : "no"} · secrets in .env: ${s.repoContext.hasEnv ? "yes" : "no"}`)
      : "");

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
    "Show the best next pitstop command, a repo-aware remediation plan, and everything still pending. " +
      "Reads the sealed .pitstop/ artifacts — no guessing.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--plan", "print only the ordered remediation plan")
  .option("--json", "print machine-readable JSON")
  .action(async (repoArg: string, options: { plan?: boolean; json?: boolean }) => {
    const repo = path.resolve(repoArg);
    const s = computeNext(repo);
    if (options.json) {
      console.log(JSON.stringify({ repo, ...s }, null, 2));
      return;
    }
    if (options.plan) {
      console.log(renderPlan(s.plan, Math.max(0, s.plan.findIndex((p) => p.command === s.nextCommand))));
      return;
    }
    await printNextCard(repo);
  });
