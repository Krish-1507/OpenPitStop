import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { resolveFinding, type ReproFinding } from "../repro/ids.js";
import { loadProofs } from "../report/format.js";
import { relevantEntriesForFiles, type MemoryEntry } from "../memory/store.js";
import { loadPenLatest, resolvePenFinding } from "../pen/store.js";
import type { PenFinding } from "../pen/types.js";
import type { ScanResult, Cluster } from "../analyzers/types.js";

/**
 * `pitstop inspect <finding-id>` — deep dive on a single finding.
 *
 * Shows the exact code, the cluster it belongs to, whether a permanent repro
 * test exists, and the memory OpenPitStop has about the files involved. One
 * command from the scan box to a fully actionable picture.
 */

function latestScan(repo: string): ScanResult | null {
  const p = path.join(repo, ".pitstop", "scan-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ScanResult;
  } catch {
    return null;
  }
}

function severityPaint(sev: string): (t: string) => string {
  switch (sev) {
    case "critical":
    case "high":
      return chalk.red;
    case "medium":
      return chalk.yellow;
    default:
      return chalk.dim;
  }
}

function rel(repo: string, p?: string): string {
  if (!p) return "";
  // Cluster files are stored relative to the repo; issue files are absolute.
  if (!path.isAbsolute(p)) return p.replace(/\\/g, "/");
  try {
    return path.relative(repo, p).replace(/\\/g, "/");
  } catch {
    return p;
  }
}

function resolve(repo: string, p?: string): string | null {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(repo, p);
}

/** ±6 lines around the finding, target line highlighted. */
function codeSnippet(repo: string, f: ReproFinding): string[] {
  const abs = resolve(repo, f.file);
  if (!abs || !fs.existsSync(abs)) return [];
  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const hasLine = f.line != null;
  const target = f.line ?? 1;
  const start = Math.max(1, target - 6);
  const end = Math.min(lines.length, target + 6);
  const width = String(end).length;
  const out: string[] = [];
  for (let i = start; i <= end; i++) {
    const gut = String(i).padStart(width);
    const raw = lines[i - 1] ?? "";
    const body = raw.length > 100 ? raw.slice(0, 100) + " …" : raw;
    const isTarget = hasLine && i === target;
    out.push(
      isTarget
        ? `${chalk.dim(gut + " │")} ${chalk.bgRed(chalk.black("►"))} ${chalk.bold(body)}`
        : `${chalk.dim(gut + " │")} ${chalk.dim(body)}`,
    );
  }
  return out;
}

function clusterOf(r: ScanResult, id: string): Cluster | null {
  for (const c of r.clusters ?? []) {
    const ids = [c.rootCause.id, ...c.symptoms.map((s) => s.id)].filter(Boolean);
    if (ids.includes(id)) return c;
  }
  return null;
}

function memoryLines(repo: string, f: ReproFinding, c: Cluster | null): string[] {
  const files = c ? c.sharedFiles : f.file ? [f.file] : [];
  if (files.length === 0) return [];
  const entries = relevantEntriesForFiles(repo, files);
  if (entries.length === 0) return [];
  const typeColor = (e: MemoryEntry): (s: string) => string => {
    switch (e.type) {
      case "decision": return chalk.cyan;
      case "fix": return chalk.green;
      case "rejection": return chalk.red;
    }
  };
  const out: string[] = [chalk.bold("OpenPitStop memory:")];
  for (const e of entries.slice(0, 5)) {
    out.push(`  ${typeColor(e)(e.type.toUpperCase().padEnd(9))} ${e.summary}`);
    if (e.context) out.push(`    ${chalk.dim("why: " + e.context)}`);
  }
  return out;
}

/** Pen-finding deep dive: attack, response, sandbox evidence, fix. */
function renderPenInspect(repo: string, f: PenFinding): void {
  const paint = severityPaint(f.severity);
  const lines: string[] = [];
  lines.push(`${chalk.bold("Finding")}: ${paint(f.severity.toUpperCase())} ${chalk.bold(f.type)} · ${chalk.bold(f.confidence.toUpperCase())} · ${chalk.dim(f.id)}`);
  const where = f.file
    ? `${rel(repo, f.file)}${f.line ? ":" + f.line : ""}`
    : f.route
      ? `${f.route} [${f.method ?? ""}]`
      : "no location";
  lines.push(`${chalk.bold("Location")}: ${chalk.cyan(where)}`);
  lines.push("");
  lines.push(f.title);
  lines.push("");
  lines.push(f.description);
  lines.push("");
  if (f.attack) {
    lines.push(
      chalk.bold("Attack fired:"),
      `  ${chalk.cyan(`${f.attack.method} ${f.attack.path}`)}`,
      f.attack.payload !== undefined ? `  payload: ${chalk.dim(JSON.stringify(f.attack.payload).slice(0, 200))}` : "",
    );
  }
  if (f.response) {
    lines.push(
      chalk.bold("Observed response:"),
      `  HTTP ${f.response.status ?? "—"}${f.response.snippet ? ` — ${f.response.snippet}` : ""}`,
    );
  }
  if (f.outbound?.length) {
    lines.push(chalk.bold("Sandbox evidence:"), ...f.outbound.map((e) => `  ${chalk.red(e)}`));
  }
  if (f.repro) {
    lines.push("", chalk.bold("Reproduce by hand:"), `  ${chalk.dim(f.repro)}`);
  }
  lines.push("");
  if (f.fix) {
    lines.push(chalk.bold("Fix:"), `  ${f.fix}`);
  }
  lines.push("");
  lines.push(
    chalk.dim(`next: ${chalk.cyan(`pitstop repro ${f.id}`)} captures this as a permanent failing-then-passing test`),
  );
  console.log(
    boxen(lines.join("\n"), {
      title: ` PITSTOP — Inspect ${f.id} `,
      titleAlignment: "center",
      borderStyle: "round",
      padding: 1,
      borderColor: paint === chalk.red ? "red" : paint === chalk.yellow ? "yellow" : "cyan",
    }),
  );
}

