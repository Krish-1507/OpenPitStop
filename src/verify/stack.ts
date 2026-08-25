import fs from "node:fs";
import path from "node:path";
import { seal, checkEvidence, type OpenPitStopEvidence, type EvidenceCheck } from "../evidence.js";
import { buildUnderstanding, type RepoUnderstanding } from "../understand/index.js";
import { discoverTestLayers, runTestLayer, parseTestCounts, failingTestNames } from "../commands/test.js";

/**
 * stack.ts — FULL VERIFICATION STACK ("beyond: did the test pass?").
 *
 * A production change must do more than make a test green. The stack runs
 * every verification layer the repo actually has — unit / integration / e2e
 * tests, type checks, lints, builds — and, critically, DIAGNOSES failures
 * instead of just reporting them:
 *
 *   "error TS2345 at src/x.ts:42"   → type-error   (a signature changed somewhere)
 *   "Cannot find module"            → missing-dependency (environment, not code)
 *   "AssertionError"                → assertion-failure (behavior changed)
 *   "SyntaxError"                   → syntax-error
 *   "eslint rule x/y"               → lint-violation (which rule, where)
 *   timeout                         → timeout
 *
 * A diagnosis tells the agent WHAT KIND of failure it is and WHERE — so the
 * fix is targeted instead of "randomly edit until the error disappears".
 * OpenPitStop never auto-edits; it hands the diagnosis back.
 *
 * Layers that don't apply to the repo are SKIPPED with the reason — never
 * invented, never silently dropped.
 */

export type StackLayerKind = "unit" | "integration" | "e2e" | "typecheck" | "lint" | "build";

export interface StackDiagnosis {
  category:
    | "type-error"
    | "missing-dependency"
    | "assertion-failure"
    | "syntax-error"
    | "lint-violation"
    | "environment"
    | "timeout"
    | "none"
    | "unclassified";
  summary: string;
  locations: string[];
}

export interface StackLayerResult {
  id: string;
  kind: StackLayerKind;
  command: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  exitCode: number | null;
  durationMs: number;
  counts?: { passed: number; failed: number; total: number };
  failing?: string[];
  diagnosis?: StackDiagnosis;
  skipReason?: string;
}

export type StackVerdict = "STACK_PASS" | "STACK_FAIL" | "STACK_UNPROVEN";

export interface StackResult {
  repo: string;
  generatedAt: string;
  layers: StackLayerResult[];
  verdict: StackVerdict;
  reasons: string[];
  failedLayers: string[];
  sealedPath?: string;
  sealed?: OpenPitStopEvidence;
}

