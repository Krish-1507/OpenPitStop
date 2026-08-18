import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import type { ScanResult, Cluster } from "../analyzers/types.js";
import type { IntegrityFinding, Verdict } from "../analyzers/integrity/types.js";
import { computeScore, gradeColor, gradeHex, gradeOf, renderBadgeSvg } from "./score.js";
import { brandBarHtml, PRODUCT, TAGLINE } from "../brand.js";
import { loadPenLatest } from "../pen/store.js";
import type { HonestyScore } from "../verify/honesty.js";

export interface VerifyMetrics {
  tests: { total: number; passed: number; failed: number; durationMs: number; coverage?: number };
  perf: { buildTimeMs?: number; bundleSizeBytes?: number };
  securityCount: number;
  duplicationCount: number;
}

export interface VerifyReport {
  timestamp: string;
  repo: string;
  baselineTimestamp?: string;
  risk: "High" | "Medium" | "Low";
  exitCode: number;
  deltas: {
    passed: number;
    failed: number;
    durationMs: number;
    coverage: number;
    buildTimeMs: number;
    bundleSizeBytes: number;
    security: number;
    duplication: number;
  };
  baseline: VerifyMetrics;
  current: VerifyMetrics;
  /** OpenPitStop score at verify time (baseline vs patched current). */
  score?: { baseline: number; current: number; delta: number; grade: string };
  /** Phase 16 integrity gate result captured by `pitstop verify`. */
  integrity?: {
    verdict: Verdict;
    findings: IntegrityFinding[];
    summary: { confirmed: number; suspicious: number; total: number };
  };
  /** 0-100 trust rating from `pitstop verify` — did the fix fake it? */
  honesty?: HonestyScore;
}

export interface History {
  repo: string;
  scans: ScanResult[];
  verifies: VerifyReport[];
}

export function loadHistory(repo: string): History {
  const dir = path.join(repo, ".pitstop");
  const read = (prefix: string): any[] => {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  };
  const scans = read("scan-") as ScanResult[];
  const verifies = read("verify-") as VerifyReport[];
  scans.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  verifies.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return { repo, scans, verifies };
}

/**
 * Gather every Phase 16 integrity verdict recorded by the loop (from verify-*.json
 * and integrity-*.json in `.pitstop/`) and summarize catches vs self-corrections.
 */
export function collectIntegrity(repo: string): ReportModel["integrity"] | undefined {
  const dir = path.join(repo, ".pitstop");
  if (!fs.existsSync(dir)) return undefined;
  const events: { timestamp: string; verdict: Verdict; findings: IntegrityFinding[] }[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    if (!(f.startsWith("verify-") || f.startsWith("integrity-"))) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const verdict: Verdict | undefined = j.integrity?.verdict ?? j.verdict;
      const findings: IntegrityFinding[] = j.integrity?.findings ?? j.findings ?? [];
      if (verdict) events.push({ timestamp: j.timestamp ?? "", verdict, findings });
    } catch {
      /* ignore */
    }
  }
  if (events.length === 0) return undefined;
  events.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  const catches = events.filter((e) => e.verdict !== "CLEAN");
  const selfCorrected = catches.filter((c) =>
    events.some((e) => e.timestamp > c.timestamp && e.verdict === "CLEAN"),
  ).length;
  return { checks: events.length, catches: catches.length, selfCorrected, events };
}

export interface MetricLine {
  label: string;
  value: string;
  color?: "green" | "yellow" | "red" | "dim";
}

/** A committed repro test that permanently proves a fix. */
export interface ReproProof {
  /** Relative path of the pitstop-repro-*.test.* file. */
  file: string;
  /** The finding id (from scan-latest.json) its header links back to. */
  findingId?: string;
}

const REPRO_TEST_RE = /^pitstop-repro-.+\.test\.(mjs|js|ts|py)$/;
const REPRO_ID_RE = /\b(?:pitstop repro|finding)[^\w-]*([A-Za-z][A-Za-z0-9]*-[0-9a-f]{6,})/i;

/** Scan the repo for committed permanent proof files. */
export function loadProofs(repo: string): ReproProof[] {
  const out: ReproProof[] = [];
  const stack: string[] = [repo];
  const ignore = new Set(["node_modules", ".git", ".pitstop", "dist", "coverage", ".next"]);
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!ignore.has(e.name) && !e.name.startsWith(".")) stack.push(path.join(dir, e.name));
      } else if (e.isFile() && REPRO_TEST_RE.test(e.name)) {
        const abs = path.join(dir, e.name);
        let findingId: string | undefined;
        try {
          const head = fs.readFileSync(abs, "utf8").slice(0, 1200);
          const m = head.match(REPRO_ID_RE);
          if (m && m[1]) findingId = m[1];
        } catch {
          /* ignore */
        }
        out.push({ file: path.relative(repo, abs), findingId });
      }
    }
  }
  out.sort((a, b) => (a.file < b.file ? -1 : 1));
  return out;
}

