/** Canonical language identifiers shared by every core subsystem. */
export type Language =
  | "js"
  | "python"
  | "java"
  | "go"
  | "dotnet"
  | "php"
  | "ruby"
  | "c"
  | "cpp"
  | "rust"
  | "kotlin"
  | "swift"
  | "dart"
  | "unknown";

export type KnownLanguage = Exclude<Language, "unknown">;

export type LanguageSupportLevel = "detected" | "parsed" | "analyzed" | "verified";
export type InfrastructureKind = "docker" | "terraform" | "kubernetes" | "helm" | "github-actions" | "sql" | "yaml" | "json";

export interface SourceLocation {
  file: string;
  line: number;
  endLine?: number;
}

export interface SourceSymbol {
  name: string;
  kind: "module" | "class" | "function" | "method" | "interface";
  line: number;
  exported?: boolean;
}

export interface SourceDependency {
  specifier: string;
  line: number;
  kind: "import" | "require" | "export-from";
  /** Relative/resolved local path when a parser can prove one. */
  resolved?: string;
}

export interface SourceStructure {
  file: string;
  language: Language;
  backend: "babel" | "python-ast" | "tree-sitter" | "heuristic";
  parsed: boolean;
  symbols: SourceSymbol[];
  dependencies: SourceDependency[];
  routes: { method: string; path: string; line: number }[];
  error?: string;
  /** Explicit distinction between an AST parse and a lightweight lead finder. */
  structural: boolean;
}

export interface LanguageParser {
  id: string;
  languages: KnownLanguage[];
  available(repo: string): boolean;
  parse(repo: string, file: string): Promise<SourceStructure>;
}

export interface LanguageTestCommand {
  layer: "unit" | "integration" | "e2e";
  name: string;
  command: string;
  args: string[];
  /** The tool must be on PATH, or the repository must supply this file. */
  binary: string;
  wrapper?: string;
  evidence: string[];
}

export interface LanguageAdapter {
  id: KnownLanguage;
  displayName: string;
  priority: "first" | "second" | "third";
  markers: string[];
  nestedMarkers?: string[];
  extensions: string[];
  dependencyFiles: string[];
  entryPoints: string[];
  packageManagers?: string[];
  frameworkFiles?: Record<string, string[]>;
  test?: LanguageTestCommand;
  build?: { command: string; args: string[]; binary: string; evidence: string[] };
  /** Analyzer coverage is a repository fact, not an extension match. */
  analysis: {
    dependencyGraph: boolean;
    staticSecurity: boolean;
    semgrepLanguages: string[];
  };
}

export interface InfrastructureAdapter {
  id: InfrastructureKind;
  displayName: string;
  files: string[];
  extensions?: string[];
}

export interface DetectedLanguage {
  id: Language;
  displayName: string;
  files: number;
  evidence: string[];
  primary: boolean;
}

export interface DetectedInfrastructure {
  id: InfrastructureKind;
  displayName: string;
  files: string[];
}

export interface LanguageToolPlan {
  tool: "tree-sitter" | "semgrep" | "codeql" | "osv-scanner" | "gitleaks" | "trivy" | "checkov";
  relevant: boolean;
  available: boolean;
  enabled: boolean;
  reason: string;
  evidence: string[];
}

export interface LanguageAnalysisFile {
  file: string;
  language: Language;
  status: "parsed" | "heuristic" | "skipped" | "failed";
  backend?: string;
  symbols: SourceSymbol[];
  dependencies: SourceDependency[];
  routes: { method: string; path: string; line: number }[];
  note?: string;
}

export interface LanguageSupport {
  id: Language;
  displayName: string;
  priority?: string;
  files: number;
  evidence: string[];
  level: LanguageSupportLevel;
  parser: { status: "available" | "unavailable" | "not-run" | "failed"; backend?: string; note: string };
  analysis: { status: "available" | "partial" | "unavailable"; note: string };
  /** Verification is an evidence outcome; none is inferred from an extension. */
  verification: { status: "unproven" | "verified" | "failed"; note: string };
  tests: string[];
  build: string[];
  frameworks: string[];
  dependencies: string[];
  entryPoints: string[];
}

export interface LanguageAnalysis {
  schemaVersion: 1;
  repo: string;
  generatedAt: string;
  primaryLanguage: Language;
  languages: DetectedLanguage[];
  infrastructure: DetectedInfrastructure[];
  support: LanguageSupport[];
  files: LanguageAnalysisFile[];
  tools: LanguageToolPlan[];
  limits: { maxFiles: number; skippedFiles: number };
}
