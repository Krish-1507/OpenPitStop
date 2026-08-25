import fs from "node:fs";
import path from "node:path";
import { seal, type OpenPitStopEvidence } from "../evidence.js";
import { detectLanguage, walkFiles, type Language } from "../analyzers/util.js";
import { discoverTestLayers, type TestLayerSpec } from "../commands/test.js";

/**
 * understand/index.ts — REPO AWARENESS.
 *
 * "Understand" is stage one of the pipeline:
 *   Understand → Contract → Plan → Change → Inspect → Verify → Attack →
 *   Holdout → Architecture/Regressions → Gate
 *
 * Everything downstream (planning, boundary enforcement, verification-stack
 * selection) reads this artifact instead of re-guessing the repo. It is a
 * sealed evidence document, not a guess: every claim here is derived from
 * real files (package.json, tsconfig, CI workflows, CODEOWNERS, the tree).
 *
 * It also loads the repo's ARCHITECTURE CONFIGURATION when present — the
 * declarative rules (boundaries, protected paths, forbidden paths) that
 * `pitstop architecture-check` enforces. Without a config, boundaries are
 * empty and the checker reports accordingly (never invented).
 */

export interface BoundaryRule {
  /** Glob(s) the rule applies to, e.g. "src/core/**". */
  from: string | string[];
  /** Import targets that are forbidden from these files. */
  forbidImportsFrom: string[];
  reason?: string;
}

export interface ArchitectureConfig {
  id?: string;
  boundaries?: BoundaryRule[];
  /** Paths that require explicit human approval to modify. */
  protected?: { path: string; reason?: string }[];
  /** Paths that must never be modified (secrets, generated code, ...). */
  forbidden?: { path: string; reason?: string }[];
  description?: string;
}

export interface RepoUnderstanding {
  repo: string;
  generatedAt: string;
  primaryLanguage: Language;
  languages: Language[];
  frameworks: string[];
  packageManager: "npm" | "yarn" | "pnpm" | "unknown";
  scripts: Record<string, string>;
  verificationCommands: {
    test?: string;
    typecheck?: string;
    lint?: string;
    build?: string;
    integration?: string;
    e2e?: string;
  };
  testLayers: TestLayerSpec[];
  ci: { provider: string | null; workflows: string[] };
  moduleMap: { dir: string; files: number; role: string }[];
  entryPoints: string[];
  ownership: { path: string; owners: string[] }[];
  architecture: ArchitectureConfig;
  architectureConfigPath: string | null;
  sealedPath?: string;
  evidence?: OpenPitStopEvidence;
}

const IGNORE = new Set([
  "node_modules", "dist", "build", ".git", ".pitstop", "coverage", ".next",
  ".venv", "venv", "__pycache__", "demo-repo", "templates", ".pytest_cache",
]);

const FRAMEWORKS: Record<string, string> = {
  express: "express", fastify: "fastify", koa: "koa", "@nestjs/core": "nestjs",
  next: "next", react: "react", vue: "vue", svelte: "svelte", angular: "angular",
  jest: "jest", vitest: "vitest", mocha: "mocha", "node:test": "node-test",
  playwright: "playwright", cypress: "cypress", eslint: "eslint", prettier: "prettier",
  typescript: "typescript", prisma: "prisma", mongoose: "mongoose", sequelize: "sequelize",
  tailwindcss: "tailwind", vite: "vite", webpack: "webpack", esbuild: "esbuild",
};

/** Minimal glob: `**` crosses segments, `*` stays within one segment. Single-pass —
 *  chained .replace() calls re-process their own insertions (`.*` → `.[^/]*`). */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += ".";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatches(patterns: string | string[], p: string): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  const norm = p.replace(/\\/g, "/");
  return list.some((pat) => globToRegExp(pat).test(norm));
}

function findArchitectureConfig(repo: string): { config: ArchitectureConfig; path: string | null } {
  const candidates = [
    path.join(repo, "openpitstop.architecture.json"),
    path.join(repo, ".pitstop", "architecture.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, "utf8");
      const cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as ArchitectureConfig;
      // validate minimally — an invalid config must fail loudly, not silently no-op
      if (cfg.boundaries) {
        for (const b of cfg.boundaries) {
          if (!b.from || !Array.isArray(b.forbidImportsFrom)) {
            throw new Error(`boundary rule needs "from" and "forbidImportsFrom"`);
          }
        }
      }
      return { config: cfg, path: p };
    } catch (e: any) {
      throw new Error(`invalid architecture config at ${path.relative(repo, p)}: ${e.message}`);
    }
  }
  return { config: {}, path: null };
}