export interface ReportModel {
  repo: string;
  generatedAt: string;
  latestScan: ScanResult | null;
  latestVerify: VerifyReport | null;
  scansCount: number;
  verifiesCount: number;
  lines: MetricLine[];
  clusters: Cluster[];
  hasVerify: boolean;
  /** Committed repro tests that permanently prove each fix. */
  proofs: ReproProof[];
  /**
   * Proof coverage: of the findings a pen test surfaced, how many ship with a
   * permanent failing-first repro test. This is the number that answers
   * "vs Strix, do you just report, or do you prove?" — higher is better.
   */
  proofCoverage?: { total: number; covered: number; pct: number; hasPen: boolean };
  /**
   * Aggregated Phase 16 integrity evidence from every `pitstop verify` (and
   * `pitstop integrity`) run in `.pitstop/`. A "catch" is any non-CLEAN
   * verdict; a catch followed by a later CLEAN check is a self-correction the
   * loop performed on its own. Frame these as a positive — the gate working.
   */
  integrity?: {
    checks: number;
    catches: number;
    selfCorrected: number;
    events: { timestamp: string; verdict: Verdict; findings: IntegrityFinding[] }[];
  };
}

const NOT_SCANNED = "not scanned";
const NOT_ASSESSED = "not assessed";

function bundleKB(b?: number): string {
  return b == null ? NOT_SCANNED : `${(b / 1024).toFixed(1)} KB`;
}
function ms(n?: number): string {
  return n == null ? NOT_SCANNED : `${n} ms`;
}

export function buildModel(repo: string): ReportModel {
  const hist = loadHistory(repo);
  const latestScan = hist.scans[hist.scans.length - 1] ?? null;
  const latestVerify = hist.verifies[hist.verifies.length - 1] ?? null;

  const integrity = collectIntegrity(repo);

  const lines: MetricLine[] = [];

  // OpenPitStop Score — the headline number, computed from the latest scan.
  if (!latestScan) {
    lines.push({ label: "OpenPitStop Score", value: NOT_SCANNED, color: "dim" });
  } else {
    const sc = computeScore(latestScan);
    const analyzed =
      sc.analyzed < sc.total ? ` — ${sc.analyzed}/${sc.total} categories` : "";
    lines.push({
      label: "OpenPitStop Score",
      value: `${sc.score}/100 (${sc.grade})${analyzed}`,
      color: gradeColor(sc.grade),
    });
  }

  // Critical Issues Fixed — derived from improvements in the latest verify.
  if (!latestVerify) {
    lines.push({ label: "Critical Issues Fixed", value: NOT_ASSESSED, color: "dim" });
  } else {
    const d = latestVerify.deltas;
    let fixed = 0;
    if (d.security < 0) fixed += -d.security;
    if (d.duplication < 0) fixed += -d.duplication;
    if (d.failed < 0) fixed += -d.failed;
    lines.push({ label: "Critical Issues Fixed", value: String(fixed) });
  }

  // Security Vulnerabilities
  if (!latestScan || latestScan.security.status !== "ok") {
    lines.push({ label: "Security Vulnerabilities", value: NOT_SCANNED, color: "dim" });
  } else {
    const issues = latestScan.security.issues;
    const bySev: Record<string, number> = {};
    for (const i of issues) bySev[i.severity] = (bySev[i.severity] ?? 0) + 1;
    const crit = bySev.critical ?? 0;
    const high = bySev.high ?? 0;
    const color = issues.length > 0 ? (crit > 0 ? "red" : "yellow") : "green";
    const detail = issues.length === 0 ? "" : ` (crit ${crit} · high ${high})`;
    lines.push({
      label: "Security Vulnerabilities",
      value: `${issues.length}${detail}`,
      color,
    });
  }

  // Memory Leaks — no analyzer exists yet.
  lines.push({ label: "Memory Leaks", value: NOT_SCANNED, color: "dim" });

  // Broken Tests
  if (!latestScan || latestScan.tests.status !== "ok") {
    lines.push({ label: "Broken Tests", value: NOT_SCANNED, color: "dim" });
  } else {
    const t = latestScan.tests;
    const color = t.failed > 0 ? "red" : "green";
    lines.push({
      label: "Broken Tests",
      value: `${t.failed} failed / ${t.total} total`,
      color,
    });
  }

  // Reliability (flaky tests + race-condition heuristics)
  if (!latestScan || latestScan.reliability?.status !== "ok") {
    lines.push({ label: "Reliability", value: NOT_SCANNED, color: "dim" });
  } else {
    const rel = latestScan.reliability;
    const dirty = rel.flakyTests.length > 0 || rel.raceSmells.length > 0;
    lines.push({
      label: "Reliability",
      value: `${rel.flakyTests.length} flaky · ${rel.raceSmells.length} race smell(s) · ${rel.runs} runs`,
      color: dirty ? "yellow" : "green",
    });
  }

  // Accessibility
  if (!latestScan || latestScan.accessibility?.status !== "ok") {
    lines.push({ label: "Accessibility", value: NOT_SCANNED, color: "dim" });
  } else {
    const a = latestScan.accessibility;
    const dirty = a.issues.length > 0;
    lines.push({
      label: "Accessibility",
      value: `${a.issues.length} issues${a.engine ? ` · ${a.engine}` : ""}`,
      color: dirty ? "yellow" : "green",
    });
  }

  // Performance (with deltas from verify when available)
  if (!latestScan || latestScan.perf.status !== "ok") {
    lines.push({ label: "Performance", value: NOT_SCANNED, color: "dim" });
  } else {
    const p = latestScan.perf;
    const parts: string[] = [`build ${ms(p.buildTimeMs)}`, `bundle ${bundleKB(p.bundleSizeBytes)}`];
    if (latestVerify) {
      const d = latestVerify.deltas;
      if (p.buildTimeMs != null && d.buildTimeMs !== 0) {
        const good = d.buildTimeMs < 0;
        parts[0] += ` (${good ? "" : "+"}${d.buildTimeMs}ms)`;
      }
      if (p.bundleSizeBytes != null && d.bundleSizeBytes !== 0) {
        const good = d.bundleSizeBytes < 0;
        parts[1] += ` (${good ? "-" : "+"}${(Math.abs(d.bundleSizeBytes) / 1024).toFixed(1)}KB)`;
      }
    }
    lines.push({ label: "Performance", value: parts.join(" · "), color: "green" });
  }

  // Devex (unused exports / duplicate functions)
  if (!latestScan || latestScan.devex?.status !== "ok") {
    lines.push({ label: "Devex", value: NOT_SCANNED, color: "dim" });
  } else {
    const dx = latestScan.devex;
    const dirty = dx.unusedExports.length > 0 || dx.duplicateFunctions.length > 0;
    lines.push({
      label: "Devex",
      value: `${dx.unusedExports.length} unused export(s) · ${dx.duplicateFunctions.length} dup function(s)`,
      color: dirty ? "yellow" : "green",
    });
  }

  // Technical Debt
  if (!latestScan || latestScan.dependencyGraph.status !== "ok") {
    lines.push({ label: "Technical Debt", value: NOT_SCANNED, color: "dim" });
  } else {
    const dg = latestScan.dependencyGraph;
    const clones =
      latestScan.duplication.status === "ok"
        ? String(latestScan.duplication.cloneCount)
        : NOT_SCANNED;
    lines.push({
      label: "Technical Debt",
      value: `${dg.circular.length} circular · ${clones} clones · ${dg.orphans.length} orphans`,
      color: dg.circular.length > 0 ? "yellow" : "green",
    });
  }

  // Regression Risk
  if (!latestVerify) {
    lines.push({ label: "Regression Risk", value: NOT_ASSESSED, color: "dim" });
  } else {
    const c = latestVerify.risk === "High" ? "red" : latestVerify.risk === "Medium" ? "yellow" : "green";
    lines.push({ label: "Regression Risk", value: latestVerify.risk, color: c });
  }

  // Integrity (Phase 16 gate) — aggregated from every verify/integrity run.
  if (!integrity || integrity.checks === 0) {
    lines.push({ label: "Integrity", value: NOT_ASSESSED, color: "dim" });
  } else if (integrity.catches === 0) {
    lines.push({ label: "Integrity", value: "clean", color: "green" });
  } else {
    const anyConfirmed = integrity.events.some((e) => e.verdict === "CONFIRMED_CHEAT");
    lines.push({
      label: "Integrity",
      value: `${integrity.catches} catch(es) · ${integrity.selfCorrected} self-corrected`,
      color: anyConfirmed ? "red" : "yellow",
    });
  }

  const proofCoverage = (() => {
    const pen = loadPenLatest(repo);
    const proofs = loadProofs(repo);
    if (pen && pen.findings.length > 0) {
      const total = pen.findings.length;
      const covered = Math.min(proofs.length, total);
      return { total, covered, pct: Math.round((covered / total) * 100), hasPen: true };
    }
    return { total: 0, covered: 0, pct: 0, hasPen: false };
  })();

  return {
    repo,
    generatedAt: new Date().toISOString(),
    latestScan,
    latestVerify,
    scansCount: hist.scans.length,
    verifiesCount: hist.verifies.length,
    lines,
    clusters: latestScan?.clusters ?? [],
    hasVerify: !!latestVerify,
    proofs: loadProofs(repo),
    integrity,
    proofCoverage,
  };
}

