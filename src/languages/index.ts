import fs from "node:fs";
import path from "node:path";
import { commandExists } from "../analyzers/util.js";
import { adapterFor, languageDisplayName } from "./adapters.js";
import { discoverLanguages, LANGUAGE_FILE_LIMIT, sourceFiles } from "./discovery.js";
import { babelParser } from "./parsers/babelJs.js";
import { heuristicParser } from "./parsers/heuristic.js";
import { pythonParser } from "./parsers/pythonAst.js";
import { treeSitterParser, treeSitterGrammarFor, treeSitterUsableFor } from "./parsers/treeSitter.js";
import { planLanguageTools } from "./tools.js";
import type {
  DetectedLanguage,
  Language,
  LanguageAnalysis,
  LanguageAnalysisFile,
  LanguageParser,
  LanguageSupport,
} from "./types.js";

/**
 * Phase 2 language layer. Detection and parsing are local and deterministic;
 * optional parsers never turn an unavailable grammar into a structural claim.
 */
export async function analyzeLanguages(repoInput: string): Promise<LanguageAnalysis> {
  const repo = path.resolve(repoInput);
  const discovered = discoverLanguages(repo);
  const tools = planLanguageTools(repo, discovered.languages, discovered.infrastructure);
  const files: LanguageAnalysisFile[] = [];
  let skippedFiles = 0;

  for (const language of discovered.languages) {
    if (language.id === "unknown") continue;
    const parser = chooseParser(language.id);
    const sources = prioritize(repo, language, sourceFiles(repo, language.id));
    const selected = sources.slice(0, LANGUAGE_FILE_LIMIT);
    skippedFiles += Math.max(0, sources.length - selected.length);
    for (const file of selected) {
      try {
        const result = await parser.parse(repo, file);
        files.push({
          file: result.file,
          language: result.language,
          status: result.parsed ? "parsed" : result.error ? "failed" : "heuristic",
          backend: result.backend,
          symbols: result.symbols,
          dependencies: result.dependencies,
          routes: result.routes,
          note: result.error ?? (result.structural ? undefined : "heuristic lead finder; not a structural parse"),
        });
      } catch (error) {
        files.push({
          file: path.relative(repo, file).replace(/\\/g, "/"),
          language: language.id,
          status: "failed",
          backend: parser.id,
          symbols: [],
          dependencies: [],
          routes: [],
          note: (error as Error).message.slice(0, 300),
        });
      }
    }
  }

  return {
    schemaVersion: 1,
    repo,
    generatedAt: new Date().toISOString(),
    primaryLanguage: discovered.primary,
    languages: discovered.languages,
    infrastructure: discovered.infrastructure,
    support: discovered.languages.map((language) => supportFor(repo, language, files, tools)),
    files,
    tools,
    limits: { maxFiles: LANGUAGE_FILE_LIMIT, skippedFiles },
  };
}

function chooseParser(language: Language): LanguageParser {
  if (language === "js") return babelParser;
  if (language === "python") return pythonParser.available("") ? pythonParser : heuristicParser;
  const grammar = treeSitterGrammarFor(language);
  if (grammar && treeSitterUsableFor(language)) return treeSitterParser;
  return heuristicParser;
}

function prioritize(repo: string, language: DetectedLanguage, files: string[]): string[] {
  const adapter = adapterFor(language.id);
  const entries = new Set(adapter?.entryPoints ?? []);
  return [...files].sort((a, b) => {
    const ar = path.relative(repo, a).replace(/\\/g, "/");
    const br = path.relative(repo, b).replace(/\\/g, "/");
    const ae = [...entries].some((entry) => ar === entry || ar.startsWith(`${entry}/`));
    const be = [...entries].some((entry) => br === entry || br.startsWith(`${entry}/`));
    if (ae !== be) return ae ? -1 : 1;
    return ar.localeCompare(br);
  });
}

function supportFor(
  repo: string,
  detected: DetectedLanguage,
  allFiles: LanguageAnalysisFile[],
  tools: ReturnType<typeof planLanguageTools>,
): LanguageSupport {
  const language = detected.id;
  const adapter = adapterFor(language);
  const files = allFiles.filter((file) => file.language === language);
  const parsed = files.filter((file) => file.status === "parsed");
  const heuristics = files.filter((file) => file.status === "heuristic");
  const failed = files.filter((file) => file.status === "failed");
  const parser = adapter?.analysis.staticSecurity
    ? {
        status: parsed.length > 0 ? "available" as const : failed.length > 0 ? "failed" as const : "not-run" as const,
        backend: parsed[0]?.backend,
        note: parsed.length > 0
          ? `${parsed.length} structurally parsed, ${heuristics.length} heuristic, ${failed.length} failed`
          : failed.length > 0
            ? `${failed.length} file(s) could not be parsed: ${failed[0].note ?? "unknown error"}`
            : "no source file selected",
      }
    : { status: "unavailable" as const, note: "no structural parser for this language" };

  const analysisStatus = parsed.length > 0 && adapter?.analysis.staticSecurity ? "available" as const
    : heuristics.length > 0 ? "partial" as const
      : "unavailable" as const;
  const level = analysisStatus === "available"
    ? "analyzed" as const
    : parsed.length > 0 ? "parsed" as const : "detected" as const;
  const treeSitter = tools.find((tool) => tool.tool === "tree-sitter");
  const analysisNote = analysisStatus === "available"
    ? "offline static security is available; dependency audit depends on manifests and installed tools"
    : analysisStatus === "partial"
      ? `parser unavailable; ${heuristics.length} file(s) are heuristic leads only`
      : "no source analysis was possible";

  return {
    id: language,
    displayName: languageDisplayName(language),
    priority: adapter?.priority,
    files: detected.files,
    evidence: detected.evidence,
    level,
    parser,
    analysis: { status: analysisStatus, note: analysisNote },
    verification: {
      status: "unproven",
      note: "no supported reproduction or independently verified fix in this run",
    },
    tests: testCommands(repo, language),
    build: buildCommands(repo, language),
    frameworks: frameworksFor(repo, language),
    dependencies: (adapter?.dependencyFiles ?? []).filter((file) => !file.includes("*") && fs.existsSync(path.join(repo, file))),
    entryPoints: entryPointsFor(repo, language),
  };
}

