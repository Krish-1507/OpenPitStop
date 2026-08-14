import fs from "node:fs";
import path from "node:path";
import { commandExists, detectLanguage, safeExecAsync } from "./util.js";
import { nonJsToolchainPresent, runNonJsSuite } from "./suiteRunner.js";
import type { TestsResult } from "./types.js";

export async function analyzeTests(repo: string): Promise<TestsResult> {
  const lang = detectLanguage(repo);
  const empty: TestsResult = {
    status: "skipped",
    note: "no test framework detected",
    total: 0,
    passed: 0,
    failed: 0,
    durationMs: 0,
  };

  if (lang === "go" || lang === "rust" || lang === "dart" || lang === "dotnet" || lang === "java") {
    if (!nonJsToolchainPresent(lang, repo)) {
      return { ...empty, note: `no ${lang} test toolchain found on PATH` };
    }
    const sr = await runNonJsSuite(repo);
    if (!sr) return { ...empty, note: `no tests discovered by the ${lang} runner` };
    if (sr.total === 0) {
      return {
        status: "error",
        note: sr.unparseable ?? "runner produced no results",
        total: 0,
        passed: 0,
        failed: 0,
        durationMs: sr.durationMs,
      };
    }
    return {
      status: "ok",
      framework: sr.framework,
      total: sr.total,
      passed: sr.passed,
      failed: sr.failed,
      durationMs: sr.durationMs,
    };
  }

  if (lang === "python") {
    if (!commandExists("pytest")) return empty;
    const start = performance.now();
    const r = await safeExecAsync("pytest", ["-q"], repo, 180000);
    const durationMs = Math.round(performance.now() - start);
    const m = r.stdout.match(/(\d+)\s+passed/);
    const failed = r.stdout.match(/(\d+)\s+failed/);
    const total = (m ? Number(m[1]) : 0) + (failed ? Number(failed[1]) : 0);
    return {
      status: "ok",
      framework: "pytest",
      total,
      passed: m ? Number(m[1]) : 0,
      failed: failed ? Number(failed[1]) : 0,
      durationMs,
    };
  }

  // JS/TS
  const pkgPath = path.join(repo, "package.json");
  let pkg: any = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      pkg = {};
    }
  }
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
  const hasJest =
    !!deps.jest ||
    fs.existsSync(path.join(repo, "jest.config.js")) ||
    fs.existsSync(path.join(repo, "jest.config.ts"));
  const hasVitest = !!deps.vitest || fs.existsSync(path.join(repo, "vitest.config.ts"));

  const hasBin = (name: string) =>
    commandExists(name) || fs.existsSync(path.join(repo, "node_modules", ".bin", name));

  if (hasJest && hasBin("jest")) {
    return runJest(repo);
  }
  if (hasVitest && hasBin("vitest")) {
    return runVitest(repo);
  }
  return empty;
}

function jestCommand(repo: string): { cmd: string; args: string[] } {
  const localCli = path.join(repo, "node_modules", "jest", "bin", "jest.js");
  if (fs.existsSync(localCli)) return { cmd: "node", args: [localCli] };
  if (commandExists("jest")) return { cmd: "jest", args: [] };
  return { cmd: "", args: [] };
}

async function runJest(repo: string): Promise<TestsResult> {
  const j = jestCommand(repo);
  if (!j.cmd) {
    return {
      status: "skipped",
      note: "jest not installed",
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: 0,
    };
  }
  const cacheDir = path.join(repo, ".pitstop", "cache", "jest");
  fs.mkdirSync(cacheDir, { recursive: true });
  const start = performance.now();
  const r = await safeExecAsync(
    j.cmd,
    [...j.args, "--json", "--coverage", "--coverageReporters=json-summary", "--cacheDirectory", cacheDir],
    repo,
    180000,
  );
  const durationMs = Math.round(performance.now() - start);
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    return {
      status: "error",
      note: "jest produced no JSON",
      framework: "jest",
      total: 0,
      passed: 0,
      failed: 0,
      durationMs,
    };
  }
  let coverage: number | undefined;
  const summary = path.join(repo, "coverage", "coverage-summary.json");
  if (fs.existsSync(summary)) {
    try {
      const c = JSON.parse(fs.readFileSync(summary, "utf8"));
      coverage = c.total?.lines?.pct;
    } catch {
      /* ignore */
    }
  }
  return {
    status: "ok",
    framework: "jest",
    total: json.numTotalTests ?? 0,
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests ?? 0,
    durationMs,
    coverage,
  };
}

function vitestCommand(repo: string): { cmd: string; args: string[] } {
  const localCli = path.join(repo, "node_modules", "vitest", "vitest.mjs");
  if (fs.existsSync(localCli)) return { cmd: "node", args: [localCli] };
  if (commandExists("vitest")) return { cmd: "vitest", args: [] };
  return { cmd: "", args: [] };
}

async function runVitest(repo: string): Promise<TestsResult> {
  const v = vitestCommand(repo);
  if (!v.cmd) {
    return {
      status: "skipped",
      note: "vitest not installed",
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: 0,
    };
  }
  const tmp = path.join(repo, ".pitstop", "vitest-report.json");
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const start = performance.now();
  const r = await safeExecAsync(
    v.cmd,
    [...v.args, "run", "--reporter=json", "--outputFile", tmp],
    repo,
    180000,
  );
  const durationMs = Math.round(performance.now() - start);
  let json: any;
  if (fs.existsSync(tmp)) {
    try {
      json = JSON.parse(fs.readFileSync(tmp, "utf8"));
    } catch {
      json = undefined;
    }
  }
  if (!json) {
    return {
      status: "error",
      note: "vitest produced no JSON",
      framework: "vitest",
      total: 0,
      passed: 0,
      failed: 0,
      durationMs,
    };
  }
  const files = json.testResults ?? [];
  let total = 0;
  let passed = 0;
  let failed = 0;
  for (const f of files) {
    total += f.assertionResults?.length ?? 0;
    for (const a of f.assertionResults ?? []) {
      if (a.status === "passed") passed++;
      else if (a.status === "failed") failed++;
    }
  }
  return {
    status: "ok",
    framework: "vitest",
    total,
    passed,
    failed,
    durationMs,
  };
}