export const inspect = new Command("inspect")
  .description(
    "Deep-dive on a single finding id: code location, cluster context, repro proof, and OpenPitStop's memory of the files.",
  )
  .argument("<id>", "finding id from a scan box or .pitstop/scan-latest.json (e.g. security-19c390c6)")
  .option("--repo <path>", "repo to inspect (defaults to cwd)", ".")
  .action((idArg: string, options: { repo: string }) => {
    const repo = path.resolve(options.repo);
    const id = (idArg.match(/[A-Za-z0-9]+-[A-Za-z0-9]{6,}/)?.[0] ?? idArg).trim();
    if (!id) {
      console.log(chalk.red(`could not parse a finding id from "${idArg}"`));
      return;
    }

    const result = latestScan(repo);
    const penResult = loadPenLatest(repo);
    if (!result && !penResult) {
      console.log(
        chalk.red(`no scan found — run \`pitstop scan\` first to create .pitstop/scan-latest.json`),
      );
      return;
    }

    const f = result ? resolveFinding(result, id) : null;
    if (!f && penResult) {
      const pf = resolvePenFinding(penResult, id);
      if (pf) {
        renderPenInspect(repo, pf);
        return;
      }
    }

    if (!f) {
      console.log(
        chalk.red(`finding "${id}" not found in scan-latest.json or pen-latest.json\n`) +
          chalk.dim(`hint: ids look like ${chalk.cyan("security-19c390c6")}; run \`pitstop scan\` to refresh.`),
      );
      return;
    }

    const c = result ? clusterOf(result, id) : null;
    const paint = severityPaint(f.severity);
    const loc = f.file ? `${rel(repo, f.file)}${f.line ? ":" + f.line : ""}` : "no file location";
    const reproCapable = ["security", "a11y", "reliability", "devex", "ledger", "perf", "graph"].includes(
      f.source,
    );

    const proofs = loadProofs(repo).filter((p) => p.findingId === id);
    const proofLines =
      proofs.length > 0
        ? [
            chalk.bold("Permanent proof:"),
            ...proofs.map((p) => `  ${chalk.green("✓")} committed repro test: ${chalk.cyan(p.file)}`),
          ]
        : [
            `${chalk.bold("Permanent proof:")} ${chalk.yellow("none committed yet")} — run \`pitstop repro ${id}\` to capture a failing-then-passing regression test.`,
          ];

    const lines: string[] = [];
    lines.push(`${chalk.bold("Finding")}: ${paint(f.severity.toUpperCase())} ${chalk.bold(f.type)}`);
    lines.push(`${chalk.bold("Location")}: ${chalk.cyan(loc)}`);
    lines.push("");
    lines.push(f.description);
    lines.push("");

    const snip = codeSnippet(repo, f);
    if (snip.length > 0) {
      lines.push(chalk.bold("Code:"), ...snip, "");
    }

    if (c) {
      const isRoot = c.rootCause.id === id;
      lines.push(
        chalk.bold("Cluster context:"),
        isRoot
          ? `  this is the ROOT CAUSE → ${c.symptoms.length} symptom(s) across ${c.sharedFiles.length} shared file(s)`
          : `  symptom of → ${chalk.red(c.rootCause.severity.toUpperCase() + " " + c.rootCause.type)}: ${c.rootCause.description}`,
        `  shared: ${chalk.dim(c.sharedFiles.map((x) => rel(repo, x)).join(", "))}`,
        "",
      );
    }

    if (f.source === "ledger" && f.data) {
      const ev = f.data as { scenario?: string; orderId?: string; idempotencyKey?: string; doubleCharged?: boolean; chargeCalls?: unknown[] };
      lines.push(
        chalk.bold("Ledger evidence:"),
        `  scenario: ${ev.scenario ?? "?"} · order: ${ev.orderId ?? "?"} · key: ${ev.idempotencyKey ?? "?"} · double-charged: ${ev.doubleCharged ? chalk.red("YES") : chalk.green("no")}`,
        `  gateway calls: ${ev.chargeCalls?.length ?? 0}`,
        "",
      );
    }

    if (f.source === "perf" && f.data) {
      const p = f.data as { buildTimeMs?: number; bundleSizeBytes?: number };
      lines.push(
        chalk.bold("Performance baseline:"),
        `  build: ${p.buildTimeMs != null ? p.buildTimeMs + " ms" : "—"} · bundle: ${p.bundleSizeBytes != null ? (p.bundleSizeBytes / 1024).toFixed(1) + " KB" : "—"}`,
        "",
      );
    }

    lines.push(...proofLines, "");

    const mem = memoryLines(repo, f, c);
    if (mem.length > 0) lines.push(...mem, "");

    if (reproCapable) {
      lines.push(
        chalk.dim(`next: ${chalk.cyan(`pitstop repro ${id}`)} captures this as a permanent failing-then-passing test`),
      );
    } else {
      lines.push(chalk.dim("this finding type is diagnostic-only (no repro generator)."));
    }

    console.log(
      boxen(lines.join("\n"), {
        title: ` PITSTOP — Inspect ${id} `,
        titleAlignment: "center",
        borderStyle: "round",
        padding: 1,
        borderColor: paint === chalk.red ? "red" : paint === chalk.yellow ? "yellow" : "cyan",
      }),
    );
  });
