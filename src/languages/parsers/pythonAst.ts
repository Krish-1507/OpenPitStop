import path from "node:path";
import { safeExec, safeExecAsync } from "../../analyzers/util.js";
import type { LanguageParser, SourceDependency, SourceStructure, SourceSymbol } from "../types.js";

/**
 * Uses the repository's Python interpreter only as a parser. No project code is
 * imported or executed: the script reads one file text and prints a JSON AST
 * summary, so a malicious module body cannot run during analysis.
 */
const SCRIPT = String.raw`
import ast, json, sys
try:
    source = open(sys.argv[1], encoding="utf-8").read()
    tree = ast.parse(source)
except SyntaxError as error:
    print(json.dumps({"error": "syntax error at line %s: %s" % (error.lineno, error.msg)}))
    sys.exit(0)
except Exception as error:
    print(json.dumps({"error": str(error)}))
    sys.exit(0)
symbols, dependencies, routes = [], [], []
for node in ast.walk(tree):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        symbols.append({"name": node.name, "kind": "function", "line": node.lineno})
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            func = call.func if call else decorator
            if isinstance(func, ast.Attribute) and func.attr in ("get", "post", "put", "patch", "delete", "route") and call and call.args:
                arg = call.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    method = "POST" if func.attr == "route" else func.attr.upper()
                    routes.append({"method": method, "path": arg.value, "line": node.lineno})
    elif isinstance(node, ast.ClassDef):
        symbols.append({"name": node.name, "kind": "class", "line": node.lineno})
    elif isinstance(node, ast.Import):
        for alias in node.names:
            dependencies.append({"specifier": alias.name, "line": node.lineno, "kind": "import"})
    elif isinstance(node, ast.ImportFrom):
        dependencies.append({"specifier": ("." * (node.level or 0)) + (node.module or ""), "line": node.lineno, "kind": "import"})
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ("path", "re_path") and node.args:
        arg = node.args[0]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            routes.append({"method": "POST", "path": arg.value, "line": node.lineno})
print(json.dumps({"symbols": symbols[:400], "dependencies": dependencies[:400], "routes": routes[:200]}))
`;

let pythonCache: string | null | undefined;

/** Probe the interpreter; a Windows Store alias exists but cannot run code. */
function pythonBinary(): string | null {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = [process.env.PITSTOP_PYTHON?.trim(), "python3", "python"].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const probe = safeExec(candidate, ["-c", "import json, sys"], process.cwd(), 5000);
    if (probe.code === 0) {
      pythonCache = candidate;
      return candidate;
    }
  }
  pythonCache = null;
  return null;
}

export const pythonParser: LanguageParser = {
  id: "python-ast",
  languages: ["python"],
  available: () => pythonBinary() !== null,
  async parse(repo, file) {
    const relative = path.relative(repo, file).replace(/\\/g, "/");
    const binary = pythonBinary();
    if (!binary) {
      return {
        file: relative, language: "python", backend: "python-ast", parsed: false, structural: true,
        symbols: [], dependencies: [], routes: [], error: "python interpreter not found",
      };
    }
    const result = await safeExecAsync(binary, ["-c", SCRIPT, file], repo, 30000);
    let payload: any;
    try {
      payload = JSON.parse(result.stdout.trim());
    } catch {
      return {
        file: relative, language: "python", backend: "python-ast", parsed: false, structural: true,
        symbols: [], dependencies: [], routes: [],
        error: (result.stderr || result.stdout || "python parser produced no JSON").slice(0, 300),
      };
    }
    if (payload.error) {
      return {
        file: relative, language: "python", backend: "python-ast", parsed: false, structural: true,
        symbols: [], dependencies: [], routes: [], error: String(payload.error),
      };
    }
    return {
      file: relative,
      language: "python",
      backend: "python-ast",
      parsed: true,
      structural: true,
      symbols: (payload.symbols ?? []) as SourceSymbol[],
      dependencies: (payload.dependencies ?? []) as SourceDependency[],
      routes: payload.routes ?? [],
    };
  },
};
