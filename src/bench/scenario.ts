import fs from "node:fs";
import path from "node:path";
import { languageDisplayName } from "../languages/adapters.js";
import type { KnownLanguage } from "../languages/types.js";

/**
 * The benchmark contract.
 *
 * A scenario is a tiny repository plus a recorded expectation. The benchmark runs the
 * same analyzer the CLI runs and compares the result with that expectation. Nothing is
 * tuned for the fixtures and nothing here calls a model: a scenario that misses is a
 * measurement, not an error.
 */
export type BenchKind =
  | "vulnerable"
  | "fixed"
  | "benign"
  | "known-miss"
  | "known-false-positive"
  | "unsupported"
  | "broken";

export type BenchCheck = "security";

export const BENCH_CHECKS: BenchCheck[] = ["security"];

/**
 * Languages the static security rules actually read (`.js`, `.jsx`, `.ts`, `.tsx`,
 * `.mjs`, `.cjs`, `.py`, `.go`, `.rb`, `.php`, `.java`, `.cs`; see CODE_EXTS in
 * analyzers/securityStatic.ts). A stack outside this list produces no security
 * evidence, so its fixtures are reported as skipped coverage instead of "clean".
 */
export const SECURITY_COVERAGE: KnownLanguage[] = ["js", "python", "go", "ruby", "php", "java", "dotnet"];

export interface ExpectedFinding {
  /** Finding category, e.g. "sql-injection" or "authentication". */
  category: string;
  /** Repo-relative POSIX path the finding must point at, when the location matters. */
  file?: string;
}

export interface ScenarioExpectation {
  /** Categories (and files) a vulnerable scenario must report, or a known-miss must not. */
  findings?: ExpectedFinding[];
  /** Categories a fixed or benign scenario must stay quiet about. */
  forbid?: string[];
}

export interface Scenario {
  id: string;
  title: string;
  kind: BenchKind;
  stack: string;
  checks: BenchCheck[];
  expect: ScenarioExpectation;
  /** For `fixed` scenarios: the vulnerable scenario this is the corrected twin of. */
  pairOf?: string;
  note?: string;
  /** Absolute path of the fixture repository. */
  repo: string;
  /** Absolute path of scenario.json. */
  file: string;
}

const KINDS: BenchKind[] = ["vulnerable", "fixed", "benign", "known-miss", "known-false-positive", "unsupported", "broken"];
const ALLOWED_KEYS = new Set(["id", "title", "kind", "stack", "checks", "expect", "pairOf", "note"]);

function fail(file: string, message: string): never {
  throw new Error(`${path.relative(process.cwd(), file) || file}: ${message}`);
}

function asString(value: unknown, file: string, key: string): string {
  if (typeof value !== "string" || !value.trim()) fail(file, `"${key}" must be a non-empty string`);
  return value.trim();
}

function asStringList(value: unknown, file: string, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(file, `"${key}" must be a non-empty array`);
  return value.map((entry) => asString(entry, file, key));
}

