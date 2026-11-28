import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { languageDisplayName, languageForExtension } from "../languages/adapters.js";
import { isTestFile } from "../architecture/impact.js";
import { findCycles } from "../analyzers/dependencyGraph.js";
import { parseJsFile } from "./jsParser.js";
import { parsePythonFile } from "./pythonIndex.js";
import type {
  AuditSourceFile,
  ExecutionPath,
  ExecutionStep,
  JsFileIndex,
  PythonFileIndex,
  RepoIndex,
} from "./indexTypes.js";

/**
 * audit/indexer.ts — build one accepted, cacheable repository index.
 *
 * File-level imports become a resolved graph; call edges exist only where a
 * call resolves to a function in this repository through a relative import or
 * the same file. Method calls and alias imports stay unresolved and are
 * counted as such in the report — never guessed.
 */

const MAX_FILE_BYTES = 400 * 1024;
const CACHE_VERSION = "audit-index-v4";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".pitstop", ".turbo", ".cache", "vendor", "target", "Pods", ".gradle", ".idea",
  ".vscode", ".terraform", "site-packages",
  // Fixture and seed directories that are not part of the code under review.
  // Keep this aligned with the existing scan walker so audit and scan agree.
  "bench", "templates", "demo-repo",
]);

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

/** The core language id for JavaScript and TypeScript is "js"; the audit
 * distinguishes the two only where it matters, through parser options. */
function languageForFile(relative: string): import("../languages/types.js").Language {
  const extension = path.extname(relative).toLowerCase();
  if (JS_EXTENSIONS.includes(extension)) return "js";
  return languageForExtension(extension) ?? "unknown";
}

export interface IndexCache {
  get(hash: string): JsFileIndex | PythonFileIndex | undefined;
  set(hash: string, value: JsFileIndex | PythonFileIndex): void;
}

export interface IndexOptions {
  repo: string;
  scope: string[];
  maxFiles: number;
  cache?: IndexCache;
  warnings?: string[];
}

export function cacheKey(relative: string, content: string): string {
  return CACHE_VERSION + ":" + createHash("sha256").update(relative).update("\0").update(content).digest("hex");
}

export function normalizeScope(scope: string[]): string[] {
  return scope
    .map((entry) => entry.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\.$/, ""))
    .filter(Boolean);
}

function inScope(relative: string, scope: string[]): boolean {
  if (scope.length === 0) return true;
  return scope.some((entry) => relative === entry || relative.startsWith(entry + "/"));
}

function walkSourceFiles(repo: string, scope: string[], warnings: string[]): string[] {
  const files: string[] = [];
  const stack = [repo];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push("Could not read " + path.relative(repo, dir) + ": " + (error as Error).message);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const relative = path.relative(repo, abs).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        // Tool caches and build outputs are not source. Dot-directories are
        // configuration/state in practice; skipping them prevents self-scans
        // of .tmp-dist, .pitstop and editor state.
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        if (scope.length > 0 && !inScope(relative, scope) && !scope.some((s) => s.startsWith(relative + "/"))) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!inScope(relative, scope)) continue;
      if (languageForFile(relative) === "unknown") continue;
      files.push(relative);
    }
  }
  return files;
}

function priority(file: string, entryNames: Set<string>): number {
  const basename = path.posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
  if (entryNames.has(basename)) return 0;
  if (isTestFile(file)) return 3;
  return 1;
}

function entryNamesFor(repo: string): Set<string> {
  const names = new Set(["index", "main", "app", "server", "cli", "bin"]);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as {
      main?: string;
      bin?: string | Record<string, string>;
    };
    const add = (value: string) => {
      const base = path.posix.basename(value).replace(/\.[^.]+$/, "").toLowerCase();
      if (base) names.add(base);
    };
    if (manifest.main) add(manifest.main);
    if (typeof manifest.bin === "string") add(manifest.bin);
    else if (manifest.bin) for (const value of Object.values(manifest.bin)) add(value);
  } catch {
    /* no manifest */
  }
  return names;
}