function entryPointsFor(repo: string, language: Language): string[] {
  const adapter = adapterFor(language);
  const found = new Set((adapter?.entryPoints ?? []).filter((file) => fs.existsSync(path.join(repo, file))));
  if (language === "js") {
    const pkg = readPackage(repo);
    if (typeof pkg?.main === "string") found.add(pkg.main);
    if (typeof pkg?.bin === "string") found.add(pkg.bin);
    else if (pkg?.bin && typeof pkg.bin === "object") {
      for (const value of Object.values(pkg.bin)) if (typeof value === "string") found.add(value);
    }
    for (const file of ["src/cli.ts", "src/cli.js", "cli.ts", "cli.js"]) {
      if (fs.existsSync(path.join(repo, file))) found.add(file);
    }
  }
  return [...found].filter((file) => fs.existsSync(path.join(repo, file))).slice(0, 12);
}

function packageManager(repo: string): string {
  if (fs.existsSync(path.join(repo, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repo, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(repo, "bun.lockb")) || fs.existsSync(path.join(repo, "bun.lock"))) return "bun";
  return "npm";
}

function readPackage(repo: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function testCommands(repo: string, language: Language): string[] {
  const adapter = adapterFor(language);
  if (!adapter) return [];
  if (language === "js") {
    const pkg = readPackage(repo);
    const manager = packageManager(repo);
    if (typeof pkg?.scripts?.test === "string") return [`${manager} test`];
    return commandExists("node") ? ["node --test"] : [];
  }
  if (!adapter.test) return [];
  if (adapter.test.wrapper && fs.existsSync(path.join(repo, adapter.test.wrapper))) return [`${adapter.test.wrapper} ${adapter.test.args.join(" ")}`];
  const evidence = adapter.test.evidence.some((file) => fs.existsSync(path.join(repo, file)));
  return commandExists(adapter.test.binary) || evidence
    ? [`${adapter.test.name}`]
    : [];
}

function buildCommands(repo: string, language: Language): string[] {
  const adapter = adapterFor(language);
  if (!adapter) return [];
  if (language === "js") {
    const pkg = readPackage(repo);
    return typeof pkg?.scripts?.build === "string" ? [`${packageManager(repo)} run build`] : [];
  }
  return adapter.build && commandExists(adapter.build.binary) ? [`${adapter.build.command} ${adapter.build.args.join(" ")}`] : [];
}

const FRAMEWORK_DEPS: Record<string, string> = {
  express: "Express", fastify: "Fastify", koa: "Koa", "@nestjs/core": "NestJS", next: "Next.js",
  react: "React", vue: "Vue", svelte: "Svelte", "@angular/core": "Angular", typescript: "TypeScript",
  jest: "Jest", vitest: "Vitest", playwright: "Playwright", cypress: "Cypress", prisma: "Prisma",
  django: "Django", flask: "Flask", fastapi: "FastAPI", rails: "Rails", laravel: "Laravel",
  spring: "Spring", "spring-boot": "Spring Boot",
};

function frameworksFor(repo: string, language: Language): string[] {
  const found = new Set<string>();
  const pkg = readPackage(repo);
  if (pkg && language === "js") {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const dependency of Object.keys(deps)) if (FRAMEWORK_DEPS[dependency]) found.add(FRAMEWORK_DEPS[dependency]);
  }
  if (language === "python") {
    for (const file of ["requirements.txt", "pyproject.toml", "setup.py"]) {
      try {
        const text = fs.readFileSync(path.join(repo, file), "utf8").toLowerCase();
        for (const name of ["django", "flask", "fastapi", "pytest"]) if (text.includes(name)) found.add(FRAMEWORK_DEPS[name]);
      } catch { /* missing file */ }
    }
  }
  if (language === "ruby" && fs.existsSync(path.join(repo, "config", "application.rb"))) found.add("Rails");
  if (language === "php" && fs.existsSync(path.join(repo, "artisan"))) found.add("Laravel");
  return [...found].sort();
}
