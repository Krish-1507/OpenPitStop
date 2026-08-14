import fs from "node:fs";
import path from "node:path";
import { commandExists, safeExecAsync, walkFiles, lineOf, detectLanguage } from "./util.js";
import { runNonJsSuite } from "./suiteRunner.js";
import type { FlakyTest, ReliabilityResult, ScanIssue } from "./types.js";

/** Only bother with flakiness detection when the suite is fast enough. */
const MAX_SUITE_MS = 60_000;
/**
 * Sequential runs; we deliberately run serially so runs perturb each other as
 * little as possible. 2 runs is the minimum that can detect a changed outcome;
 * pass a higher `runs` for a stronger signal (cost: N× suite time).
 */
const DEFAULT_RUNS = 2;
const MIN_RUNS_FOR_FLAKY = 2;
const MAX_FLAKY_REPORTED = 20;
const JS_EXTS = [".js", ".jsx", ".ts", ".tsx"];

/**
 * Reliability analysis.
 *
 * HONEST CAVEATS (heuristics, never certainty):
 *
 * - Flaky-test detection works by running the suite `runs` times IN SEQUENCE and
 *   flagging any test whose pass/fail changed between runs. Running the suite
 *   multiple times can itself perturb results (cache warm-up, shuffle order), and a
 *   genuinely flaky test may not flake within the runs executed — absence of a
 *   finding is NOT proof the suite is stable. We only run this when the suite is
 *   fast (<60s); a slow suite is skipped with a note. With `runs < 2` the flaky
 *   detector cannot run (it needs two observed outcomes), so only the race-smell
 *   heuristic is reported and the note says so.
 * - The race-condition "smells" (timer-based waits, module-scope mutable state
 *   reassigned near async code) are a cheap static grep. Every one of them is
 *   labeled "heuristic, needs human review". A smell is a hint to look, not an
 *   assertion that a bug exists.
 */
export async function analyzeReliability(
  repo: string,
  opts: { runs?: number } = {},
): Promise<ReliabilityResult> {
  const runsRequested = Math.max(1, Math.floor(opts.runs ?? DEFAULT_RUNS));
  const skipped = (note: string): ReliabilityResult => ({
    status: "skipped",
    note,
    runs: 0,
    durationMs: 0,
    flakyTests: [],
    raceSmells: [],
  });

  // Race-smell grep is independent of the test runner and always attempted.
  const raceSmells = scanRaceSmells(repo);

  const first = await runSuite(repo);
  if (!first) {
    // No runnable suite — but surface races if any were found.
    return raceSmells.length > 0
      ? {
          status: "ok",
          note: "no runnable test suite; race-smell heuristic only",
          runs: 0,
          durationMs: 0,
          flakyTests: [],
          raceSmells,
        }
      : skipped("no runnable test suite");
  }

  if (first.durationMs >= MAX_SUITE_MS) {
    return {
      status: raceSmells.length > 0 ? "ok" : "skipped",
      note: `test suite took ${first.durationMs}ms (>= 60s) — too slow to run ${runsRequested}x; only the race-smell heuristic ran`,
      runs: 1,
      durationMs: first.durationMs,
      suiteDurationMs: first.durationMs,
      flakyTests: [],
      raceSmells,
    };
  }

  // Flaky detection needs at least two observed outcomes per test.
  const runs = [first];
  for (let i = 1; i < runsRequested; i++) {
    const r = await runSuite(repo);
    if (r) runs.push(r);
  }

  let note: string | undefined;
  if (runs.length < MIN_RUNS_FOR_FLAKY) {
    note =
      "flaky detection needs >= 2 suite runs; runs=1 means only the race-smell heuristic was checked";
  } else if (raceSmells.length > 0 || detectFlaky(runs).length > 0) {
    note = "findings are heuristics — confirm each before acting";
  }
  const flakyTests = detectFlaky(runs);

  const totalDuration = runs.reduce((n, r) => n + r.durationMs, 0);

  return {
    status: "ok",
    note,
    runs: runs.length,
    durationMs: totalDuration,
    suiteDurationMs: first.durationMs,
    flakyTests,
    raceSmells,
  };
}

