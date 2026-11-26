import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { commandExists, detectLanguage, walkFiles, type Language } from "../analyzers/util.js";
import { languageDisplayName, languageMarkerFiles } from "../languages/adapters.js";
import {
  AGENT_DEFINITIONS,
  type AgentId,
  type InstallTarget,
} from "../installer/targets.js";

export interface AgentDetection {
  id: AgentId;
  name: string;
  /** At least one executable, home directory, or project directory was found. */
  installed: boolean;
  /** Human-readable evidence for the detection (never a guess). */
  evidence: string[];
  /** A pitstop command currently exists at project level. */
  projectConfigured: boolean;
  /** A pitstop command currently exists at user level. */
  homeConfigured: boolean;
  configured: boolean;
  note?: string;
}

export interface GitDetection {
  isRepo: boolean;
  branch: string | null;
  hasCommits: boolean;
}

export interface ProjectDetection {
  root: string;
  displayPath: string;
  name: string;
  type: string;
  languages: string[];
  frameworks: string[];
  packageManager: string;
  git: GitDetection;
  entryPoints: string[];
  verificationCommands: Record<string, string>;
  testLayers: string[];
  architectureConfig: string | null;
  manifests: string[];
}

const TECH_MARKERS: Array<{ file: string; language: string }> = [
  { file: "tsconfig.json", language: "TypeScript" },
  { file: "Dockerfile", language: "Docker" },
  { file: "docker-compose.yml", language: "Docker Compose" },
  { file: "docker-compose.yaml", language: "Docker Compose" },
];

// Language manifest markers come from the adapters, so adding a language in
// Phase 2 also updates onboarding without a second list to keep in sync.
const MARKERS: Array<{ file: string; language: string }> = [
  ...TECH_MARKERS,
  ...languageMarkerFiles(),
];

const FRAMEWORK_DEPS: Record<string, string> = {
  express: "Express",
  fastify: "Fastify",
  koa: "Koa",
  "@nestjs/core": "NestJS",
  next: "Next.js",
  react: "React",
  vue: "Vue",
  svelte: "Svelte",
  "@angular/core": "Angular",
  typescript: "TypeScript",
  jest: "Jest",
  vitest: "Vitest",
  mocha: "Mocha",
  playwright: "Playwright",
  cypress: "Cypress",
  prisma: "Prisma",
  mongoose: "Mongoose",
  tailwindcss: "Tailwind CSS",
  vite: "Vite",
  django: "Django",
  flask: "Flask",
  fastapi: "FastAPI",
};

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function exists(root: string, relative: string): boolean {
  return fs.existsSync(path.join(root, relative));
}

