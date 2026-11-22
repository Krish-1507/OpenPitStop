import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import type { LanguageParser, SourceDependency, SourceStructure, SourceSymbol } from "../types.js";

const EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

function walk(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value === "object" && "type" in (value as object)) walk(value, visit);
  }
}

function nameOf(node: any): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "MemberExpression") return `${nameOf(node.object)}.${nameOf(node.property)}`;
  return "";
}

export function parseJavaScriptSource(repo: string, file: string): SourceStructure {
  const relative = path.relative(repo, file).replace(/\\/g, "/");
  const content = fs.readFileSync(file, "utf8");
  const symbols: SourceSymbol[] = [];
  const dependencies: SourceDependency[] = [];
  const routes: { method: string; path: string; line: number }[] = [];
  const seen = new Set<string>();
  const pushSymbol = (name: string, kind: SourceSymbol["kind"], node: any, exported = false) => {
    if (!name) return;
    const line = node.loc?.start?.line ?? 1;
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name, kind, line, exported });
  };

  const ast = parse(content, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins: ["typescript", "jsx", "decorators-legacy", "classProperties", "importAttributes"],
  });

  for (const statement of ast.program.body) {
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      const declaration: any = statement.declaration;
      if (!declaration) continue;
      if (declaration.type === "FunctionDeclaration") pushSymbol(declaration.id?.name ?? "default", "function", declaration, true);
      else if (declaration.type === "ClassDeclaration") pushSymbol(declaration.id?.name ?? "default", "class", declaration, true);
      else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) pushSymbol(nameOf(declarator.id), "function", declarator, true);
      }
    }
  }

  walk(ast.program, (node) => {
    if (node.type === "ImportDeclaration") {
      dependencies.push({
        specifier: String(node.source?.value ?? ""),
        line: node.loc?.start?.line ?? 1,
        kind: "import",
      });
    } else if (node.type === "ExportNamedDeclaration" && node.source) {
      dependencies.push({
        specifier: String(node.source.value ?? ""),
        line: node.loc?.start?.line ?? 1,
        kind: "export-from",
      });
    } else if (node.type === "CallExpression" && node.callee?.name === "require" && node.arguments?.[0]?.value) {
      dependencies.push({
        specifier: String(node.arguments[0].value),
        line: node.loc?.start?.line ?? 1,
        kind: "require",
      });
    } else if (node.type === "FunctionDeclaration" && node.id?.name) {
      pushSymbol(node.id.name, "function", node);
    } else if (node.type === "ClassDeclaration" && node.id?.name) {
      pushSymbol(node.id.name, "class", node);
    } else if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init?.type === "ArrowFunctionExpression") {
      pushSymbol(node.id.name, "function", node);
    } else if (["ClassMethod", "ObjectMethod"].includes(node.type) && node.key) {
      pushSymbol(nameOf(node.key), "method", node);
    } else if (node.type === "TSInterfaceDeclaration" && node.id?.name) {
      pushSymbol(node.id.name, "interface", node);
    } else if (node.type === "CallExpression") {
      const callee = node.callee;
      if (callee?.type === "MemberExpression" && callee.property?.name) {
        const method = String(callee.property.name).toUpperCase();
        const route = node.arguments?.[0]?.value;
        if (["GET", "POST", "PUT", "PATCH", "DELETE", "ALL"].includes(method) && typeof route === "string" && route.startsWith("/")) {
          routes.push({ method, path: route, line: node.loc?.start?.line ?? 1 });
        }
      }
    }
  });

  return {
    file: relative,
    language: "js",
    backend: "babel",
    parsed: true,
    structural: true,
    symbols,
    dependencies,
    routes,
  };
}

export const babelParser: LanguageParser = {
  id: "babel",
  languages: ["js"],
  available: () => true,
  async parse(repo, file) {
    try {
      return parseJavaScriptSource(repo, file);
    } catch (error) {
      return {
        file: path.relative(repo, file).replace(/\\/g, "/"),
        language: "js",
        backend: "babel",
        parsed: false,
        structural: true,
        symbols: [],
        dependencies: [],
        routes: [],
        error: (error as Error).message,
      };
    }
  },
};

export function isJavaScriptFile(file: string): boolean {
  return EXTENSIONS.has(path.extname(file));
}

