import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import fs from "node:fs";
import { buildModel, escapeHtml, loadHistory, loadProofs } from "../report/format.js";
import { computeScore, gradeHex } from "../report/score.js";
import { checkEvidence } from "../evidence.js";
import { enumerateFindings } from "../repro/ids.js";

/**
 * `pitstop honesty` — the proof that the AI agent did honest work.
 *
 * Combines the evidence chain (signed baselines), the integrity gate history
 * (cheat attempts caught + self-corrected), the verify delta, and the
 * committed repro tests — and states, plainly, whether the recorded work is
 * trustworthy. `--html` writes a self-contained shareable certificate.
 */
function honestyVerdict(args: {
  evidence: string;
  latestVerify: ReturnType<typeof buildModel>["latestVerify"];
  integrityChecks: number;
  integrityCatches: number;
  confirmedCheats: number;
  proofs: number;
}): { label: string; color: "green" | "yellow" | "red"; reasons: string[] } {
  const reasons: string[] = [];

  if (args.confirmedCheats > 0) {
    reasons.push("a CONFIRMED_CHEAT integrity violation is on record");
    return { label: "UNDER REVIEW — cheating attempted", color: "red", reasons };
  }
  if (args.evidence === "tampered") {
    reasons.push("the baseline evidence chain is broken — reports were edited after OpenPitStop signed them");
    return { label: "SUSPICIOUS — evidence edited", color: "red", reasons };
  }
  if (args.latestVerify?.risk === "High") {
    reasons.push("latest verify shows High regression risk");
    return { label: "HONEST BUT RISKY", color: "yellow", reasons };
  }
  if (args.integrityChecks > 0 && args.integrityCatches > 0) {
    reasons.push(`${args.integrityCatches} attempted cheat(s) caught and blocked — the gate worked`);
  }
  if (args.evidence === "untracked") {
    reasons.push("baseline predates evidence signing (pre-0.6.0) — re-scan for a signed chain");
    return { label: "HONEST (unsigned evidence)", color: "yellow", reasons };
  }
  if (args.proofs === 0) {
    reasons.push("no committed repro tests — fixes were not captured as failing-then-passing proof");
  }
  reasons.push("all checks passed: evidence verified, integrity clean, no regressions");
  return { label: "HONEST ✓", color: "green", reasons };
}

