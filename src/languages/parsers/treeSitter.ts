import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { findRoutesInFile } from "../../analyzers/routes.js";
import { languageForExtension } from "../adapters.js";
import type { LanguageParser, SourceDependency, SourceStructure, SourceSymbol } from "../types.js";

/**
 * Optional structural parser. Tree-sitter and its grammars are NOT bundled
 * dependencies: if they are installed locally, OpenPitStop uses them; if not,
 * the parser reports unavailable and callers fall back to a labeled heuristic.
 * This keeps install size and native-build risk out of the core package.
 */
const TREE_SITTER_PACKAGES: Record<string, string> = {
  go: "tree-sitter-go",
  java: "tree-sitter-java",
  dotnet: "tree-sitter-c-sharp",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php",
  rust: "tree-sitter-rust",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  kotlin: "tree-sitter-kotlin",
  swift: "tree-sitter-swift",
  dart: "tree-sitter-dart",
};

const requireFromHere = createRequire(import.meta.url);
const parserCache = new Map<string, any>();
const grammarCache = new Map<string, any>();

function canResolve(specifier: string): boolean {
  try {
    requireFromHere.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

async function dynamicImport(specifier: string): Promise<any> {
  // Kept dynamic so the package remains optional for consumers.
  return new Function("specifier", "return import(specifier)")(specifier);
}

async function loadParser(): Promise<any> {
  if (parserCache.has("parser")) return parserCache.get("parser");
  const mod = await dynamicImport("tree-sitter");
  const Parser = mod?.default ?? mod?.Parser ?? mod;
  if (typeof Parser !== "function") throw new Error("tree-sitter did not export a Parser constructor");
  const parser = new Parser();
  parserCache.set("parser", parser);
  return parser;
}

async function loadGrammar(pkg: string): Promise<any> {
  if (grammarCache.has(pkg)) return grammarCache.get(pkg);
  const mod = await dynamicImport(pkg);
  const grammar = mod?.default ?? mod;
  grammarCache.set(pkg, grammar);
  return grammar;
}

function walk(node: any, visit: (node: any) => void): void {
  if (!node) return;
  visit(node);
  const count = node.namedChildCount ?? node.childCount ?? 0;
  for (let index = 0; index < count; index++) {
    walk(node.namedChild?.(index) ?? node.child?.(index), visit);
  }
}

const FUNCTION_TYPES = new Set(["function_definition", "function_declaration", "function_item", "method_declaration", "method_definition"]);
const CLASS_TYPES = new Set(["class_declaration", "class_definition", "class_specifier", "struct_item", "interface_declaration"]);

function symbolKind(type: string): SourceSymbol["kind"] | null {
  if (FUNCTION_TYPES.has(type)) return type.includes("method") ? "method" : "function";
  if (CLASS_TYPES.has(type)) return type === "interface_declaration" ? "interface" : "class";
  return null;
}

export const treeSitterParser: LanguageParser = {
  id: "tree-sitter",
  languages: Object.keys(TREE_SITTER_PACKAGES) as LanguageParser["languages"],
  available: () => canResolve("tree-sitter"),
  async parse(repo, file): Promise<SourceStructure> {
    const relative = path.relative(repo, file).replace(/\\/g, "/");
    const language = languageForExtension(path.extname(file));
    const pkg = language ? TREE_SITTER_PACKAGES[language] ?? null : null;
    if (!pkg || !canResolve(pkg)) {
      return {
        file: relative, language: "unknown", backend: "tree-sitter", parsed: false, structural: true,
        symbols: [], dependencies: [], routes: [], error: "no tree-sitter grammar installed",
      };
    }
    try {
      const parser = await loadParser();
      const grammar = await loadGrammar(pkg);
      parser.setLanguage(grammar);
      const content = fs.readFileSync(file, "utf8");
      const tree = parser.parse(content);
      const symbols: SourceSymbol[] = [];
      const dependencies: SourceDependency[] = [];
      const seen = new Set<string>();
      walk(tree.rootNode, (node) => {
        const kind = symbolKind(node.type);
        if (kind) {
          const nameNode = node.childForFieldName?.("name");
          const name = nameNode?.text ?? "";
          const line = (node.startPosition?.row ?? 0) + 1;
          const key = `${kind}:${name}:${line}`;
          if (name && !seen.has(key)) {
            seen.add(key);
            symbols.push({ name, kind, line });
          }
        }
        if (node.type.includes("import") || node.type === "use_declaration") {
          const text = node.text ?? "";
          const line = (node.startPosition?.row ?? 0) + 1;
          for (const match of text.matchAll(/["']([^"']+)["']/g)) {
            dependencies.push({ specifier: match[1], line, kind: "import" });
          }
        }
      });
      return {
        file: relative,
        language: language as any,
        backend: "tree-sitter",
        parsed: true,
        structural: true,
        symbols,
        dependencies,
        routes: findRoutesInFile(content, path.extname(file)),
      };
    } catch (error) {
      return {
        file: relative, language: "unknown", backend: "tree-sitter", parsed: false, structural: true,
        symbols: [], dependencies: [], routes: [], error: (error as Error).message.slice(0, 300),
      };
    }
  },
};

export function treeSitterGrammarFor(language: string): string | null {
  return TREE_SITTER_PACKAGES[language] ?? null;
}

export function treeSitterAvailable(): boolean {
  return canResolve("tree-sitter");
}

export function treeSitterUsableFor(language: string): boolean {
  const pkg = TREE_SITTER_PACKAGES[language];
  return Boolean(pkg && canResolve("tree-sitter") && canResolve(pkg));
}
