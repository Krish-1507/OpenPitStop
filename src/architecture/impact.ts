import path from "node:path";
import { buildEdges } from "../analyzers/dependencyGraph.js";
import { walkFiles } from "../analyzers/util.js";
import { LANGUAGE_ADAPTERS } from "../languages/adapters.js";
import { findRoutes } from "../pen/static.js";
import { buildUnderstanding, globMatches, ownersFor } from "../understand/index.js";
import { moduleOf } from "./map.js";

/**
 * Change impact analysis — "what else does this change touch?"
 *
 * The answer is built from the repository, never guessed:
 *   - dependents: the reverse of the resolved import graph (JS/TS/Python today)
 *   - modules: the same module grouping `pitstop map --architecture` prints
 *   - routes: HTTP routes whose defining file is in the affected set
 *   - tests: test files that import an affected file, or whose name pairs with a
 *     changed file (the convention every test runner already understands)
 *   - constraints: the repository's own boundary/protected/forbidden rules and
 *     CODEOWNERS ownership for the changed files
 *   - recommended checks: the existing verification commands that apply
 *
 * It is a REVIEW ORDER, not a proof: importing a changed file does not prove the
 * changed line runs, and a matching test name does not prove the test covers it.
 * Every limit is printed with the result.
 */

export interface ImpactChangedFile {
  file: string;
  status: string;
  owners: string[];
}

export interface ImpactedFile {
  file: string;
  /** Import hops from the nearest changed file; 1 = direct dependent. */
  distance: number;
  /** The file one hop closer that imports this one. */
  via: string | null;
}

export interface ImpactRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  sensitive: boolean;
}

export interface ImpactTest {
  file: string;
  reason: "imports-affected-file" | "name-matches-changed-file";
}

export interface ImpactConstraint {
  kind: "boundary" | "protected" | "forbidden";
  file: string;
  rule: string;
  reason?: string;
}

export interface ImpactRecommendation {
  command: string;
  why: string;
}

export interface ChangeImpact {
  repo: string;
  generatedAt: string;
  engine: string | null;
  changed: ImpactChangedFile[];
  directDependents: string[];
  dependents: ImpactedFile[];
  affectedModules: { module: string; files: number }[];
  routes: ImpactRoute[];
  tests: ImpactTest[];
  constraints: ImpactConstraint[];
  summary: { dependents: number; modules: number; routes: number; tests: number; constraints: number };
  recommended: ImpactRecommendation[];
  depth: number;
  depthLimited: boolean;
  truncated: boolean;
  limits: string[];
}

export interface ImpactOptions {
  /** How many import hops to follow. Defaults to 8. */
  depth?: number;
  /** Hard cap on discovered dependents, so a hub file cannot flood the output. */
  maxDependents?: number;
}

const DEFAULT_DEPTH = 8;
const DEFAULT_MAX_DEPENDENTS = 2000;

const TEST_DIR_RE = /(?:^|\/)(?:__tests__|test|tests|spec|e2e)(?:\/|$)/i;
const TEST_NAME_RE = /[._-](?:test|spec)\.[^/]+$/i;
const PY_TEST_RE = /(?:^|\/)test_[^/]+\.py$/i;
const GO_TEST_RE = /_test\.go$/i;

/** Repo-relative, forward-slashed — the only path form this module reasons about. */
function relativeTo(repo: string, file: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(repo, file);
  return path.relative(repo, absolute).replace(/\\/g, "/");
}

/** A test file by directory or by runner convention (`x.test.ts`, `test_x.py`, `x_test.go`). */
export function isTestFile(file: string): boolean {
  return TEST_DIR_RE.test(file) || TEST_NAME_RE.test(file) || PY_TEST_RE.test(file) || GO_TEST_RE.test(file);
}

/** `src/auth/login.ts` -> "login"; `test/login.test.ts` -> "login". */
export function testStem(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base
    .replace(/\.[^.]+$/, "")
    .replace(/[._-](?:test|spec)$/i, "")
    .replace(/^(?:test|spec)[._-]/i, "")
    .toLowerCase();
}

