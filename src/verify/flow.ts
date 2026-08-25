import fs from "node:fs";
import path from "node:path";
import { buildUnderstanding, sealUnderstanding, loadUnderstanding } from "../understand/index.js";
import { runVerifyStack, sealStackResult } from "./stack.js";
import { checkArchitecture, sealArchitectureResult } from "./architecture.js";
import { runRegressionCheck, sealRegressionResult } from "./regression.js";
import { runVerify } from "../commands/verify.js";
import { evaluateGate, renderGateMatrix } from "./gateMatrix.js";
import { loadLatestPlan } from "./plan.js";

/**
 * flow.ts — the full pipeline as one command:
 *
 *   Understand → Contract? → Plan-scope → Inspect state → Verify stack →
 *   Attack? → Holdout? → Architecture + Regressions → GATE
 *
 * Stages that require agent-provided inputs (contract, plan, holdout suite,
 * baseline refs) run only when those inputs are configured — the flow never
 * invents evidence for a stage it skipped; the final gate renders those
 * layers as NOT_CONFIGURED.
 */

export interface FlowStageResult {
  stage: string;
  status: "RAN" | "SKIPPED" | "FAIL";
  detail: string;
  verdict?: string;
}

export interface FlowResult {
  stages: FlowStageResult[];
  gateExit: number;
  verdict: string;
  decision: import("./gateMatrix.js").GateDecision;
}

