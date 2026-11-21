import type { KnownLanguage, Language } from "./types.js";

/**
 * Language adapters — the boundary Phase 2 extends.
 *
 * Phase 1 only describes *detection*: which real files identify a language and
 * which extensions prove it is also present in a mixed repo. It deliberately
 * does not claim test, build, or analyzer capabilities that the existing
 * analyzers do not already implement. Phase 2 can grow this contract without
 * changing callers.
 */
export interface LanguageAdapter {
  id: KnownLanguage;
  displayName: string;
  /** Root-level files that identify the primary language. */
  markers: string[];
  /** Nested project files, used only when no root marker exists. */
  nestedMarkers?: string[];
  /** Source extensions used to detect secondary languages. */
  extensions: string[];
}

export const LANGUAGE_ADAPTERS: readonly LanguageAdapter[] = [
  {
    id: "js",
    displayName: "JavaScript",
    markers: ["package.json"],
    extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"],
  },
  {
    id: "python",
    displayName: "Python",
    markers: ["requirements.txt", "pyproject.toml", "setup.py"],
    extensions: [".py"],
  },
  {
    id: "go",
    displayName: "Go",
    markers: ["go.mod"],
    extensions: [".go"],
  },
  {
    id: "rust",
    displayName: "Rust",
    markers: ["Cargo.toml"],
    extensions: [".rs"],
  },
  {
    id: "dart",
    displayName: "Dart",
    markers: ["pubspec.yaml", "pubspec.lock"],
    extensions: [".dart"],
  },
  {
    id: "java",
    displayName: "Java",
    markers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    extensions: [".java", ".kt", ".kts"],
  },
  {
    id: "dotnet",
    displayName: "C#",
    nestedMarkers: [".csproj", ".fsproj", ".vbproj"],
    markers: [],
    extensions: [".cs", ".fs", ".vb"],
  },
];

/** Display names for every language, including the honest unknown outcome. */
export function languageDisplayName(language: Language): string {
  if (language === "unknown") return "Unknown";
  return LANGUAGE_ADAPTERS.find((adapter) => adapter.id === language)?.displayName ?? "Unknown";
}

export function adapterFor(language: Language): LanguageAdapter | null {
  return LANGUAGE_ADAPTERS.find((adapter) => adapter.id === language) ?? null;
}

export function extensionsFor(language: Language): string[] {
  return adapterFor(language)?.extensions ?? [];
}

/**
 * Pick the primary language from real evidence. `exists` and `hasFiles` are
 * injected so this stays a pure decision function and callers keep their own
 * ignore rules (generated dirs, fixtures) in one place.
 */
export function detectLanguageFrom(
  exists: (relativePath: string) => boolean,
  hasFiles: (extensions: string[]) => boolean,
): Language {
  for (const adapter of LANGUAGE_ADAPTERS) {
    if (adapter.markers.some((marker) => exists(marker))) return adapter.id;
    if (adapter.nestedMarkers?.length && hasFiles(adapter.nestedMarkers)) return adapter.id;
  }
  return "unknown";
}

/** Root marker files for onboarding manifests, without duplicating adapters. */
export function languageMarkerFiles(): { file: string; language: string }[] {
  return LANGUAGE_ADAPTERS.flatMap((adapter) =>
    adapter.markers.map((file) => ({ file, language: adapter.displayName })),
  );
}