export function renderTerminal(model: ReportModel): string {
  if (model.scansCount === 0) {
    return boxen(
      chalk.yellow("No scan history found.\nRun `pitstop scan` to generate a report."),
      {
        title: " PITSTOP — Repository Analysis Complete ",
        titleAlignment: "center",
        borderStyle: "double",
        padding: 1,
        borderColor: "yellow",
      },
    );
  }

  const lines = model.lines.map((l) => {
    const colorFn =
      l.color === "green"
        ? chalk.green
        : l.color === "yellow"
          ? chalk.yellow
          : l.color === "red"
            ? chalk.red
            : chalk.dim;
    return `  ${chalk.bold(l.label.padEnd(24))}: ${colorFn(l.value)}`;
  });

  const pc = model.proofCoverage;
  const proofLine =
    pc && pc.hasPen
      ? `  ${chalk.bold("Proof coverage".padEnd(24))}: ` +
        (pc.pct >= 80 ? chalk.green(`${pc.pct}%`) : pc.pct >= 50 ? chalk.yellow(`${pc.pct}%`) : chalk.red(`${pc.pct}%`)) +
        chalk.dim(` — ${pc.covered}/${pc.total} finding(s) ship a permanent repro test`)
      : `  ${chalk.bold("Proof coverage".padEnd(24))}: ${chalk.yellow("no pen run — run `pitstop pen --fix` to generate repro tests")}`;

  const header = `${chalk.dim(`repo: ${model.repo}`)}  ·  ${chalk.dim(`${model.scansCount} scan(s), ${model.verifiesCount} verify(ies)`)}`;
  const contentParts = [header, "", ...lines, proofLine];
  const integrity = integrityTerminalBlock(model);
  if (integrity) contentParts.push("", integrity);
  const content = contentParts.join("\n");

  return boxen(content, {
    title: " PITSTOP — Repository Analysis Complete ",
    titleAlignment: "center",
    borderStyle: "double",
    padding: 1,
    borderColor: "cyan",
  });
}