export function buildRepoIndex(options: IndexOptions): RepoIndex {
  const repo = path.resolve(options.repo);
  const warnings = options.warnings ?? [];
  const scope = normalizeScope(options.scope);
  const entries = entryNamesFor(repo);
  const discovered = walkSourceFiles(repo, scope, warnings);

  discovered.sort((a, b) => {
    const pa = priority(a, entries);
    const pb = priority(b, entries);
    if (pa !== pb) return pa - pb;
    const da = a.split("/").length;
    const db = b.split("/").length;
    if (da !== db) return da - db;
    return a < b ? -1 : 1;
  });

  const selected = discovered.slice(0, Math.max(1, options.maxFiles));
  const skipped = Math.max(0, discovered.length - selected.length);
  if (skipped > 0) {
    warnings.push(
      "File budget reached: " + skipped + " source files were not indexed (limit " + options.maxFiles + ").",
    );
  }

  const files: AuditSourceFile[] = [];
  for (const relative of selected) {
    const abs = path.join(repo, relative);
    let content: string;
    try {
      const stat = fs.statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        warnings.push("Skipped large file over " + Math.round(MAX_FILE_BYTES / 1024) + " KB: " + relative);
        continue;
      }
      content = fs.readFileSync(abs, "utf8");
    } catch (error) {
      warnings.push("Could not read " + relative + ": " + (error as Error).message);
      continue;
    }
    if (content.includes("\0")) {
      warnings.push("Skipped binary-looking source file: " + relative);
      continue;
    }
    const language = languageForFile(relative);
    const source: AuditSourceFile = {
      file: relative,
      abs,
      language,
      content,
      lines: content.split(/\r?\n/).length,
    };
    const ext = path.extname(relative).toLowerCase();
    const key = cacheKey(relative, content);
    const cached = options.cache?.get(key);
    if (ext === ".py" || ext === ".pyi") {
      source.python = cached && "broadExcept" in cached ? (cached as PythonFileIndex) : parsePythonFile(relative, content);
    } else if (JS_EXTENSIONS.includes(ext)) {
      source.js = cached && "anyCount" in cached ? (cached as JsFileIndex) : parseJsFile(relative, content);
      if (!source.js.parseOk) {
        warnings.push("Could not parse " + relative + " — file-level rules skipped.");
      }
    }
    if (source.js || source.python) options.cache?.set(key, source.js ?? (source.python as PythonFileIndex));
    files.push(source);
  }

  const fileSet = new Set(files.map((file) => file.file));
  const jsFiles = new Map<string, JsFileIndex>();
  for (const file of files) if (file.js) jsFiles.set(file.file, file.js);

  const edges = new Map<string, Set<string>>();
  for (const file of files) edges.set(file.file, new Set());
  const reverseEdges = new Map<string, Set<string>>();
  for (const file of files) reverseEdges.set(file.file, new Set());
  const imports: RepoIndex["imports"] = [];

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    edges.get(from)?.add(to);
    reverseEdges.get(to)?.add(from);
  };

  for (const file of files) {
    const js = file.js;
    if (js) {
      for (const entry of js.imports) {
        const resolved = resolveJsSpecifier(file.file, entry.specifier, fileSet);
        imports.push({ file: file.file, specifier: entry.specifier, line: entry.line, ...(resolved ? { resolved } : {}) });
        if (resolved) addEdge(file.file, resolved);
      }
    }
    const python = file.python;
    if (python) {
      for (const entry of python.imports) {
        const resolved = resolvePythonSpecifier(file.file, entry.specifier, fileSet);
        imports.push({ file: file.file, specifier: entry.specifier, line: entry.line, ...(resolved ? { resolved } : {}) });
        if (resolved) addEdge(file.file, resolved);
      }
    }
  }

  const cycles = findCycles(edges).map((cycle) => cycle.map((entry) => entry.replace(/\\/g, "/")));

  const functions: RepoIndex["functions"] = [];
  for (const file of files) {
    if (!file.js) continue;
    for (const fn of file.js.functions) functions.push({ ...fn, file: file.file });
  }
  functions.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  const fnIndex = new Map<string, Map<string, (typeof functions)[number]>>();
  for (const fn of functions) {
    let byName = fnIndex.get(fn.file);
    if (!byName) {
      byName = new Map();
      fnIndex.set(fn.file, byName);
    }
    if (!byName.has(fn.name)) byName.set(fn.name, fn);
  }

  const importBindings = new Map<string, Map<string, { imported: string; resolved?: string }>>();
  for (const file of files) {
    if (!file.js) continue;
    const map = new Map<string, { imported: string; resolved?: string }>();
    for (const entry of file.js.imports) {
      const resolved = resolveJsSpecifier(file.file, entry.specifier, fileSet);
      for (const binding of entry.bindings) {
        if (!binding.typeOnly) map.set(binding.local, { imported: binding.imported, ...(resolved ? { resolved } : {}) });
      }
    }
    importBindings.set(file.file, map);
  }

  const callGraph = new Map<string, Set<string>>();
  let resolvedCalls = 0;
  for (const fn of functions) {
    const fromKey = functionKey(fn.file, fn.name, fn.line);
    for (const call of fn.calls) {
      if (call.object) continue;
      let target: (typeof functions)[number] | undefined = fnIndex.get(fn.file)?.get(call.name);
      if (!target) {
        const binding = importBindings.get(fn.file)?.get(call.name);
        if (binding?.resolved && binding.imported !== "*" && binding.imported !== "default") {
          target = fnIndex.get(binding.resolved)?.get(binding.imported);
        }
      }
      if (!target) continue;
      const toKey = functionKey(target.file, target.name, target.line);
      let set = callGraph.get(fromKey);
      if (!set) {
        set = new Set();
        callGraph.set(fromKey, set);
      }
      set.add(toKey);
      resolvedCalls += 1;
    }
  }

  const routes: RepoIndex["routes"] = [];
  for (const file of files) {
    if (!file.js) continue;
    for (const route of file.js.routes) routes.push({ ...route, file: file.file });
  }

  const tests: RepoIndex["tests"] = [];
  const testsByFile = new Map<string, number>();
  for (const file of files) {
    if (file.js) {
      for (const test of file.js.tests) tests.push({ file: file.file, name: test.name, line: test.line, hasAssertion: test.hasAssertion, skipped: test.skipped });
      if (file.js.tests.length > 0) testsByFile.set(file.file, file.js.tests.length);
    }
    if (file.python) {
      for (const test of file.python.tests) tests.push({ file: file.file, name: test.name, line: test.line, hasAssertion: test.hasAssertion, skipped: test.skipped });
      if (file.python.tests.length > 0) testsByFile.set(file.file, (testsByFile.get(file.file) ?? 0) + file.python.tests.length);
    }
  }

  const executionPaths = buildExecutionPaths(routes, functions, fnIndex, importBindings, callGraph);

  const semantic = files.filter((file) => file.js?.parseOk).length;
  const parsed = files.filter((file) => file.js?.parseOk || file.python).length;
  // JS stores top-level calls on the file and function calls on each function;
  // Python stores all of its calls on the file. Add each source exactly once.
  const calls = files.reduce((sum, file) => {
    if (file.js) {
      return sum + file.js.calls.length + file.js.functions.reduce((inner, fn) => inner + fn.calls.length, 0);
    }
    if (file.python) return sum + file.python.calls.length;
    return sum;
  }, 0);

  return {
    repo,
    files,
    functions,
    edges,
    reverseEdges,
    cycles,
    routes,
    executionPaths,
    tests,
    testsByFile,
    imports,
    warnings,
    discovered: discovered.length,
    skipped,
    stats: {
      parsed,
      semantic,
      functions: functions.length + files.reduce((sum, file) => sum + (file.python?.functions.length ?? 0), 0),
      calls,
      resolvedCalls,
    },
  };
}

