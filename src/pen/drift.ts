/**
 * pen/drift.ts — compare a pen run against the previously sealed run.
 *
 * This is the differentiator a finder-only tool (Strix) never ships: it doesn't
 * just report once, it remembers. OpenPitStop re-reads the last `.pitstop/
 * pen-latest.json` and tells you, in one glance:
 *
 *   - NEW findings      → a regression introduced since the last run
 *   - RESOLVED findings → a fix that made a previous finding disappear (proof)
 *   - ESCALATIONS       → a static hypothesis the live attack just confirmed
 *
 * `regression` is true when a NEW high/critical appeared, or a hypothesis
 * escalated to PROVEN — exactly the signal a CI gate should fail on.
 */

import type { PenFinding, PenConfidence, PenDrift, PenDriftEntry, PenDriftEscalation } from "./types.js";

// Lower rank = more certain / more dangerous. Used to detect escalations.
const RANK: Record<PenConfidence, number> = {
  proven: 0,
  indicated: 1,
  heuristic: 2,
};

function key(f: PenFinding): string {
  return `${f.type}|${f.route ?? f.file ?? "?"}`;
}

function toEntry(f: PenFinding): PenDriftEntry {
  return {
    id: f.id,
    type: f.type,
    target: f.route ?? f.file ?? "?",
    severity: f.severity,
    confidence: f.confidence,
    title: f.title,
  };
}

export function computePenDrift(
  prev: PenFinding[] | null,
  cur: PenFinding[],
  baselineTimestamp?: string,
): PenDrift {
  if (!prev || prev.length === 0) {
    return { new: [], resolved: [], escalations: [], regression: false };
  }

  const prevByKey = new Map<string, PenFinding>();
  for (const f of prev) prevByKey.set(key(f), f);
  const curByKey = new Map<string, PenFinding>();
  for (const f of cur) curByKey.set(key(f), f);

  const news: PenDriftEntry[] = [];
  for (const f of cur) if (!prevByKey.has(key(f))) news.push(toEntry(f));

  const resolved: PenDriftEntry[] = [];
  for (const f of prev) if (!curByKey.has(key(f))) resolved.push(toEntry(f));

  const escalations: PenDriftEscalation[] = [];
  for (const f of cur) {
    const p = prevByKey.get(key(f));
    if (p && RANK[f.confidence] < RANK[p.confidence]) {
      escalations.push({
        id: f.id,
        type: f.type,
        target: f.route ?? f.file ?? "?",
        from: p.confidence,
        to: f.confidence,
      });
    }
  }

  const regression =
    news.some((e) => e.severity === "critical" || e.severity === "high") ||
    escalations.some((e) => e.to === "proven" && e.from !== "proven");

  return { baselineTimestamp, new: news, resolved, escalations, regression };
}
