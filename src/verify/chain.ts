import fs from "node:fs";
import path from "node:path";
import { seal, checkEvidence, canonicalize, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";

/**
 * chain.ts — the unified, explainable VERIFICATION EVIDENCE CHAIN.
 *
 * When OpenPitStop produces a verdict, a developer must be able to answer
 * "why should I trust this verdict?" without reading source code. This module
 * aggregates the REAL sealed evidence documents OpenPitStop already wrote into
 * `.pitstop/` (baseline-verify, state-verify, verifier-check, holdout,
 * acceptance, regression, verify/integrity, scan) into one chain:
 *
 *   TASK → BASELINE → STATE → TESTS → ACCEPTANCE → SECURITY → REGRESSION →
 *   INTEGRITY → EVIDENCE → VERDICT
 *
 * HONESTY CONTRACTS:
 *  - Only components that actually ran appear with a real status. A component
 *    with no evidence document is NOT_CONFIGURED — never a green check.
 *  - Every document's seal is re-verified; tampered or unreadable evidence is
 *    reported as TAMPERED and BLOCKS the verdict.
 *  - Skipped checks (the underlying tool reported "skipped") are SKIPPED.
 *  - Ran-but-could-not-classify results are UNPROVEN.
 *  - The verdict is derived, never asserted: BLOCKED on any failure/tamper,
 *    VERIFIED only when a strong verification passed and nothing is unproven,
 *    UNPROVEN otherwise.
 */

export type ChainStatus = "PASS" | "FAIL" | "SKIPPED" | "NOT_CONFIGURED" | "UNPROVEN" | "TAMPERED";

export interface ChainItem {
  id: string;
  category: string;
  status: ChainStatus;
  timestamp?: string;
  commitSha?: string;
  command?: string;
  inputs?: string;
  outputs?: string;
  evidenceRef: string;
  digest?: string;
  reason: string;
}

export type ChainVerdict = "VERIFIED" | "BLOCKED" | "UNPROVEN";

export interface EvidenceChain {
  repo: string;
  generatedAt: string;
  items: ChainItem[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    unproven: number;
    skipped: number;
    notConfigured: number;
    tampered: number;
    regressions: number;
    integrityViolations: number;
  };
  verdict: ChainVerdict;
  reasons: string[];
}

/** Categories in chain order. `exclude` protects non-report files sharing a prefix. */
const CATEGORIES: {
  id: string;
  category: string;
  prefix: string;
  exclude?: string[];
  label: string;
}[] = [
  { id: "baseline-verification", category: "BASELINE", prefix: "baseline-verify-", label: "baseline verification" },
  { id: "state-verification", category: "STATE", prefix: "state-verify-", label: "state verification" },
  { id: "tests", category: "TESTS", prefix: "scan-latest.json", label: "tests (scan)" },
  { id: "acceptance", category: "ACCEPTANCE", prefix: "acceptance-", exclude: ["acceptance-pin.json"], label: "acceptance criteria" },
  { id: "security", category: "SECURITY", prefix: "scan-latest.json", label: "security (scan)" },
  { id: "pen", category: "PEN", prefix: "pen-latest.json", label: "security (pen)" },
  { id: "regression-check", category: "REGRESSION", prefix: "regression-", exclude: ["regression-baseline.json"], label: "regression checks" },
  { id: "integrity", category: "INTEGRITY", prefix: "verify-", label: "integrity" },
  { id: "verifier-health", category: "VERIFIER", prefix: "verifier-check-", label: "verifier health" },
  { id: "holdout", category: "HOLDOUT", prefix: "holdout-", label: "holdout verification" },
];

function latestDoc(dir: string, prefix: string, exclude: string[] = []): { file: string; doc: any; check: EvidenceCheck } | null {
  if (!fs.existsSync(dir)) return null;
  let latest: string | null = null;
  let latestMtime = 0;
  for (const f of fs.readdirSync(dir)) {
    if (exclude.includes(f)) continue;
    if (prefix.endsWith(".json") ? f !== prefix : !f.startsWith(prefix)) continue;
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p).mtimeMs;
      if (st > latestMtime) {
        latestMtime = st;
        latest = p;
      }
    } catch {}
  }
  if (!latest) return null;
  try {
    const raw = fs.readFileSync(latest, "utf8");
    const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const doc = JSON.parse(clean);
    return { file: latest, doc, check: checkEvidence(doc) };
  } catch (e: any) {
    // unreadable/malformed evidence is an integrity problem, not a silent skip
    return { file: latest, doc: null, check: { status: "tampered", digest: "", reason: `unreadable or malformed: ${e.message}` } };
  }
}