export function functionKey(file: string, name: string, line: number): string {
  return file + "#" + name + "@" + line;
}

function buildExecutionPaths(
  routes: RepoIndex["routes"],
  functions: RepoIndex["functions"],
  fnIndex: Map<string, Map<string, RepoIndex["functions"][number]>>,
  importBindings: Map<string, Map<string, { imported: string; resolved?: string }>>,
  callGraph: Map<string, Set<string>>,
): ExecutionPath[] {
  const byKey = new Map<string, RepoIndex["functions"][number]>();
  for (const fn of functions) byKey.set(functionKey(fn.file, fn.name, fn.line), fn);

  const resolveHandler = (route: RepoIndex["routes"][number]): RepoIndex["functions"][number] | undefined => {
    if (!route.handlerName) return undefined;
    const direct = fnIndex.get(route.file)?.get(route.handlerName);
    if (direct) return direct;
    if (route.handlerName.startsWith("<handler:") && route.handlerLine) {
      return functions.find((fn) => fn.file === route.file && fn.line === route.handlerLine);
    }
    const binding = importBindings.get(route.file)?.get(route.handlerName);
    if (binding?.resolved) return fnIndex.get(binding.resolved)?.get(binding.imported);
    return undefined;
  };

  const paths: ExecutionPath[] = [];
  for (const route of routes) {
    const handler = resolveHandler(route);
    if (!handler) continue;
    const start = functionKey(handler.file, handler.name, handler.line);
    const queue: { key: string; steps: ExecutionStep[]; depth: number }[] = [
      { key: start, steps: [{ file: handler.file, name: handler.name, line: handler.line }], depth: 0 },
    ];
    const seen = new Set<string>([start]);
    while (queue.length > 0 && paths.length < 20) {
      const current = queue.shift() as { key: string; steps: ExecutionStep[]; depth: number };
      const next = [...(callGraph.get(current.key) ?? [])].filter((key) => !seen.has(key)).sort();
      if (next.length === 0 || current.depth >= 5) {
        paths.push({
          route: route.method + " " + route.routePath,
          method: route.method,
          handler: handler.name,
          file: handler.file,
          depth: current.depth,
          steps: current.steps,
        });
        continue;
      }
      for (const key of next.slice(0, 4)) {
        const fn = byKey.get(key);
        if (!fn) continue;
        seen.add(key);
        queue.push({
          key,
          steps: [...current.steps, { file: fn.file, name: fn.name, line: fn.line }],
          depth: current.depth + 1,
        });
      }
    }
  }
  return paths.slice(0, 20);
}

