/**
 * pen/report.ts — rendering for `pitstop pen`: terminal box, markdown, and a
 * self-contained sealed HTML report (zero external assets, like the rest of
 * OpenPitStop's reports).
 */

import boxen from "boxen";
import chalk from "chalk";
import path from "node:path";
import { escapeHtml } from "../report/format.js";
import { sortFindings, summarizeFindings, SEVERITY_ORDER, type PenFinding, type PenResult } from "./types.js";

function sevPaint(sev: PenFinding["severity"]): (s: string) => string {
  switch (sev) {
    case "critical":
    case "high":
      return chalk.red;
    case "medium":
      return chalk.yellow;
    case "low":
      return chalk.dim;
    default:
      return chalk.dim;
  }
}

function confMark(conf: PenFinding["confidence"]): string {
  switch (conf) {
    case "proven":
      return chalk.bgRed(chalk.black("PROVEN"));
    case "indicated":
      return chalk.bgYellow(chalk.black("IND"));
    default:
      return chalk.bgGray(chalk.black("HEUR"));
  }
}

function rel(repo: string, p?: string): string {
  if (!p) return "";
  return path.relative(repo, p).replace(/\\/g, "/");
}

function loc(repo: string, f: PenFinding): string {
  const where = f.route ? `${f.route}${f.method ? " [" + f.method + "]" : ""}` : f.file ? rel(repo, f.file) : "";
  if (!where) return "";
  return chalk.dim(`${f.line ? `:${f.line}` : ""}`) === "" ? where : `${where}${f.line ? chalk.dim(`:${f.line}`) : ""}`;
}

export function renderPenBox(result: PenResult): string {
  const sum = result.summary;
  const lines: string[] = [];

  const sevParts = SEVERITY_ORDER.filter((s) => sum[s] > 0).map((s) => {
    const paint = s === "critical" || s === "high" ? chalk.red : s === "medium" ? chalk.yellow : chalk.dim;
    return paint(`${sum[s]} ${s}`);
  });
  lines.push(
    `${chalk.bold("Findings")}: ${sevParts.length ? sevParts.join(" · ") : chalk.green("clean")}`,
  );
  lines.push(
    `${chalk.bold("Confidence")}: ${sum.proven} proven · ${sum.indicated} indicated · ${sum.heuristic} heuristic`,
  );
  if (result.staticProof) {
    const p = result.staticProof;
    lines.push(
      chalk.dim(
        `Static findings verified live: ${p.proven} proven · ${p.indicated} indicated · ${p.unproven} unproven · ${p.notTested} not tested`,
      ),
    );
  }
  lines.push("");

  const dyn = result.dynamic;
  if (result.dynamicEnabled && dyn.status === "ok") {
    lines.push(
      `${chalk.bold("Dynamic phase")}: ${dyn.routesProbed} route(s) probed · ${dyn.attacks} attacks · boot ${dyn.bootMs}ms · ${dyn.outboundEvents} outbound events`,
    );
  } else if (result.dynamicEnabled) {
    lines.push(
      `${chalk.bold("Dynamic phase")}: ${chalk.yellow(dyn.status)} — ${dyn.note ?? ""}`,
    );
  } else {
    lines.push(`${chalk.bold("Dynamic phase")}: ${chalk.dim("skipped (--static)")}`);
  }

  lines.push("");
  const findings = sortFindings(result.findings);
  if (findings.length === 0) {
    lines.push(chalk.green("No findings. The app holds up. (The absence of proof is not proof of absence —"));
    lines.push(chalk.green("this test covers the routes and vectors OpenPitStop knows how to fire.)"));
  } else {
    const shown = findings.slice(0, 8);
    for (const f of shown) {
      const paint = sevPaint(f.severity);
      lines.push(
        `${confMark(f.confidence)} ${paint(f.severity.toUpperCase().padEnd(8))} ${chalk.bold(f.type)} [${chalk.dim(f.id)}]`,
      );
      lines.push(
        `    ${f.title} — ${loc(result.repo, f)}`,
      );
    }
    if (findings.length > 8) {
      lines.push(`${chalk.dim(`… and ${findings.length - 8} more (see PITSTOP_PEN_REPORT.md)`)}`);
    }
  }

  lines.push("");
  lines.push(chalk.cyan("next:"));
  lines.push(`  pitstop inspect <id>   deep-dive on one finding`);
  lines.push(`  pitstop repro <id>     record it as a failing-then-passing regression test`);
  lines.push(`  pitstop pen --fix      write repro tests + deterministic patches`);
  lines.push(`  pitstop drive <id>     hand the finding to your own agent and verify its fix`);

  return boxen(lines.join("\n"), {
    title: " PITSTOP — Penetration Test ",
    titleAlignment: "center",
    borderStyle: "double",
    padding: 1,
    borderColor: sum.critical + sum.high > 0 ? "red" : "green",
  });
}

