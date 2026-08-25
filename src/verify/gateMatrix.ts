import path from "node:path";
import { latestPitstopDoc } from "./chain.js";

/**
 * gateMatrix.ts — the GATE as final independent verification authority.
 *
 * The agent can say "DONE". The gate independently determines "is there enough
 * TRUSTWORTHY EVIDENCE to say DONE?" by evaluating the evidence produced by the
 * verification layers — never the agent's self-reported completion status.
 *
 * DETERMINISTIC DECISION MATRIX (evaluated strictly in this order):
 *
 *   1. any layer CHEAT        → CHEAT     (evidence or verification manipulation:
 *                                          CONFIRMED_CHEAT, tampered evidence documents)
 *   2. any layer BLOCKED      → BLOCKED   (critical regression / proven critical security)
 *   3. any layer FAILED       → FAILED    (required verification failed: tests, acceptance,
 *                                          holdout, baseline, state)
 *   4. required layers unmet  → UNPROVEN  (a configured requirement has no passing evidence)
 *   5. strong pass, all clear → VERIFIED  (baseline/acceptance/holdout passed, nothing unproven)
 *   6. otherwise              → UNPROVEN  (insufficient deep evidence — legacy scan-only runs
 *                                          keep exit 0 for backward compatibility, labeled honestly)
 *
 * Checks that were never configured are reported NOT_CONFIGURED — they are
 * never fabricated into a pass. Skipped tools are SKIPPED.
 */

export type GateLayerStatus =
  | "PASS"
  | "FAIL"
  | "UNPROVEN"
  | "SKIPPED"
  | "NOT_CONFIGURED"
  | "TAMPERED"
  | "CHEAT"
  | "BLOCKED";

export interface GateLayer {
  id: string;
  label: string;
  status: GateLayerStatus;
  detail: string;
  evidenceRef?: string;
  reasons: string[];
}

export type GateVerdict = "VERIFIED" | "FAILED" | "UNPROVEN" | "BLOCKED" | "CHEAT";

export interface GateDecision {
  verdict: GateVerdict;
  exitCode: number;
  layers: GateLayer[];
  reasons: string[];
  summary: { layers: number; passed: number; failed: number; unproven: number; notConfigured: number; tampered: number };
}

/** Live results from `runVerify` (the scan-based measurement layer). */
export interface LiveGateInput {
  missingBaseline: boolean;
  blocked: boolean;
  integrityVerdict: string;
  evidenceStatus: string;
  risk: string;
  currentScore: number;
  currentGrade: string;
  testsPassed: number;
  testsFailed: number;
  stale: boolean;
  staleNote?: string;
}

export interface GateMatrixOptions {
  threshold: number;
  /** Layer ids that MUST have passing evidence for VERIFIED (e.g. "baseline,acceptance"). */
  require?: string[];
}

const LAYER_ORDER = [
  "state",
  "baseline",
  "acceptance",
  "tests",
  "stack",
  "architecture",
  "regression",
  "security",
  "integrity",
  "holdout",
  "verifier",
] as const;

function sealedLayer(
  repo: string,
  id: string,
  label: string,
  prefix: string,
  exclude: string[],
  map: (doc: any) => { status: GateLayerStatus; detail: string; reasons: string[] },
): GateLayer {
  const found = latestPitstopDoc(path.join(repo, ".pitstop"), prefix, exclude);
  if (!found) {
    return { id, label, status: "NOT_CONFIGURED", detail: "never run", reasons: [] };
  }
  const relRef = path.relative(repo, found.file) || found.file;
  if (found.check.status !== "verified" || !found.doc) {
    return {
      id, label, status: "CHEAT",
      detail: `evidence tampered or malformed (${relRef})`,
      evidenceRef: relRef,
      reasons: [`${label}: evidence failed its own seal — ${found.check.reason ?? "digest mismatch"}. Evidence manipulation is a CHEAT condition.`],
    };
  }
  const m = map(found.doc);
  return { id, label, status: m.status, detail: m.detail, evidenceRef: relRef, reasons: m.reasons };
}