function parseCodeowners(repo: string): { path: string; owners: string[] }[] {
  const candidates = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
  for (const rel of candidates) {
    const p = path.join(repo, rel);
    if (!fs.existsSync(p)) continue;
    const rules: { path: string; owners: string[] }[] = [];
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split(/\s+/);
      if (parts.length < 2) continue;
      rules.push({ path: parts[0], owners: parts.slice(1) });
    }
    // GitHub semantics: the LAST matching pattern wins.
    return rules.reverse();
  }
  return [];
}

export function ownersFor(rules: { path: string; owners: string[] }[], file: string): string[] {
  const f = file.replace(/\\/g, "/");
  const matches = (rPath: string): boolean => {
    const p = rPath.replace(/^\//, "").replace(/\/$/, "");
    if (p === "*" || p === "**" || p === "") return true; // catch-all
    if (globMatches(p, f)) return true; // exact file or glob
    return globMatches(p.endsWith("/**") ? p : `${p}/**`, f); // directory subtree
  };
  // rules arrive reversed (deepest-ancestor first); first hit wins
  let pat = f;
  while (true) {
    for (const r of rules) {
      const p = r.path.replace(/^\//, "").replace(/\/$/, "");
      const hitHere = p === pat || globMatches(p, pat) || globMatches(p.endsWith("/**") ? p : `${p}/**`, pat);
      if (hitHere) return r.owners;
    }
    const idx = pat.lastIndexOf("/");
    if (idx === -1) {
      const catchAll = rules.find((r) => r.path === "*");
      return catchAll ? catchAll.owners : [];
    }
    pat = pat.slice(0, idx);
  }
}

function inferRole(dir: string): string {
  const n = dir.toLowerCase();
  if (n === "src" || n === "lib" || n === "source") return "source";
  if (n === "test" || n === "tests" || n === "__tests__" || n === "spec") return "tests";
  if (n === "docs" || n === "doc") return "documentation";
  if (n === "scripts" || n === "tools" || n === "bin") return "tooling";
  if (n === ".github" || n === "ci") return "ci";
  if (n === "apps" || n === "app") return "applications";
  if (n === "packages" || n === "modules") return "packages";
  if (n === "infra" || n === "deploy" || n === "deployment" || n === "terraform" || n === "k8s") return "infrastructure";
  if (n === "fixtures" || n === "fixtures") return "fixtures";
  if (n === "public" || n === "static" || n === "assets") return "assets";
  return "other";
}

export function buildUnderstanding(repo: string): RepoUnderstanding {
  const repoAbs = path.resolve(repo);
  const u: RepoUnderstanding = {
    repo: repoAbs,
    generatedAt: new Date().toISOString(),
    primaryLanguage: detectLanguage(repoAbs),
    languages: [],
    frameworks: [],
    packageManager: "unknown",
    scripts: {},
    verificationCommands: {},
    testLayers: [],
    ci: { provider: null, workflows: [] },
    moduleMap: [],
    entryPoints: [],
    ownership: [],
    architecture: { boundaries: [], protected: [], forbidden: [] },
    architectureConfigPath: null,
  };

  // ---- languages: primary + presence of secondary markers
  u.languages = [u.primaryLanguage];
  const extsByLang: Partial<Record<Language, string[]>> = {
    js: [".mjs", ".cjs"], python: [".py"], go: [".go"], rust: [".rs"], dart: [".dart"], dotnet: [".cs"], java: [".java"],
  };
  for (const lang of ["js", "python", "go", "rust", "dart", "dotnet", "java"] as Language[]) {
    if (lang !== u.primaryLanguage) {
      const exts = extsByLang[lang] ?? [];
      if (exts.length && walkFiles(repoAbs, exts).length > 0) u.languages.push(lang);
    }
  }

  // ---- package.json: scripts, frameworks, package manager, entry points
  const pkgPath = path.join(repoAbs, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""));
      u.scripts = pkg.scripts ?? {};
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      u.frameworks = [...new Set(Object.keys(deps).filter((d) => FRAMEWORKS[d]).map((d) => FRAMEWORKS[d]))];
      if (deps.typescript || fs.existsSync(path.join(repoAbs, "tsconfig.json"))) u.frameworks.push("typescript");
      u.frameworks = [...new Set(u.frameworks)];
      u.packageManager = fs.existsSync(path.join(repoAbs, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(repoAbs, "yarn.lock"))
          ? "yarn"
          : fs.existsSync(path.join(repoAbs, "package-lock.json"))
            ? "npm"
            : "unknown";
      if (pkg.main) u.entryPoints.push(pkg.main);
      if (pkg.bin) u.entryPoints.push(...(typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin)));
    } catch { /* malformed package.json — leave scripts empty, do not guess */ }
  }

  // ---- verification commands: prefer explicit scripts, then conventional files
  const has = (s: string) => typeof u.scripts[s] === "string" && u.scripts[s].length > 0;
  if (has("test")) u.verificationCommands.test = `npm run test`;
  if (has("typecheck")) u.verificationCommands.typecheck = `npm run typecheck`;
  else if (fs.existsSync(path.join(repoAbs, "tsconfig.json"))) u.verificationCommands.typecheck = `npx tsc --noEmit`;
  if (has("lint")) u.verificationCommands.lint = `npm run lint`;
  else if (deps_has(u.frameworks, "eslint")) u.verificationCommands.lint = `npx eslint .`;
  if (has("build")) u.verificationCommands.build = `npm run build`;
  u.testLayers = discoverTestLayers(repoAbs);
  const integration = u.testLayers.find((l) => l.layer === "integration");
  const e2e = u.testLayers.find((l) => l.layer === "e2e");
  if (integration) u.verificationCommands.integration = integration.cmd ?? integration.script ?? undefined;
  if (e2e) u.verificationCommands.e2e = e2e.cmd ?? e2e.script ?? undefined;

  // ---- CI
  const wfDir = path.join(repoAbs, ".github", "workflows");
  if (fs.existsSync(wfDir)) {
    u.ci.provider = "github-actions";
    u.ci.workflows = fs
      .readdirSync(wfDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => `.github/workflows/${f}`);
  } else if (fs.existsSync(path.join(repoAbs, ".gitlab-ci.yml"))) {
    u.ci.provider = "gitlab-ci";
    u.ci.workflows = [".gitlab-ci.yml"];
  } else if (fs.existsSync(path.join(repoAbs, "Jenkinsfile"))) {
    u.ci.provider = "jenkins";
    u.ci.workflows = ["Jenkinsfile"];
  }

  // ---- module map (top-level, targeted: counts only, no deep scan)
  try {
    for (const e of fs.readdirSync(repoAbs, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) {
        if (e.name === ".github") {
          u.moduleMap.push({ dir: e.name, files: walkFiles(path.join(repoAbs, e.name), [""]).length, role: "ci" });
        }
        continue;
      }
      if (IGNORE.has(e.name)) continue;
      let files = 0;
      const stack = [path.join(repoAbs, e.name)];
      while (stack.length) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const x of entries) {
          if (x.isDirectory()) { if (!IGNORE.has(x.name) && !x.name.startsWith(".")) stack.push(path.join(d, x.name)); }
          else if (x.isFile()) files++;
        }
      }
      u.moduleMap.push({ dir: e.name, files, role: inferRole(e.name) });
    }
  } catch { /* unreadable dir — skip */ }

  // ---- ownership
  u.ownership = parseCodeowners(repoAbs);

  // ---- architecture config
  const arch = findArchitectureConfig(repoAbs);
  u.architecture = arch.config;
  u.architectureConfigPath = arch.path;

  return u;
}

function deps_has(frameworks: string[], name: string): boolean {
  return frameworks.includes(name);
}

/** Seal the understanding into .pitstop/understanding.json (the shared artifact). */
export function sealUnderstanding(repo: string, u: RepoUnderstanding): RepoUnderstanding {
  const outDir = path.join(path.resolve(repo), ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const p = path.join(outDir, "understanding.json");
  const doc = seal(
    { kind: "openpitstop-repo-understanding", ...u },
    `repo understanding for ${path.resolve(repo)}`,
  );
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return { ...u, sealedPath: p, evidence: (doc as any).evidence };
}

export function loadUnderstanding(repo: string): RepoUnderstanding | null {
  const p = path.join(path.resolve(repo), ".pitstop", "understanding.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return doc as RepoUnderstanding;
  } catch {
    return null;
  }
}