/** Self-contained Markdown report (also the basis for the HTML one). */
export function renderPenMarkdown(result: PenResult): string {
  const sum = result.summary;
  const findings = sortFindings(result.findings);
  const L: string[] = [];
  L.push(`# OpenPitStop Penetration Test — ${result.repo}`);
  L.push("");
  L.push(`_${result.timestamp}_ · static: ${result.staticEnabled ? "on" : "off"} · dynamic: ${result.dynamicEnabled ? "on" : "off"}`);
  L.push("");
  L.push(`## Summary`);
  L.push("");
  L.push(`| | | | | |`);
  L.push(`|---|---|---|---|---|`);
  L.push(`| critical | high | medium | low | info |`);
  L.push(`| ${sum.critical} | ${sum.high} | ${sum.medium} | ${sum.low} | ${sum.info} |`);
  L.push("");
  L.push(`Confidence: **${sum.proven} proven** · ${sum.indicated} indicated · ${sum.heuristic} heuristic`);
  L.push("");
  if (result.staticProof) {
    const p = result.staticProof;
    L.push(
      `Static findings verified live: **${p.proven} proven** · ${p.indicated} indicated · ${p.unproven} unproven · ${p.notTested} not tested — every pattern finding was either confirmed by a live attack or honestly labeled unproven.`,
    );
    L.push("");
  }
  if (result.dynamicEnabled) {
    L.push(
      `Dynamic: ${result.dynamic.status} — ${result.dynamic.routesProbed} routes, ${result.dynamic.attacks} attacks, boot ${result.dynamic.bootMs}ms, ${result.dynamic.outboundEvents} outbound events.`,
    );
    if (result.dynamic.note) L.push(`> ${result.dynamic.note}`);
  }
  L.push("");
  L.push(`## Findings`);
  L.push("");
  if (findings.length === 0) {
    L.push("Nothing surfaced. See the boxed caveat: coverage is the routes + patterns OpenPitStop knows.");
  }
  for (const f of findings) {
    L.push(`### ${f.severity.toUpperCase()} — ${f.title} \`${f.id}\``);
    L.push("");
    L.push(`- **Confidence**: ${f.confidence}`);
    const where = f.file ? rel(result.repo, f.file) + (f.line ? `:${f.line}` : "") : f.route ? `${f.route} (${f.method})` : "—";
    L.push(`- **Where**: \`${where}\``);
    L.push("");
    L.push(f.description);
    L.push("");
    if (f.runtimeProof) {
      L.push(
        `- **Runtime verification**: ${
          f.runtimeProof === "proven"
            ? "**PROVEN** by live attack"
            : f.runtimeProof === "indicated"
              ? "indicated by live probing"
              : f.runtimeProof === "unproven"
                ? "unproven (probed, no signal)"
                : "not tested"
        } — ${f.runtimeNote ?? ""}`,
      );
    }
    if (f.attack) {
      L.push(`- **Attack**: \`${f.attack.method} ${f.attack.path}${f.attack.payload ? " payload=" + escapeHtml(JSON.stringify(f.attack.payload)).replace(/&lt;/g, "<").replace(/&gt;/g, ">") : ""}\``);
    }
    if (f.response) {
      L.push(`- **Response**: HTTP ${f.response.status ?? "—"}${f.response.snippet ? ` — ${f.response.snippet}` : ""}`);
    }
    if (f.outbound?.length) {
      L.push(`- **Sandbox evidence**:`);
      for (const e of f.outbound) L.push(`  - \`${e}\``);
    }
    if (f.repro) L.push(`- **Reproduce**: ${f.repro}`);
    if (f.fix) {
      L.push(`- **Fix**: ${f.fix}`);
      L.push(`  Run \`pitstop repro ${f.id}\` to capture it as a regression test, then \`pitstop pen\` again.`);
    }
    L.push("");
  }
  return L.join("\n");
}

