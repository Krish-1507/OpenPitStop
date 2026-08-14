import path from "node:path";
import type { LedgerResult } from "../types.js";
import { discover } from "./discover.js";
import {
  startHarness,
  newEvidencePath,
  readAbortReason,
} from "./harness.js";
import { runAttacks } from "./attacks.js";
import {
  analyzeEvidence,
  writeEvidenceFile,
  type EvidenceOutput,
} from "./evidence.js";

/**
 * ledger.ts — orchestrates `pitstop scan --ledger`.
 *
 * This is invasive (it boots the app and fires live traffic at it), so it is
 * ONLY ever invoked from the CLI when the user explicitly passes `--ledger`.
 * Every outbound HTTP call from the app is routed through a nock sandbox before
 * it can leave the process; the request/response pairs the "gateway" receives
 * are recorded so evidence of a double-charge is real, not simulated.
 */
export async function runLedgerAnalyzer(repo: string): Promise<LedgerResult> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  let discovery;
  try {
    discovery = discover(repo);
  } catch (e) {
    return {
      status: "error",
      note: `endpoint discovery failed: ${(e as Error).message}`,
      endpoints: [],
      evidence: [],
    };
  }

  if (discovery.endpoints.length === 0) {
    return {
      status: "ok",
      note:
        "no money-moving endpoints discovered (route keywords: charge/capture/payment/" +
        "transfer/refund/webhook; payment SDKs: razorpay/stripe/braintree)",
      endpoints: [],
      evidence: [],
    };
  }

  const harnessResult = await startHarness(repo, discovery.gatewayHosts);
  if (!harnessResult.harness) {
    return {
      status: harnessResult.aborted ? "aborted" : "error",
      note: harnessResult.abortReason ?? "could not arm the ledger harness",
      endpoints: discovery.endpoints,
      evidence: [],
    };
  }
  const harness = harnessResult.harness;

  let evidenceOut: EvidenceOutput | null = null;
  let abortedReason: string | null = null;
  let runError: string | null = null;
  try {
    const attacks = await runAttacks({
      baseUrl: harness.baseUrl,
      endpoints: discovery.endpoints,
    });
    evidenceOut = analyzeEvidence({
      repo,
      discovery,
      attacks,
      gatewayLogPath: harness.gatewayLogPath,
    });
    abortedReason = readAbortReason(harness.controlPath);
  } catch (e) {
    runError = (e as Error).message;
  } finally {
    await harness.close();
  }

  if (runError) {
    return {
      status: "error",
      note: `attack/evidence phase failed: ${runError}`,
      endpoints: discovery.endpoints,
      evidence: [],
    };
  }

  if (abortedReason) {
    return {
      status: "aborted",
      note: abortedReason,
      endpoints: discovery.endpoints,
      evidence: [],
    };
  }

  if (!evidenceOut) {
    return {
      status: "error",
      note: "no evidence produced",
      endpoints: discovery.endpoints,
      evidence: [],
    };
  }

  const evidenceFile = newEvidencePath(repo, ts);
  writeEvidenceFile(evidenceFile, evidenceOut.evidence, harness.gatewayLogPath);
  for (const e of evidenceOut.evidence) e.evidenceFile = evidenceFile;

  const notes: string[] = [];
  if (evidenceOut.note) notes.push(evidenceOut.note);
  if (discovery.sdkImports.length === 0) {
    notes.push(
      "no payment-SDK import detected — route heuristics only; the mock gateway was " +
        "not pointed at a specific provider",
    );
  }

  return {
    status: "ok",
    note: notes.length ? notes.join(" · ") : undefined,
    endpoints: discovery.endpoints,
    evidence: evidenceOut.evidence,
    gatewayLogPath: harness.gatewayLogPath,
    evidenceFile,
  };
}

export { discover } from "./discover.js";
export { runAttacks } from "./attacks.js";
export { analyzeEvidence } from "./evidence.js";