function deltaCell(n: number, unit: string, higherIsBetter: boolean, isPct = false): string {
  if (n === 0) return "0";
  const good = higherIsBetter ? n > 0 : n < 0;
  const sign = n > 0 ? "+" : "";
  const val = isPct ? `${sign}${n.toFixed(1)}%` : unit === "KB" ? `${sign}${(n / 1024).toFixed(1)} KB` : `${sign}${n}${unit}`;
  return good ? chalk.green(val) : chalk.red(val);
}

export interface MarkdownOptions {
  /** Put the root-cause → symptoms clusters directly under the header. */
  clustersFirst?: boolean;
  /** One-line context shown under the header (branch, base, PR, etc.). */
  headerNote?: string;
  /** Title override (default "Repository Analysis Complete"). */
  title?: string;
}

function summarySection(lines: MetricLine[]): string[] {
  const out: string[] = [];
  out.push(`## Summary`);
  out.push("");
  out.push(`| Metric | Value |`);
  out.push(`| --- | --- |`);
  for (const l of lines) out.push(`| ${l.label} | ${l.value} |`);
  out.push("");
  return out;
}

/** Root cause → symptoms cluster framing, mirroring the interactive scan box. */
function clustersSection(clusters: Cluster[]): string[] {
  const out: string[] = [];
  out.push(`## Root-Cause Clusters`);
  out.push("");
  if (clusters.length === 0) {
    out.push(`No root-cause clusters identified.`);
    out.push("");
    return out;
  }
  clusters.forEach((c, i) => {
    const sev = c.rootCause.severity.toUpperCase();
    out.push(`${i + 1}. **Root cause** (${sev} ${c.rootCause.type}): ${c.rootCause.description}`);
    out.push(`   → ${c.symptoms.length} symptom(s) · shared: \`${c.sharedFiles.join("`, `")}\``);
    for (const s of c.symptoms) {
      out.push(`     - (${s.severity.toUpperCase()} ${s.type}): ${s.description}`);
    }
    if (i < clusters.length - 1) out.push("");
  });
  out.push("");
  return out;
}

function beforeAfterSection(model: ReportModel): string[] {
  const out: string[] = [];
  out.push(`## Before / After`);
  out.push("");
  if (!model.hasVerify || !model.latestVerify) {
    out.push(`No verify history — run \`pitstop verify\` (or \`pitstop ci\` in a PR) to populate the before/after diff.`);
    out.push("");
    return out;
  }
  const v = model.latestVerify;
  const b = v.baseline;
  const cur = v.current;
  const d = v.deltas;
  out.push(`Latest verify risk: **${v.risk}** (baseline ${v.baselineTimestamp ?? "unknown"})`);
  out.push("");
  out.push(`| Metric | Baseline | Current | Δ |`);
  out.push(`| --- | --- | --- | --- |`);
  const row = (name: string, base: string, curr: string, deltaStr: string) => {
    out.push(`| ${name} | ${base} | ${curr} | ${deltaStr} |`);
  };
  row(
    "Tests passed",
    String(b.tests.passed),
    String(cur.tests.passed),
    deltaCell(d.passed, "", true),
  );
  row(
    "Tests failed",
    String(b.tests.failed),
    String(cur.tests.failed),
    deltaCell(d.failed, "", false),
  );
  row("Duration", ms(b.tests.durationMs), ms(cur.tests.durationMs), deltaCell(d.durationMs, "ms", false));
  row(
    "Coverage",
    b.tests.coverage != null ? `${b.tests.coverage.toFixed(1)}%` : "—",
    cur.tests.coverage != null ? `${cur.tests.coverage.toFixed(1)}%` : "—",
    deltaCell(d.coverage, "%", true, true),
  );
  row(
    "Build time",
    ms(b.perf.buildTimeMs),
    ms(cur.perf.buildTimeMs),
    deltaCell(d.buildTimeMs, "ms", false),
  );
  row(
    "Bundle size",
    bundleKB(b.perf.bundleSizeBytes),
    bundleKB(cur.perf.bundleSizeBytes),
    deltaCell(d.bundleSizeBytes, "KB", false),
  );
  row(
    "Security findings",
    String(b.securityCount),
    String(cur.securityCount),
    deltaCell(d.security, "", false),
  );
  row(
    "Duplication clones",
    String(b.duplicationCount),
    String(cur.duplicationCount),
    deltaCell(d.duplication, "", false),
  );
  out.push("");
  return out;
}

