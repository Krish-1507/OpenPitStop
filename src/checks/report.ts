import path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import type { ScanResult } from "../analyzers/types.js";
import type { GateDecision } from "../verify/gateMatrix.js";
import type { StackResult } from "../verify/stack.js";
import type { ProjectDetection } from "../onboarding/detect.js";
import type { FindingConfidence, FindingRisk, FindingSeverity } from "../findings/schema.js";
import { impactFor } from "../findings/schema.js";
import { computeScore } from "../report/score.js";
import { findingIdFor } from "../repro/ids.js";

export type CheckMode = "quick" | "deep" | "ship";

export interface CheckFinding {
  id: string;
  source: string;
  group: "security" | "dependency" | "code-quality" | "reliability" | "accessibility" | "architecture";
  category: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  description: string;
  file?: string;
  line?: number;
  impact: string;
  reproduction: string;
  suggestedFix: string;
  verification: string;
  sourceTool: string;
  reachability: string;
  /** Deterministic triage score and reasons; present after a full scan. */
  risk?: FindingRisk;
  /** False for aggregate findings (clones, duplicate functions) without a repro id. */
  addressable: boolean;
}

export interface CheckGroup {
  key: CheckFinding["group"];
  label: string;
  count: number;
  bySeverity: Record<string, number>;
}

export interface CheckSkipped {
  area: string;
  reason: string;
}

export interface CheckVerificationItem {
  id: string;
  label: string;
  status: "passed" | "failed" | "skipped" | "not-run";
  detail: string;
}

export interface CheckNextStep {
  label: string;
  command: string;
  why: string;
}

export interface CheckReport {
  schemaVersion: 1;
  mode: CheckMode;
  generatedAt: string;
  repo: string;
  project: ProjectDetection;
  understandingPath?: string;
  scanPath?: string;
  score: { value: number; grade: string; analyzed: number; total: number };
  findings: {
    total: number;
    suppressed: number;
    groups: CheckGroup[];
    top: CheckFinding[];
  };
  verification: {
    verdict: "passed" | "failed" | "partial" | "not-run";
    items: CheckVerificationItem[];
  };
  skipped: CheckSkipped[];
  nextSteps: CheckNextStep[];
  recommendation: string;
  gate?: {
    strict: boolean;
    verdict: string;
    exitCode: number;
    reasons: string[];
    layers: GateDecision["layers"];
  };
  evidencePath?: string;
}

const GROUP_LABELS: Record<CheckFinding["group"], string> = {
  security: "Security",
  dependency: "Dependencies",
  "code-quality": "Code quality",
  reliability: "Reliability",
  accessibility: "Accessibility",
  architecture: "Architecture",
};

const GROUP_ORDER: CheckFinding["group"][] = [
  "security", "dependency", "code-quality", "reliability", "accessibility", "architecture",
];

const SEVERITY_ORDER: FindingSeverity[] = ["critical", "high", "medium", "low", "info", "warning", "unknown"];
const CONFIDENCE_ORDER: FindingConfidence[] = ["proven", "indicated", "heuristic", "unknown"];

function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity.toLowerCase() as FindingSeverity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

function confidenceRank(confidence: string): number {
  const index = CONFIDENCE_ORDER.indexOf(confidence as FindingConfidence);
  return index === -1 ? CONFIDENCE_ORDER.length : index;
}

function groupOf(source: string, type: string): CheckFinding["group"] {
  if (source === "graph") return "architecture";
  if (source === "a11y") return "accessibility";
  if (source === "reliability") return "reliability";
  if (source === "devex" || source === "duplication") return "code-quality";
  if (type === "dependency") return "dependency";
  return "security";
}

function rel(repo: string, file?: string): string | undefined {
  if (!file) return undefined;
  return (path.isAbsolute(file) ? path.relative(repo, file) : file).replace(/\\/g, "/");
}

