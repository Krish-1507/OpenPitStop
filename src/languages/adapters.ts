import type { InfrastructureAdapter, KnownLanguage, Language, LanguageAdapter } from "./types.js";

/**
 * Canonical language adapters. Core code never infers support from a file
 * extension alone: each adapter declares its evidence and analyzer coverage.
 * Optional tools are discovered at runtime; missing tools never become passes.
 */
export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  {
    id: "js", displayName: "JavaScript / TypeScript", priority: "first",
    markers: ["package.json"], extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"],
    dependencyFiles: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
    entryPoints: ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.js", "src/index.js", "server.ts", "server.js", "app.ts", "app.js"],
    packageManagers: ["npm", "pnpm", "yarn", "bun"],
    test: { layer: "unit", name: "node:test", command: "node", args: ["--test"], binary: "node", evidence: ["package.json"] },
    build: { command: "npm", args: ["run", "build"], binary: "npm", evidence: ["package.json"] },
    analysis: { dependencyGraph: true, staticSecurity: true, semgrepLanguages: ["javascript", "typescript"] },
  },
  {
    id: "python", displayName: "Python", priority: "first",
    markers: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "poetry.lock"],
    extensions: [".py"],
    dependencyFiles: ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock"],
    entryPoints: ["main.py", "app.py", "manage.py", "src/main.py", "src/app.py"],
    packageManagers: ["pip", "poetry", "uv", "pipenv"],
    test: { layer: "unit", name: "pytest", command: "pytest", args: ["-q"], binary: "pytest", evidence: ["pytest.ini", "pyproject.toml", "conftest.py", "tests"] },
    analysis: { dependencyGraph: true, staticSecurity: true, semgrepLanguages: ["python"] },
  },
  {
    id: "java", displayName: "Java", priority: "second",
    markers: ["pom.xml", "build.gradle"], extensions: [".java"],
    dependencyFiles: ["pom.xml", "build.gradle", "build.gradle.kts", "gradle.lockfile"],
    entryPoints: ["src/main/java", "app/src/main/java"],
    test: { layer: "unit", name: "maven", command: "mvn", args: ["test"], binary: "mvn", wrapper: "mvnw", evidence: ["pom.xml"] },
    build: { command: "mvn", args: ["package", "-DskipTests"], binary: "mvn", evidence: ["pom.xml"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["java"] },
  },
  {
    id: "go", displayName: "Go", priority: "second",
    markers: ["go.mod"], extensions: [".go"], dependencyFiles: ["go.mod", "go.sum"],
    entryPoints: ["main.go", "cmd"],
    packageManagers: ["go modules"],
    test: { layer: "unit", name: "go test", command: "go", args: ["test", "./..."], binary: "go", evidence: ["go.mod"] },
    build: { command: "go", args: ["build", "./..."], binary: "go", evidence: ["go.mod"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["go"] },
  },
  {
    id: "dotnet", displayName: "C# / .NET", priority: "second",
    markers: [], nestedMarkers: [".csproj", ".fsproj", ".vbproj", ".sln"], extensions: [".cs", ".fs", ".vb"],
    dependencyFiles: ["packages.lock.json", "Directory.Packages.props", "*.csproj", "*.sln"],
    entryPoints: ["Program.cs"], packageManagers: ["NuGet"],
    test: { layer: "unit", name: "dotnet test", command: "dotnet", args: ["test"], binary: "dotnet", evidence: [".csproj", ".sln"] },
    build: { command: "dotnet", args: ["build"], binary: "dotnet", evidence: [".csproj", ".sln"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["csharp"] },
  },
  {
    id: "php", displayName: "PHP", priority: "second",
    markers: ["composer.json"], extensions: [".php", ".phtml"],
    dependencyFiles: ["composer.json", "composer.lock"], entryPoints: ["public/index.php", "index.php", "artisan"],
    packageManagers: ["composer"],
    frameworkFiles: { Laravel: ["artisan"], Symfony: ["symfony.lock"] },
    test: { layer: "unit", name: "phpunit", command: "vendor/bin/phpunit", args: [], binary: "vendor/bin/phpunit", evidence: ["phpunit.xml", "phpunit.xml.dist"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["php"] },
  },
  {
    id: "ruby", displayName: "Ruby", priority: "second",
    markers: ["Gemfile"], extensions: [".rb", ".rake"],
    dependencyFiles: ["Gemfile", "Gemfile.lock", "*.gemspec"], entryPoints: ["config.ru", "app.rb", "bin/rails", "lib"],
    packageManagers: ["bundler"],
    frameworkFiles: { Rails: ["config/application.rb", "bin/rails"] },
    test: { layer: "unit", name: "rails test", command: "bundle", args: ["exec", "rails", "test"], binary: "bundle", evidence: ["bin/rails", "config/application.rb"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["ruby"] },
  },
  {
    id: "c", displayName: "C", priority: "third",
    // .h is ambiguous between C and C++; it never proves either language.
    markers: [], extensions: [".c"],
    dependencyFiles: ["conanfile.txt", "conanfile.py", "vcpkg.json"], entryPoints: ["main.c", "src/main.c"],
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["c"] },
  },
  {
    id: "cpp", displayName: "C++", priority: "third",
    markers: [], extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
    dependencyFiles: ["conanfile.txt", "conanfile.py", "vcpkg.json"], entryPoints: ["main.cpp", "src/main.cpp"],
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["cpp"] },
  },
  {
    id: "rust", displayName: "Rust", priority: "third",
    markers: ["Cargo.toml"], extensions: [".rs"], dependencyFiles: ["Cargo.toml", "Cargo.lock"],
    entryPoints: ["src/main.rs", "src/lib.rs"], packageManagers: ["cargo"],
    test: { layer: "unit", name: "cargo test", command: "cargo", args: ["test"], binary: "cargo", evidence: ["Cargo.toml"] },
    build: { command: "cargo", args: ["build"], binary: "cargo", evidence: ["Cargo.toml"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["rust"] },
  },
  {
    id: "kotlin", displayName: "Kotlin", priority: "third",
    markers: [], extensions: [".kt", ".kts"], dependencyFiles: ["build.gradle.kts", "settings.gradle.kts"],
    entryPoints: ["src/main/kotlin"], packageManagers: ["gradle"],
    test: { layer: "unit", name: "gradle test", command: "gradle", args: ["test"], binary: "gradle", wrapper: "gradlew", evidence: ["build.gradle.kts"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["kotlin"] },
  },
  {
    id: "swift", displayName: "Swift", priority: "third",
    markers: ["Package.swift"], extensions: [".swift"], dependencyFiles: ["Package.swift", "Package.resolved"],
    entryPoints: ["Sources"], packageManagers: ["Swift Package Manager"],
    test: { layer: "unit", name: "swift test", command: "swift", args: ["test"], binary: "swift", evidence: ["Package.swift"] },
    build: { command: "swift", args: ["build"], binary: "swift", evidence: ["Package.swift"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["swift"] },
  },
  {
    id: "dart", displayName: "Dart / Flutter", priority: "third",
    markers: ["pubspec.yaml", "pubspec.lock"], extensions: [".dart"],
    dependencyFiles: ["pubspec.yaml", "pubspec.lock"], entryPoints: ["lib/main.dart", "bin"],
    test: { layer: "unit", name: "flutter test", command: "flutter", args: ["test"], binary: "flutter", evidence: ["pubspec.yaml"] },
    build: { command: "flutter", args: ["build", "web"], binary: "flutter", evidence: ["pubspec.yaml"] },
    analysis: { dependencyGraph: false, staticSecurity: true, semgrepLanguages: ["dart"] },
  },
];

export const INFRASTRUCTURE_ADAPTERS: readonly InfrastructureAdapter[] = [
  { id: "docker", displayName: "Docker", files: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"] },
  { id: "terraform", displayName: "Terraform", files: [], extensions: [".tf", ".tfvars"] },
  { id: "kubernetes", displayName: "Kubernetes", files: [], extensions: [".yaml", ".yml"] },
  { id: "helm", displayName: "Helm", files: ["Chart.yaml"] },
  { id: "github-actions", displayName: "GitHub Actions", files: [], extensions: [".yml", ".yaml"] },
  { id: "sql", displayName: "SQL", files: [], extensions: [".sql"] },
  { id: "yaml", displayName: "YAML", files: [], extensions: [".yaml", ".yml"] },
  { id: "json", displayName: "JSON / configuration", files: [], extensions: [".json", ".jsonc"] },
];

export function adapterFor(language: Language): LanguageAdapter | null {
  return LANGUAGE_ADAPTERS.find((adapter) => adapter.id === language) ?? null;
}

export function languageDisplayName(language: Language): string {
  return language === "unknown" ? "Unknown" : adapterFor(language)?.displayName ?? "Unknown";
}

export function extensionsFor(language: Language): string[] {
  return adapterFor(language)?.extensions ?? [];
}

export function languageForExtension(extension: string): KnownLanguage | null {
  const ext = extension.toLowerCase();
  // .h may be C or C++; absence of other C++ evidence must not claim C++.
  if (ext === ".h") return null;
  return LANGUAGE_ADAPTERS.find((adapter) => adapter.extensions.includes(ext))?.id ?? null;
}

/**
 * Marker-first primary detection. C/C++ and PHP/Ruby can be identified from
 * source files only when no stronger project marker exists.
 */
const DETECTION_ORDER: KnownLanguage[] = [
  "js", "python", "go", "rust", "dart", "java", "dotnet", "php", "ruby", "c", "cpp", "kotlin", "swift",
];

export function detectLanguageFrom(
  exists: (relativePath: string) => boolean,
  hasFiles: (extensions: string[]) => boolean,
): Language {
  for (const id of DETECTION_ORDER) {
    const adapter = adapterFor(id);
    if (!adapter) continue;
    if (adapter.markers.some((marker) => exists(marker))) return adapter.id;
    if (adapter.nestedMarkers?.length && hasFiles(adapter.nestedMarkers)) return adapter.id;
  }
  // Source-only repositories: a recognized source file is real evidence even
  // without a manifest. Marker detection above still wins for mixed repos.
  for (const id of DETECTION_ORDER) {
    const adapter = adapterFor(id);
    if (adapter && adapter.extensions.length && hasFiles(adapter.extensions)) return id;
  }
  return "unknown";
}

/** Root marker files for manifests, derived from the adapters. */
export function languageMarkerFiles(): { file: string; language: string }[] {
  return LANGUAGE_ADAPTERS.flatMap((adapter) =>
    adapter.markers.map((file) => ({ file, language: adapter.displayName })),
  );
}
