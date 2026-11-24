import fs from "node:fs";
import path from "node:path";
import {
  commandExists,
  detectLanguage,
  safeExec,
  walkFiles,
  Language,
} from "./util.js";
import type { DependencyGraphResult } from "./types.js";

const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const PY_EXTS = [".py"];

export interface BuiltEdges {
  edges: Map<string, Set<string>>;
  lang: Language;
  engine: string;
}

/**
 * Build the file import graph for a repo. Prefers `madge` for JS/TS when it is
 * installed, otherwise falls back to a regex-based import scanner that works
 * for both JS/TS and Python. Returns null for unsupported (non JS/TS/Python) repos.
 */
export function buildEdges(repo: string): BuiltEdges | null {
  const lang = detectLanguage(repo);
  if (lang !== "js" && lang !== "python") return null;

  if (lang === "js" && commandExists("madge")) {
    const r = safeExec(
      "madge",
      [repo, "--json", "--circular", "--extensions", "ts,tsx,js,jsx"],
      repo,
      120000,
    );
    if (r.code === 0 && r.stdout) {
      try {
        const json = JSON.parse(r.stdout);
        const modules: Record<string, string[]> = json.modules ?? {};
        const edges = new Map<string, Set<string>>();
        for (const [from, deps] of Object.entries(modules)) {
          edges.set(from, new Set(deps));
        }
        return { edges, lang, engine: "madge" };
      } catch {
        /* fall through to regex */
      }
    }
  }

  const exts = lang === "js" ? JS_EXTS : PY_EXTS;
  return { edges: regexGraph(repo, exts, lang), lang, engine: "regex" };
}

export function analyzeDependencyGraph(repo: string): DependencyGraphResult {
  const built = buildEdges(repo);
  if (!built) {
    return {
      status: "skipped",
      note: "not a JS/TS or Python repo",
      files: 0,
      circular: [],
      mostDependedOn: [],
      orphans: [],
    };
  }
  return finalizeGraph(built.edges, repo, built.engine);
}

function finalizeGraph(
  edges: Map<string, Set<string>>,
  repo: string,
  engine: string,
): DependencyGraphResult {
  const circular = findCycles(edges);
  const inCount = new Map<string, number>();
  for (const deps of edges.values()) {
    for (const d of deps) inCount.set(d, (inCount.get(d) ?? 0) + 1);
  }
  const mostDependedOn = [...inCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file: path.relative(repo, file), count }));
  // Orphans = files not reachable from any entry root (in-degree 0 node),
  // i.e. truly disconnected modules. Entry points themselves are roots.
  const roots = [...edges.keys()].filter((n) => (inCount.get(n) ?? 0) === 0);
  const visited = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const n = queue.pop() as string;
    if (visited.has(n)) continue;
    visited.add(n);
    for (const d of edges.get(n) ?? []) if (!visited.has(d)) queue.push(d);
  }
  const orphans = [...edges.keys()]
    .filter((n) => !visited.has(n))
    .map((n) => path.relative(repo, n));

  return {
    status: "ok",
    engine,
    files: edges.size,
    circular,
    mostDependedOn,
    orphans,
  };
}

function regexGraph(
  repo: string,
  exts: string[],
  lang: Language,
): Map<string, Set<string>> {
  const files = walkFiles(repo, exts);
  const fileSet = new Set(files);
  const edges = new Map<string, Set<string>>();
  for (const f of files) edges.set(f, new Set());

  const re =
    lang === "python"
      ? /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm
      : /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const f of files) {
    let content: string;
    try {
      content = fs.readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const dir = path.dirname(f);
    const matches = content.matchAll(re);
    for (const m of matches) {
      const spec = (m[1] || m[2] || "").trim();
      if (!spec) continue;
      let resolved: string | null = null;
      if (lang === "python") {
        resolved = spec.startsWith(".")
          ? resolvePythonRelative(dir, spec)
          : resolvePythonAbs(repo, spec, fileSet);
      } else if (spec.startsWith(".")) {
        resolved = resolveJsRelative(dir, spec, fileSet);
      }
      if (resolved && edges.has(resolved)) edges.get(f)!.add(resolved);
    }
  }
  return edges;
}

function resolveJsRelative(
  dir: string,
  spec: string,
  fileSet: Set<string>,
): string | null {
  const base = path.resolve(dir, spec);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
  const candidates: string[] = [...exts.map((e) => stem + e)];
  for (const e of exts) {
    candidates.push(path.join(stem, "index" + e));
  }
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

function resolvePythonRelative(dir: string, spec: string): string | null {
  const dots = spec.match(/^\.+/)?.[0].length ?? 0;
  const rest = spec.slice(dots).split(".").filter(Boolean);
  let base = dir;
  for (let i = 0; i < dots - 1; i++) base = path.dirname(base);
  const target = path.resolve(base, ...rest) + ".py";
  const pkg = path.join(path.resolve(base, ...rest), "__init__.py");
  if (fs.existsSync(target)) return target;
  if (fs.existsSync(pkg)) return pkg;
  return null;
}

function resolvePythonAbs(
  repo: string,
  spec: string,
  fileSet: Set<string>,
): string | null {
  const parts = spec.split(".");
  const mod = parts[parts.length - 1];
  const candidates = [
    path.join(repo, ...parts) + ".py",
    path.join(repo, ...parts, "__init__.py"),
    path.join(repo, ...parts.slice(0, -1), mod) + ".py",
  ];
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

export function findCycles(edges: Map<string, Set<string>>): string[][] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of edges.keys()) color.set(n, WHITE);
  const stack: string[] = [];
  const cycles: string[][] = [];

  const dfs = (u: string) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of edges.get(u) ?? []) {
      if (!edges.has(v)) continue;
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        if (idx !== -1) cycles.push([...stack.slice(idx), v]);
      } else if (color.get(v) === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const n of edges.keys()) if (color.get(n) === WHITE) dfs(n);

  const seen = new Set<string>();
  const dedup: string[][] = [];
  for (const c of cycles) {
    const key = [...new Set(c)].sort().join("|");
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(c);
    }
  }
  return dedup;
}