function baseFinding(
  repo: string,
  input: {
    id: string; source: string; type: string; category?: string; severity: string;
    confidence?: string; description: string; file?: string; line?: number; fix?: string;
    title?: string; sourceTool?: string; reachability?: string; risk?: FindingRisk;
    addressable?: boolean;
  },
): CheckFinding {
  const category = input.category ?? input.type;
  const adjusted = input.severity.toLowerCase() as FindingSeverity;
  const severity = SEVERITY_ORDER.includes(adjusted) ? adjusted : "unknown";
  return {
    id: input.id,
    source: input.source,
    group: groupOf(input.source, input.type),
    category,
    severity,
    confidence: (input.confidence as FindingConfidence) ?? "unknown",
    title: input.title ?? (category.split(/[._/-]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Finding"),
    description: input.description.replace(/^\[(?:indicated|proven|heuristic)\]\s*/i, ""),
    file: rel(repo, input.file),
    line: input.line,
    impact: impactFor({ type: input.type, category: input.category, severity: input.severity, description: input.description }),
    reproduction: input.addressable === false
      ? "Review the cited files in the full check report; this aggregate finding has no single reproduction id."
      : `pitstop inspect ${input.id}`,
    suggestedFix: input.fix ?? "Review the affected code and apply the smallest correction that preserves existing behavior.",
    verification: input.addressable === false
      ? "Apply the correction, then run `pitstop check deep .` and compare the affected files."
      : `Apply the fix, then run \`pitstop check deep .\` and \`pitstop inspect ${input.id}\` again.`,
    sourceTool: input.sourceTool ?? (input.source === "security" ? "static-security" : input.source),
    reachability: input.reachability ?? "unknown",
    risk: input.risk,
    addressable: input.addressable !== false,
  };
}

export function collectCheckFindings(repo: string, scan: ScanResult): CheckFinding[] {
  const findings: CheckFinding[] = [];
  for (const issue of scan.security.issues) {
    if (!issue.id) continue;
    findings.push(baseFinding(repo, {
      id: issue.id, source: "security", type: issue.type, category: issue.category,
      severity: issue.severity, confidence: issue.confidence, description: issue.description,
      file: issue.file, line: issue.line, fix: issue.fix, title: issue.title,
      sourceTool: issue.sourceTool, reachability: issue.reachability, risk: issue.risk,
    }));
  }
  for (const issue of scan.accessibility.issues) {
    if (!issue.id) continue;
    findings.push(baseFinding(repo, {
      id: issue.id, source: "a11y", type: issue.type, category: issue.category,
      severity: issue.severity, confidence: issue.confidence, description: issue.description,
      file: issue.file, line: issue.line, fix: issue.fix, title: issue.title,
      sourceTool: issue.sourceTool, reachability: issue.reachability, risk: issue.risk,
    }));
  }
  for (const issue of scan.reliability.raceSmells) {
    if (!issue.id) continue;
    findings.push(baseFinding(repo, {
      id: issue.id, source: "reliability", type: "race-condition", category: issue.category,
      severity: issue.severity, confidence: issue.confidence, description: issue.description,
      file: issue.file, line: issue.line, fix: issue.fix, title: issue.title,
      sourceTool: issue.sourceTool, reachability: issue.reachability, risk: issue.risk,
    }));
  }
  for (const flake of scan.reliability.flakyTests) {
    if (!flake.id) continue;
    findings.push(baseFinding(repo, {
      id: flake.id, source: "reliability", type: "flaky-test", severity: "warning",
      description: `flaky test: ${flake.name} (outcome changed across ${scan.reliability.runs} runs)`,
      file: flake.file,
    }));
  }
  for (const issue of scan.devex.unusedExports) {
    if (!issue.id) continue;
    findings.push(baseFinding(repo, {
      id: issue.id, source: "devex", type: "unused-export", category: issue.category,
      severity: issue.severity, confidence: issue.confidence, description: issue.description,
      file: issue.file, line: issue.line, fix: issue.fix, title: issue.title,
      sourceTool: issue.sourceTool, reachability: issue.reachability, risk: issue.risk,
    }));
  }
  for (const duplicate of scan.devex.duplicateFunctions) {
    const id = `devex-${duplicate.files[0]?.file ?? "duplicate"}`;
    findings.push(baseFinding(repo, {
      id, source: "devex", type: "duplicate-function", severity: "medium",
      description: `near-identical function bodies (${(duplicate.similarity * 100).toFixed(0)}% similar, ${duplicate.lines} lines): ${duplicate.name}`,
      file: duplicate.files[0]?.file, line: duplicate.files[0]?.line,
      fix: "Extract the shared behavior or remove the duplicate so the two copies cannot drift.",
      addressable: false,
    }));
  }
  for (const cycle of scan.dependencyGraph.circular) {
    const files = cycle.map((file) => rel(repo, file) ?? file);
    findings.push(baseFinding(repo, {
      id: findingIdFor("graph", "circular", cycle[0], files.join(" → ")), source: "graph", type: "circular", severity: "medium",
      description: `circular dependency: ${files.join(" → ")}`,
      file: cycle[0],
      fix: "Break the cycle by moving the shared contract to a lower-level module and importing it from both sides.",
    }));
  }
  for (const clone of scan.duplication.clones) {
    findings.push(baseFinding(repo, {
      id: `duplication-${clone.files[0] ?? "clone"}`, source: "duplication", type: "duplication",
      severity: "low", description: `duplicate code (${clone.lines} lines)`, file: clone.files[0],
      fix: "Extract the duplicated logic into one tested helper and update both call sites.",
      addressable: false,
    }));
  }
  if (scan.ledger) {
    for (const evidence of scan.ledger.evidence) {
      if (!evidence.doubleCharged || !evidence.id) continue;
      findings.push(baseFinding(repo, {
        id: evidence.id, source: "ledger", type: evidence.scenario, severity: "critical",
        description: evidence.summary, file: evidence.endpointFile,
        fix: "Enforce idempotency at the write boundary: persist the idempotency key atomically before charging and return the original result on replay.",
      }));
    }
  }
  return findings.sort((a, b) =>
    (b.risk?.score ?? 0) - (a.risk?.score ?? 0) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    confidenceRank(a.confidence) - confidenceRank(b.confidence) ||
    (a.file ?? "").localeCompare(b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0),
  );
}

export function groupFindings(findings: CheckFinding[]): CheckGroup[] {
  const groups = new Map<CheckFinding["group"], CheckGroup>();
  for (const finding of findings) {
    const current = groups.get(finding.group) ?? {
      key: finding.group,
      label: GROUP_LABELS[finding.group],
      count: 0,
      bySeverity: {},
    };
    current.count++;
    current.bySeverity[finding.severity] = (current.bySeverity[finding.severity] ?? 0) + 1;
    groups.set(finding.group, current);
  }
  return GROUP_ORDER.map((key) => groups.get(key)).filter((group): group is CheckGroup => Boolean(group));
}

function skippedChecks(scan: ScanResult): CheckSkipped[] {
  const skipped: CheckSkipped[] = [];
  const add = (area: string, reason?: string) => skipped.push({ area, reason: reason ?? "not available" });
  if (scan.dependencyGraph.status !== "ok") add("Dependency graph", scan.dependencyGraph.note);
  if (scan.security.status !== "ok") add("Security", scan.security.note);
  if (scan.duplication.status !== "ok") add("Duplication", scan.duplication.note);
  if (scan.tests.status !== "ok") add("Tests", scan.tests.note);
  if (scan.perf.status !== "ok") add("Build / performance", scan.perf.note);
  if (scan.accessibility.status !== "ok") add("Accessibility", scan.accessibility.note);
  if (scan.reliability.status !== "ok") add("Reliability", scan.reliability.note);
  if (scan.devex.status !== "ok") add("Developer experience", scan.devex.note);
  if (scan.ledger && scan.ledger.status !== "ok") add("Ledger idempotency", scan.ledger.note);
  return skipped;
}

function buildVerification(scan: ScanResult, stack: StackResult | undefined): CheckReport["verification"] {
  const items: CheckVerificationItem[] = [];
  if (stack) {
    for (const layer of stack.layers) {
      const label = layer.kind.charAt(0).toUpperCase() + layer.kind.slice(1);
      const detail = layer.status === "SKIPPED"
        ? layer.skipReason ?? "not configured"
        : layer.diagnosis?.category === "none"
          ? `${layer.command}${layer.counts ? ` · ${layer.counts.passed}/${layer.counts.total}` : ""}`
          : `${layer.command}${layer.diagnosis?.summary ? ` · ${layer.diagnosis.summary}` : ""}`;
      items.push({
        id: layer.kind,
        label,
        status: layer.status === "PASS" ? "passed" : layer.status === "FAIL" ? "failed" : "skipped",
        detail,
      });
    }
  } else {
    items.push({
      id: "tests",
      label: "Tests",
      status: scan.tests.status === "ok" ? (scan.tests.failed > 0 ? "failed" : "passed") : "not-run",
      detail: scan.tests.status === "ok"
        ? `${scan.tests.passed}/${scan.tests.total} passed`
        : scan.tests.note ?? "not run",
    });
    const buildStatus = scan.perf.status === "ok" ? "passed" : scan.perf.status === "error" ? "failed" : "not-run";
    items.push({
      id: "build",
      label: "Build",
      status: buildStatus,
      detail: scan.perf.status === "ok"
        ? `${scan.perf.buildTimeMs ?? "?"} ms`
        : scan.perf.note ?? "not run",
    });
    items.push({ id: "typecheck", label: "Typecheck", status: "not-run", detail: "run `pitstop check ship .` to include typecheck and lint" });
    items.push({ id: "lint", label: "Lint", status: "not-run", detail: "run `pitstop check ship .` to include typecheck and lint" });
  }

  const failed = items.some((item) => item.status === "failed");
  const passed = items.some((item) => item.status === "passed");
  const incomplete = items.some((item) => item.status === "not-run" || item.status === "skipped");
  const verdict = failed ? "failed" : !passed ? "not-run" : incomplete ? "partial" : "passed";
  return { verdict, items };
}

function nextStepsFor(input: {
  mode: CheckMode;
  findings: CheckFinding[];
  skipped: CheckSkipped[];
  gate?: GateDecision;
}): { steps: CheckNextStep[]; recommendation: string } {
  const steps: CheckNextStep[] = [];
  const top = input.findings.find((finding) => finding.addressable) ?? input.findings[0];
  if (input.gate && input.gate.verdict !== "VERIFIED") {
    const reason = input.gate.reasons[0] ?? "the release gate is not satisfied";
    steps.push({
      label: "Resolve the release gate",
      command: "pitstop gate --strict --score 60",
      why: reason,
    });
  }
  if (top && top.addressable) {
    const sensitive = top.group === "security" && ["critical", "high"].includes(top.severity);
    steps.push({
      label: sensitive ? "Review the highest-risk security finding" : "Review the highest-priority finding",
      command: `pitstop inspect ${top.id}`,
      why: `${top.severity.toUpperCase()} ${top.title}${top.file ? ` at ${top.file}${top.line ? `:${top.line}` : ""}` : ""}: ${top.impact}`,
    });
    steps.push({
      label: "Prepare a reproduction before changing code",
      command: `pitstop repro ${top.id}`,
      why: "A failing-first reproduction is the evidence that separates a real fix from a plausible-looking edit.",
    });
  } else if (top) {
    steps.push({
      label: "Review the aggregate finding",
      command: "pitstop check deep .",
      why: `${top.severity.toUpperCase()} ${top.title}${top.file ? ` at ${top.file}` : ""}: ${top.impact} This finding has no single reproduction id, so review the cited files and the full check report.`,
    });
  }
  if (input.skipped.length > 0) {
    steps.push({
      label: "Make skipped checks runnable",
      command: "pitstop doctor .",
      why: `${input.skipped.length} check(s) did not run; their results are not evidence of absence.`,
    });
  }
  if (input.mode === "quick") {
    steps.push({
      label: "Run a deeper audit",
      command: "pitstop check deep .",
      why: "Adds tests, build, flaky detection and reliability checks that the quick pass intentionally skips.",
    });
  } else if (input.mode === "deep") {
    steps.push({
      label: "Check release readiness",
      command: "pitstop check ship .",
      why: "Adds typecheck, lint, the verification stack and the strict release gate.",
    });
  }
  if (steps.length === 0) {
    steps.push({
      label: "Keep the baseline current",
      command: "pitstop check quick .",
      why: "No active findings were found. Re-run after changes and configure CI with `pitstop ci` for continuous evidence.",
    });
  }
  const deduped = steps.filter((step, index) => steps.findIndex((candidate) => candidate.command === step.command) === index);
  const recommendation = deduped[0]?.why ?? "No active findings in the checks that ran; keep the baseline current and re-run after changes.";
  return { steps: deduped.slice(0, 4), recommendation };
}

export function buildCheckReport(input: {
  mode: CheckMode;
  repo: string;
  project: ProjectDetection;
  scan: ScanResult;
  scanPath?: string;
  understandingPath?: string;
  stack?: StackResult;
  gate?: GateDecision;
}): CheckReport {
  const findings = collectCheckFindings(input.repo, input.scan);
  const groups = groupFindings(findings);
  const skipped = skippedChecks(input.scan);
  if (input.stack) {
    for (const layer of input.stack.layers) {
      if (layer.status === "SKIPPED") skipped.push({ area: layer.kind, reason: layer.skipReason ?? "not configured" });
    }
  }
  const seenSkipped = new Set<string>();
  const uniqueSkipped = skipped.filter((entry) => {
    const key = `${entry.area}|${entry.reason}`;
    if (seenSkipped.has(key)) return false;
    seenSkipped.add(key);
    return true;
  });
  const verification = buildVerification(input.scan, input.stack);
  const { steps, recommendation } = nextStepsFor({
    mode: input.mode,
    findings,
    skipped,
    gate: input.gate,
  });
  const score = computeScore(input.scan);
  return {
    schemaVersion: 1,
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    repo: input.repo,
    project: input.project,
    understandingPath: input.understandingPath,
    scanPath: input.scanPath,
    score: { value: score.score, grade: score.grade, analyzed: score.analyzed, total: score.total },
    findings: {
      total: findings.length,
      suppressed: input.scan.dismissed?.length ?? 0,
      groups,
      top: findings.slice(0, 5),
    },
    verification,
    skipped: uniqueSkipped,
    nextSteps: steps,
    recommendation,
    gate: input.gate
      ? {
          strict: true,
          verdict: input.gate.verdict,
          exitCode: input.gate.exitCode,
          reasons: input.gate.reasons,
          layers: input.gate.layers,
        }
      : undefined,
  };
}

function severityPaint(severity: string): (text: string) => string {
  switch (severity) {
    case "critical":
    case "high":
      return chalk.red;
    case "medium":
    case "warning":
      return chalk.yellow;
    default:
      return chalk.dim;
  }
}

function verificationMark(status: CheckVerificationItem["status"]): string {
  switch (status) {
    case "passed": return chalk.green("passed");
    case "failed": return chalk.red("failed");
    case "skipped": return chalk.yellow("skipped");
    default: return chalk.yellow("not checked");
  }
}

/** Compact terminal summary; detailed finding evidence lives in `pitstop inspect`. */
export function renderCheck(report: CheckReport): string {
  const lines: string[] = [];
  const title = report.mode === "quick" ? "Quick Check" : report.mode === "deep" ? "Deep Audit" : "Ship Check";
  lines.push(`${chalk.bold("Project")}: ${report.project.name} ${chalk.dim(`(${report.project.type})`)}`);
  lines.push(`${chalk.bold("Location")}: ${chalk.cyan(report.project.displayPath)}`);
  const git = report.project.git.isRepo
    ? `${report.project.git.branch ?? "detached"}${report.project.git.hasCommits ? "" : " (no commits yet)"}`
    : "not a git repository";
  lines.push(`${chalk.bold("Git")}: ${git}`);
  lines.push(`${chalk.bold("Package manager")}: ${report.project.packageManager}`);
  lines.push("");
  lines.push(chalk.bold("Project understanding: complete"));
  lines.push(`  languages: ${report.project.languages.join(", ")}`);
  if (report.project.frameworks.length > 0) lines.push(`  frameworks: ${report.project.frameworks.join(", ")}`);
  if (report.project.entryPoints.length > 0) lines.push(`  entry points: ${report.project.entryPoints.slice(0, 5).join(", ")}`);
  const commands = Object.entries(report.project.verificationCommands);
  if (commands.length > 0) lines.push(`  available commands: ${commands.map(([name, command]) => `${name}: ${command}`).join(" · ")}`);
  if (report.project.architectureConfig) lines.push(`  architecture rules: ${report.project.architectureConfig}`);
  lines.push(`  score: ${chalk.bold(`${report.score.value}/100 (${report.score.grade})`)}${report.score.analyzed < report.score.total ? chalk.dim(` · ${report.score.total - report.score.analyzed} categor(ies) skipped`) : ""}`);
  if (report.mode === "quick") lines.push(chalk.dim("  quick baseline saved; `pitstop check deep .` replaces it with a full scan"));
  lines.push("");

  lines.push(chalk.bold("Findings:"));
  const active = report.findings.total;
  if (active === 0) {
    lines.push(`  ${chalk.green("No active findings in the checks that ran.")}`);
  } else {
    for (const group of report.findings.groups) {
      const breakdown = Object.entries(group.bySeverity)
        .sort((a, b) => severityRank(a[0]) - severityRank(b[0]))
        .map(([severity, count]) => `${count} ${severity}`)
        .join(", ");
      lines.push(`  ${group.label}: ${group.count}${breakdown ? chalk.dim(` (${breakdown})`) : ""}`);
    }
  }
  if (report.findings.suppressed > 0) lines.push(`  ${chalk.dim(`${report.findings.suppressed} dismissed finding(s) kept for audit; they do not affect the score.`)}`);
  lines.push("");

  const top = report.findings.top[0];
  if (top) {
    const paint = severityPaint(top.severity);
    lines.push(chalk.bold("Highest priority:"));
    lines.push(`  ${paint(top.severity.toUpperCase())} · ${chalk.bold(top.title)}${top.file ? chalk.cyan(` — ${top.file}${top.line ? `:${top.line}` : ""}`) : ""}`);
    lines.push(`  What: ${top.description}`);
    lines.push(`  Why it matters: ${top.impact}`);
    lines.push(`  Confidence: ${top.confidence} · evidence: ${top.sourceTool}`);
    if (top.risk) {
      lines.push(`  Risk: ${top.risk.level} (${top.risk.score}/100) — ${top.risk.reasons.join("; ")}`);
    }
    if (top.reachability === "reachable") {
      lines.push(`  Reachability: ${chalk.yellow("reachable")} — the cited file also contains a discovered HTTP route; review the path, not just the line.`);
    }
    lines.push(`  Fix: ${top.suggestedFix}`);
    lines.push(
      top.addressable
        ? `  Inspect: ${chalk.cyan(`pitstop inspect ${top.id}`)}`
        : `  ${chalk.dim("This aggregate finding has no single reproduction id; review the cited files and the full report.")}`,
    );
    lines.push("");
  }

  lines.push(chalk.bold("Verification:"));
  for (const item of report.verification.items) {
    lines.push(`  ${item.label}: ${verificationMark(item.status)} ${chalk.dim(`— ${item.detail}`)}`);
  }
  lines.push("");

  if (report.skipped.length > 0) {
    lines.push(chalk.bold("Skipped checks (not evidence of absence):"));
    for (const skipped of report.skipped) {
      lines.push(`  ${chalk.yellow(skipped.area)}: ${chalk.dim(skipped.reason)}`);
    }
    lines.push("");
  }

  if (report.gate) {
    const gateColor = report.gate.verdict === "VERIFIED" ? chalk.green : report.gate.verdict === "CHEAT" ? chalk.red : chalk.yellow;
    lines.push(chalk.bold("Release gate:") + ` ${gateColor.bold(report.gate.verdict)}`);
    for (const reason of report.gate.reasons.slice(0, 3)) lines.push(`  ${chalk.dim("—")} ${reason}`);
    lines.push("");
  }

  lines.push(chalk.bold("Recommended next step:"));
  lines.push(`  ${report.recommendation}`);
  lines.push("");
  lines.push(chalk.bold("Next steps:"));
  report.nextSteps.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.label} ${chalk.cyan(`(${step.command})`)}`);
    lines.push(`     ${chalk.dim(step.why)}`);
  });

  return boxen(lines.join("\n"), {
    title: ` PITSTOP — ${title} `,
    titleAlignment: "center",
    borderStyle: "double",
    padding: 1,
    borderColor: report.verification.verdict === "failed" || report.gate?.verdict === "FAILED" ? "red" : "cyan",
  });
}