export function evaluateGate(
  repo: string,
  live: LiveGateInput,
  opts: GateMatrixOptions,
): GateDecision {
  const layers: GateLayer[] = [];
  const reasons: string[] = [];
  const requireSet = new Set((opts.require ?? []).map((s) => s.trim()).filter(Boolean));

  // ---- live: tests + score + risk
  if (live.missingBaseline) {
    // backward-compatible: the gate has always failed hard with no scan baseline
    layers.push({ id: "tests", label: "Tests", status: "FAIL", detail: "no scan baseline — run `pitstop scan` first", reasons: ["no baseline — run `pitstop scan` (or `pitstop try`) once to create one"] });
  } else {
    const failedTests = live.testsFailed ?? 0;
    const belowScore = live.currentScore < opts.threshold;
    const highRisk = live.risk === "High";
    if (failedTests > 0 || highRisk || belowScore) {
      const why: string[] = [];
      if (failedTests > 0) why.push(`${failedTests} failing test(s)`);
      if (highRisk) why.push("regression risk HIGH");
      if (belowScore) why.push(`score ${live.currentScore}/100 below the ${opts.threshold}/100 gate`);
      layers.push({ id: "tests", label: "Tests", status: "FAIL", detail: `${live.testsPassed} passed / ${failedTests} failed · score ${live.currentScore}/100 (${live.currentGrade})`, reasons: why });
    } else {
      layers.push({ id: "tests", label: "Tests", status: "PASS", detail: `${live.testsPassed} passed / ${failedTests} failed · score ${live.currentScore}/100 (${live.currentGrade})`, reasons: [] });
    }
    if (live.stale) layers.push({ id: "stale", label: "Baseline freshness", status: "UNPROVEN", detail: live.staleNote ?? "baseline is stale", reasons: [live.staleNote ?? "baseline is stale"] });
  }

  // ---- live: integrity + evidence signature
  if (live.evidenceStatus === "tampered") {
    layers.push({ id: "integrity", label: "Integrity", status: "CHEAT", detail: "baseline evidence TAMPERED", reasons: ["the scan baseline was edited after OpenPitStop signed it — evidence manipulation"] });
  } else if (live.blocked && live.integrityVerdict === "CONFIRMED_CHEAT") {
    layers.push({ id: "integrity", label: "Integrity", status: "CHEAT", detail: "CONFIRMED_CHEAT", reasons: ["agent-cheat detectors CONFIRMED manipulation (deleted test / hardcoded pass / forced exit)"] });
  } else if (live.integrityVerdict === "SUSPICIOUS" || live.blocked) {
    layers.push({ id: "integrity", label: "Integrity", status: "UNPROVEN", detail: live.integrityVerdict, reasons: ["integrity gate SUSPICIOUS — needs human review"] });
  } else {
    layers.push({ id: "integrity", label: "Integrity", status: "PASS", detail: "INTACT", reasons: [] });
  }

  // ---- sealed: baseline-aware verification
  layers.push(
    sealedLayer(repo, "baseline", "Baseline", "baseline-verify-", [], (doc) => {
      switch (doc.verdict) {
        case "VERIFIED": return { status: "PASS", detail: `VERIFIED @ ${(doc.candidate?.commitSha ?? "").slice(0, 12)}…`, reasons: [] };
        case "FAILED": return { status: "FAIL", detail: "candidate still fails the baseline verification", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "INTEGRITY_FAILURE": return { status: "CHEAT", detail: "verification identity changed or evidence broken", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: state verification
  layers.push(
    sealedLayer(repo, "state", "State", "state-verify-", [], (doc) => {
      switch (doc.verdict) {
        case "STATE_VERIFIED": return { status: "PASS", detail: `VERIFIED @ ${(doc.candidate?.sha ?? "").slice(0, 12)}…`, reasons: [] };
        case "STATE_MISMATCH": return { status: "FAIL", detail: "claimed changes not observed on disk/git", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "INTEGRITY_FAILURE": return { status: "CHEAT", detail: "state evidence integrity failure", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: acceptance
  layers.push(
    sealedLayer(repo, "acceptance", "Acceptance", "acceptance-", ["acceptance-pin.json"], (doc) => {
      const total = doc.totalCriteria ?? (doc.criteria?.length ?? 0);
      const verified = (doc.criteria ?? []).filter((e: any) => e.pass === true).length;
      switch (doc.verdict) {
        case "SATISFIED": return { status: "PASS", detail: `${verified}/${total} criteria`, reasons: [] };
        case "NOT_SATISFIED": return { status: "FAIL", detail: `${verified}/${total} criteria — requirement not met`, reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "INTEGRITY_FAILURE": return { status: "CHEAT", detail: "contract changed after authorization", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: regression
  layers.push(
    sealedLayer(repo, "regression", "Regression", "regression-", ["regression-baseline.json"], (doc) => {
      const regs: string[] = doc.regressions ?? [];
      const news: string[] = doc.newFailures ?? [];
      switch (doc.verdict) {
        case "NO_REGRESSION": return { status: "PASS", detail: "NONE", reasons: [] };
        case "REGRESSION": return { status: "BLOCKED", detail: [...regs, ...news].join(", "), reasons: Array.isArray(doc.reasons) ? doc.reasons : ["previously passing checks now failing"] };
        case "INTEGRITY_FAILURE": return { status: "CHEAT", detail: "comparison could not be trusted", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: verification stack (tests/typecheck/lint/build with diagnosis)
  layers.push(
    sealedLayer(repo, "stack", "Verify stack", "verify-stack-", [], (doc) => {
      const failed: string[] = doc.failedLayers ?? [];
      switch (doc.verdict) {
        case "STACK_PASS": {
          const parts = (doc.layers ?? [])
            .filter((l: any) => l.status === "PASS")
            .map((l: any) => `${l.id}${l.counts ? ` ${l.counts.passed}/${l.counts.total}` : " ✓"}`);
          return { status: "PASS", detail: parts.join(" · ") || "all configured layers pass", reasons: [] };
        }
        case "STACK_FAIL": return { status: "FAIL", detail: `failed: ${failed.join(", ")}`, reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: architecture & boundaries
  layers.push(
    sealedLayer(repo, "architecture", "Architecture", "architecture-", [], (doc) => {
      switch (doc.verdict) {
        case "CONFORMS": return { status: "PASS", detail: doc.planRef ? "conforms · plan scope checked" : "conforms", reasons: [] };
        case "APPROVAL_REQUIRED": return { status: "UNPROVEN", detail: "protected path touched — approval required", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "VIOLATIONS": return { status: "FAIL", detail: "boundary/forbidden/plan violations", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "INTEGRITY_FAILURE": return { status: "CHEAT", detail: "architecture check could not be trusted", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: [] };
      }
    }),
  );

  // ---- sealed: security (pen) + drift
  layers.push(
    sealedLayer(repo, "security", "Security", "pen-latest.json", [], (doc) => {
      const findings = doc.findings ?? [];
      const provenCritical = findings.filter(
        (f: any) => (f.proofStatus === "proven" || f.verdict === "proven") && ["high", "critical"].includes(String(f.severity ?? "").toLowerCase()),
      );
      const driftNew = doc.drift?.new ?? doc.drift?.newFindings ?? [];
      if (provenCritical.length > 0) {
        return { status: "BLOCKED", detail: `${provenCritical.length} PROVEN high/critical finding(s)`, reasons: [`proven high/critical security findings: ${provenCritical.map((f: any) => f.id ?? f.title ?? "?").join(", ")}`] };
      }
      if (driftNew.length > 0) {
        return { status: "BLOCKED", detail: `${driftNew.length} NEW finding(s) vs last sealed run`, reasons: ["security drift: new findings since the last sealed pen run"] };
      }
      return { status: "PASS", detail: findings.length > 0 ? `${findings.length} finding(s), none proven high/critical` : "CLEAR", reasons: [] };
    }),
  );

  // ---- sealed: holdout
  layers.push(
    sealedLayer(repo, "holdout", "Holdout", "holdout-", [], (doc) => {
      switch (doc.verdict) {
        case "HOLDOUT_PASS": return { status: "PASS", detail: `suite ${doc.suite?.id ?? "?"} passed`, reasons: [] };
        case "HOLDOUT_FAIL": return { status: "FAIL", detail: "hidden requirements not satisfied", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "HOLDOUT_INTEGRITY_FAILURE": return { status: "CHEAT", detail: "holdout modified or untrusted", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
      }
    }),
  );

  // ---- sealed: verifier health (informational; tampered = CHEAT)
  layers.push(
    sealedLayer(repo, "verifier", "Verifier health", "verifier-check-", [], (doc) => {
      switch (doc.verdict) {
        case "VERIFIER_VALID": return { status: "PASS", detail: "falsifiable", reasons: [] };
        case "VERIFIER_WEAK": return { status: "UNPROVEN", detail: "passed a known-bad state — weak evidence", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "VERIFIER_BROKEN": return { status: "FAIL", detail: "fails a known-good state", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        case "INTEGRITY_FAILURE": return { status: "UNPROVEN", detail: "self-test could not run", reasons: Array.isArray(doc.reasons) ? doc.reasons : [] };
        default: return { status: "UNPROVEN", detail: doc.verdict ?? "unknown", reasons: [] };
      }
    }),
  );

  // ---- order layers for display
  const byId = new Map(layers.map((l) => [l.id, l]));
  const ordered = LAYER_ORDER.map((id) => byId.get(id)).filter((l): l is GateLayer => !!l);
  for (const l of layers) if (!ordered.includes(l)) ordered.push(l);

  // ---- deterministic decision matrix
  const cheat = ordered.filter((l) => l.status === "CHEAT");
  const blocked = ordered.filter((l) => l.status === "BLOCKED");
  const failed = ordered.filter((l) => l.status === "FAIL");
  const unproven = ordered.filter((l) => l.status === "UNPROVEN");

  let verdict: GateVerdict;
  let exitCode: number;
  if (cheat.length > 0) {
    verdict = "CHEAT";
    exitCode = 2;
    for (const l of cheat) reasons.push(...l.reasons);
  } else if (blocked.length > 0) {
    verdict = "BLOCKED";
    exitCode = 1;
    for (const l of blocked) reasons.push(...l.reasons);
  } else if (failed.length > 0) {
    verdict = "FAILED";
    exitCode = 1;
    for (const l of failed) reasons.push(...l.reasons);
  } else {
    const strongPass = ordered.some((l) => ["baseline", "acceptance", "holdout"].includes(l.id) && l.status === "PASS");
    const unmetRequire = [...requireSet].filter((r) => byId.get(r)?.status !== "PASS");
    if (unmetRequire.length > 0) {
      verdict = "UNPROVEN";
      exitCode = 1;
      reasons.push(`required verification layers without passing evidence: ${unmetRequire.join(", ")} (--require)`);
    } else if (strongPass && unproven.length === 0) {
      verdict = "VERIFIED";
      exitCode = 0;
      reasons.push("strong verification passed (baseline/acceptance/holdout), all configured layers green, integrity intact");
    } else {
      verdict = "UNPROVEN";
      exitCode = 0; // legacy-compatible: scan-based checks pass; deep evidence is insufficient
      reasons.push(
        strongPass
          ? "unproven layers remain — their results cannot be trusted as pass or fail"
          : "insufficient deep evidence for VERIFIED — run `pitstop baseline-verify`, `pitstop acceptance-verify`, or `pitstop holdout-verify` (all scan-based checks pass)",
      );
    }
  }

  return {
    verdict,
    exitCode,
    layers: ordered,
    reasons,
    summary: {
      layers: ordered.length,
      passed: ordered.filter((l) => l.status === "PASS").length,
      failed: ordered.filter((l) => l.status === "FAIL" || l.status === "BLOCKED").length,
      unproven: ordered.filter((l) => l.status === "UNPROVEN").length,
      notConfigured: ordered.filter((l) => l.status === "NOT_CONFIGURED").length,
      tampered: ordered.filter((l) => l.status === "CHEAT" || l.status === "TAMPERED").length,
    },
  };
}

/** The matrix box (existing project UI style). */
export function renderGateMatrix(decision: GateDecision): string {
  const line = (label: string, l: GateLayer | undefined) => {
    if (!l) return "";
    const mark =
      l.status === "PASS" ? "✓" : l.status === "FAIL" || l.status === "BLOCKED" ? "✗" : l.status === "CHEAT" ? "✗" : l.status === "UNPROVEN" ? "?" : "—";
    return `${mark} ${label.padEnd(16)} ${l.status}${l.detail ? ` · ${l.detail}` : ""}`;
  };
  const rows: string[] = [];
  for (const l of decision.layers) {
    const label = l.label.padEnd(16);
    const mark =
      l.status === "PASS" ? "✓" : l.status === "FAIL" || l.status === "BLOCKED" || l.status === "CHEAT" ? "✗" : l.status === "UNPROVEN" ? "?" : "—";
    rows.push(`${mark} ${label} ${l.status}${l.detail ? ` · ${l.detail}` : ""}`);
  }
  void line;
  const vColor = decision.verdict === "VERIFIED" ? "\x1b[32m" : decision.verdict === "CHEAT" || decision.verdict === "BLOCKED" ? "\x1b[31m" : decision.verdict === "FAILED" ? "\x1b[31m" : "\x1b[33m";
  const reset = "\x1b[39m\x1b[22m";
  rows.push("".padEnd(44, "─"));
  rows.push(`${vColor}\x1b[1mVERDICT: ${decision.verdict}\x1b[22m${reset}`);
  return rows.join("\n");
}