/* ------------------------------------------------------------------ */
/* Running the suite                                                   */
/* ------------------------------------------------------------------ */

interface RunResult {
  tests: { name: string; file?: string; status: "passed" | "failed" }[];
  passed: number;
  failed: number;
  durationMs: number;
}

function runSuite(repo: string): Promise<RunResult | null> {
  const lang = detectLanguage(repo);
  if (lang === "unknown") return Promise.resolve(null);

  if (lang === "python") return commandExists("pytest") ? runPytest(repo) : Promise.resolve(null);

  if (lang !== "js") {
    // Go/Rust/Flutter/.NET/Java: shared runner, per-test outcomes when the
    // runner exposes them (go -json, cargo json, flutter --machine), whole-suite
    // pseudo-test otherwise (dotnet/maven/gradle text/XML summaries).
    return runNonJsSuite(repo).then((sr) =>
      sr
        ? {
            tests: sr.tests,
            passed: sr.passed,
            failed: sr.failed,
            durationMs: sr.durationMs,
          }
        : null,
    );
  }

  if (!fs.existsSync(path.join(repo, "package.json"))) {
    return Promise.resolve(null);
  }
  let pkg: any = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasBin = (name: string) =>
    commandExists(name) || fs.existsSync(path.join(repo, "node_modules", ".bin", name));

  if (deps.jest && hasBin("jest")) return runJest(repo);
  if (deps.vitest && hasBin("vitest")) return runVitest(repo);
  if (commandExists("pytest")) return runPytest(repo);
  return Promise.resolve(null);
}

async function runJest(repo: string): Promise<RunResult | null> {
  let cmd: string;
  let args: string[];
  const local = path.join(repo, "node_modules", "jest", "bin", "jest.js");
  if (fs.existsSync(local)) {
    cmd = "node";
    args = [local];
  } else if (commandExists("jest")) {
    cmd = "jest";
    args = [];
  } else {
    return null;
  }
  const start = performance.now();
  const cacheDir = path.join(repo, ".pitstop", "cache", "jest");
  fs.mkdirSync(cacheDir, { recursive: true });
  const r = await safeExecAsync(cmd, [...args, "--json", "--cacheDirectory", cacheDir], repo, 180000);
  const durationMs = Math.round(performance.now() - start);
  // jest exits 0 on pass, 1 on failure — both are valid outputs.
  if (r.code !== 0 && r.code !== 1) return null;
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  const tests: RunResult["tests"] = [];
  for (const tr of json.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      tests.push({
        name: a.fullName ?? a.title ?? "",
        file: tr.name,
        status: a.status === "passed" ? "passed" : "failed",
      });
    }
  }
  return {
    tests,
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests ?? 0,
    durationMs,
  };
}

async function runVitest(repo: string): Promise<RunResult | null> {
  let cmd: string;
  let args: string[];
  const local = path.join(repo, "node_modules", "vitest", "vitest.mjs");
  if (fs.existsSync(local)) {
    cmd = "node";
    args = [local];
  } else if (commandExists("vitest")) {
    cmd = "vitest";
    args = [];
  } else {
    return null;
  }
  const tmp = path.join(repo, ".pitstop", "vitest-reliability.json");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const start = performance.now();
  await safeExecAsync(cmd, [...args, "run", "--reporter=json", "--outputFile", tmp], repo, 180000);
  const durationMs = Math.round(performance.now() - start);
  let json: any;
  if (fs.existsSync(tmp)) {
    try {
      json = JSON.parse(fs.readFileSync(tmp, "utf8"));
    } catch {
      json = undefined;
    }
  }
  if (!json) return null;
  const tests: RunResult["tests"] = [];
  for (const tr of json.testResults ?? []) {
    for (const a of tr.assertionResults ?? []) {
      tests.push({
        name: a.fullName ?? a.title ?? "",
        file: tr.name,
        status: a.status === "passed" ? "passed" : "failed",
      });
    }
  }
  return {
    tests,
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests ?? 0,
    durationMs,
  };
}

