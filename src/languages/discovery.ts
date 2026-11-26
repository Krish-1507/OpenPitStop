import fs from "node:fs";
import path from "node:path";
import { INFRASTRUCTURE_ADAPTERS, LANGUAGE_ADAPTERS, adapterFor, languageForExtension } from "./adapters.js";
import { detectLanguage, walkFiles } from "../analyzers/util.js";
import type { DetectedInfrastructure, DetectedLanguage, Language } from "./types.js";

export const LANGUAGE_FILE_LIMIT = 80;
const GENERATED_EXTENSIONS = new Set([".lock", ".map"]);

function isGeneratedSource(file: string): boolean {
  return GENERATED_EXTENSIONS.has(path.extname(file)) || file.endsWith(".min.js");
}

/** Language evidence is based on real repository files and root markers. */
export function discoverLanguages(repoInput: string): {
  primary: Language;
  languages: DetectedLanguage[];
  infrastructure: DetectedInfrastructure[];
} {
  const repo = path.resolve(repoInput);
  const primary = detectLanguage(repo);
  const languages: DetectedLanguage[] = [];
  for (const adapter of LANGUAGE_ADAPTERS) {
    const files = walkFiles(repo, adapter.extensions).filter((file) => !isGeneratedSource(file));
    const evidence = adapter.markers.filter((marker) => fs.existsSync(path.join(repo, marker)));
    const nested = adapter.nestedMarkers ? walkFiles(repo, adapter.nestedMarkers) : [];
    evidence.push(...nested.map((file) => path.relative(repo, file).replace(/\\/g, "/")));
    if (files.length === 0 && evidence.length === 0) continue;
    languages.push({
      id: adapter.id,
      displayName: adapter.displayName,
      files: files.length,
      evidence: [...evidence, ...(files.length > 0 ? [`${files.length} source file(s)`] : [])],
      primary: primary === adapter.id,
    });
  }
  // Keep the historical unknown result: no marker and no recognized sources.
  if (languages.length === 0 && primary === "unknown") {
    languages.push({ id: "unknown", displayName: "Unknown", files: 0, evidence: [], primary: true });
  }
  return { primary, languages, infrastructure: discoverInfrastructure(repo) };
}

export function discoverInfrastructure(repo: string): DetectedInfrastructure[] {
  return INFRASTRUCTURE_ADAPTERS.flatMap((adapter) => {
    let files: string[] = [];
    if (adapter.id === "github-actions") {
      const directory = path.join(repo, ".github", "workflows");
      try {
        files = fs.readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
          .map((entry) => path.join(directory, entry.name));
      } catch { /* no workflows */ }
    } else if (adapter.id === "kubernetes") {
      files = walkFiles(repo, [".yaml", ".yml"]).filter(isKubernetesManifest);
    } else {
      files = adapter.files
        .map((file) => path.join(repo, file))
        .filter((file) => fs.existsSync(file));
      if (adapter.extensions?.length) files.push(...walkFiles(repo, adapter.extensions));
      files = [...new Set(files)];
    }
    files = files.filter((file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    }).slice(0, 50);
    return files.length === 0 ? [] : [{
      id: adapter.id,
      displayName: adapter.displayName,
      files: files.map((file) => path.relative(repo, file).replace(/\\/g, "/")),
    }];
  });
}

function isKubernetesManifest(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  if (/(?:^|[./])(?:chart|values)(?:[.-]|\.)/.test(base) || /(?:^|[/\\])charts[/\\]/.test(file)) return false;
  if (/(?:^|[/\\])\.github[/\\]workflows[/\\]/.test(file)) return false;
  try {
    const content = fs.readFileSync(file, "utf8").slice(0, 20000);
    return /^apiVersion\s*:\s*[^\s]+/m.test(content) && /^kind\s*:\s*\w+/m.test(content);
  } catch { return false; }
}

export function languageForFile(file: string): Language {
  return languageForExtension(path.extname(file)) ?? "unknown";
}

export function sourceFiles(repo: string, language: Language): string[] {
  const adapter = adapterFor(language);
  return adapter ? walkFiles(repo, adapter.extensions) : [];
}
