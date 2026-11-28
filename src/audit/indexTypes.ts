import type { Language } from "../languages/types.js";

/**
 * audit/indexTypes.ts — serializable repository-index shapes.
 *
 * These types are shared by the parser, the rules and the report. They stay
 * free of Babel nodes so an index can be cached and re-read without trusting
 * anything executable.
 */

export interface JsCall {
  name: string;
  object?: string;
  line: number;
  endLine: number;
  args: string[];
  awaited: boolean;
  statement: boolean;
  inLoop: boolean;
}

export interface JsLoop {
  kind: string;
  line: number;
  endLine: number;
  awaits: number;
  calls: { name: string; object?: string; line: number }[];
}

export interface JsFunction {
  name: string;
  kind: "function" | "method" | "arrow";
  line: number;
  endLine: number;
  loc: number;
  params: string[];
  async: boolean;
  exported: boolean;
  cyclomatic: number;
  maxDepth: number;
  awaits: number;
  calls: JsCall[];
  loops: JsLoop[];
  tokens: string[];
  parent?: string;
}

export interface JsImportBinding {
  local: string;
  imported: string;
  typeOnly: boolean;
}

export interface JsImport {
  specifier: string;
  line: number;
  start: number;
  end: number;
  bindings: JsImportBinding[];
  sideEffect: boolean;
  // A re-export consumes the target module even though this file is not a
  // runtime importer. `star` means every target export may flow through.
  reExport?: "star" | "named";
}

export interface JsExport {
  name: string;
  line: number;
  isDefault: boolean;
}

export interface JsCatch {
  line: number;
  endLine: number;
  empty: boolean;
  onlyLogs: boolean;
}

export interface JsTest {
  name: string;
  line: number;
  endLine: number;
  hasAssertion: boolean;
  skipped: boolean;
}

export interface JsRoute {
  method: string;
  routePath: string;
  line: number;
  handlerName?: string;
  handlerLine?: number;
}

export interface JsLiteral {
  value: string;
  line: number;
  inFunction: boolean;
}

export interface JsNumber {
  value: number;
  line: number;
  inFunction: boolean;
}

export interface JsRegex {
  pattern: string;
  flags: string;
  line: number;
  dynamic: boolean;
}

export interface JsFileIndex {
  file: string;
  parseOk: boolean;
  error?: string;
  lines: number;
  functions: JsFunction[];
  imports: JsImport[];
  exports: JsExport[];
  calls: JsCall[];
  routes: JsRoute[];
  tests: JsTest[];
  catches: JsCatch[];
  strings: JsLiteral[];
  numbers: JsNumber[];
  regexes: JsRegex[];
  anyCount: number;
  anyLines: number[];
  nonNullCount: number;
  nonNullLines: number[];
  typeIgnoreLines: number[];
  looseEquality: { line: number; operator: string }[];
  usedNames: string[];
}

export interface PythonFunction {
  name: string;
  line: number;
  endLine: number;
  loc: number;
  async: boolean;
  cyclomatic: number;
  awaits: number;
  calls: { name: string; line: number }[];
  inLoopCalls: { name: string; line: number }[];
  hasAssert: boolean;
}

export interface PythonFileIndex {
  file: string;
  lines: number;
  functions: PythonFunction[];
  imports: { specifier: string; line: number }[];
  broadExcept: { line: number; endLine: number; empty: boolean }[];
  strings: JsLiteral[];
  numbers: JsNumber[];
  calls: { name: string; line: number }[];
  tests: { name: string; line: number; hasAssertion: boolean; skipped: boolean }[];
  usedNames: string[];
}

export interface AuditSourceFile {
  /** Repo-relative, forward-slash path. */
  file: string;
  abs: string;
  language: Language;
  content: string;
  lines: number;
  js?: JsFileIndex;
  python?: PythonFileIndex;
}

export interface ExecutionStep {
  file: string;
  name: string;
  line: number;
}

export interface ExecutionPath {
  route: string;
  method: string;
  handler: string;
  file: string;
  depth: number;
  steps: ExecutionStep[];
}

export interface RepoIndex {
  repo: string;
  files: AuditSourceFile[];
  functions: (JsFunction & { file: string })[];
  edges: Map<string, Set<string>>;
  reverseEdges: Map<string, Set<string>>;
  cycles: string[][];
  routes: (JsRoute & { file: string })[];
  executionPaths: ExecutionPath[];
  tests: { file: string; name: string; line: number; hasAssertion: boolean; skipped: boolean }[];
  testsByFile: Map<string, number>;
  imports: { file: string; specifier: string; line: number; resolved?: string }[];
  warnings: string[];
  /** Files that matched the scope and language filter before the budget. */
  discovered: number;
  skipped: number;
  stats: { parsed: number; semantic: number; functions: number; calls: number; resolvedCalls: number };
}
