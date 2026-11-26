/**
 * Canonical language identifiers.
 *
 * Kept in the language layer so adapters, analyzers, understanding and
 * onboarding share one vocabulary. `unknown` is a real outcome, never a guess.
 */
export type Language =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "dart"
  | "dotnet"
  | "java"
  | "unknown";

export type KnownLanguage = Exclude<Language, "unknown">;