function pickSha(doc: any): string | undefined {
  return doc?.candidate?.sha ?? doc?.candidate?.commitSha ?? doc?.commitSha ?? doc?.sha ?? undefined;
}

function statusFromVerdict(verdict: string | undefined): { status: ChainStatus; blocking: boolean } {
  switch (verdict) {
    case "VERIFIED":
    case "STATE_VERIFIED":
    case "SATISFIED":
    case "HOLDOUT_PASS":
    case "NO_REGRESSION":
    case "VERIFIER_VALID":
      return { status: "PASS", blocking: false };
    case "FAILED":
    case "STATE_MISMATCH":
    case "NOT_SATISFIED":
    case "HOLDOUT_FAIL":
    case "REGRESSION":
    case "VERIFIER_BROKEN":
      return { status: "FAIL", blocking: true };
    case "UNPROVEN":
    case "HOLDOUT_UNPROVEN":
    case "VERIFIER_WEAK":
      return { status: "UNPROVEN", blocking: false };
    case "INTEGRITY_FAILURE":
    case "HOLDOUT_INTEGRITY_FAILURE":
      return { status: "FAIL", blocking: true };
    default:
      return { status: "UNPROVEN", blocking: false };
  }
}

/** Build the chain from the REAL evidence documents in <repo>/.pitstop. */
export function buildEvidenceChain(repo: string): EvidenceChain {
  const repoAbs = path.resolve(repo);
  const pitstop = path.join(repoAbs, ".pitstop");
  const items: ChainItem[] = [];
  const reasons: string[] = [];

  for (const cat of CATEGORIES) {
    const found = latestDoc(pitstop, cat.prefix, cat.exclude);
    if (!found) {
      items.push({
        id: cat.id,
        category: cat.category,
        status: "NOT_CONFIGURED",
        evidenceRef: "",
        reason: `${cat.label}: never run — no evidence document in .pitstop/`,
      });
      continue;
    }
    const { file, doc, check } = found;
    const relRef = path.relative(repoAbs, file) || file;
    const digest = check.digest;

    // integrity of the evidence document itself
    if (check.status === "tampered" || !doc) {
      items.push({
        id: cat.id,
        category: cat.category,
        status: "TAMPERED",
        evidenceRef: relRef,
        digest,
        reason: `${cat.label}: evidence is TAMPERED or unreadable — ${check.reason ?? "digest mismatch"}. The verdict cannot be trusted.`,
      });
      reasons.push(`${cat.label} evidence is tampered or malformed (${relRef})`);
      continue;
    }

    const sha = pickSha(doc);
    const ts = doc.timestamp;

    if (cat.id === "tests" || cat.id === "security") {
      // scan-derived items
      const sec = cat.id === "security";
      const section = sec ? doc.security : doc.tests;
      if (!section || section.status === "skipped") {
        items.push({
          id: cat.id, category: cat.category, status: "SKIPPED",
          timestamp: doc.timestamp, evidenceRef: relRef, digest,
          reason: `${cat.label}: the underlying scan recorded this category as skipped (tool not installed or not applicable)`,
        });
        continue;
      }
      if (sec) {
        const n = (section.issues ?? []).length;
        items.push({
          id: cat.id, category: cat.category, status: "PASS",
          timestamp: doc.timestamp, commitSha: undefined, evidenceRef: relRef, digest,
          outputs: `${n} finding(s)`,
          reason: `security scan ran — ${n} finding(s) observed${n > 0 ? " (findings are evidence, not a verification failure)" : ""}`,
        });
      } else {
        const failed = section.failed ?? 0;
        const passed = section.passed ?? 0;
        items.push({
          id: cat.id, category: cat.category, status: failed > 0 ? "FAIL" : "PASS",
          timestamp: doc.timestamp, evidenceRef: relRef, digest,
          outputs: `${passed} passed / ${failed} failed`,
          reason: failed > 0 ? `${failed} test(s) failing in the scan baseline` : `${passed} test(s) passing in the scan baseline`,
        });
      }
      continue;
    }

    if (cat.id === "pen") {
      const findings = doc.findings ?? [];
      const proven = findings.filter((f: any) => f.proofStatus === "proven" || f.verdict === "proven").length;
      items.push({
        id: cat.id, category: cat.category, status: "PASS",
        timestamp: doc.timestamp, evidenceRef: relRef, digest,
        outputs: `${findings.length} finding(s)${proven ? `, ${proven} proven` : ""}`,
        reason: `pen-test evidence present — ${findings.length} finding(s), ${proven} proven by live attack (findings are evidence, not a verification failure)`,
      });
      continue;
    }

    if (cat.id === "integrity") {
      const iv = doc.integrity?.verdict ?? "CLEAN";
      const blocked = doc.blocked === true;
      let status: ChainStatus;
      let reason: string;
      if (iv === "CONFIRMED_CHEAT" || blocked) {
        status = "FAIL";
        reason = `integrity gate ${iv} — agent-cheat detectors confirmed manipulation; the change is blocked`;
      } else if (iv === "SUSPICIOUS") {
        status = "UNPROVEN";
        reason = "integrity gate SUSPICIOUS — needs human review before trusting the change";
      } else {
        status = "PASS";
        reason = "integrity gate CLEAN — no cheat patterns in the diff";
      }
      if (doc.evidence?.status === "tampered") {
        status = "TAMPERED";
        reason = "the verify report's baseline evidence was edited after OpenPitStop signed it";
      }
      items.push({
        id: cat.id, category: cat.category, status,
        timestamp: doc.timestamp, evidenceRef: relRef, digest,
        outputs: iv,
        reason,
      });
      if (status === "FAIL") reasons.push(reason);
      continue;
    }

    // verdict-carrying documents (baseline/state/acceptance/holdout/regression/verifier)
    const { status, blocking } = statusFromVerdict(doc.verdict);
    const reasonText: string = Array.isArray(doc.reasons) && doc.reasons.length ? doc.reasons.join(" ") : `verdict ${doc.verdict ?? "unknown"}`;
    items.push({
      id: cat.id,
      category: cat.category,
      status,
      timestamp: ts,
      commitSha: sha,
      command: doc.command ?? doc.verification?.command,
      inputs: doc.suite ? `suite ${doc.suite.id ?? ""} (hash ${String(doc.suite.hash ?? "").slice(0, 12)})` : doc.contract ? `contract ${doc.contract.id} (hash ${String(doc.contract.hash ?? "").slice(0, 12)})` : undefined,
      outputs: doc.verdict,
      evidenceRef: relRef,
      digest,
      reason: `${cat.label}: ${doc.verdict ?? "unknown"} — ${reasonText.slice(0, 300)}`,
    });
    if (blocking) reasons.push(`${cat.label}: ${doc.verdict} — ${reasonText.slice(0, 200)}`);
  }

  const summary = {
    total: items.length,
    passed: items.filter((i) => i.status === "PASS").length,
    failed: items.filter((i) => i.status === "FAIL").length,
    unproven: items.filter((i) => i.status === "UNPROVEN").length,
    skipped: items.filter((i) => i.status === "SKIPPED").length,
    notConfigured: items.filter((i) => i.status === "NOT_CONFIGURED").length,
    tampered: items.filter((i) => i.status === "TAMPERED").length,
    regressions: items.find((i) => i.category === "REGRESSION")?.outputs === "REGRESSION"
      ? (latestDoc(pitstop, "regression-", ["regression-baseline.json"])?.doc.regressions ?? []).length
      : 0,
    integrityViolations: items.filter((i) => i.category === "INTEGRITY" && (i.status === "TAMPERED" || i.outputs === "CONFIRMED_CHEAT")).length,
  };

  const blocking = items.filter((i) => i.status === "FAIL" || i.status === "TAMPERED");
  const strongPass = items.some(
    (i) => i.status === "PASS" && ["BASELINE", "ACCEPTANCE", "HOLDOUT"].includes(i.category),
  );
  let verdict: ChainVerdict;
  if (blocking.length > 0) {
    verdict = "BLOCKED";
    if (reasons.length === 0) {
      for (const b of blocking) reasons.push(`${b.category}: ${b.reason}`);
    }
  } else if (strongPass && summary.unproven === 0) {
    verdict = "VERIFIED";
    reasons.push("a strong verification (baseline/acceptance/holdout) passed and nothing is unproven or failing");
  } else {
    verdict = "UNPROVEN";
    if (!strongPass) {
      reasons.push("no strong verification (baseline-aware, acceptance, or holdout) has passed yet — run `pitstop baseline-verify`, `pitstop acceptance-verify`, or `pitstop holdout-verify` for a strong verdict");
    } else {
      reasons.push("unproven checks remain — their results cannot be trusted as pass or fail");
    }
  }

  return { repo: repoAbs, generatedAt: new Date().toISOString(), items, summary, verdict, reasons };
}