function proofSection(proofs: ReproProof[], coverage?: ReportModel["proofCoverage"]): string[] {
  const out: string[] = [];
  out.push(`## Fixes shipped with permanent proof`);
  out.push("");
  if (coverage && coverage.hasPen) {
    const badge = coverage.pct >= 80 ? "✅" : coverage.pct >= 50 ? "⚠️" : "❌";
    out.push(`**Proof coverage: ${badge} ${coverage.pct}%** — ${coverage.covered} of ${coverage.total} pen-test findings ship with a permanent failing-first repro test. This is the number that separates "we reported a vuln" from "we proved the fix" — Strix stops at the report; OpenPitStop ships the regression test.`);
    out.push("");
  }
  if (proofs.length === 0) {
    out.push(`No \`pitstop-repro-*.test.*\` files are committed. Every fix in the loop is`);
    out.push(`supposed to ship with a permanent repro test that proves it — their absence is a`);
    out.push(`red flag that fixes went out without a captured failing-then-passing proof.`);
    out.push("");
    return out;
  }
  out.push(`One line per committed fix, linking the test that permanently proves it:`);
  out.push("");
  out.push(`| Finding | Proved by |`);
  out.push(`| --- | --- |`);
  for (const p of proofs) {
    out.push(`| \`${p.findingId ?? "?"}\` | \`${p.file}\` |`);
  }
  out.push("");
  return out;
}

function integrityTerminalBlock(model: ReportModel): string | null {
  const integ = model.integrity;
  if (!integ || integ.checks === 0) return null;
  if (integ.catches === 0) {
    return `${chalk.bold("Integrity gate")}: ${chalk.green("clean — no cheating detected across " + integ.checks + " check(s)")}`;
  }
  const lines: string[] = [
    `${chalk.bold("Integrity gate")}: ${chalk.yellow(integ.catches + " catch(es)")}, ${chalk.green(integ.selfCorrected + " self-corrected by the loop")}`,
  ];
  for (const e of integ.events.filter((x) => x.verdict !== "CLEAN")) {
    for (const f of e.findings) {
      lines.push(
        `  - [${f.confidence}] ${f.detector}/${f.pattern} @ ${f.file}${f.line ? ":" + f.line : ""}: ${f.evidence}`,
      );
    }
  }
  return lines.join("\n");
}

function integritySection(model: ReportModel): string[] {
  const out: string[] = ["## Integrity gate", ""];
  const integ = model.integrity;
  if (!integ || integ.checks === 0) {
    out.push("No integrity checks recorded by the loop. Run `pitstop verify` (or `pitstop integrity`) to populate.");
    out.push("");
    return out;
  }
  if (integ.catches === 0) {
    out.push(
      `Clean — the integrity gate ran ${integ.checks} time(s) and caught no cheating. Honest fixes sailed through, which is exactly what a trustworthy gate must allow.`,
    );
    out.push("");
    return out;
  }
  out.push(
    `OpenPitStop's integrity gate caught **${integ.catches}** cheating attempt(s) across ${integ.checks} check(s).`,
  );
  if (integ.selfCorrected > 0) {
    out.push(
      `OpenPitStop caught ${integ.selfCorrected} attempted cheat(s), reverted them, retried the same cluster with the real fix, and proceeded. A catch that ends in a clean verify is the gate working — this is the single most credible line in this report.`,
    );
  }
  if (integ.catches - integ.selfCorrected > 0) {
    out.push(
      `**${integ.catches - integ.selfCorrected}** marked **"requires human review"** — the loop escalated instead of looping forever or hiding the cheat.`,
    );
  }
  out.push("");
  out.push(`| Verdict | Detector | Evidence |`);
  out.push(`| --- | --- | --- |`);
  for (const e of integ.events.filter((x) => x.verdict !== "CLEAN")) {
    for (const f of e.findings) {
      out.push(
        `| ${e.verdict} | ${f.detector}/${f.pattern} | \`${f.file}${f.line ? ":" + f.line : ""}\` — ${f.evidence} |`,
      );
    }
  }
  out.push("");
  return out;
}

function notesSection(): string[] {
  return [
    `## Notes`,
    ``,
    `- Every figure above is read directly from \`.pitstop/scan-*.json\` and \`.pitstop/verify-*.json\`.`,
    `- Categories marked **${NOT_SCANNED}** could not be analyzed for this repo (see the scan's per-category notes for why).`,
    `- Categories marked **${NOT_ASSESSED}** depend on a \`pitstop verify\` run that has not happened.`,
    `- Accessibility can only run a live page test with pa11y/axe; otherwise it falls back to static JSX linting.`,
    `- Reliability and race-condition findings are heuristics — confirm each before acting.`,
    ``,
  ];
}

