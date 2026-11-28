import {
  CATEGORY_LABELS,
  CATEGORY_WEIGHTS,
  type AuditCategory,
  type AuditFinding,
  type AuditMode,
  type CategoryScore,
  type EngineeringScore,
  type FindingConfidence,
  type ScoreDeduction,
} from "./types.js";

/**
 * audit/score.ts — transparent, weighted Engineering Quality Score.
 *
 * Every point deducted is listed with the finding that caused it. Categories
 * that were not measured are excluded and the remaining weights are
 * re-normalised, so a quick audit is never punished for the depths it did not
 * attempt. Unproven findings deduct almost nothing.
 */

const BASE_POINTS: Record<string, number> = { critical: 30, high: 18, medium: 9, low: 3 };
const CONFIRMATION_FACTOR: Record<string, number> = { confirmed: 1, potential: 0.7, unproven: 0.3 };
const CONFIDENCE_FACTOR: Record<string, number> = { high: 1, medium: 0.85, low: 0.65 };
const CAPS: { severity: "critical" | "high"; value: number; reason: string }[] = [
  {
    severity: "critical",
    value: 79,
    reason: "A confirmed critical finding caps the overall score below 80 regardless of category averages.",
  },
  {
    severity: "high",
    value: 89,
    reason: "A confirmed high-severity finding caps the overall score below 90 regardless of category averages.",
  },
];
const DECAY = [1, 0.75, 0.55, 0.4, 0.3, 0.25, 0.2];

export interface ScoreInput {
  findings: AuditFinding[];
  measured: AuditCategory[];
  mode: AuditMode;
  categoryNotes?: Partial<Record<AuditCategory, string>>;
  parseFailures?: number;
  /** Share of indexed files in languages with no semantic or rule coverage. */
  unsupportedShare?: number;
}

export function scoreFindings(input: ScoreInput): EngineeringScore {
  const active = input.findings.filter((finding) => finding.lifecycle !== "suppressed" && finding.lifecycle !== "resolved");
  const deductions: ScoreDeduction[] = [];
  const byCategory = new Map<AuditCategory, AuditFinding[]>();

  for (const finding of active) {
    const base = BASE_POINTS[finding.severity] ?? 1;
    const raw = round(base * (CONFIRMATION_FACTOR[finding.confirmation] ?? 1) * (CONFIDENCE_FACTOR[finding.confidence] ?? 1));
    const list = byCategory.get(finding.category) ?? [];
    list.push(finding);
    byCategory.set(finding.category, list);
    deductions.push({
      findingId: finding.id,
      rule: finding.rule,
      category: finding.category,
      severity: finding.severity,
      rawPoints: raw,
      points: 0,
      reason: finding.title,
    });
  }

  const categoryScores: CategoryScore[] = [];
  const weightTotal = input.measured.reduce((sum, category) => sum + (CATEGORY_WEIGHTS[category] ?? 0), 0);

  for (const category of Object.keys(CATEGORY_WEIGHTS) as AuditCategory[]) {
    const measured = input.measured.includes(category);
    const weight = CATEGORY_WEIGHTS[category] ?? 0;
    const categoryFindings = byCategory.get(category) ?? [];
    let applied = 0;
    if (measured && categoryFindings.length > 0) {
      const sorted = [...categoryFindings].sort((a, b) => {
        const ar = rawFor(a);
        const br = rawFor(b);
        return br - ar;
      });
      for (const [index, finding] of sorted.entries()) {
        const raw = rawFor(finding);
        const points = round(raw * (DECAY[Math.min(index, DECAY.length - 1)] ?? 0.2));
        const record = deductions.find((entry) => entry.findingId === finding.id);
        if (record) record.points = points;
        applied += points;
      }
    }
    applied = Math.min(100, round(applied));
    categoryScores.push({
      category,
      label: CATEGORY_LABELS[category],
      weight,
      measured,
      score: measured ? round(100 - applied) : 0,
      deductionTotal: applied,
      findingCount: categoryFindings.length,
      ...(input.categoryNotes?.[category] ? { note: input.categoryNotes[category] } : {}),
    });
  }

  for (const finding of active) {
    const record = deductions.find((entry) => entry.findingId === finding.id);
    finding.deduction = record?.points ?? 0;
  }

  const measuredScores = categoryScores.filter((category) => category.measured);
  const weighted =
    weightTotal === 0
      ? 100
      : round(
          measuredScores.reduce((sum, category) => sum + category.score * category.weight, 0) / weightTotal,
        );
  const cap = CAPS.find((entry) =>
    active.some((finding) => finding.confirmation === "confirmed" && finding.severity === entry.severity),
  );
  const overall = cap ? Math.min(weighted, cap.value) : weighted;
  const confirmed = active.filter((finding) => finding.confirmation === "confirmed");
  const uncertain = active.filter((finding) => finding.confirmation !== "confirmed");
  const uncertainShare =
    active.length === 0
      ? 0
      : uncertain.reduce((sum, finding) => sum + finding.deduction, 0) /
        Math.max(1, active.reduce((sum, finding) => sum + finding.deduction, 0));
  const parsePenalty = (input.parseFailures ?? 0) > 0 ? 0.15 : 0;
  const unsupportedPenalty = Math.min(0.35, Math.max(0, input.unsupportedShare ?? 0) * 0.7);
  const confidence: FindingConfidence =
    input.mode === "quick" || uncertainShare + parsePenalty + unsupportedPenalty >= 0.45
      ? "low"
      : uncertainShare + parsePenalty + unsupportedPenalty >= 0.2
        ? "medium"
        : "high";
  const band =
    "±" +
    Math.max(
      2,
      Math.round(
        3 +
          uncertainShare * 10 +
          parsePenalty * 20 +
          unsupportedPenalty * 20 +
          (input.mode === "quick" ? 2 : 0),
      ),
    );

  return {
    overall,
    measuredWeight: weightTotal,
    categories: categoryScores,
    deductions,
    confidence,
    band,
    ...(cap ? { cap: { value: cap.value, reason: cap.reason } } : {}),
    summary:
      "Overall " +
      overall +
      "/100 (" +
      grade(overall) +
      ") from " +
      measuredScores.length +
      " measured categories (" +
      Math.round(weightTotal) +
      "/100 weight)" +
      (cap ? " (severity cap applied)" : "") +
      " and " +
      active.length +
      " active findings; " +
      confirmed.length +
      " confirmed, " +
      uncertain.length +
      " potential/unproven.",
  };
}

function rawFor(finding: AuditFinding): number {
  const base = BASE_POINTS[finding.severity] ?? 1;
  return round(
    base *
      (CONFIRMATION_FACTOR[finding.confirmation] ?? 1) *
      (CONFIDENCE_FACTOR[finding.confidence] ?? 1),
  );
}

export function grade(score: number): string {
  if (score >= 95) return "excellent";
  if (score >= 80) return "strong";
  if (score >= 70) return "fair";
  if (score >= 60) return "weak";
  return "critical";
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