/** Deterministic serialization of the chain content (timestamps excluded). */
export function canonicalChain(chain: EvidenceChain): string {
  const { generatedAt, ...rest } = chain;
  void generatedAt;
  return canonicalize(rest);
}

/** Seal the chain so the explanation itself is tamper-evident. */
export function sealEvidenceChain(chain: EvidenceChain): { path: string; evidence: OpenPitStopEvidence } {
  const outDir = path.join(chain.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const p = path.join(outDir, `explain-${ts}.json`);
  const doc = seal(
    {
      kind: "openpitstop-evidence-chain",
      repo: chain.repo,
      items: chain.items,
      summary: chain.summary,
      verdict: chain.verdict,
      reasons: chain.reasons,
    },
    `evidence chain for ${chain.repo}`,
  );
  fs.writeFileSync(p, JSON.stringify(doc, null, 2));
  return { path: p, evidence: (doc as any).evidence };
}

/** Human-readable explanation (the `pitstop explain` output). */
export function renderExplain(chain: EvidenceChain, verbose = false): string {
  const L: string[] = [];
  L.push(`${chalkBold("OPENPITSTOP VERDICT")}`);
  L.push("");
  for (const i of chain.items) {
    const mark =
      i.status === "PASS" ? "✓" : i.status === "FAIL" ? "✗" : i.status === "TAMPERED" ? "✗" : i.status === "UNPROVEN" ? "?" : "○";
    const paint =
      i.status === "PASS" ? green : i.status === "FAIL" || i.status === "TAMPERED" ? red : i.status === "UNPROVEN" ? yellow : dim;
    L.push(`${mark} ${paint(i.category.padEnd(11))} ${paint(i.status)}${i.commitSha ? dim(`  @ ${i.commitSha.slice(0, 12)}…`) : ""}`);
    if (verbose) {
      if (i.command) L.push(`    ${dim("command:")} ${i.command}`);
      if (i.inputs) L.push(`    ${dim("inputs:")} ${i.inputs}`);
      if (i.outputs) L.push(`    ${dim("outputs:")} ${i.outputs}`);
      if (i.timestamp) L.push(`    ${dim("at:")} ${i.timestamp}`);
      L.push(`    ${dim("evidence:")} ${i.evidenceRef}${i.digest ? dim(` (digest ${i.digest.slice(0, 12)}…)`) : ""}`);
      L.push(`    ${dim("why:")} ${i.reason}`);
    }
  }
  L.push("");
  L.push(
    `${chalkBold("Evidence:")} ${chain.summary.total} items · ` +
      `${green(`${chain.summary.passed} passed`)} · ` +
      `${chain.summary.failed ? red(`${chain.summary.failed} failed`) : `${chain.summary.failed} failed`} · ` +
      `${chain.summary.unproven} unproven · ${chain.summary.skipped} skipped · ${chain.summary.notConfigured} not configured · ` +
      `${chain.summary.tampered} tampered · ${chain.summary.regressions} regressions · ${chain.summary.integrityViolations} integrity violations`,
  );
  L.push("");
  L.push(chalkBold("VERDICT"));
  L.push("━".repeat(34));
  const vColor = chain.verdict === "VERIFIED" ? green : chain.verdict === "BLOCKED" ? red : yellow;
  L.push(vColor(chalkBold(chain.verdict)));
  L.push("━".repeat(34));
  L.push("");
  L.push(`${chalkBold("Why:")}`);
  for (const r of chain.reasons) L.push(`· ${r}`);
  if (chain.verdict === "UNPROVEN" && chain.summary.notConfigured > 0) {
    L.push(dim(`· ${chain.summary.notConfigured} check(s) have never been run — they are listed above as NOT_CONFIGURED, not as passes`));
  }
  return L.join("\n");
}

/* tiny chalk-free color helpers so chain.ts stays dependency-light in tests */
function dim(s: string) { return `\x1b[2m${s}\x1b[22m`; }
function green(s: string) { return `\x1b[32m${s}\x1b[39m`; }
function red(s: string) { return `\x1b[31m${s}\x1b[39m`; }
function yellow(s: string) { return `\x1b[33m${s}\x1b[39m`; }
function chalkBold(s: string) { return `\x1b[1m${s}\x1b[22m`; }
