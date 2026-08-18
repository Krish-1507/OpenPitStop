/**
 * pen/proof.ts — the runtime-proof pass: every STATIC finding gets a live
 * verdict from the dynamic phase.
 *
 * The dynamic phase boots the app under the sandbox and fires the full attack
 * battery (command injection, SSRF, XSS, path traversal, SQL/NOSQL, header
 * and rate-limit checks) at every discovered route. That run is the ground
 * truth for the whole app. This pass attaches it to the static findings:
 *
 *   proven      — the dynamic phase recorded a CANARY for this attack class
 *                 (a spawn containing the marker, an outbound call to the
 *                 canary host, the marker reflected unescaped, a host file
 *                 leaked). The static pattern is now backed by a live attack.
 *   indicated   — live probing produced class-level signals (a DB error
 *                 surface, a crash on the class payload) but no canary.
 *   unproven    — the class was probed on every route and produced no
 *                 signal at all: the pattern may be a false positive or the
 *                 sink unreachable. Honest label, not a downgrade.
 *   not-tested  — no live probe exists for this class (secrets, config
 *                 hygiene) or the app did not boot (dynamic aborted).
 *
 * This is the answer to "static scanners are noisy": every pattern finding
 * now either carries live proof or an honest "could not be reproduced".
 */

import type { PenFinding } from "./types.js";

export type StaticProofVerdict = "proven" | "indicated" | "unproven" | "not-tested";

export interface StaticProofSummary {
  proven: number;
  indicated: number;
  unproven: number;
  notTested: number;
}

/** static finding type -> the dynamic finding types that can confirm it live. */
const CLASS_TO_DYNAMIC: Record<string, string[]> = {
  "command-injection": ["command-injection"],
  "arbitrary-code-execution": ["command-injection"],
  ssrf: ["ssrf"],
  "xss-sink": ["reflected-xss"],
  "path-traversal": ["path-traversal"],
  "sql-injection": ["sql-injection", "crash-on-input"],
  "nosql-injection": ["sql-injection", "crash-on-input"],
  "prototype-pollution": ["crash-on-input"],
  "missing-security-headers": ["missing-security-headers"],
  "info-leak-header": ["info-leak-header"],
  "no-rate-limit": ["no-rate-limit"],
  "race-condition": ["race-condition"],
  idor: ["idor"],
  "price-tampering": ["price-tampering"],
  xxe: ["xxe"],
  "insecure-deserialization": ["insecure-deserialization"],
  "jwt-weak-secret": ["jwt-weak-secret"],
};

interface ProofInput {
  status: "ok" | "aborted";
  note?: string;
  findings: PenFinding[];
}

/**
 * Attach a live verdict to every static finding based on the dynamic phase's
 * evidence. Returns new finding objects (never mutates inputs) plus a summary.
 */
export function applyStaticProof(
  staticFindings: PenFinding[],
  dynamic: ProofInput,
): { findings: PenFinding[]; summary: StaticProofSummary } {
  const summary: StaticProofSummary = { proven: 0, indicated: 0, unproven: 0, notTested: 0 };

  const findings = staticFindings.map((f) => {
    if (dynamic.status !== "ok") {
      summary.notTested++;
      return {
        ...f,
        runtimeProof: "not-tested" as const,
        runtimeNote: `no runtime verification: the dynamic phase did not run (${dynamic.note ?? "app did not respond"})`,
      };
    }

    const mapped = CLASS_TO_DYNAMIC[f.type];
    if (!mapped) {
      summary.notTested++;
      return {
        ...f,
        runtimeProof: "not-tested" as const,
        runtimeNote:
          "this finding class is a static/config observation (secret, cookie, CORS policy) — there is no live probe for it",
      };
    }

    const dynOfClass = dynamic.findings.filter((d) => mapped.includes(d.type));
    const provenDyn = dynOfClass.find((d) => d.confidence === "proven");
    if (provenDyn) {
      summary.proven++;
      const evidence = provenDyn.outbound?.length
        ? ` sandbox evidence: ${provenDyn.outbound.join(" · ")}`
        : "";
      return {
        ...f,
        confidence: "proven" as const,
        runtimeProof: "proven" as const,
        proofType: provenDyn.type,
        runtimeNote:
          `PROVEN live: a ${f.type} attack on route ${provenDyn.route ?? provenDyn.attack?.path ?? "?"} ` +
          `(${provenDyn.method ?? "?"}) recorded a canary.${evidence} See dynamic finding ${provenDyn.id}.`,
        attack: provenDyn.attack ?? f.attack,
        response: provenDyn.response ?? f.response,
        outbound: provenDyn.outbound ?? f.outbound,
        route: provenDyn.route ?? f.route,
        method: provenDyn.method ?? f.method,
        repro: provenDyn.repro ?? f.repro,
      };
    }

    const indicatedDyn = dynOfClass.find((d) => d.confidence === "indicated");
    if (indicatedDyn) {
      summary.indicated++;
      return {
        ...f,
        confidence: "indicated" as const,
        runtimeProof: "indicated" as const,
        runtimeNote:
          `Live probing for this class produced class-level signals without a canary ` +
          `(dynamic finding ${indicatedDyn.id}: ${indicatedDyn.title.toLowerCase()}). ` +
          `Evidence points but is not conclusive — treat as indicated, not proven.`,
        attack: indicatedDyn.attack ?? f.attack,
        response: indicatedDyn.response ?? f.response,
        route: indicatedDyn.route ?? f.route,
        method: indicatedDyn.method ?? f.method,
        repro: indicatedDyn.repro ?? f.repro,
      };
    }

    summary.unproven++;
    return {
      ...f,
      runtimeProof: "unproven" as const,
      runtimeNote:
        `The app's routes were probed live with ${f.type} payloads and produced no signal — ` +
        "this static pattern could not be reproduced. It may be a false positive or an unreachable sink.",
    };
  });

  return { findings, summary };
}