/**
 * pytest: `-q` only exposes per-suite counts, not per-test names. We model the
 * whole run as one pseudo-test so a changing pass/fail between runs still flags.
 */
async function runPytest(repo: string): Promise<RunResult | null> {
  const start = performance.now();
  const r = await safeExecAsync("pytest", ["-q", "--tb=no"], repo, 180000);
  const durationMs = Math.round(performance.now() - start);
  const passed = Number((r.stdout.match(/(\d+)\s+passed/) ?? [])[1] ?? 0);
  const failed = Number((r.stdout.match(/(\d+)\s+failed/) ?? [])[1] ?? 0);
  // Distinguish "no tests collected" from a real clean run.
  if (passed === 0 && failed === 0 && !/passed|failed/.test(r.stdout)) return null;
  const tests: RunResult["tests"] = [
    {
      name: failed > 0 ? "(pytest suite: failures)" : "(pytest suite)",
      status: failed > 0 ? "failed" : "passed",
    },
  ];
  return { tests, passed, failed, durationMs };
}

function detectFlaky(runs: RunResult[]): FlakyTest[] {
  const byKey = new Map<string, { name: string; file?: string; statuses: ("passed" | "failed")[] }>();
  for (const run of runs) {
    for (const t of run.tests) {
      const key = `${t.file ?? ""}::${t.name}`;
      if (!byKey.has(key)) {
        byKey.set(key, { name: t.name, file: t.file, statuses: [] });
      }
      byKey.get(key)!.statuses.push(t.status);
    }
  }
  const flaky: FlakyTest[] = [];
  for (const v of byKey.values()) {
    const distinct = new Set(v.statuses);
    if (v.statuses.length >= 2 && distinct.has("passed") && distinct.has("failed")) {
      flaky.push({ name: v.name, file: v.file, statuses: v.statuses });
    }
  }
  flaky.sort((a, b) => b.statuses.length - a.statuses.length);
  return flaky.slice(0, MAX_FLAKY_REPORTED);
}

/* ------------------------------------------------------------------ */
/* Race-condition smell heuristics (labeled, never certain)             */
/* ------------------------------------------------------------------ */

const TEST_FILE_RE =
  /(?:\.(?:test|spec)\.(?:js|jsx|ts|tsx)$)|(?:[\\/](?:__tests__|test|tests|spec)[\\/])/;

function scanRaceSmells(repo: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  for (const f of walkFiles(repo, JS_EXTS)) {
    let content: string;
    try {
      content = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(repo, f);
    if (TEST_FILE_RE.test(rel)) {
      issues.push(...timerSmells(content, f));
    } else {
      issues.push(...moduleStateSmells(content, f));
    }
  }
  return issues;
}

function timerSmells(content: string, file: string): ScanIssue[] {
  const out: ScanIssue[] = [];
  const re = /\b(?:setTimeout|setInterval)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({
      type: "race-condition",
      severity: "warning",
      file,
      line: lineOf(content, m.index),
      description:
        "test uses a timer-based wait (setTimeout/setInterval) — flaky-risk; prefer event- or poll-until helpers. heuristic, needs human review",
    });
  }
  return out;
}

/** Module-scope let/var at column 0 that is reassigned in a file with async code. */
function moduleStateSmells(content: string, file: string): ScanIssue[] {
  const out: ScanIssue[] = [];
  const declRe = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)/gm;
  let d: RegExpExecArray | null;
  while ((d = declRe.exec(content)) !== null) {
    const name = d[1];
    // Only flag when the module also has async/await or Promise usage nearby.
    if (!/\basync\b|\bawait\b|\bPromise\b/.test(content)) continue;
    const reassign = new RegExp(`\\b${name}\\s*=(?!=)`, "g");
    // Skip the declaration itself; look for a second assignment.
    const count = (content.match(reassign) ?? []).length;
    if (count > 1) {
      out.push({
        type: "race-condition",
        severity: "warning",
        file,
        line: lineOf(content, d.index),
        description:
          `module-level mutable state \`${name}\` is reassigned in a file that also has async code — ` +
          "may race across concurrent tasks. heuristic, needs human review",
      });
    }
  }
  return out;
}