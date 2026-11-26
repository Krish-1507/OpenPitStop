import fs from "node:fs";
import path from "node:path";
import { findRoutesInFile } from "../../analyzers/routes.js";
import { languageForExtension } from "../adapters.js";
import type { LanguageParser, SourceDependency, SourceStructure, SourceSymbol } from "../types.js";

const SYMBOL_PATTERNS: Array<{ re: RegExp; kind: SourceSymbol["kind"] }> = [
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm, kind: "function" },
  { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, kind: "class" },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gm, kind: "interface" },
  { re: /^\s*def\s+([A-Za-z_]\w*)/gm, kind: "function" },
  { re: /^\s*class\s+([A-Za-z_]\w*)/gm, kind: "class" },
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, kind: "function" },
  { re: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm, kind: "function" },
  { re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:class|interface)\s+([A-Za-z_]\w*)/gm, kind: "class" },
  { re: /^\s*(?:type\s+)?([A-Za-z_]\w*)\s+(?:struct|interface)\s*\{/gm, kind: "class" },
];

/** Explicitly a lead finder, not a structural parse. */
export const heuristicParser: LanguageParser = {
  id: "heuristic",
  languages: ["python", "go", "java", "dotnet", "php", "ruby", "c", "cpp", "rust", "kotlin", "swift", "dart"],
  available: () => true,
  async parse(repo, file): Promise<SourceStructure> {
    const relative = path.relative(repo, file).replace(/\\/g, "/");
    const language = languageForExtension(path.extname(file));
    let content = "";
    try {
      const stat = fs.statSync(file);
      if (stat.size > 1_000_000) {
        return {
          file: relative, language: language ?? "unknown", backend: "heuristic", parsed: false, structural: false,
          symbols: [], dependencies: [], routes: [], error: "file too large for heuristic scan",
        };
      }
      content = fs.readFileSync(file, "utf8");
    } catch (error) {
      return {
        file: relative, language: language ?? "unknown", backend: "heuristic", parsed: false, structural: false,
        symbols: [], dependencies: [], routes: [], error: (error as Error).message,
      };
    }
    const symbols: SourceSymbol[] = [];
    const seen = new Set<string>();
    for (const { re, kind } of SYMBOL_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const name = match[1];
        const line = content.slice(0, match.index).split("\n").length;
        const key = `${kind}:${name}:${line}`;
        if (!seen.has(key)) {
          seen.add(key);
          symbols.push({ name, kind, line });
        }
      }
    }
    const dependencies: SourceDependency[] = [];
    const importRe = /^\s*(?:import|use|require|from)\b[^\n]*?["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(content)) !== null) {
      dependencies.push({
        specifier: match[1],
        line: content.slice(0, match.index).split("\n").length,
        kind: "import",
      });
    }
    return {
      file: relative,
      language: language ?? "unknown",
      backend: "heuristic",
      parsed: false,
      structural: false,
      symbols,
      dependencies,
      routes: findRoutesInFile(content, path.extname(file)),
    };
  },
};