export function detectGit(root: string): GitDetection {
  const run = (args: string[]): string | null => {
    try {
      const result = spawnSync("git", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      return result.status === 0 ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  };
  const inside = run(["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return { isRepo: false, branch: null, hasCommits: false };
  const branch = run(["branch", "--show-current"]) || null;
  const head = run(["rev-parse", "--verify", "HEAD"]);
  return { isRepo: true, branch, hasCommits: Boolean(head) };
}

function packageManagerOf(root: string): string {
  if (exists(root, "pnpm-lock.yaml") || exists(root, "pnpm-workspace.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) return "bun";
  if (exists(root, "package-lock.json") || exists(root, "npm-shrinkwrap.json")) return "npm";
  if (exists(root, "uv.lock")) return "uv";
  if (exists(root, "poetry.lock")) return "poetry";
  if (exists(root, "Pipfile.lock")) return "pipenv";
  if (exists(root, "requirements.txt") || exists(root, "pyproject.toml")) return "pip";
  if (exists(root, "go.mod")) return "go modules";
  if (exists(root, "Cargo.toml")) return "cargo";
  if (exists(root, "pom.xml")) return "maven";
  return "unknown";
}

function typeOf(language: Language, root: string, languages: string[]): string {
  if (language === "js") {
    const typescript =
      languages.includes("TypeScript") ||
      exists(root, "tsconfig.json") ||
      walkFiles(root, [".ts"]).length > 0;
    return typescript ? "Node.js / TypeScript" : "Node.js / JavaScript";
  }
  switch (language) {
    case "python": return "Python";
    case "go": return "Go";
    case "rust": return "Rust";
    case "dart": return "Dart / Flutter";
    case "dotnet": return ".NET";
    case "java": return "Java / JVM";
    default: return "Unknown project type";
  }
}

function frameworksOf(root: string, language: Language): string[] {
  const found = new Set<string>();
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      if (FRAMEWORK_DEPS[name]) found.add(FRAMEWORK_DEPS[name]);
    }
  }
  if (language === "python") {
    const safeRead = (file: string): string => {
      try { return fs.readFileSync(path.join(root, file), "utf8"); } catch { return ""; }
    };
    const text = [
      safeRead("requirements.txt"),
      safeRead("pyproject.toml"),
      safeRead("setup.py"),
    ].join("\n").toLowerCase();
    for (const name of ["django", "flask", "fastapi", "pytest"]) {
      if (text.includes(name)) found.add(FRAMEWORK_DEPS[name] ?? name);
    }
  }
  return [...found].sort();
}

function verificationCommandsOf(root: string, packageManager: string): Record<string, string> {
  const commands: Record<string, string> = {};
  const pkg = readJson(path.join(root, "package.json"));
  const scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  const runner = packageManager === "pnpm" ? "pnpm" : packageManager === "yarn" ? "yarn" : packageManager === "bun" ? "bun run" : "npm run";
  for (const name of ["test", "typecheck", "lint", "build"]) {
    if (typeof scripts[name] === "string" && scripts[name]) commands[name] = `${runner} ${name}`;
  }
  if (!commands.test) {
    if (exists(root, "pytest.ini") || exists(root, "conftest.py") || exists(root, "pyproject.toml")) commands.test = "pytest -q";
    else if (exists(root, "go.mod")) commands.test = "go test ./...";
    else if (exists(root, "Cargo.toml")) commands.test = "cargo test";
  }
  return commands;
}

function entryPointsOf(root: string): string[] {
  const candidates = [
    "src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx",
    "src/main.ts", "src/main.tsx", "src/main.js",
    "server.ts", "server.js", "app.ts", "app.js",
    "main.py", "app.py", "manage.py",
    "main.go", "src/main.rs",
  ];
  const found = candidates.filter((file) => exists(root, file));
  const pkg = readJson(path.join(root, "package.json"));
  if (pkg?.main && typeof pkg.main === "string") found.push(pkg.main);
  if (pkg?.bin) {
    if (typeof pkg.bin === "string") found.push(pkg.bin);
    else if (typeof pkg.bin === "object") found.push(...Object.values(pkg.bin).filter((v): v is string => typeof v === "string"));
  }
  return [...new Set(found)].slice(0, 12);
}

/** Detect the project using real files only. Never invokes a build or test. */
export function detectProject(repoInput: string): ProjectDetection {
  const root = path.resolve(repoInput);
  const language = detectLanguage(root);
  const languages = new Set<string>([languageDisplayName(language)]);
  const manifests: string[] = [];
  for (const marker of MARKERS) {
    if (!exists(root, marker.file)) continue;
    languages.add(marker.language);
    manifests.push(marker.file);
  }
  for (const file of ["package.json", "package-lock.json", "requirements.txt", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "pubspec.yaml"]) {
    if (exists(root, file) && !manifests.includes(file)) manifests.push(file);
  }
  const pkg = readJson(path.join(root, "package.json"));
  const name = typeof pkg?.name === "string" && pkg.name.trim()
    ? pkg.name
    : path.basename(root);
  const packageManager = packageManagerOf(root);
  const git = detectGit(root);
  const architecture = ["openpitstop.architecture.json", ".pitstop/architecture.json"]
    .map((file) => path.join(root, file))
    .find((file) => fs.existsSync(file)) ?? null;
  const testLayers: string[] = [];
  if (["test", "tests", "__tests__", "spec", "e2e", "integration", "cypress"].some((dir) => exists(root, dir))) {
    testLayers.push("tests present");
  }
  return {
    root,
    displayPath: root === process.cwd() ? "." : path.relative(process.cwd(), root) || ".",
    name,
    type: typeOf(language, root, [...languages]),
    languages: [...languages],
    frameworks: frameworksOf(root, language),
    packageManager,
    git,
    entryPoints: entryPointsOf(root),
    verificationCommands: verificationCommandsOf(root, packageManager),
    testLayers,
    architectureConfig: architecture ? path.relative(root, architecture).replace(/\\/g, "/") : null,
    manifests,
  };
}

function targetExists(targets: InstallTarget[]): boolean {
  return targets.some((target) => fs.existsSync(target.path));
}

/**
 * Detect agents from installed executables and real configuration directories.
 * A tool is marked configured only when a pitstop target file exists.
 */
export function detectAgents(repoInput: string, home: string = os.homedir()): AgentDetection[] {
  const root = path.resolve(repoInput);
  return AGENT_DEFINITIONS.map((agent) => {
    const evidence: string[] = [];
    for (const binary of agent.binaries) {
      if (commandExists(binary)) evidence.push(`\`${binary}\` on PATH`);
    }
    for (const dir of agent.homeDirs) {
      if (fs.existsSync(path.join(home, dir))) evidence.push(`~/${dir}`);
    }
    for (const dir of agent.projectDirs) {
      if (fs.existsSync(path.join(root, dir))) evidence.push(`${dir}/ in this project`);
    }
    const projectConfigured = targetExists(agent.projectTargets(root));
    const homeConfigured = targetExists(agent.homeTargets(home));
    return {
      id: agent.id,
      name: agent.name,
      installed: evidence.length > 0,
      evidence: [...new Set(evidence)],
      projectConfigured,
      homeConfigured,
      configured: projectConfigured || homeConfigured,
      note: agent.note,
    };
  });
}

export function detectedAgentsOnly(agents: AgentDetection[]): AgentDetection[] {
  return agents.filter((agent) => agent.installed);
}