export async function runFlow(opts: {
  repo: string;
  baselineRef?: string;
  command?: string;
  contractSpec?: string;
  suiteSpec?: string;
  planScope?: boolean;
  skip?: string[];
  threshold?: number;
  require?: string[];
  timeoutMs?: number;
}): Promise<FlowResult> {
  const repo = path.resolve(opts.repo);
  const skip = new Set(opts.skip ?? []);
  const stages: FlowStageResult[] = [];
  const run = (stage: string, fn: () => Promise<{ status: "RAN" | "SKIPPED" | "FAIL"; detail: string; verdict?: string }>) =>
    fn().then((r) => { stages.push({ stage, ...r }); return r; });

  // ---- 1. UNDERSTAND (always — the foundation artifact)
  await run("understand", async () => {
    try {
      const u = sealUnderstanding(repo, buildUnderstanding(repo));
      const cached = loadUnderstanding(repo);
      void cached;
      return {
        status: "RAN",
        detail: `${u.primaryLanguage} · ${u.frameworks.slice(0, 4).join(", ") || "no frameworks"} · ${u.testLayers.length} test layer(s) · ci ${u.ci.provider ?? "none"} · ${u.architectureConfigPath ? "architecture config found" : "no architecture config"}`,
      };
    } catch (e: any) {
      return { status: "FAIL", detail: e.message };
    }
  });

  // ---- 2. CONTRACT (acceptance) — only when configured
  if (opts.contractSpec && !skip.has("acceptance")) {
    const { verifyAcceptance, sealAcceptanceResult } = await import("./acceptance.js");
    await run("contract", async () => {
      const r = sealAcceptanceResult(
        await verifyAcceptance({ repo, contractSpec: opts.contractSpec!, candidateRef: "HEAD" }),
      );
      return { status: r.verdict === "SATISFIED" ? "RAN" : "FAIL", detail: `${r.verdict} (${r.totalCriteria} criteria)`, verdict: r.verdict };
    });
  } else {
    stages.push({ stage: "contract", status: "SKIPPED", detail: "no --contract given" });
  }

  // ---- 3. PLAN SCOPE + 4. INSPECT ACTUAL STATE (architecture-check)
  if (!skip.has("architecture")) {
    const plan = loadLatestPlan(repo);
    await run("architecture", async () => {
      const r = sealArchitectureResult(
        await checkArchitecture({ repo, againstPlan: opts.planScope === true || !!plan }),
      );
      return {
        status: r.verdict === "CONFORMS" || (r.verdict === "APPROVAL_REQUIRED" && r.approved) ? "RAN" : "FAIL",
        detail: `${r.verdict}${r.planRef ? " · plan scope checked" : ""} — ${r.entries.length} entr(ies)`,
        verdict: r.verdict,
      };
    });
  } else {
    stages.push({ stage: "architecture", status: "SKIPPED", detail: "--skip architecture" });
  }

  // ---- 5. VERIFY STACK (tests + typecheck + lint + build, with diagnosis)
  if (!skip.has("stack")) {
    await run("verify-stack", async () => {
      const r = sealStackResult(await runVerifyStack({ repo, timeoutMs: opts.timeoutMs }));
      return {
        status: r.verdict === "STACK_PASS" ? "RAN" : r.verdict === "STACK_FAIL" ? "FAIL" : "SKIPPED",
        detail: r.layers.map((l) => `${l.id}:${l.status}`).join(" · ") || "no layers",
        verdict: r.verdict,
      };
    });
  } else {
    stages.push({ stage: "verify-stack", status: "SKIPPED", detail: "--skip stack" });
  }

  // ---- 6. ATTACK THE VERIFIER — explicit, only when the operator asks
  stages.push({ stage: "attack-verifier", status: "SKIPPED", detail: "run `pitstop verifier-check --command <the verification> --mutate …` explicitly — never automatic" });

  // ---- 7. HOLDOUT — only when a suite is configured
  if (opts.suiteSpec && !skip.has("holdout")) {
    const { runHoldoutSuite, sealHoldoutResults } = await import("./holdout.js");
    await run("holdout", async () => {
      const r = await runHoldoutSuite({ repo, suiteSpec: opts.suiteSpec!, candidateRef: "HEAD" });
      sealHoldoutResults(r);
      return { status: r.verdict === "HOLDOUT_PASS" ? "RAN" : "FAIL", detail: r.verdict, verdict: r.verdict };
    });
  } else {
    stages.push({ stage: "holdout", status: "SKIPPED", detail: "no --suite given (holdout must stay hidden from the agent during iteration)" });
  }

  // ---- 8. BASELINE + 9. REGRESSION — when a baseline ref AND command are configured
  const baselineConfigured = !!(opts.baselineRef && opts.command);
  if (baselineConfigured && !skip.has("baseline")) {
    await run("baseline", async () => {
      const { baselineAwareVerify } = await import("./baseline.js");
      const r = await baselineAwareVerify({
        repo,
        baselineRef: opts.baselineRef!,
        candidateRef: "HEAD",
        verification: { id: "flow:baseline", command: opts.command!, timeoutMs: opts.timeoutMs ?? 120000 },
      });
      return { status: r.verdict === "VERIFIED" ? "RAN" : r.verdict === "UNPROVEN" ? "SKIPPED" : "FAIL", detail: r.verdict, verdict: r.verdict };
    });
  } else {
    stages.push({ stage: "baseline", status: "SKIPPED", detail: "needs --baseline <ref> and --command <cmd>" });
  }
  if (baselineConfigured && !skip.has("regression")) {
    await run("regression", async () => {
      const r = sealRegressionResult(
        await runRegressionCheck({ repo, command: opts.command!, baselineRef: opts.baselineRef!, timeoutMs: opts.timeoutMs }),
      );
      return { status: r.verdict === "NO_REGRESSION" ? "RAN" : r.verdict === "UNPROVEN" ? "SKIPPED" : "FAIL", detail: r.verdict, verdict: r.verdict };
    });
  } else {
    stages.push({ stage: "regression", status: "SKIPPED", detail: "needs --baseline <ref> and --command <cmd>" });
  }

  // ---- 10. STATE — claim-driven; the agent runs it with its claims
  stages.push({ stage: "state", status: "SKIPPED", detail: "claim-driven — run `pitstop state-verify --claim …` with the agent's claims" });

  // ---- GATE (reads every sealed layer; the single verdict)
  const outcome = await runVerify(repo);
  const decision = evaluateGate(repo, {
    missingBaseline: outcome.missingBaseline,
    blocked: outcome.blocked,
    integrityVerdict: outcome.missingBaseline ? "CLEAN" : outcome.integrity.verdict,
    evidenceStatus: outcome.evidence?.status ?? "missing",
    risk: outcome.missingBaseline ? "Low" : outcome.risk,
    currentScore: outcome.missingBaseline ? 0 : outcome.currentScore.score,
    currentGrade: outcome.missingBaseline ? "F" : outcome.currentScore.grade,
    testsPassed: outcome.current.tests.passed,
    testsFailed: outcome.current.tests.failed,
    stale: outcome.stale,
    staleNote: outcome.staleNote,
  }, { threshold: opts.threshold ?? 60, require: opts.require });

  return { stages, gateExit: decision.exitCode, verdict: decision.verdict, decision };
}

export function renderFlowStages(stages: FlowStageResult[]): string {
  return stages
    .map((s) => {
      const mark = s.status === "RAN" ? "✓" : s.status === "FAIL" ? "✗" : "—";
      return `${mark} ${s.stage.padEnd(16)} ${s.status.padEnd(8)} ${s.detail}`;
    })
    .join("\n");
}

export { renderGateMatrix };
