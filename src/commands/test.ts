import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import { Command } from "commander";
import { safeExecAsync, commandExists, detectLanguage } from "../analyzers/util.js";

export interface TestLayerSpec {
  layer: "unit" | "integration" | "e2e";
  runner: string;
  script?: string;
  cmd?: string;
  args?: string[];
}

export interface LayerRun {
  layer: string;
  runner: string;
  status: "ok" | "failed" | "skipped" | "error";
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  note?: string;
  failing: string[];
}

const LAYER_ORDER: Record<string, number> = { unit: 0, integration: 1, e2e: 2 };

/**
 * Discover the three layers of the test pyramid, the way a senior dev would:
 * npm scripts first (least surprising), then well-known runners and configs.
 * Every layer reports why it was discovered (or not) — nothing is assumed.
 */
export function discoverTestLayers(repo: string): TestLayerSpec[] {
  const layers: TestLayerSpec[] = [];
  let pkg: Record<string, any> = {};
  const pkgPath = path.join(repo, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      pkg = {};
    }
  }
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, string>;
  const binExists = (n: string) =>
    commandExists(n) || fs.existsSync(path.join(repo, "node_modules", ".bin", n));
  const has = (...parts: string[]) => fs.existsSync(path.join(repo, ...parts));
  const firstScript = (names: string[]) => names.find((n) => typeof scripts[n] === "string");

  const unitScript = firstScript(["test", "test:unit", "unit"]);
  if (unitScript) {
    layers.push({ layer: "unit", script: unitScript, runner: `npm script (${unitScript})` });
  } else if (deps.vitest && binExists("vitest")) {
    layers.push({ layer: "unit", runner: "vitest", cmd: "vitest", args: ["run"] });
  } else if (deps.jest && binExists("jest")) {
    layers.push({ layer: "unit", runner: "jest", cmd: "jest", args: ["--ci"] });
  } else if (deps.mocha && binExists("mocha")) {
    layers.push({ layer: "unit", runner: "mocha", cmd: "mocha", args: [] });
  }

  const itScript = firstScript(["test:integration", "test:it", "integration"]);
  if (itScript) {
    layers.push({ layer: "integration", script: itScript, runner: `npm script (${itScript})` });
  } else {
    const itDir = has("tests", "integration")
      ? "tests/integration"
      : has("test", "integration")
        ? "test/integration"
        : has("__tests__", "integration")
          ? "__tests__/integration"
          : null;
    if (itDir && deps.vitest && binExists("vitest")) {
      layers.push({ layer: "integration", runner: `vitest (${itDir})`, cmd: "vitest", args: ["run", itDir] });
    } else if (itDir && deps.jest && binExists("jest")) {
      layers.push({ layer: "integration", runner: `jest (${itDir})`, cmd: "jest", args: [itDir, "--ci"] });
    }
  }

  const e2eScript = firstScript(["test:e2e", "test:e2e:ci", "e2e", "test:playwright", "test:cypress"]);
  if (e2eScript) {
    layers.push({ layer: "e2e", script: e2eScript, runner: `npm script (${e2eScript})` });
  } else if (
    deps.playwright ||
    has("playwright.config.ts") ||
    has("playwright.config.js") ||
    has("playwright.config.mjs")
  ) {
    layers.push({ layer: "e2e", runner: "playwright", cmd: "npx", args: ["playwright", "test"] });
  } else if (
    deps.cypress ||
    has("cypress.config.ts") ||
    has("cypress.config.js") ||
    has("cypress.config.mjs")
  ) {
    layers.push({ layer: "e2e", runner: "cypress", cmd: "npx", args: ["cypress", "run"] });
  }

  const lang = detectLanguage(repo);
  if (lang === "python" && commandExists("pytest")) {
    if (!layers.some((l) => l.layer === "unit")) {
      layers.push({ layer: "unit", runner: "pytest", cmd: "pytest", args: ["-q"] });
    }
    const pyIt = has("tests", "integration") ? "tests/integration" : has("test", "integration") ? "test/integration" : null;
    if (pyIt && !layers.some((l) => l.layer === "integration")) {
      layers.push({ layer: "integration", runner: `pytest (${pyIt})`, cmd: "pytest", args: [pyIt, "-q"] });
    }
    const pyE2e = has("tests", "e2e") ? "tests/e2e" : has("e2e") ? "e2e" : null;
    if (pyE2e && !layers.some((l) => l.layer === "e2e")) {
      layers.push({ layer: "e2e", runner: `pytest (${pyE2e})`, cmd: "pytest", args: [pyE2e, "-q"] });
    }
  }

  return layers.sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);
}