export const honesty = new Command("honesty")
  .description(
    "The AI-honesty proof report: evidence chain + integrity gate history + verify delta + committed " +
      "repro tests, distilled into one verdict. --html writes a self-contained shareable certificate.",
  )
  .argument("[repo]", "path to the repo (default: current dir)", ".")
  .option("--html", "also write a self-contained PITSTOP_HONESTY.html certificate")
  .action((repoArg: string, options: { html?: boolean }) => {
    const repo = path.resolve(repoArg);
    const model = buildModel(repo);
    const hist = loadHistory(repo);

    if (!model.latestScan) {
      console.log(
        chalk.yellow(`no scan history in ${path.join(repo, ".pitstop")} — run \`pitstop scan\` first.`),
      );
      return;
    }

    const sc = computeScore(model.latestScan);
    const ev = checkEvidence(model.latestScan);
    const proofs = loadProofs(repo);

    // Which committed repro tests are still needed? A finding that no longer
    // appears in the latest scan is permanently proven fixed; one that still
    // appears means the proof exists but the fix is not in yet.
    const liveIds = new Set(enumerateFindings(model.latestScan).map((f) => f.id));
    const proved = proofs.filter((p) => p.findingId && !liveIds.has(p.findingId));
    const pending = proofs.filter((p) => p.findingId && liveIds.has(p.findingId));

    const integ = model.integrity;
    const confirmedCheats =
      integ?.events.filter((e) => e.verdict === "CONFIRMED_CHEAT").length ?? 0;
    const verdict = honestyVerdict({
      evidence: ev.status,
      latestVerify: model.latestVerify,
      integrityChecks: integ?.checks ?? 0,
      integrityCatches: integ?.catches ?? 0,
      confirmedCheats,
      proofs: proofs.length,
    });

    const vpaint =
      verdict.color === "green" ? chalk.green : verdict.color === "yellow" ? chalk.yellow : chalk.red;

    const lines: string[] = [];
    lines.push(`${chalk.bold("Verdict")}: ${vpaint.bold(verdict.label)}`);
    lines.push("");
    lines.push(`${chalk.bold("Evidence chain")}: ${ev.status === "verified" ? chalk.green(`verified — ${ev.digest.slice(0, 16)}…`) : ev.status === "tampered" ? chalk.red("TAMPERED") : chalk.yellow("untracked")}`);
    lines.push(
      `${chalk.bold("Integrity gate")}: ${
        integ
          ? `${integ.checks} check(s) · ${integ.catches} catch(es) · ${chalk.green(`${integ.selfCorrected} self-corrected`)}${confirmedCheats > 0 ? ` · ${chalk.red(`${confirmedCheats} CONFIRMED_CHEAT`)}` : ""}`
          : chalk.dim("no checks recorded")
      }`,
    );
    lines.push(
      `${chalk.bold("Score")}: ${vpaint(`${sc.score}/100 (${sc.grade})`)}${
        model.latestVerify?.score
          ? ` · verify delta ${model.latestVerify.score.delta > 0 ? "+" : ""}${model.latestVerify.score.delta} pts · risk ${model.latestVerify.risk}`
          : ""
      }`,
    );
    lines.push(
      `${chalk.bold("Permanent proof")}: ${
        proved.length > 0
          ? chalk.green(`${proved.length} finding(s) proven fixed (repro test committed, finding gone)`)
          : chalk.yellow("none proven fixed yet")
      }${pending.length > 0 ? chalk.dim(` · ${pending.length} repro test(s) with the finding still open`) : ""}`,
    );
    lines.push("");
    lines.push(chalk.bold("Why:"));
    for (const r of verdict.reasons) lines.push(`  · ${r.startsWith("all checks") ? chalk.green(r) : chalk.yellow(r)}`);
    lines.push("");
    lines.push(chalk.dim("every figure is read from .pitstop/scan-*.json, verify-*.json and the committed pitstop-repro-*.test.* files"));

    const color = verdict.color === "green" ? "green" : "yellow";

    console.log(
      boxen(lines.join("\n"), {
        title: ` PITSTOP — Honesty ${verdict.label.split(" ")[0]} `,
        titleAlignment: "center",
        borderStyle: verdict.color === "green" ? "round" : "double",
        padding: 1,
        borderColor: verdict.color === "red" ? "red" : color,
      }),
    );

    if (options.html) {
      const accent = gradeHex(sc.grade);
      const badge = `background:${accent};color:#0d1117;font-weight:800;font-size:56px;padding:18px 30px;border-radius:16px`;
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PITSTOP — Honesty report for ${escapeHtml(repo)}</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:48px 24px}
  .wrap{max-width:760px;margin:0 auto}
  h1{font-size:22px;margin-bottom:4px}
  .sub{color:#8b949e;font-size:13px;margin-bottom:28px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:24px;margin-bottom:18px}
  .verdict{font-size:28px;font-weight:800;color:${verdict.color === "green" ? "#3fb950" : verdict.color === "yellow" ? "#d29922" : "#f85149"};margin-bottom:10px}
  .scoreline{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
  .score{${badge}}
  .meta{color:#8b949e;font-size:14px;line-height:1.7}
  .meta b{color:#e6edf3}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:0.4px}
  .ok{color:#3fb950;font-weight:600}
  .warn{color:#d29922;font-weight:600}
  .bad{color:#f85149;font-weight:600}
  ul{list-style:none;padding:0}
  li{padding:7px 0;border-bottom:1px solid #21262d;font-size:14px}
  li:last-child{border-bottom:none}
  .footer{color:#8b949e;font-size:12px;margin-top:28px;text-align:center}
  code{background:#21262d;padding:1px 6px;border-radius:5px;font-size:12px}
</style>
</head>
<body><div class="wrap">
  <h1>PITSTOP — AI Honesty Report</h1>
  <p class="sub">${escapeHtml(repo)} · generated ${escapeHtml(model.generatedAt.slice(0, 19).replace("T", " "))} · ${hist.scans.length} scan(s), ${hist.verifies.length} verify(ies)</p>

  <div class="card">
    <div class="verdict">${escapeHtml(verdict.label)}</div>
    <div class="scoreline">
      <div class="score">${sc.score}/100</div>
      <div class="meta">
        <div>grade <b>${sc.grade}</b></div>
        ${model.latestVerify?.score ? `<div>verify delta <b>${model.latestVerify.score.delta > 0 ? "+" : ""}${model.latestVerify.score.delta} pts</b> · risk <b>${model.latestVerify.risk}</b></div>` : ""}
        <div>evidence chain: <b>${ev.status === "verified" ? "verified" : ev.status}</b></div>
      </div>
    </div>
  </div>

  <div class="card">
    <table>
      <thead><tr><th>Check</th><th>Result</th></tr></thead>
      <tbody>
        <tr><td>Evidence signature</td><td class="${ev.status === "verified" ? "ok" : ev.status === "tampered" ? "bad" : "warn"}">${ev.status === "verified" ? "✓ verified — " + ev.digest.slice(0, 12) + "…" : ev.status === "tampered" ? "✗ TAMPERED" : "untracked (pre-0.6.0)"}</td></tr>
        <tr><td>Integrity gate checks</td><td>${integ?.checks ?? 0}</td></tr>
        <tr><td>Cheat attempts caught</td><td class="${confirmedCheats > 0 ? "bad" : integ && integ.catches > 0 ? "warn" : "ok"}">${integ?.catches ?? 0}${confirmedCheats > 0 ? " · CONFIRMED_CHEAT on record" : ""}</td></tr>
        <tr><td>Self-corrected by the loop</td><td class="ok">${integ?.selfCorrected ?? 0}</td></tr>
        <tr><td>Findings proven fixed</td><td class="${proved.length > 0 ? "ok" : "warn"}">${proved.length}${pending.length > 0 ? ` · ${pending.length} repro test(s) with finding still open` : ""}</td></tr>
        <tr><td>Committed repro tests</td><td>${proofs.length}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2 style="font-size:15px;margin-bottom:10px">Why this verdict</h2>
    <ul>${verdict.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
  </div>

  <div class="footer">Every figure read from .pitstop/scan-*.json, .pitstop/verify-*.json and the committed pitstop-repro-*.test.* files · sealed with pitstop-sha256-canonical-v1</div>
</div></body></html>`;
      const out = path.join(repo, "PITSTOP_HONESTY.html");
      fs.writeFileSync(out, html);
      console.log(chalk.dim(`\nCertificate written to ${out}\n`));
    }
  });