export function renderMarkdown(model: ReportModel, opts: MarkdownOptions = {}): string {
  const out: string[] = [];
  out.push(`# ${PRODUCT} — ${opts.title ?? "Repository Analysis Complete"}`);
  out.push("");
  out.push(`_${TAGLINE}_`);
  out.push("");
  out.push(`_Generated ${model.generatedAt}_  `);
  out.push(`_Repo: \`${model.repo}\` · ${model.scansCount} scan(s), ${model.verifiesCount} verify(ies)_`);
  if (opts.headerNote) out.push(`_${opts.headerNote}_`);
  if (model.latestScan) {
    out.push("");
    out.push(`![OpenPitStop score](PITSTOP_BADGE.svg)`);
  }
  out.push("");

  if (opts.clustersFirst) {
    out.push(...clustersSection(model.clusters));
    out.push(...summarySection(model.lines));
  } else {
    out.push(...summarySection(model.lines));
    out.push(...clustersSection(model.clusters));
  }

  out.push(...beforeAfterSection(model));
  out.push(...proofSection(model.proofs, model.proofCoverage));
  out.push(...integritySection(model));
  if (model.latestVerify?.honesty) {
    const h = model.latestVerify.honesty;
    out.push(`## Honesty Score`);
    out.push("");
    out.push(`**${h.score}/100 · ${h.rating}** — did the agent (or an auto-fix PR) fake the result?`);
    for (const r of h.reasons) out.push(`- ${r}`);
    out.push("");
  }
  out.push(...notesSection());

  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* Single-file HTML report                                             */
/* ------------------------------------------------------------------ */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** README/CI badge: proof coverage of pen-test findings that ship a repro test. */
export function renderProofBadgeSvg(pct: number): string {
  const color = pct >= 80 ? "#3fb950" : pct >= 50 ? "#d29922" : "#f85149";
  const left = "PROOF";
  const right = pct >= 80 ? `${pct}% proven` : `${pct}%`;
  const wLeft = Math.round(left.length * 7.4 + 14);
  const wRight = Math.round(right.length * 7.4 + 14);
  const w = wLeft + wRight;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="OpenPitStop proof coverage ${pct}%">
  <linearGradient id="pg" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0%" stop-color="#5c5c5c" stop-opacity="0.95"/>
    <stop offset="100%" stop-color="#3a3a3a" stop-opacity="0.95"/>
  </linearGradient>
  <rect width="${w}" height="20" rx="3" fill="url(#pg)"/>
  <rect x="${wLeft}" width="${wRight}" height="20" fill="${color}"/>
  <g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">
    <text x="${wLeft / 2}" y="14">${left}</text>
    <text x="${wLeft + wRight / 2}" y="14">${right}</text>
  </g>
</svg>`;
}

/** Minimal inline-SVG line chart for a metric across scans. */
export function svgTrend(values: (number | null)[], colorHex: string): string {
  const pts: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v != null) pts.push({ i, v });
  });
  if (pts.length === 0) return `<p class="muted">no data</p>`;
  const n = pts.length;
  const W = Math.max(260, n * 44 + 40);
  const H = 72;
  const min = Math.min(...pts.map((p) => p.v));
  const max = Math.max(...pts.map((p) => p.v));
  const span = max - min || 1;
  const x = (i: number): number => 18 + (n === 1 ? 0 : (i * (W - 44)) / (n - 1));
  const y = (v: number): number => H - 14 - ((v - min) / span) * (H - 30);
  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const dots = pts
    .map((p) => `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" fill="${colorHex}"/>`)
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="trend">
    <polyline points="${line}" fill="none" stroke="${colorHex}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="18" y="${H - 2}" font-size="10" fill="#8b949e">${min}</text>
    <text x="18" y="11" font-size="10" fill="#8b949e">${max}</text>
  </svg>`;
}

const LINE_HEX: Record<string, string> = {
  green: "#3fb950",
  yellow: "#d29922",
  red: "#f85149",
  dim: "#8b949e",
};

function verdictHex(v: Verdict): string {
  return v === "CLEAN" ? "#3fb950" : v === "SUSPICIOUS" ? "#d29922" : "#f85149";
}

/**
 * Self-contained HTML report (inline CSS, inline SVG charts, zero external
 * assets) — the artifact you send to a stakeholder and it just works.
 */
export function renderHtml(model: ReportModel): string {
  const hist = loadHistory(model.repo);
  const scans = hist.scans;
  const sc = model.latestScan ? computeScore(model.latestScan) : null;
  const heroColor = sc ? gradeHex(sc.grade) : "#58a6ff";
  const badge = sc ? `<div class="badge">${escapeHtml(renderBadgeSvg(sc))}</div>` : "";
  const time = model.generatedAt.slice(0, 19).replace("T", " ");

  const summaryRows = model.lines
    .map((l) => {
      const c = LINE_HEX[l.color ?? "dim"] ?? "#8b949e";
      return `<tr><td class="label">${escapeHtml(l.label)}</td><td style="color:${c}">${escapeHtml(l.value)}</td></tr>`;
    })
    .join("\n");

  const clusterCards = (() => {
    if (model.clusters.length === 0) return `<p class="muted">No root-cause clusters identified.</p>`;
    return model.clusters
      .map(
        (c, i) => `
    <div class="card">
      <h3>${i + 1}. Root cause <span class="chip" style="color:${c.rootCause.severity === "critical" || c.rootCause.severity === "high" ? "#f85149" : "#d29922"}">${escapeHtml(c.rootCause.severity.toUpperCase())} ${escapeHtml(c.rootCause.type)}</span>${c.rootCause.id ? ` <code>${escapeHtml(c.rootCause.id)}</code>` : ""}</h3>
      <p>${escapeHtml(c.rootCause.description)}</p>
      <p class="muted">→ ${c.symptoms.length} symptom(s) · shared: <code>${escapeHtml(c.sharedFiles.join("`, `"))}</code></p>
      <ul>${c.symptoms.map((s) => `<li>(${escapeHtml(s.severity.toUpperCase())} ${escapeHtml(s.type)}) ${escapeHtml(s.description)}</li>`).join("")}</ul>
    </div>`,
      )
      .join("\n");
  })();

  const beforeAfter = (() => {
    const v = model.latestVerify;
    if (!v) return `<p class="muted">No verify history — run \`pitstop verify\` to populate the before/after diff.</p>`;
    const b = v.baseline;
    const cur = v.current;
    const d = v.deltas;
    const cell = (n: number, unit: string, higherIsBetter: boolean): string => {
      if (n === 0) return `<span class="muted">0</span>`;
      const good = higherIsBetter ? n > 0 : n < 0;
      const sign = n > 0 ? "+" : "";
      const val = unit === "KB" ? `${sign}${(n / 1024).toFixed(1)} KB` : unit === "ms" ? `${sign}${n} ms` : unit === "%" ? `${sign}${n.toFixed(1)}%` : `${sign}${n}`;
      return `<span style="color:${good ? "#3fb950" : "#f85149"}">${val}</span>`;
    };
    const kb = (x?: number) => (x == null ? "—" : `${(x / 1024).toFixed(1)} KB`);
    const ms = (x?: number) => (x == null ? "—" : `${x} ms`);
    const pct = (x?: number) => (x == null ? "—" : `${x.toFixed(1)}%`);
    const r = (name: string, base: string, curr: string, dlt: string): string =>
      `<tr><td class="label">${name}</td><td>${base}</td><td>${curr}</td><td>${dlt}</td></tr>`;
    return `
  <div class="card">
    <h3>Before / After <span class="chip">risk: <b style="color:${v.risk === "High" ? "#f85149" : v.risk === "Medium" ? "#d29922" : "#3fb950"}">${v.risk}</b></span></h3>
    <table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Δ</th></tr></thead><tbody>
      ${r("OpenPitStop score", `${v.score?.baseline ?? "—"}/100 (${v.score ? gradeOf(v.score.current) : ""})`, `${v.score?.current ?? "—"}/100`, cell(v.score?.delta ?? 0, "", true))}
      ${r("Tests passed", String(b.tests.passed), String(cur.tests.passed), cell(d.passed, "", true))}
      ${r("Tests failed", String(b.tests.failed), String(cur.tests.failed), cell(d.failed, "", false))}
      ${r("Duration", ms(b.tests.durationMs), ms(cur.tests.durationMs), cell(d.durationMs, "ms", false))}
      ${r("Coverage", pct(b.tests.coverage), pct(cur.tests.coverage), cell(d.coverage, "%", true))}
      ${r("Build time", ms(b.perf.buildTimeMs), ms(cur.perf.buildTimeMs), cell(d.buildTimeMs, "ms", false))}
      ${r("Bundle size", kb(b.perf.bundleSizeBytes), kb(cur.perf.bundleSizeBytes), cell(d.bundleSizeBytes, "KB", false))}
      ${r("Security findings", String(b.securityCount), String(cur.securityCount), cell(d.security, "", false))}
      ${r("Duplication clones", String(b.duplicationCount), String(cur.duplicationCount), cell(d.duplication, "", false))}
    </tbody></table>
  </div>`;
  })();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PITSTOP — ${escapeHtml(model.repo)}</title>