/** Deterministic failure diagnosis from runner output. */
export function diagnoseFailure(kind: StackLayerKind, output: string, timedOut: boolean): StackDiagnosis {
  if (timedOut) return { category: "timeout", summary: "the layer exceeded its time budget — possibly a hang or an interactive prompt", locations: [] };
  const text = `${output}`;
  const locations: string[] = [];
  const locRe = /([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|mjs|cjs))(?::(\d+)(?::(\d+))?)?|\((\d+),(\d+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(text)) && locations.length < 10) {
    const loc = m[2] ? `${m[1]}:${m[2]}${m[3] ? ":" + m[3] : ""}` : m[1];
    if (loc && !locations.includes(loc)) locations.push(loc);
  }

  if (/\berror\s+TS\d+/.test(text)) {
    const codes = [...text.matchAll(/error\s+(TS\d+)/g)].map((x) => x[1]).slice(0, 5);
    return { category: "type-error", summary: `type check failed (${[...new Set(codes)].join(", ")}) — a type signature does not match its usage`, locations };
  }
  if (/Cannot find module|MODULE_NOT_FOUND|Cannot find package/.test(text)) {
    const mod = text.match(/Cannot find (?:module|package)\s+'?([^'":\n]+?)'?\s*./)?.[1];
    return { category: "missing-dependency", summary: `missing dependency${mod ? `: ${mod}` : ""} — environment/dependency problem, not a behavior change`, locations };
  }
  if (/SyntaxError/.test(text)) {
    return { category: "syntax-error", summary: "syntax error — the file does not parse", locations };
  }
  if (kind === "lint") {
    const rules = [...text.matchAll(/([a-z@][a-z@/-]+\/[a-z-]+)\s*$/gm)].map((x) => x[1]).slice(0, 5);
    const problems = text.match(/(\d+)\s+problems?\s*\(/)?.[1];
    return {
      category: rules.length ? "lint-violation" : "lint-violation",
      summary: rules.length ? `lint rules violated: ${[...new Set(rules)].join(", ")}` : problems ? `${problems} lint problem(s)` : "lint violations detected",
      locations,
    };
  }
  if (/AssertionError|assert\.|expect\(|Assertion failed/.test(text)) {
    const names = failingTestNames(text, 5);
    return {
      category: "assertion-failure",
      summary: names.length ? `behavioral assertion failure in: ${names.join("; ")}` : "a behavioral assertion failed — the change altered observable behavior",
      locations,
    };
  }
  if (/ECONNREFUSED|EADDRINUSE|EACCES|EPERM|ENOENT/.test(text)) {
    return { category: "environment", summary: "environment-level failure (port/permission/file) — not necessarily a code problem", locations };
  }
  if (kind === "build" && /Build failed|Compilation error|failed to compile/i.test(text)) {
    return { category: "syntax-error", summary: "build failed — see locations", locations };
  }
  return { category: "unclassified", summary: "failure not recognized by the taxonomy — read the captured output in the evidence", locations };
}

function layerCommand(u: RepoUnderstanding, kind: StackLayerKind): string | null {
  return (u.verificationCommands as Record<string, string | undefined>)[kind] ?? null;
}

export async function runVerifyStack(opts: {
  repo: string;
  timeoutMs?: number;
  only?: StackLayerKind[];
}): Promise<StackResult> {
  const repo = path.resolve(opts.repo);
  const reasons: string[] = [];
  const layers: StackLayerResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 300000;

  const u = buildUnderstanding(repo);
  const wanted = (k: StackLayerKind) => (opts.only ? opts.only.includes(k) : true);

  // ---- test layers (unit / integration / e2e) via the existing pyramid runner
  const layerKinds: StackLayerKind[] = ["unit", "integration", "e2e"];
  for (const kind of layerKinds) {
    if (!wanted(kind)) continue;
    const spec = u.testLayers.find((l) => l.layer === kind);
    if (!spec) {
      layers.push({ id: kind, kind, command: "", status: "SKIPPED", exitCode: null, durationMs: 0, skipReason: `no ${kind} suite discovered in this repo` });
      continue;
    }
    const run = await runTestLayer(repo, spec, timeoutMs);
    const counts = { passed: run.passed, failed: run.failed, total: run.total };
    const failing = run.failing ?? [];
    // a failing test layer IS an assertion failure (the runner gives us the
    // failing names, not the raw output); runner errors go through the taxonomy
    const diagnosis =
      run.status === "failed"
        ? failing.length > 0
          ? { category: "assertion-failure" as const, summary: `behavioral assertion failure in: ${failing.slice(0, 5).join("; ")}`, locations: [] }
          : diagnoseFailure(kind, run.note ?? "", false)
        : run.status === "error"
          ? diagnoseFailure(kind, run.note ?? "", false)
          : run.status === "ok"
            ? { category: "none" as const, summary: "all checks passed", locations: [] }
            : undefined;
    layers.push({
      id: kind, kind,
      command: spec.cmd ?? spec.script ?? kind,
      status: run.status === "ok" ? "PASS" : run.status === "skipped" ? "SKIPPED" : "FAIL",
      exitCode: run.status === "ok" ? 0 : 1,
      durationMs: run.durationMs ?? 0,
      counts,
      failing: failing.slice(0, 10),
      diagnosis,
      skipReason: run.status === "skipped" ? "layer reported skipped" : undefined,
    });
  }

  // ---- typecheck / lint / build
  for (const kind of ["typecheck", "lint", "build"] as StackLayerKind[]) {
    if (!wanted(kind)) continue;
    const cmd = layerCommand(u, kind);
    if (!cmd) {
      layers.push({ id: kind, kind, command: "", status: "SKIPPED", exitCode: null, durationMs: 0, skipReason: `no ${kind} command detected (no npm script, no ${kind === "typecheck" ? "tsconfig.json" : kind === "lint" ? "eslint" : "build script"})` });
      continue;
    }
    const started = Date.now();
    let exitCode: number;
    let output: string;
    let timedOut = false;
    try {
      const { execa } = await import("execa");
      const res = await execa(cmd, [], {
        cwd: repo, shell: true, windowsHide: true, reject: false,
        timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024,
        env: (() => { const e = { ...process.env }; delete (e as any).NODE_TEST_CONTEXT; return e; })() as any,
      });
      exitCode = typeof res.exitCode === "number" ? res.exitCode : -1;
      output = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      timedOut = res.timedOut ?? false;
    } catch (err: any) {
      exitCode = -1;
      output = err?.message ?? String(err);
    }
    const pass = !timedOut && exitCode === 0;
    const counts = parseTestCounts(output);
    layers.push({
      id: kind, kind, command: cmd,
      status: pass ? "PASS" : "FAIL",
      exitCode, durationMs: Date.now() - started,
      counts: counts.total > 0 ? counts : undefined,
      diagnosis: pass ? { category: "none", summary: "clean", locations: [] } : diagnoseFailure(kind, output, timedOut),
    });
  }

  const failedLayers = layers.filter((l) => l.status === "FAIL");
  const verdict: StackVerdict =
    failedLayers.length > 0 ? "STACK_FAIL" : layers.every((l) => l.status === "SKIPPED") ? "STACK_UNPROVEN" : "STACK_PASS";

  if (verdict === "STACK_FAIL") {
    for (const l of failedLayers) {
      reasons.push(
        `${l.kind}: ${l.diagnosis ? `${l.diagnosis.category} — ${l.diagnosis.summary}` : "failed"}${l.diagnosis?.locations.length ? ` (${l.diagnosis.locations.slice(0, 3).join(", ")})` : ""}`,
      );
    }
  } else if (verdict === "STACK_UNPROVEN") {
    reasons.push("no verification layer is configured for this repo — nothing to run");
  } else {
    reasons.push(`all ${layers.filter((l) => l.status === "PASS").length} configured verification layer(s) pass`);
  }

  return {
    repo,
    generatedAt: new Date().toISOString(),
    layers,
    verdict,
    reasons,
    failedLayers: failedLayers.map((l) => l.kind),
  };
}

export function sealStackResult(result: StackResult): StackResult {
  const outDir = path.join(result.repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const sealedPath = path.join(outDir, `verify-stack-${ts}.json`);
  const doc = seal({
    timestamp: result.generatedAt,
    repo: result.repo,
    layers: result.layers,
    verdict: result.verdict,
    reasons: result.reasons,
    failedLayers: result.failedLayers,
  }, `verification stack for ${result.repo}`);
  fs.writeFileSync(sealedPath, JSON.stringify(doc, null, 2));
  return { ...result, sealedPath, sealed: (doc as any).evidence };
}

export function checkStackEvidence(file: string): EvidenceCheck {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return checkEvidence(doc);
  } catch (e: any) {
    return { status: "tampered", digest: "", reason: e.message };
  }
}