/** Validate one scenario.json; every rejection names the file and the exact field. */
export function loadScenario(dir: string): Scenario {
  const file = path.join(dir, "scenario.json");
  if (!fs.existsSync(file)) fail(file, "missing scenario.json");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch (error) {
    fail(file, `invalid JSON: ${(error as Error).message}`);
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) fail(file, `unknown key "${key}"`);
  }

  const id = asString(raw.id, file, "id");
  if (id !== path.basename(dir)) fail(file, `"id" must match the directory name ("${path.basename(dir)}")`);
  const title = asString(raw.title, file, "title");
  const kind = asString(raw.kind, file, "kind") as BenchKind;
  if (!KINDS.includes(kind)) fail(file, `"kind" must be one of ${KINDS.join(", ")}`);
  const stack = asString(raw.stack, file, "stack");

  const checks = raw.checks === undefined ? ["security"] : asStringList(raw.checks, file, "checks");
  for (const check of checks) {
    if (!BENCH_CHECKS.includes(check as BenchCheck)) fail(file, `unknown check "${check}" (known: ${BENCH_CHECKS.join(", ")})`);
  }

  const expectRaw = raw.expect;
  if (!expectRaw || typeof expectRaw !== "object" || Array.isArray(expectRaw)) fail(file, `"expect" must be an object`);
  const expectObject = expectRaw as Record<string, unknown>;
  for (const key of Object.keys(expectObject)) {
    if (key !== "findings" && key !== "forbid") fail(file, `unknown key "expect.${key}"`);
  }
  const findings = Array.isArray(expectObject.findings)
    ? (expectObject.findings as unknown[]).map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(file, `"expect.findings" entries must be objects`);
        const item = entry as Record<string, unknown>;
        for (const key of Object.keys(item)) {
          if (key !== "category" && key !== "file") fail(file, `unknown key "expect.findings[].${key}"`);
        }
        const finding: ExpectedFinding = { category: asString(item.category, file, "expect.findings[].category") };
        if (item.file !== undefined) finding.file = asString(item.file, file, "expect.findings[].file").replace(/\\/g, "/");
        return finding;
      })
    : undefined;
  const forbid = expectObject.forbid === undefined ? undefined : asStringList(expectObject.forbid, file, "expect.forbid");
  if (findings && forbid) fail(file, `"expect" takes either findings or forbid, not both`);

  if (kind === "vulnerable" && !findings?.length) fail(file, `a vulnerable scenario must declare "expect.findings"`);
  if (kind === "known-miss" && !findings?.length) fail(file, `a known-miss scenario must declare "expect.findings"`);
  if (kind === "benign" && !forbid?.length) fail(file, `a benign scenario must declare "expect.forbid"`);
  if (kind === "known-false-positive" && !forbid?.length) fail(file, `a known-false-positive scenario must declare "expect.forbid"`);
  if (kind === "fixed" && (findings || forbid)) {
    fail(file, `a fixed scenario derives its expectation from "pairOf" and declares nothing in "expect"`);
  }
  if ((kind === "unsupported" || kind === "broken") && (findings || forbid)) {
    fail(file, `"${kind}" scenarios do not declare findings or forbid — there is nothing to expect from an uncovered check`);
  }

  const pairOf = raw.pairOf === undefined ? undefined : asString(raw.pairOf, file, "pairOf");
  if (kind === "fixed" && !pairOf) fail(file, `a fixed scenario must name "pairOf"`);
  if (kind !== "fixed" && pairOf) fail(file, `"pairOf" is only valid on a fixed scenario`);

  const note = raw.note === undefined ? undefined : asString(raw.note, file, "note");
  const repo = path.join(dir, "repo");
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) fail(file, `missing fixture repository directory "repo/"`);

  return { id, title, kind, stack, checks: checks as BenchCheck[], expect: { findings, forbid }, pairOf, note, repo, file };
}

/**
 * Load every scenario under a benchmark root, in stable id order. A directory without a
 * scenario.json is an error: fixtures are curated, so a stray directory is a mistake.
 */
export function discoverScenarios(root: string): Scenario[] {
  const base = path.join(path.resolve(root), "scenarios");
  if (!fs.existsSync(base)) fail(base, "benchmark scenarios directory not found");

  const scenarios: Scenario[] = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
    scenarios.push(loadScenario(path.join(base, entry.name)));
  }
  if (!scenarios.length) fail(base, "no benchmark scenarios found");

  const byId = new Map<string, Scenario>();
  for (const scenario of scenarios) {
    if (byId.has(scenario.id)) fail(scenario.file, `duplicate scenario id "${scenario.id}"`);
    byId.set(scenario.id, scenario);
  }
  for (const scenario of scenarios) {
    if (!scenario.pairOf) continue;
    const twin = byId.get(scenario.pairOf);
    if (!twin) fail(scenario.file, `"pairOf" names unknown scenario "${scenario.pairOf}"`);
    if (twin.kind !== "vulnerable") fail(scenario.file, `"pairOf" must name a vulnerable scenario, "${twin.id}" is ${twin.kind}`);
  }
  return scenarios;
}

/** Human-readable check coverage, used in the skipped-coverage report. */
export function coverageLabel(check: BenchCheck): string {
  if (check === "security") return SECURITY_COVERAGE.map((language) => languageDisplayName(language)).join(", ");
  return check;
}