function lastCount(out: string, re: RegExp): number | null {
  const all = [...out.matchAll(re)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

/**
 * Parse test counts out of any runner's text output. Prefers the summary
 * lines node:test/jest/vitest/pytest/mocha/cypress/playwright all print in
 * some form; returns zeros when nothing parses so the caller stays honest
 * ("runner exited 0, counts unparsed") instead of inventing numbers.
 */
export function parseTestCounts(out: string): { passed: number; failed: number; total: number } {
  const passHash = lastCount(out, /^\s*#\s*pass\s+(\d+)\s*$/gm);
  const failHash = lastCount(out, /^\s*#\s*fail\s+(\d+)\s*$/gm);
  const passed =
    passHash ??
    lastCount(out, /(\d+)\s+passed/g) ??
    lastCount(out, /(\d+)\s+passing/g) ??
    0;
  const failed =
    failHash ??
    lastCount(out, /(\d+)\s+failed/g) ??
    lastCount(out, /(\d+)\s+failing/g) ??
    0;
  return { passed, failed, total: passed + failed };
}

/** Pull the names of failing tests out of runner output (first ~10). */
export function failingTestNames(out: string, limit = 10): string[] {
  const names: string[] = [];
  for (const raw of out.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const isFailureLine =
      /^[✕×✗✘✖]/.test(t) ||
      /^(?:FAIL|✖)\b/.test(t) ||
      /^not\s+ok\b/.test(t) ||
      /^\d+\)\s+[A-Za-z]/.test(t) ||
      /\b(?:failed|failing)\s*[:\-]/.test(t);
    if (!isFailureLine) continue;
    const clean = t
      .replace(/^not\s+ok\s+\d+\s*-\s*/, "")
      .replace(/^\d+\)\s*/, "")
      .slice(0, 140);
    if (clean.length > 3 && !names.includes(clean)) names.push(clean);
    if (names.length >= limit) break;
  }
  return names;
}

export async function runTestLayer(
  repo: string,
  spec: TestLayerSpec,
  timeoutMs = 300000,
): Promise<LayerRun> {
  const start = performance.now();
  let code = -1;
  let out = "";
  // Node's test runner refuses to run when NODE_TEST_CONTEXT is set to
  // ANYTHING (even "") — it checks !== undefined. Remove it so a `pitstop test`
  // invoked from inside another test run still executes real suites.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NODE_TEST_CONTEXT: undefined,
  };
  try {
    const r = spec.cmd
      ? await safeExecAsync(spec.cmd, spec.args ?? [], repo, timeoutMs, childEnv)
      : await safeExecAsync("npm", ["run", spec.script ?? "", "--silent"], repo, timeoutMs, childEnv);
    code = r.code;
    out = `${r.stdout}\n${r.stderr}`;
  } catch (err: any) {
    return {
      layer: spec.layer,
      runner: spec.runner,
      status: "error",
      total: 0,
      passed: 0,
      failed: 0,
      durationMs: Math.round(performance.now() - start),
      note: `runner failed to start: ${err?.message ?? String(err)}`,
      failing: [],
    };
  }
  const durationMs = Math.round(performance.now() - start);
  const counts = parseTestCounts(out);
  const failing = failingTestNames(out);
  const status: "ok" | "failed" = code === 0 ? "ok" : "failed";
  if (counts.total === 0) {
    return {
      layer: spec.layer,
      runner: spec.runner,
      status,
      total: 0,
      passed: 0,
      failed: 0,
      durationMs,
      note:
        code === 0
          ? "runner exited 0 — test counts unparsed"
          : `runner exited ${code} — test counts unparsed`,
      failing,
    };
  }
  return {
    layer: spec.layer,
    runner: spec.runner,
    status,
    total: counts.total,
    passed: counts.passed,
    failed: counts.failed,
    durationMs,
    failing,
  };
}

function label(text: string): string {
  return chalk.bold(chalk.cyan(text.padEnd(14)));
}

export function renderTestPyramid(runs: LayerRun[], repo: string): string {
  const lines: string[] = [];
  for (const r of runs) {
    const duration = r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`;
    if (r.status === "ok") {
      lines.push(
        `${label(r.layer)}: ${chalk.green(`${r.passed} pass`)} · ${chalk.dim(`${r.failed} fail`)} · ${chalk.dim(duration)} (${r.runner})`,
      );
    } else if (r.status === "failed") {
      lines.push(
        `${label(r.layer)}: ${chalk.red(`${r.failed} fail`)} · ${chalk.dim(`${r.passed} pass · ${duration}`)} (${r.runner})`,
      );
    } else if (r.status === "error") {
      lines.push(`${label(r.layer)}: ${chalk.yellow("error")} — ${chalk.dim(r.note ?? "runner failed")}`);
    } else {
      lines.push(`${label(r.layer)}: ${chalk.yellow(`skipped — ${r.note ?? "no suite discovered"}`)}`);
    }
  }
  const seenNames = new Set<string>();
  const failing: string[] = [];
  for (const r of runs) {
    for (const f of r.failing) {
      if (seenNames.has(f)) continue;
      seenNames.add(f);
      failing.push(`    ${chalk.red("✕")} ${f}`);
    }
  }
  if (failing.length) {
    lines.push("", chalk.bold("Failing tests — fix these, then re-run:"));
    lines.push(...failing);
  }
  const failedLayers = runs.filter((r) => r.status === "failed" || r.status === "error");
  if (failedLayers.length) {
    lines.push(
      "",
      chalk.yellow(
        `${failedLayers.length} layer(s) failing — OpenPitStop Test Pyramid verdict: ${chalk.bold("DO NOT SHIP")}`,
      ),
    );
  } else if (runs.some((r) => r.status === "ok")) {
    lines.push("", chalk.green("All discovered layers green — this is a shippable test pyramid."));
  }
  return boxen(lines.join("\n"), {
    title: " PITSTOP — Test Pyramid ",
    titleAlignment: "center",
    borderStyle: "double",
    padding: 1,
    borderColor: "cyan",
  });
}

export const testCmd = new Command("test")
  .description(
    "Run the test pyramid — unit, integration and e2e layers — with honest per-layer results and " +
      "failing-test names. Like scan, it reports exactly what it found: no suite, no score, no lies.",
  )
  .argument("[repo]", "path to the repo to test (default: current dir)", ".")
  .option("--unit", "only run the unit layer")
  .option("--integration", "only run the integration layer")
  .option("--e2e", "only run the e2e layer")
  .option("--timeout <ms>", "per-layer timeout in ms (default: 300000)", "300000")
  .option("--json", "print machine-readable layer results as JSON")
  .action(async (repoArg: string, options: { unit?: boolean; integration?: boolean; e2e?: boolean; timeout?: string; json?: boolean }) => {
    const repo = path.resolve(repoArg);
    if (!options.json) {
      console.log(chalk.cyan(`\nTesting ${repo} ...\n`));
    }

    const discovered = discoverTestLayers(repo);
    const wanted = (["unit", "integration", "e2e"] as const).filter((l) => options[l]);
    const specs = discovered.filter((s) => wanted.length === 0 || wanted.includes(s.layer));

    const runs: LayerRun[] = [];
    for (const spec of specs) {
      if (!options.json) {
        console.log(chalk.dim(`  running ${spec.layer} (${spec.runner}) …`));
      }
      runs.push(await runTestLayer(repo, spec, Number(options.timeout) || 300000));
    }

    if (wanted.length === 0) {
      for (const l of ["unit", "integration", "e2e"] as const) {
        if (!runs.some((r) => r.layer === l)) {
          runs.push({ layer: l, runner: "—", status: "skipped", total: 0, passed: 0, failed: 0, durationMs: 0, note: "no suite discovered", failing: [] });
        }
      }
    }

    runs.sort((a, b) => LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer]);

    if (options.json) {
      console.log(JSON.stringify({ repo, layers: runs }, null, 2));
    } else {
      console.log(`\n${renderTestPyramid(runs, repo)}\n`);
      const skipped = runs.filter((r) => r.status === "skipped");
      if (skipped.length && wanted.length === 0) {
        console.log(
          chalk.dim(
            `No ${skipped.map((s) => s.layer).join(", ")} layer discovered — add e.g. "test:e2e": "playwright test" to package.json and it will be picked up automatically.`,
          ),
        );
      }
    }

    const failedAny = runs.some((r) => r.status === "failed" || r.status === "error");
    process.exitCode = failedAny ? 1 : 0;
  });