export function resolveJsSpecifier(from: string, specifier: string, fileSet: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates: string[] = [base];
  if (base.endsWith(".js")) candidates.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
  if (base.endsWith(".jsx")) candidates.push(base.slice(0, -4) + ".tsx");
  if (base.endsWith(".mjs")) candidates.push(base.slice(0, -4) + ".mts");
  if (base.endsWith(".cjs")) candidates.push(base.slice(0, -4) + ".cts");
  for (const ext of JS_EXTENSIONS) candidates.push(base + ext);
  for (const ext of JS_EXTENSIONS) candidates.push(base + "/index" + ext);
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/");
    if (fileSet.has(normalized)) return normalized;
  }
  return undefined;
}

export function resolvePythonSpecifier(from: string, specifier: string, fileSet: Set<string>): string | undefined {
  const baseDir = path.posix.dirname(from);
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(dots);
    let dir = baseDir;
    for (let i = 1; i < dots; i++) dir = path.posix.dirname(dir);
    const stem = rest ? path.posix.join(dir, rest.replace(/\./g, "/")) : dir;
    candidates.push(stem + ".py", stem + "/__init__.py");
  } else {
    const stem = specifier.replace(/\./g, "/");
    candidates.push(stem + ".py", stem + "/__init__.py", "src/" + stem + ".py", "src/" + stem + "/__init__.py");
  }
  for (const candidate of candidates) {
    const normalized = path.posix.normalize(candidate);
    if (fileSet.has(normalized)) return normalized;
  }
  return undefined;
}

export function languageLabel(language: string): string {
  return languageDisplayName(language as never);
}
