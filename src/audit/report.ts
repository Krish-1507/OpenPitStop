import {
  CATEGORY_LABELS,
  SEVERITY_ORDER,
  type AuditCategory,
  type AuditFinding,
  type AuditReport,
  type EngineeringScore,
} from "./types.js";
import { grade } from "./score.js";

/**
 * audit/report.ts — the 15-section engineering report.
 *
 * The markdown is the human artifact; JSON is the complete machine artifact.
 * Nothing in the markdown is invented at render time: every sentence either
 * reads a measured field or states a limit explicitly.
 */

const SECTION_TITLES = [
  "Executive summary",
  "Scope, method and limits",
  "Repository profile",
  "Engineering Quality Score",
  "Score breakdown",
  "Confirmed findings",
  "Potential and unproven findings",
  "Architecture and dependencies",
  "Performance and unnecessary operations",
  "Type safety, readability and hardcoding",
  "Security posture",
  "Testing and verification",
  "Predicted risks",
  "Strengths and positive signals",
  "Prioritized recommendations",
];

export function renderMarkdown(report: AuditReport): string {
  const lines: string[] = [];
  const active = report.findings.filter((finding) => finding.lifecycle !== "suppressed");
  const confirmed = active.filter((finding) => finding.confirmation === "confirmed");
  const potential = active.filter((finding) => finding.confirmation !== "confirmed");

  lines.push("# Deep Codebase Intelligence Report");
  lines.push("");
  lines.push("**Repository:** " + report.repo);
  lines.push("");
  lines.push(
    "**Mode:** " +
      report.mode +
      " · **Generated:** " +
      report.generatedAt +
      " · **Duration:** " +
      formatDuration(report.durationMs) +
      " · **Schema:** " +
      report.schemaVersion,
  );
  if (report.evidence) {
    lines.push("");
    lines.push(
      "**Evidence seal:** " +
        report.evidence.scheme +
        " · " +
        report.evidence.digest.slice(0, 16) +
        "..." +
        (report.contentDigest ? " · nested content " + report.contentDigest.slice(0, 16) + "..." : "") +
        " · re-checked before lifecycle or fix-plan use",
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  const sections = [
    () => sectionExecutive(report, active, confirmed, potential),
    () => sectionScope(report),
    () => sectionProfile(report),
    () => sectionScore(report.score, report.coverage.wholeRepository),
    () => sectionBreakdown(report.score),
    () => sectionFindings("Confirmed findings", confirmed, true, report.coverage.wholeRepository),
    () => [
      ...sectionFindings("Potential and unproven findings", potential, false, report.coverage.wholeRepository),
      ...sectionSuppressed(report),
      ...sectionResolved(report),
    ],
    () => sectionCategory(["architecture"], report, true),
    () => sectionCategory(["performance"], report, false),
    () => sectionCategory(["type-safety", "readability"], report, false, ["hardcoded-url"]),
    () => sectionSecurity(report),
    () => sectionTesting(report),
    () => sectionRisks(report),
    () => sectionStrengths(report),
    () => sectionRecommendations(report),
  ];

  sections.forEach((render, index) => {
    lines.push("## " + (index + 1) + ". " + SECTION_TITLES[index]);
    lines.push("");
    lines.push(...render());
    lines.push("");
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

function sectionExecutive(
  report: AuditReport,
  active: AuditFinding[],
  confirmed: AuditFinding[],
  potential: AuditFinding[],
): string[] {
  const lines: string[] = [];
  const score = report.score;
  const suppressed = report.findings.filter((finding) => finding.lifecycle === "suppressed");
  lines.push("**" + score.summary + "**");
  lines.push("");
  lines.push(
    "The audit read " +
      report.coverage.indexed +
      " of " +
      report.coverage.sourceFiles +
      " discovered source files (" +
      report.coverage.parsed +
      " parsed) in the requested repository scope, across " +
      report.coverage.languages.length +
      " language(s). It produced " +
      active.length +
      " active finding(s): " +
      confirmed.length +
      " confirmed and " +
      potential.length +
      " potential/unproven." +
      (report.resolved.length > 0
        ? " " + report.resolved.length + " previously reported finding(s) no longer appear."
        : "") +
      (suppressed.length > 0
        ? " " + suppressed.length + " suppressed finding(s) stay visible and leave the score."
        : ""),
  );
  lines.push("");
  const topRisks = report.risks.slice(0, 3);
  if (topRisks.length > 0) {
    lines.push("**Most consequential predicted risks**");
    lines.push("");
    for (const risk of topRisks) {
      lines.push(
        "- **" +
          risk.title +
          "** (" +
          risk.confidence +
          " confidence, " +
          risk.horizon +
          " horizon) — " +
          risk.impact,
      );
    }
    lines.push("");
  }
  if (report.recommendations.length > 0) {
    lines.push("**First actions**");
    lines.push("");
    for (const recommendation of report.recommendations.slice(0, 3)) {
      lines.push(
        "- P" +
          recommendation.priority +
          ": " +
          recommendation.title +
          " — " +
          recommendation.action +
          " _(effort: " +
          recommendation.effort +
          ")_",
      );
    }
    lines.push("");
  }
  lines.push(
    "> This score measures the evidence the audit could collect. It is not a certification, a security review, or a measure of product quality. See the limits in section 2 before quoting it.",
  );
  return lines;
}

function sectionScope(report: AuditReport): string[] {
  const lines: string[] = [];
  lines.push(
    "| Field | Value |",
    "| --- | --- |",
    "| Mode | " + report.mode + " |",
    "| Scope | " + (report.coverage.scope.length > 0 ? report.coverage.scope.map(cell).join(", ") : "whole repository") + " |",
    "| File budget | " + report.coverage.budget + " |",
    "| Complete file view | " +
      (report.coverage.wholeRepository ? "yes" : "no (" + cell(report.coverage.wholeRepositoryReason ?? "incomplete") + ")") +
      " |",
    "| Discovered source files | " + report.coverage.sourceFiles + " |",
    "| Indexed / parsed | " + report.coverage.indexed + " / " + report.coverage.parsed + " |",
    "| Semantic (call-graph) files | " + report.coverage.semantic + " |",
    "| Skipped by file budget | " + report.coverage.skipped + " |",
    "| Tests detected (structural) | " + report.coverage.testsDetected + " |",
    "| Measured categories | " + report.coverage.categoriesMeasured.map(labelFor).join(", ") + " |",
    "| Not measured | " +
      (report.coverage.categoriesNotMeasured.length > 0
        ? report.coverage.categoriesNotMeasured.map(labelFor).join(", ")
        : "none") +
      " |",
  );
  lines.push("");
  lines.push("**Method**");
  lines.push("");
  lines.push(
    "1. Discover source files under the requested scope (the repository root by default), applying ignore rules, the file budget and binary/large-file guards.",
  );
  lines.push(
    "2. Build a structural index: parser or scanner per supported language, then imports, exports, functions, call sites, routes, tests, literals and resolved relative imports.",
  );
  lines.push(
    "3. Apply deterministic rules to the index. Each rule emits evidence, a confirmation state and a concrete change with trade-offs.",
  );
  lines.push(
    "4. Score only what was measured, with per-category diminishing returns, then predict risks separately from findings.",
  );
  if (report.mode === "full") {
    lines.push(
      "5. Full mode attempts the repository's existing analyzers. Their security findings are folded into the finding list; test, performance and reliability signals inform verification evidence, strengths and predicted risks. An unavailable analyzer is disclosed, not treated as a pass.",
    );
  }
  lines.push("");
  lines.push("**Tools and data used**");
  lines.push("");
  lines.push("| Tool | Available | Used | Note |", "| --- | --- | --- | --- |");
  for (const tool of report.coverage.tools) {
    lines.push(
      "| " + cell(tool.name) + " | " + (tool.available ? "yes" : "no") + " | " + (tool.used ? "yes" : "no") + " | " + cell(tool.note) + " |",
    );
  }
  lines.push("");
  lines.push("**Limits**");
  lines.push("");
  for (const limit of report.limits) lines.push("- " + limit);
  lines.push("");
  lines.push("**Reproduce**");
  lines.push("");
  lines.push("Run the audit from the repository root and compare the sealed JSON artifact:");
  lines.push("");
  const reproduce = [
    "pitstop audit .",
    "--mode " + report.mode,
    "--max-files " + report.coverage.budget,
    "--category " + report.coverage.categoriesMeasured.join(","),
    ...report.coverage.scope.map((entry) => "--scope " + JSON.stringify(entry)),
    "--json",
  ];
  lines.push("    " + reproduce.join(" "));
  return lines;
}

function sectionProfile(report: AuditReport): string[] {
  const lines: string[] = [];
  lines.push("**Language coverage**");
  lines.push("");
  lines.push("| Language | Files | Indexed | Depth | Note |", "| --- | --- | --- | --- | --- |");
  for (const language of report.coverage.languages) {
    lines.push(
      "| " +
        cell(language.displayName) +
        " | " +
        language.files +
        " | " +
        language.indexed +
        " | " +
        language.semantic +
        " | " +
        cell(language.note) +
        " |",
    );
  }
  lines.push("");
  lines.push("**Repository index**");
  lines.push("");
  lines.push(
    "| Files | Functions | Imports | Call sites | Resolved call sites | Routes | Cycles | Boundaries |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    "| " +
      report.index.files +
      " | " +
      report.index.functions +
      " | " +
      report.index.imports +
      " | " +
      report.index.callSites +
      " | " +
      report.index.resolvedCallSites +
      " | " +
      report.index.routes +
      " | " +
      report.index.cycles.length +
      " | " +
      report.index.boundaries +
      " |",
  );
  lines.push("");
  lines.push("**Entry points**");
  lines.push("");
  if (report.index.entryPoints.length === 0) {
    lines.push("No conventional entry points were detected.");
  } else {
    for (const entry of report.index.entryPoints.slice(0, 15)) lines.push("- " + entry);
  }
  lines.push("");
  lines.push("**Execution paths**");
  lines.push("");
  if (report.index.executionPaths.length === 0) {
    lines.push("No route-to-handler execution paths could be resolved. This usually means routes are registered dynamically or the framework is not recognised.");
  } else {
    for (const path of report.index.executionPaths.slice(0, 10)) {
      lines.push(
        "- **" + path.route + "** (" + path.depth + " steps): " + path.path.join(" -> "),
      );
    }
  }
  return lines;
}

function sectionScore(score: EngineeringScore, wholeRepository: boolean): string[] {
  const lines: string[] = [];
  lines.push("**Overall: " + score.overall + "/100** " + bar(score.overall));
  lines.push("");
  lines.push(
    "**Confidence:** " +
      score.confidence +
      " · **Band:** " +
      score.band +
      " · **Measured weight:** " +
      score.measuredWeight +
      "/100",
  );
  if (score.cap) {
    lines.push("");
    lines.push("**Severity cap:** " + score.cap.reason);
  }
  lines.push("");
  lines.push(
    "The score starts at 100 per measured category. Each active finding deducts points by severity, confirmation and confidence, with diminishing returns inside a category so one noisy rule cannot dominate. Unmeasured categories are excluded and the remaining weights are re-normalised.",
  );
  if (!wholeRepository) {
    lines.push("");
    lines.push(
      "Only findings displayed in this report deduct points. Findings omitted by a budget or outside the audited set are disclosed in section 2 and are not part of this score.",
    );
  }
  lines.push("");
  lines.push("| Category | Weight | Score | Deducted | Findings | Measured | Note |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const category of score.categories) {
    lines.push(
      "| " +
        cell(category.label) +
        " | " +
        category.weight +
        " | " +
        (category.measured ? category.score + "/100" : "not measured") +
        " | " +
        (category.measured ? "-" + category.deductionTotal : "0") +
        " | " +
        category.findingCount +
        " | " +
        (category.measured ? "yes" : "no") +
        " | " +
        cell(category.note ?? "") +
        " |",
    );
  }
  lines.push("");
  const unmeasured = score.categories.filter((category) => !category.measured);
  if (unmeasured.length > 0) {
    lines.push(
      "Excluded from the overall score: " + unmeasured.map((category) => category.label).join(", ") + ". The score is not comparable to a run in a mode that measured them.",
    );
    lines.push("");
  }
  lines.push(
    "The band reflects the share of the deduction carried by potential/unproven findings and parser gaps. Two decimal places are not meaningful; treat the score as a range.",
  );
  return lines;
}

function sectionBreakdown(score: EngineeringScore): string[] {
  const lines: string[] = [];
  const applied = score.deductions.filter((entry) => entry.points > 0).sort((a, b) => b.points - a.points);
  if (applied.length === 0) {
    lines.push("No finding deducted points. This does not prove the absence of problems; it means no measured rule fired.");
    return lines;
  }
  lines.push("| Points | Severity | Rule | Category | Finding |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const entry of applied.slice(0, 30)) {
    lines.push(
      "| -" +
        entry.points +
        " | " +
        entry.severity +
        " | " +
        cell(entry.rule) +
        " | " +
        cell(CATEGORY_LABELS[entry.category]) +
        " | " +
        cell(entry.reason) +
        " |",
    );
  }
  lines.push("");
  lines.push(
    "The table shows the " +
      Math.min(30, applied.length) +
      " largest deductions. The complete list (" +
      score.deductions.length +
      " entries, including findings with zero applied points) is in the JSON report (use --json or the persisted artifact). Every applied point maps to a finding id.",
  );
  return lines;
}

function sectionFindings(title: string, findings: AuditFinding[], detail: boolean, completeView: boolean): string[] {
  const lines: string[] = [];
  if (findings.length === 0) {
    lines.push(
      completeView
        ? "None among the active findings. This category is empty for the files and rules that were measured."
        : "None among the displayed active findings. This run was bounded (see section 2), so this is not a global negative result.",
    );
    return lines;
  }
  const sorted = [...findings].sort((a, b) => {
    const severity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severity !== 0) return severity;
    return a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : a.location.line - b.location.line;
  });
  const bySeverity = new Map<string, number>();
  for (const finding of sorted) bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  lines.push(
    [...bySeverity.entries()].map(([severity, count]) => count + " " + severity).join(" · "),
  );
  lines.push("");
  for (const finding of sorted) {
    lines.push(renderFinding(finding, detail));
    lines.push("");
  }
  return lines;
}

function sectionResolved(report: AuditReport): string[] {
  if (report.resolved.length === 0) return [];
  const lines: string[] = [];
  lines.push("**Resolved since the last sealed audit**");
  lines.push("");
  for (const finding of report.resolved.slice(0, 20)) {
    lines.push(
      "- " +
        finding.severity +
        " rule " +
        finding.rule +
        " at " +
        finding.location.file +
        ":" +
        finding.location.line +
        " (id " +
        finding.id +
        ")",
    );
  }
  if (report.resolved.length > 20) {
    lines.push("- ... and " + (report.resolved.length - 20) + " more in the JSON artifact.");
  }
  lines.push("");
  lines.push("These findings were absent from a file this run examined; they are not re-scored.");
  return lines;
}

function sectionSuppressed(report: AuditReport): string[] {
  const suppressed = report.findings
    .filter((finding) => finding.lifecycle === "suppressed")
    .sort((a, b) => (a.location.file < b.location.file ? -1 : a.location.file > b.location.file ? 1 : a.location.line - b.location.line));
  if (suppressed.length === 0) return [];
  const lines: string[] = [];
  lines.push("**Suppressed findings (visible here, excluded from the score)**");
  lines.push("");
  for (const finding of suppressed) {
    lines.push(
      "- " +
        finding.severity +
        " rule " +
        finding.rule +
        " at " +
        finding.location.file +
        ":" +
        finding.location.line +
        " (id " +
        finding.id +
        ") — reason: " +
        (finding.suppression?.reason ?? "not recorded") +
        (finding.suppression?.expires ? "; expires " + finding.suppression.expires : ""),
    );
  }
  lines.push("");
  lines.push("A suppression is a local, reviewable decision, not a deletion: the finding stays in the JSON and in this list.");
  return lines;
}

function renderFinding(finding: AuditFinding, detail: boolean): string {
  const lines: string[] = [];
  lines.push(
    "### [" +
      finding.severity.toUpperCase() +
      " · " +
      finding.confirmation +
      " · " +
      finding.confidence +
      " confidence] " +
      finding.title,
  );
  lines.push("");
  lines.push(
    "**Location:** " +
      finding.location.file +
      ":" +
      finding.location.line +
      (finding.location.endLine !== finding.location.line ? "-" + finding.location.endLine : "") +
      " · **Category:** " +
      CATEGORY_LABELS[finding.category] +
      " · **Rule:** " +
      finding.rule +
      " · **ID:** " +
      finding.id,
  );
  lines.push("");
  lines.push(finding.explanation);
  lines.push("");
  lines.push("**Impact:** " + finding.impact);
  lines.push("");
  lines.push("**Why this is a problem here:** " + finding.why);
  lines.push("");
  lines.push("**Evidence:**");
  lines.push("");
  for (const evidence of finding.evidence) {
    lines.push("- " + evidence.source + ": " + evidence.detail);
    if (evidence.excerpt) lines.push("  - excerpt: " + evidence.excerpt);
  }
  lines.push("");
  lines.push("**Recommended change:** " + finding.suggestion.summary);
  lines.push("");
  lines.push(finding.suggestion.change);
  lines.push("");
  lines.push("**Trade-offs and risks of the change:** " + finding.suggestion.tradeoffs);
  lines.push("");
  lines.push(
    "**Effort:** " +
      finding.suggestion.effort +
      " · **Automatic fix available:** " +
      (finding.suggestion.autoFixable ? "yes (through the approval workflow)" : "no"),
  );
  if (detail && finding.patch) {
    lines.push("");
    lines.push("**Deterministic patch (not applied):**");
    lines.push("");
    lines.push(
      "    " +
        finding.patch.file +
        ":" +
        finding.patch.startLine +
        " replace " +
        JSON.stringify(finding.patch.before) +
        " with " +
        JSON.stringify(finding.patch.after),
    );
  }
  return lines.join("\n");
}

function sectionCategory(
  categories: AuditCategory[],
  report: AuditReport,
  architecture: boolean,
  extraRules: string[] = [],
): string[] {
  const lines: string[] = [];
  const unmeasured = categories.filter((category) => report.coverage.categoriesNotMeasured.includes(category));
  const findings = report.findings.filter(
    (finding) =>
      (categories.includes(finding.category) || extraRules.includes(finding.rule)) &&
      finding.lifecycle !== "suppressed",
  );
  // Extra rules can be measured even when every category named by this section is
  // not. Keep an extra-rule finding visible, but never imply the named categories
  // were checked when they were not.
  if (unmeasured.length === categories.length && findings.length === 0) {
    lines.push("This area was not measured in this run (category not selected); its absence here is not a clean result.");
    return lines;
  }
  if (unmeasured.length > 0) {
    lines.push("Not measured here: " + unmeasured.map((category) => CATEGORY_LABELS[category]).join(", ") + ".");
    lines.push("");
  }
  if (architecture && !unmeasured.includes("architecture")) {
    if (report.index.cycles.length === 0) {
      lines.push(
        report.coverage.wholeRepository
          ? "No import cycles were found in the resolved relative-import graph."
          : "No import cycles were found in the indexed portion of the resolved graph; the run was bounded, so this is not a global negative result.",
      );
    } else {
      lines.push("**Resolved import cycles**");
      lines.push("");
      for (const cycle of report.index.cycles.slice(0, 10)) {
        lines.push("- " + cycle.join(" -> "));
      }
    }
    lines.push("");
    const understandingUnavailable = report.coverage.limitations.some((limit) =>
      /Repository understanding was unavailable/.test(limit),
    );
    if (understandingUnavailable) {
      lines.push("Architecture boundary data was unavailable because repository understanding failed; no conclusion about configured boundaries is possible.");
    } else if (report.index.boundaries === 0) {
      lines.push("No architecture boundaries are configured, so boundary violations cannot be detected. Boundaries can be declared in the repository's pitstop architecture configuration.");
    } else {
      lines.push(report.index.boundaries + " architecture boundary rule(s) were evaluated against resolved imports.");
    }
    lines.push("");
  }
  if (findings.length === 0) {
    lines.push(
      report.coverage.wholeRepository
        ? "No findings in this area for the measured rules."
        : "No findings in this area in the displayed set; the run was bounded (see section 2), so this is not a global negative result.",
    );
    return lines;
  }
  for (const finding of findings) {
    lines.push(
      "- **" +
        finding.severity +
        " / " +
        finding.confirmation +
        "** " +
        finding.title +
        " — " +
        finding.location.file +
        ":" +
        finding.location.line,
    );
    lines.push("  - " + finding.impact);
    lines.push("  - Change: " + finding.suggestion.summary);
  }
  return lines;
}

function sectionSecurity(report: AuditReport): string[] {
  const lines: string[] = [];
  const security = report.findings.filter(
    (finding) => finding.category === "security" && finding.lifecycle !== "suppressed",
  );
  if (report.coverage.categoriesNotMeasured.includes("security")) {
    lines.push(
      "**Security was not measured in this run.** Quick mode skips it, and a category filter can exclude it; run with --mode deep or --mode full without excluding security before drawing any security conclusion.",
    );
    return lines;
  }
  lines.push(
    "Security is measured by deterministic pattern rules and, in full mode, the repository's existing security analyzer. This is not a penetration test, a dependency audit, or a taint analysis; it cannot prove the absence of a vulnerability.",
  );
  lines.push("");
  if (security.length === 0) {
    lines.push(
      report.coverage.wholeRepository
        ? "No security findings were indicated by the measured rules. This is a negative result for this rule set, not a clean bill of health."
        : "No security findings are displayed, but this run was bounded (see section 2); this is not a complete negative result.",
    );
    return lines;
  }
  for (const finding of security) {
    lines.push(
      "- **" +
        finding.severity +
        " / " +
        finding.confirmation +
        "** " +
        finding.title +
        " — " +
        finding.location.file +
        ":" +
        finding.location.line,
    );
    lines.push("  - " + finding.suggestion.summary);
  }
  return lines;
}

function sectionTesting(report: AuditReport): string[] {
  const lines: string[] = [];
  if (report.coverage.categoriesNotMeasured.includes("testing")) {
    lines.push("Testing was not measured in this run (category not selected); its absence here is not a clean result.");
    return lines;
  }
  const testFindings = report.findings.filter(
    (finding) => finding.category === "testing" && finding.lifecycle !== "suppressed",
  );
  lines.push("| Signal | Value |", "| --- | --- |");
  const testFiles = report.coverage.testFiles ?? report.coverage.testsDetected;
  lines.push("| Test declarations detected | " + report.coverage.testsDetected + " |");
  lines.push("| Test files detected | " + testFiles + " |");
  lines.push("| Source files (non-test) | " + Math.max(0, report.coverage.indexed - testFiles) + " |");
  const fullAnalyzers = report.coverage.tools.find((tool) => tool.name === "existing analyzers (full mode)");
  const suiteResult =
    report.mode !== "full"
      ? "not run in " + report.mode + " mode"
      : fullAnalyzers?.used
        ? "the full-mode analyzer stack ran; its test note is in the sealed JSON"
        : "not run: the full-mode analyzer stack was unavailable";
  lines.push("| Suite result | " + suiteResult + " |");
  lines.push("");
  lines.push(
    "Test declarations are counted structurally. A test that exists but asserts nothing is reported as a finding; overall line coverage percentage is not inferred when no coverage run is available.",
  );
  lines.push("");
  if (testFindings.length === 0) {
    lines.push(
      report.coverage.wholeRepository
        ? "No testing findings were produced by the measured rules."
        : "No testing findings are displayed, but this run was bounded (see section 2); this is not a complete negative result.",
    );
  } else {
    for (const finding of testFindings) {
      lines.push(
        "- **" + finding.severity + "** " + finding.title + " — " + finding.location.file + ":" + finding.location.line,
      );
    }
  }
  return lines;
}

function sectionRisks(report: AuditReport): string[] {
  const lines: string[] = [];
  if (report.risks.length === 0) {
    lines.push("No risk predictions met their evidence threshold among the measured categories. Predictions are intentionally conservative; absence here is not evidence of stability.");
    if (report.coverage.categoriesNotMeasured.length > 0) {
      lines.push("");
      lines.push(
        "Risk predicates for unmeasured categories were not evaluated: " +
          report.coverage.categoriesNotMeasured.map((category) => CATEGORY_LABELS[category]).join(", ") +
          ".",
      );
    }
    return lines;
  }
  for (const risk of report.risks) {
    lines.push(
      "### " + risk.title + " (" + risk.confidence + " confidence, " + risk.horizon + " horizon)",
    );
    lines.push("");
    lines.push(risk.explanation);
    lines.push("");
    lines.push("**Impact if it materialises:** " + risk.impact);
    lines.push("");
    lines.push("**Assumption:** " + risk.assumption);
    lines.push("");
    lines.push("**Evidence:**");
    for (const evidence of risk.evidence) lines.push("- " + evidence.source + ": " + evidence.detail);
    if (risk.locations.length > 0) {
      lines.push("");
      lines.push(
        "**Locations:** " + risk.locations.map((location) => location.file + ":" + location.line).join(", "),
      );
    }
    if (risk.relatedFindings.length > 0) {
      lines.push("");
      lines.push("**Related findings:** " + risk.relatedFindings.slice(0, 8).join(", "));
    }
    lines.push("");
  }
  lines.push(
    "> Risks are predictions, not defects. They are excluded from the score and must not be presented as confirmed bugs.",
  );
  return lines;
}

function sectionStrengths(report: AuditReport): string[] {
  const lines: string[] = [];
  if (report.strengths.length === 0) {
    lines.push("No positive signals cleared the evidence threshold among the measured categories. That is a statement about the rules, not about the team.");
    if (report.coverage.categoriesNotMeasured.length > 0) {
      lines.push("");
      lines.push(
        "Strengths for unmeasured categories were not evaluated: " +
          report.coverage.categoriesNotMeasured.map((category) => CATEGORY_LABELS[category]).join(", ") +
          ".",
      );
    }
    return lines;
  }
  for (const strength of report.strengths) {
    lines.push("- **" + strength.title + "** — " + strength.evidence);
  }
  return lines;
}

function sectionRecommendations(report: AuditReport): string[] {
  const lines: string[] = [];
  if (report.recommendations.length === 0) {
    lines.push(
      "No recommendations: no active scoring findings were produced among the measured categories (suppressed findings stay visible but do not generate recommendations).",
    );
    if (report.coverage.categoriesNotMeasured.length > 0) {
      lines.push("");
      lines.push(
        "Unmeasured categories were not evaluated: " +
          report.coverage.categoriesNotMeasured.map((category) => CATEGORY_LABELS[category]).join(", ") +
          ".",
      );
    }
    return lines;
  }
  lines.push("| Priority | Recommendation | Effort | Findings |");
  lines.push("| --- | --- | --- | --- |");
  for (const recommendation of report.recommendations) {
    lines.push(
      "| P" +
        recommendation.priority +
        " | " +
        cell(recommendation.title) +
        " | " +
        recommendation.effort +
        " | " +
        recommendation.findingIds.length +
        " |",
    );
  }
  lines.push("");
  for (const recommendation of report.recommendations) {
    lines.push("### P" + recommendation.priority + ": " + recommendation.title);
    lines.push("");
    lines.push(recommendation.action);
    lines.push("");
    lines.push("**Why:** " + recommendation.rationale);
    lines.push("");
  }
  lines.push("**Suggested sequence**");
  lines.push("");
  lines.push("1. Review the confirmed findings above; reject anything that does not match the code you know.");
  lines.push("2. Apply one recommendation at a time on a branch, with the repository's verification command.");
  lines.push("3. Re-run the audit and diff the sealed JSON. A finding should leave the list because it was fixed, not because the rule stopped seeing it.");
  lines.push("4. Keep suppressions explicit, with a reason and an expiry; they stay in the report and are excluded from the score.");
  lines.push("");
  lines.push(
    "**Patch workflow:** deterministic patches are attached to findings and executed through the approval workflow in an isolated worktree. The audit never edits the working tree directly and never commits.",
  );
  return lines;
}

export function renderAuditSummary(report: AuditReport): string {
  const lines: string[] = [];
  const active = report.findings.filter((finding) => finding.lifecycle !== "suppressed");
  const suppressed = report.findings.filter((finding) => finding.lifecycle === "suppressed");
  const high = active.filter((finding) => finding.severity === "critical" || finding.severity === "high");
  lines.push("");
  lines.push("Deep Codebase Intelligence · " + report.mode + " mode");
  lines.push("Repository: " + report.repo);
  lines.push("");
  lines.push(
    "Engineering Quality Score  " +
      report.score.overall +
      "/100  " +
      bar(report.score.overall) +
      "  " +
      grade(report.score.overall) +
      "  (" +
      report.score.band +
      ", " +
      report.score.confidence +
      " confidence)",
  );
  lines.push("");
  lines.push(
    "Indexed " +
      report.coverage.indexed +
      "/" +
      report.coverage.sourceFiles +
      " files · " +
      report.index.functions +
      " functions · " +
      report.index.routes +
      " routes · " +
      report.index.cycles.length +
      " cycles · budget " +
      report.coverage.budget,
  );
  if (!report.coverage.wholeRepository) {
    lines.push("Complete file view: no (" + (report.coverage.wholeRepositoryReason ?? "incomplete") + ")");
  }
  if (report.coverage.scope.length > 0) {
    lines.push("Scope: " + report.coverage.scope.join(", "));
  }
  lines.push(
    "Findings: " +
      active.length +
      " active (" +
      active.filter((finding) => finding.confirmation === "confirmed").length +
      " confirmed, " +
      active.filter((finding) => finding.confirmation !== "confirmed").length +
      " potential/unproven) · " +
      high.length +
      " high/critical",
  );
  if (suppressed.length > 0) {
    lines.push("Suppressed: " + suppressed.length + " (visible in the full report and JSON; excluded from the score)");
  }
  lines.push("");
  if (report.score.categories.some((category) => category.measured)) {
    lines.push("Category scores:");
    for (const category of report.score.categories.filter((entry) => entry.measured)) {
      lines.push("  " + category.label.padEnd(30, " ") + String(category.score).padStart(5, " ") + "/100  (-" + category.deductionTotal + ")");
    }
    lines.push("");
  }
  if (high.length > 0) {
    lines.push("Highest-severity findings:");
    for (const finding of high.slice(0, 5)) {
      lines.push(
        "  [" + finding.severity.toUpperCase() + "] " + finding.title + "  " + finding.location.file + ":" + finding.location.line,
      );
    }
    lines.push("");
  }
  if (report.recommendations.length > 0) {
    lines.push("Next actions:");
    for (const recommendation of report.recommendations.slice(0, 3)) {
      lines.push("  P" + recommendation.priority + "  " + recommendation.title);
    }
    lines.push("");
  }
  if (report.limits.length > 0) {
    lines.push("Limits: " + report.limits.slice(0, 2).join(" "));
    lines.push("");
  }
  return lines.join("\n");
}

function bar(score: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
  return "[" + "#".repeat(filled) + "-".repeat(10 - filled) + "]";
}

function labelFor(category: AuditCategory): string {
  return CATEGORY_LABELS[category];
}

function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return ms + "ms";
  return (ms / 1000).toFixed(1) + "s";
}