/** Self-contained HTML report (no external assets), mirroring other guard deeds. */
export function renderPenHtml(result: PenResult): string {
  const findings = sortFindings(result.findings);
  const sum = result.summary;
  const rows = findings
    .map((f) => {
      const where = f.file
        ? `<code>${escapeHtml(rel(result.repo, f.file))}${f.line ? `:${f.line}` : ""}</code>`
        : f.route
          ? `<code>${escapeHtml(f.route)}</code> [${escapeHtml(f.method ?? "")}]`
          : "—";
      const attack = f.attack
        ? `<p class="atk"><code>${escapeHtml(f.attack.method)} ${escapeHtml(f.attack.path)}</code>${f.attack.payload ? `<br><code>→ ${escapeHtml(JSON.stringify(f.attack.payload)).slice(0, 160)}</code>` : ""}</p>`
        : "";
      const evidence = f.outbound?.length
        ? `<ul class="evidence">${f.outbound.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>`
        : "";
      return `<div class="card sev-${f.severity}">
  <h3>${escapeHtml(f.severity.toUpperCase())} · ${escapeHtml(f.type)} <span class="id">${escapeHtml(f.id)}</span> <span class="conf ${f.confidence}">${f.confidence}</span></h3>
  <p><strong>${escapeHtml(f.title)}</strong></p>
  <p class="loc">${where}</p>
  <p>${escapeHtml(f.description)}</p>
  ${f.runtimeProof ? `<p class="rt rt-${f.runtimeProof}"><strong>Runtime: ${f.runtimeProof === "proven" ? "PROVEN by live attack" : f.runtimeProof === "indicated" ? "indicated by live probing" : f.runtimeProof === "unproven" ? "unproven (probed, no signal)" : "not tested"}</strong> ${escapeHtml(f.runtimeNote ?? "")}</p>` : ""}
  ${attack}
  ${f.response ? `<p class="resp">HTTP ${f.response.status ?? "—"}${f.response.snippet ? ` · ${escapeHtml(f.response.snippet)}` : ""}</p>` : ""}
  ${evidence}
  ${f.repro ? `<p><strong>Reproduce:</strong> ${escapeHtml(f.repro)}</p>` : ""}
  ${f.fix ? `<p class="fix"><strong>Fix:</strong> ${escapeHtml(f.fix)}</p>` : ""}
</div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenPitStop Pen Test — ${escapeHtml(result.repo)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background: #f6f8fb; color: #111; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; }
  header { border-bottom: 3px solid #0ea5e9; padding-bottom: 16px; margin-bottom: 24px; }
  h1 { margin: 0 0 4px; font-size: 28px; }
  .muted { color: #5b6572; }
  .sum { display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 0; }
  .badge { padding: 8px 14px; border-radius: 8px; font-weight: 600; background: #eef2f7; }
  .badge.crit, .badge.high { background: #fee2e2; color: #b91c1c; }
  .badge.med { background: #fef3c7; color: #92400e; }
  .card { border: 1px solid #e2e8f0; background: #fff; border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; border-left: 5px solid #94a3b8; }
  .card.sev-critical, .card.sev-high { border-left-color: #dc2626; }
  .card.sev-medium { border-left-color: #d97706; }
  .card.sev-low, .card.sev-info { border-left-color: #64748b; }
  h3 { margin: 0 0 6px; font-size: 15px; }
  .id { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #64748b; font-weight: 400; }
  .conf { font-size: 11px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; }
  .conf.proven { background: #dc2626; color: #fff; }
  .conf.indicated { background: #f59e0b; color: #fff; }
  .conf.heuristic { background: #94a3b8; color: #fff; }
  .loc { color: #475569; font-size: 13px; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  .atk { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 6px 10px; }
  .resp { color: #475569; }
  .evidence { color: #b91c1c; }
  .fix { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; padding: 8px 10px; }
  .rt { font-size: 12.5px; padding: 6px 10px; border-radius: 6px; }
  .rt-proven { background: #fee2e2; border: 1px solid #fecaca; color: #991b1b; }
  .rt-indicated { background: #fef3c7; border: 1px solid #fde68a; color: #92400e; }
  .rt-unproven { background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; }
  .rt-not-tested { background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; }
</style>
</head><body><div class="wrap">
<header>
  <h1>OpenPitStop Penetration Test</h1>
  <p class="muted">${escapeHtml(result.timestamp)} · ${escapeHtml(result.repo)} · static ${result.staticEnabled ? "on" : "off"} · dynamic ${result.dynamicEnabled ? "on" : "off"}</p>
  ${result.dynamicEnabled ? `<p class="muted">Dynamic: ${result.dynamic.status} — ${result.dynamic.routesProbed} routes · ${result.dynamic.attacks} attacks · boot ${result.dynamic.bootMs}ms${result.dynamic.note ? ` · ${escapeHtml(result.dynamic.note)}` : ""}</p>` : ""}
  <div class="sum">
    <span class="badge crit">critical ${sum.critical}</span>
    <span class="badge high">high ${sum.high}</span>
    <span class="badge med">medium ${sum.medium}</span>
    <span class="badge">low ${sum.low}</span>
    <span class="badge">info ${sum.info}</span>
    <span class="badge">proven ${sum.proven}</span>
  </div>
</header>
${rows}
<p class="muted">Coverage: the routes and patterns OpenPitStop knows how to fire. No proof of absence — rerun after every change.</p>
</div></body></html>`;
}