/** Reverse import graph keyed by repo-relative path, plus the engine that built it. */
function reverseGraph(repo: string): { reverse: Map<string, Set<string>>; engine: string | null } {
  const built = buildEdges(repo);
  const reverse = new Map<string, Set<string>>();
  if (!built) return { reverse, engine: null };
  for (const [from, targets] of built.edges) {
    const fromFile = relativeTo(repo, from);
    if (!reverse.has(fromFile)) reverse.set(fromFile, new Set());
    for (const target of targets) {
      const toFile = relativeTo(repo, target);
      if (!reverse.has(toFile)) reverse.set(toFile, new Set());
      reverse.get(toFile)!.add(fromFile);
    }
  }
  return { reverse, engine: built.engine };
}

/**
 * Compute the impact of changing `changed` (repo-relative or absolute paths).
 * Pure repository analysis: no git call, no network, no LLM.
 */
export function computeImpact(
  repoInput: string,
  changed: { file: string; status?: string }[],
  options: ImpactOptions = {},
): ChangeImpact {
  const repo = path.resolve(repoInput);
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH);
  const maxDependents = Math.max(1, options.maxDependents ?? DEFAULT_MAX_DEPENDENTS);
  const understanding = buildUnderstanding(repo);
  const { reverse, engine } = reverseGraph(repo);

  const changedFiles: ImpactChangedFile[] = [];
  const seen = new Set<string>();
  for (const item of changed) {
    const file = relativeTo(repo, item.file);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    changedFiles.push({ file, status: item.status ?? "modified", owners: ownersFor(understanding.ownership, file) });
  }
  changedFiles.sort((a, b) => a.file.localeCompare(b.file));

  // Breadth-first over reverse edges: distance 1 is a direct importer, and `via`
  // names the closest file that imports this one, so every hop is explainable.
  const visited = new Set(changedFiles.map((c) => c.file));
  const dependents: ImpactedFile[] = [];
  const queue: { file: string; distance: number }[] = changedFiles.map((c) => ({ file: c.file, distance: 0 }));
  let truncated = false;
  let depthLimited = false;
  for (let head = 0; head < queue.length && !truncated; head++) {
    const current = queue[head];
    const importers = reverse.get(current.file);
    if (!importers || importers.size === 0) continue;
    if (current.distance >= depth) {
      depthLimited = true;
      continue;
    }
    for (const importer of [...importers].sort()) {
      if (visited.has(importer)) continue;
      visited.add(importer);
      dependents.push({ file: importer, distance: current.distance + 1, via: current.file });
      if (dependents.length >= maxDependents) {
        truncated = true;
        break;
      }
      queue.push({ file: importer, distance: current.distance + 1 });
    }
  }
  dependents.sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));

  const affected = new Set([...changedFiles.map((c) => c.file), ...dependents.map((d) => d.file)]);

  const moduleCounts = new Map<string, number>();
  for (const file of affected) {
    const module = moduleOf(file);
    moduleCounts.set(module, (moduleCounts.get(module) ?? 0) + 1);
  }
  const affectedModules = [...moduleCounts.entries()]
    .map(([module, files]) => ({ module, files }))
    .sort((a, b) => b.files - a.files || a.module.localeCompare(b.module));

  let routes: ImpactRoute[] = [];
  try {
    routes = findRoutes(repo)
      .map((route) => ({
        method: route.method,
        path: route.path,
        file: relativeTo(repo, route.file),
        line: route.line,
        sensitive: route.sensitive,
      }))
      .filter((route) => affected.has(route.file));
  } catch {
    /* route inventory is optional context; impact still reports dependents */
  }
  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.line - b.line);

  const extensions = [...new Set(LANGUAGE_ADAPTERS.flatMap((adapter) => adapter.extensions))];
  const testFiles = walkFiles(repo, extensions).map((file) => relativeTo(repo, file)).filter(isTestFile);
  const tests: ImpactTest[] = [];
  const testIndex = new Set<string>();
  const addTest = (file: string, reason: ImpactTest["reason"]) => {
    if (testIndex.has(file)) return;
    testIndex.add(file);
    tests.push({ file, reason });
  };
  for (const file of [...affected].sort()) if (isTestFile(file)) addTest(file, "imports-affected-file");
  for (const change of changedFiles) {
    if (isTestFile(change.file)) continue;
    const stem = testStem(change.file);
    for (const candidate of testFiles) if (testStem(candidate) === stem) addTest(candidate, "name-matches-changed-file");
  }
  tests.sort((a, b) => a.file.localeCompare(b.file));

  const constraints: ImpactConstraint[] = [];
  for (const change of changedFiles) {
    for (const rule of understanding.architecture.boundaries ?? []) {
      if (!globMatches(rule.from, change.file)) continue;
      constraints.push({
        kind: "boundary",
        file: change.file,
        rule: Array.isArray(rule.from) ? rule.from.join(", ") : rule.from,
        reason: rule.reason,
      });
    }
    for (const entry of understanding.architecture.protected ?? []) {
      if (globMatches(entry.path, change.file)) constraints.push({ kind: "protected", file: change.file, rule: entry.path, reason: entry.reason });
    }
    for (const entry of understanding.architecture.forbidden ?? []) {
      if (globMatches(entry.path, change.file)) constraints.push({ kind: "forbidden", file: change.file, rule: entry.path, reason: entry.reason });
    }
  }

  const commands = understanding.verificationCommands;
  const verification = [commands.test, commands.typecheck, commands.lint, commands.build].filter((value): value is string => Boolean(value));
  const approvalTouches = constraints.filter((constraint) => constraint.kind !== "boundary");
  const boundaryCount = (understanding.architecture.boundaries ?? []).length;
  const recommended: ImpactRecommendation[] = [
    {
      command: "pitstop architecture-check --against-plan",
      why: approvalTouches.length > 0
        ? "the change touches a protected or forbidden path"
        : understanding.architectureConfigPath
          ? boundaryCount + " declared boundary rule(s) apply to this repository"
          : "checks scope, protected paths and shortcuts even with no declared architecture config",
    },
  ];
  if (verification.length) {
    recommended.push({ command: "pitstop verify-stack", why: "repository verification: " + verification.join(", ") });
  }
  if (tests.length) {
    recommended.push({ command: "pitstop test", why: tests.length + " test file(s) import or pair with the changed surface" });
  }
  if (routes.length) {
    recommended.push({ command: "pitstop pen --static", why: routes.length + " HTTP route(s) are defined in affected files" });
  }
  if (dependents.length) {
    recommended.push({ command: "pitstop regression-check", why: dependents.length + " file(s) import the changed files, directly or transitively" });
  }
  const gateLayers = ["stack", "architecture", ...(dependents.length ? ["regression"] : []), ...(routes.length ? ["security"] : [])];
  recommended.push({ command: "pitstop gate --strict --require " + gateLayers.join(","), why: "turn the evidence above into a release verdict" });

  const limits: string[] = [
    engine
      ? "Import edges come from the " + engine + " engine and only resolved relative imports: not a runtime call graph and not dynamic requires."
      : "The import graph is unavailable for this repository, so dependents were not discovered (JS/TS/Python are supported).",
    "A file importing a changed file does not prove the changed line is executed; dependents order the review, they do not prove reachability.",
    "Test files are matched by import edge or by runner naming convention; a matched test does not prove coverage of the changed behavior.",
    "Routes are pattern-matched candidates from source, not live endpoint proof.",
  ];
  if (changedFiles.some((change) => change.status === "deleted")) {
    limits.push("Deleted files are absent from the current import graph, so their former importers are not inferred.");
  }
  if (!understanding.architectureConfigPath) {
    limits.push("No architecture config was found, so boundary and protected-path constraints are unconfigured.");
  }

  return {
    repo,
    generatedAt: new Date().toISOString(),
    engine,
    changed: changedFiles,
    directDependents: dependents.filter((entry) => entry.distance === 1).map((entry) => entry.file),
    dependents,
    affectedModules,
    routes,
    tests,
    constraints,
    summary: {
      dependents: dependents.length,
      modules: affectedModules.length,
      routes: routes.length,
      tests: tests.length,
      constraints: constraints.length,
    },
    recommended,
    depth,
    depthLimited,
    truncated,
    limits,
  };
}

/** True when the change touches a path the repository marked forbidden or protected. */
export function needsApprovalOrForbidden(impact: ChangeImpact): { approval: boolean; forbidden: boolean } {
  return {
    approval: impact.constraints.some((constraint) => constraint.kind === "protected"),
    forbidden: impact.constraints.some((constraint) => constraint.kind === "forbidden"),
  };
}