<style>
   :root{color-scheme:dark}
   *{box-sizing:border-box}
   body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;margin:0;padding:32px 16px}
   .wrap{max-width:860px;margin:0 auto}
   .topbar{height:4px;background:linear-gradient(90deg,#58a6ff,#3fb950);border-radius:4px;margin-bottom:24px}
   .brand{display:flex;align-items:center;gap:14px;margin-bottom:6px}
   .brand svg{flex:none;filter:drop-shadow(0 2px 6px rgba(88,166,255,.25))}
   .brand-text{display:flex;flex-direction:column;line-height:1.15}
   .brand-name{font-size:22px;font-weight:800;letter-spacing:.2px;background:linear-gradient(90deg,#58a6ff,#3fb950);-webkit-background-clip:text;background-clip:text;color:transparent}
   .brand-tag{font-size:12.5px;color:#8b949e}
   h1{font-size:20px;margin:0 0 4px}
   .muted{color:#8b949e;font-size:13px}
   .sub{color:#8b949e;font-size:13px;margin-bottom:24px}
   .hero{display:flex;align-items:center;gap:20px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:24px;flex-wrap:wrap;box-shadow:0 1px 0 rgba(255,255,255,.02) inset}
   .score{font-size:56px;font-weight:800;line-height:1;color:${heroColor}}
   .grd{font-size:22px;font-weight:700;color:${heroColor}}
   .badge{margin-top:4px}
   h2{font-size:16px;border-bottom:1px solid #30363d;padding-bottom:8px;margin:32px 0 12px;color:#f0f6fc}
   table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px}
   th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #21262d}
   th{color:#8b949e;font-weight:600}
   .label{font-weight:600;color:#c9d1d9}
   code{background:#21262d;padding:1px 6px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
   .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px 20px;margin-bottom:16px}
   .card h3{margin:0 0 8px;font-size:14px}
   .card p{margin:4px 0;font-size:13px}
   .card ul{margin:6px 0 0;padding-left:20px;font-size:13px}
   .card li{margin:2px 0}
   .chip{background:#21262d;border-radius:20px;padding:1px 10px;font-size:12px;margin-left:8px;font-weight:600}
   .verdict{display:inline-block;border-radius:20px;padding:2px 10px;font-size:12px;font-weight:700;margin:2px 4px 2px 0}
   .trend .card{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
   .trend .card h3{min-width:180px;margin:0}
   .trend .card div{flex:1;min-width:260px}
   .footer{color:#8b949e;font-size:12px;margin-top:40px;text-align:center;border-top:1px solid #21262d;padding-top:16px}
   .footer b{color:#c9d1d9}
   a{color:#58a6ff}
   </style>
   </head>
   <body><div class="wrap">
   <div class="topbar"></div>
   ${brandBarHtml()}
   <p class="sub">${escapeHtml(model.repo)} · generated ${time} · ${model.scansCount} scan(s), ${model.verifiesCount} verify(ies)</p>

  <div class="hero">
    ${sc ? `<div><div class="score">${sc.score}<span style="font-size:20px">/100</span></div><div class="grd">${sc.grade}</div></div>` : `<div class="score" style="font-size:24px">no scan yet</div>`}
    ${badge}
    <p class="muted" style="flex-basis:100%;margin:0">${sc ? `${sc.analyzed}/${sc.total} categories analyzed. A higher number is healthier.` : "Run <code>pitstop scan</code> to score this repo."}</p>
  </div>

  <h2>Summary</h2>
  <table><tbody>${summaryRows}</tbody></table>

  <h2>Root-Cause Clusters</h2>
  ${clusterCards}

  <h2>Before / After</h2>
  ${beforeAfter}

  <h2>Trends across scans</h2>
  <div class="trend">
    ${[
      { label: "Security issues", color: "#f85149", get: (s: ScanResult) => (s.security.status === "ok" ? s.security.issues.length : null) },
      { label: "Circular imports", color: "#d29922", get: (s: ScanResult) => (s.dependencyGraph.status === "ok" ? s.dependencyGraph.circular.length : null) },
      { label: "Duplication clones", color: "#d29922", get: (s: ScanResult) => (s.duplication.status === "ok" ? s.duplication.cloneCount : null) },
      { label: "Failed tests", color: "#f85149", get: (s: ScanResult) => (s.tests.status === "ok" ? s.tests.failed : null) },
      { label: "Test coverage %", color: "#3fb950", get: (s: ScanResult) => (s.tests.status === "ok" ? s.tests.coverage ?? null : null) },
      { label: "OpenPitStop score", color: "#58a6ff", get: (s: ScanResult) => computeScore(s).score },
    ]
      .map((m) => `<div class="card"><h3>${m.label}</h3><div>${svgTrend(scans.map(m.get), m.color)}</div></div>`)
      .join("\n")}
  </div>

  ${model.integrity && model.integrity.checks > 0
    ? `<h2>Integrity gate</h2>
  <div class="card"><p>${model.integrity.checks} check(s) · ${model.integrity.catches} catch(es) · ${model.integrity.selfCorrected} self-corrected</p>
    <p>${model.integrity.events
      .map(
        (e) =>
          `<span class="verdict" style="background:${verdictHex(e.verdict)}22;color:${verdictHex(e.verdict)};border:1px solid ${verdictHex(e.verdict)}">${e.verdict}</span><span class="muted">${e.timestamp.slice(0, 19).replace("T", " ")} · ${e.findings.length} finding(s)</span>`,
      )
      .join("<br/>")}</p></div>`
    : ""}

   <h2>Fixes shipped with permanent proof</h2>
   <div class="card">
     ${model.proofCoverage && model.proofCoverage.hasPen ? `<p><b style="color:${model.proofCoverage.pct >= 80 ? "#3fb950" : model.proofCoverage.pct >= 50 ? "#d29922" : "#f85149"}">Proof coverage: ${model.proofCoverage.pct}%</b> — ${model.proofCoverage.covered} of ${model.proofCoverage.total} pen-test findings ship a permanent failing-first repro test. Strix stops at the report; OpenPitStop ships the regression test.</p>` : ""}
     ${model.proofs.length === 0 ? `<p class="muted">No pitstop-repro-*.test.* files are committed.</p>` : `<table><thead><tr><th>Finding</th><th>Proved by</th></tr></thead><tbody>${model.proofs.map((p) => `<tr><td><code>${escapeHtml(p.findingId ?? "?")}</code></td><td><code>${escapeHtml(p.file)}</code></td></tr>`).join("")}</tbody></table>`}
   </div>

   ${model.latestVerify?.honesty ? `<h2>Honesty Score</h2><div class="card"><p style="color:${model.latestVerify.honesty.rating === "TRUSTWORTHY" ? "#3fb950" : model.latestVerify.honesty.rating === "QUESTIONABLE" ? "#d29922" : "#f85149"}"><b>${model.latestVerify.honesty.score}/100 · ${model.latestVerify.honesty.rating}</b></p><ul>${model.latestVerify.honesty.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></div>` : ""}

   <div class="footer">${PRODUCT} — <b>the honest referee for AI coding agents</b> · every figure read from <code>.pitstop/scan-*.json</code> and <code>.pitstop/verify-*.json</code></div>
</div></body></html>`;
}
