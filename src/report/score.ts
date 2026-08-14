import type { ScanResult } from "../analyzers/types.js";

/**
 * score.ts — the OpenPitStop Score.
 *
 * Every scan collapses into a single 0–100 health score, weighted across the
 * categories that actually ran (skipped categories are excluded and the weights
 * renormalized, so a missing jscpd never silently tanks the number). The score
 * powers the box's headline line, the verify Δ, the report, and the README
 * badge.
 */

export interface CategoryScore {
  key: string;
  label: string;
  /** 0..100 category health. */
  score: number;
  /** Relative weight used in the weighted average. */
  weight: number;
  status: "ok" | "skipped";
  note?: string;
}

export interface ScoreResult {
  /** 0..100 composite (0 if no category could run). */
  score: number;
  /** A+ .. F from score. */
  grade: string;
  categories: CategoryScore[];
  /** Categories that actually ran and counted. */
  analyzed: number;
  /** Total categories the model knows about. */
  total: number;
}

const GRADE_BANDS: [number, string][] = [
  [95, "A+"], [90, "A"], [85, "A-"], [80, "B+"], [75, "B"], [70, "B-"],
  [65, "C+"], [60, "C"], [55, "C-"], [50, "D"], [0, "F"],
];

export function gradeOf(score: number): string {
  for (const [min, g] of GRADE_BANDS) if (score >= min) return g;
  return "F";
}

/** Hex color for the SVG badge segment. */
export function gradeHex(grade: string): string {
  switch (grade[0]) {
    case "A": return "#4CAF50";
    case "B": return "#8BC34A";
    case "C": return "#FFC107";
    case "D": return "#FF9800";
    default: return "#E53935";
  }
}

/** Terminal/Light color name for the grade (MetricLine.color). */
export function gradeColor(grade: string): "green" | "yellow" | "red" {
  switch (grade[0]) {
    case "A": return "green";
    case "B":
    case "C": return "yellow";
    default: return "red";
  }
}

const sevPenalty = (sev: string): number => {
  switch (sev) {
    case "critical": return 25;
    case "high": return 12;
    case "medium": return 5;
    case "low": return 2;
    case "warning": return 2;
    default: return 3;
  }
};

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

export function penalty100(issues: { severity: string }[]): number {
  let sum = 0;
  for (const i of issues) sum += sevPenalty(i.severity);
  return clamp(100 - sum);
}

export function scoreCategories(r: ScanResult): CategoryScore[] {
  const cats: CategoryScore[] = [];

  const sec = r.security;
  if (sec.status === "ok") {
    cats.push({ key: "security", label: "Security", weight: 22, score: penalty100(sec.issues), status: "ok" });
  }

  const t = r.tests;
  if (t.status === "ok") {
    let s: number;
    if (t.total === 0) {
      s = 70; // no tests → neutral baseline, not a pass
    } else {
      s = Math.round((100 * t.passed) / t.total);
      // Broken tests cap the score regardless of pass ratio — a red suite is red.
      if (t.failed > 0) s = Math.min(s, 50);
      if (t.coverage != null) s += t.coverage >= 80 ? 10 : t.coverage >= 60 ? 5 : 0;
      s = clamp(s);
    }
    cats.push({ key: "tests", label: "Tests", weight: 20, score: s, status: "ok" });
  }

  const dg = r.dependencyGraph;
  if (dg.status === "ok") {
    cats.push({
      key: "graph",
      label: "Dependency graph",
      weight: 10,
      score: clamp(100 - dg.circular.length * 15 - dg.orphans.length),
      status: "ok",
    });
  }

  const dup = r.duplication;
  if (dup.status === "ok") {
    cats.push({ key: "duplication", label: "Duplication", weight: 10, score: clamp(100 - dup.cloneCount * 8), status: "ok" });
  }

  const p = r.perf;
  if (p.status === "ok") {
    let s = 80;
    if (p.buildTimeMs != null) s = p.buildTimeMs < 10_000 ? 100 : p.buildTimeMs < 30_000 ? 80 : p.buildTimeMs < 60_000 ? 60 : 40;
    if (p.bundleSizeBytes != null && p.bundleSizeBytes > 512 * 1024) s -= 20;
    cats.push({ key: "perf", label: "Performance", weight: 10, score: clamp(s), status: "ok" });
  }

  const a = r.accessibility;
  if (a.status === "ok") {
    cats.push({ key: "a11y", label: "Accessibility", weight: 10, score: penalty100(a.issues), status: "ok" });
  }

  const rel = r.reliability;
  if (rel.status === "ok") {
    cats.push({
      key: "reliability",
      label: "Reliability",
      weight: 8,
      score: clamp(100 - rel.flakyTests.length * 15 - rel.raceSmells.length * 8),
      status: "ok",
    });
  }

  const dx = r.devex;
  if (dx.status === "ok") {
    cats.push({
      key: "devex",
      label: "DevEx",
      weight: 5,
      score: clamp(100 - dx.unusedExports.length * 3 - dx.duplicateFunctions.length * 5),
      status: "ok",
    });
  }

  const lg = r.ledger;
  if (lg && lg.status === "ok") {
    const charged = lg.evidence.filter((e) => e.doubleCharged).length;
    cats.push({
      key: "ledger",
      label: "Ledger idempotency",
      weight: 5,
      score: charged > 0 ? 0 : 100,
      status: "ok",
    });
  }

  return cats;
}

export interface ScoreOptions {
  /** Integrity-gate penalty (25 for confirmed cheat, 10 for suspicious). */
  integrityPenalty?: number;
}

export function computeScore(r: ScanResult, opts: ScoreOptions = {}): ScoreResult {
  const categories = scoreCategories(r);
  const included = categories.filter((c) => c.status === "ok");
  const totalWeight = included.reduce((s, c) => s + c.weight, 0);
  let score = 0;
  if (totalWeight > 0) {
    score = included.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight;
  }
  if (opts.integrityPenalty) score -= opts.integrityPenalty;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, grade: gradeOf(score), categories, analyzed: included.length, total: categories.length };
}

/** Shield-style SVG badge, single file, no external assets — README-ready. */
export function renderBadgeSvg(s: ScoreResult): string {
  const color = gradeHex(s.grade);
  const left = "PITSTOP";
  const right = `${s.score}/100 ${s.grade}`;
  const wLeft = Math.round(left.length * 7.4 + 14);
  const wRight = Math.round(right.length * 7.4 + 14);
  const w = wLeft + wRight;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="OpenPitStop score ${s.score}/100 (${s.grade})">
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#5c5c5c" stop-opacity="0.95"/>
    <stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.95"/>
  </linearGradient>
  <rect width="${w}" height="20" rx="3" fill="url(#g)"/>
  <rect x="${wLeft}" width="${wRight}" height="20" fill="${color}"/>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${wLeft / 2}" y="14">${left}</text>
    <text x="${wLeft + wRight / 2}" y="14">${right}</text>
  </g>
</svg>`;
}