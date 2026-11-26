import fs from "node:fs";
import path from "node:path";
import { commandExists } from "../analyzers/util.js";
import { adapterFor } from "./adapters.js";
import { treeSitterAvailable, treeSitterUsableFor } from "./parsers/treeSitter.js";
import type { DetectedInfrastructure, DetectedLanguage, LanguageToolPlan } from "./types.js";

/**
 * Tool planning, not tool claiming. A tool is `enabled` only when this build
 * actually invokes it; missing and intentionally opt-in tools stay visible.
 */
export function planLanguageTools(
  repo: string,
  languages: DetectedLanguage[],
  infrastructure: DetectedInfrastructure[],
): LanguageToolPlan[] {
  const present = new Set(languages.map((language) => language.id));
  const dependencyFiles = languages.flatMap((language) => {
    const adapter = adapterFor(language.id);
    return adapter?.dependencyFiles.filter((file) => !file.includes("*") && fs.existsSync(path.join(repo, file))) ?? [];
  });
  const codeqlRequested = Boolean(process.env.PITSTOP_CODEQL_CONFIG?.trim());
  const trivyRequested = Boolean(process.env.PITSTOP_TRIVY_ENABLED?.trim());
  const checkovRequested = Boolean(process.env.PITSTOP_CHECKOV_ENABLED?.trim());
  const semgrepRequested = Boolean(process.env.PITSTOP_SEMGREP_CONFIG?.trim());
  const grammars = [...present].filter((language) => {
    const adapter = adapterFor(language);
    return adapter && adapter.priority !== "first";
  });
  const nonJsDependencies = dependencyFiles.length > 0 && [...present].some((language) => language !== "js" && language !== "unknown");
  const usableGrammars = grammars.filter((language) => treeSitterUsableFor(language));

  return [
    {
      tool: "tree-sitter",
      relevant: grammars.length > 0,
      available: treeSitterAvailable(),
      enabled: usableGrammars.length > 0,
      reason: grammars.length === 0
        ? "no second/third-priority language sources detected"
        : !treeSitterAvailable()
          ? "tree-sitter is not installed; structural parsing falls back to labeled heuristics"
          : usableGrammars.length > 0
            ? "tree-sitter with a matching grammar is used for supported files"
            : "tree-sitter is installed but no matching grammar was found; files fall back to labeled heuristics",
      evidence: usableGrammars,
    },
    {
      tool: "semgrep",
      relevant: true,
      available: commandExists(process.env.PITSTOP_SEMGREP?.trim() || "semgrep"),
      enabled: semgrepRequested,
      reason: semgrepRequested
        ? commandExists(process.env.PITSTOP_SEMGREP?.trim() || "semgrep")
          ? "enabled by PITSTOP_SEMGREP_CONFIG"
          : "requested by PITSTOP_SEMGREP_CONFIG but semgrep is not installed"
        : commandExists(process.env.PITSTOP_SEMGREP?.trim() || "semgrep")
          ? "available but opt-in: set PITSTOP_SEMGREP_CONFIG to run deeper SAST"
          : "not installed; deeper SAST is unavailable",
      evidence: ["PITSTOP_SEMGREP_CONFIG"],
    },
    {
      tool: "osv-scanner",
      relevant: dependencyFiles.length > 0,
      available: commandExists("osv-scanner"),
      enabled: commandExists("osv-scanner") && nonJsDependencies,
      reason: dependencyFiles.length === 0
        ? "no supported dependency manifest detected"
        : commandExists("osv-scanner")
          ? nonJsDependencies
            ? "dependency audit is available for non-npm manifests"
            : "npm repositories use npm audit; osv-scanner is not invoked for them"
          : "osv-scanner is not installed; dependency coverage is limited to the language's native audit",
      evidence: dependencyFiles,
    },
    {
      tool: "gitleaks",
      relevant: true,
      available: commandExists("gitleaks"),
      enabled: commandExists("gitleaks"),
      reason: commandExists("gitleaks")
        ? "secret scanning is available"
        : "gitleaks is not installed; secret scanning is limited to offline static patterns",
      evidence: [],
    },
    {
      tool: "codeql",
      relevant: present.size > 0,
      available: commandExists("codeql"),
      enabled: false,
      reason: !codeqlRequested
        ? "not requested: CodeQL is heavy and opt-in via PITSTOP_CODEQL_CONFIG"
        : "requested, but this build does not execute CodeQL yet; no result is inferred from it",
      evidence: ["PITSTOP_CODEQL_CONFIG"],
    },
    {
      tool: "trivy",
      relevant: infrastructure.some((item) => ["docker", "terraform", "kubernetes", "helm"].includes(item.id)),
      available: commandExists("trivy"),
      enabled: false,
      reason: trivyRequested
        ? "requested, but this build does not execute trivy yet; no container/IaC result is inferred"
        : "available but opt-in via PITSTOP_TRIVY_ENABLED",
      evidence: infrastructure.filter((item) => ["docker", "terraform", "kubernetes", "helm"].includes(item.id)).flatMap((item) => item.files).slice(0, 10),
    },
    {
      tool: "checkov",
      relevant: infrastructure.some((item) => ["terraform", "kubernetes", "helm", "docker"].includes(item.id)),
      available: commandExists("checkov"),
      enabled: false,
      reason: checkovRequested
        ? "requested, but this build does not execute checkov yet; no IaC result is inferred"
        : "available but opt-in via PITSTOP_CHECKOV_ENABLED",
      evidence: infrastructure.filter((item) => ["terraform", "kubernetes", "helm", "docker"].includes(item.id)).flatMap((item) => item.files).slice(0, 10),
    },
  ];
}
