import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import { exec } from "node:child_process";
import chalk from "chalk";
import { buildModel, escapeHtml, loadHistory, svgTrend } from "../report/format.js";
import { computeScore, gradeHex, renderBadgeSvg } from "../report/score.js";
import { checkEvidence } from "../evidence.js";
import { enumerateFindings, type ReproFinding } from "../repro/ids.js";
import type { ScanResult } from "../analyzers/types.js";

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, warning: 4 };

/**
 * `pitstop share` — the viral artifact: a 1200×630 self-contained HTML card
 * (inline CSS + inline SVG, zero external assets) built to be screenshotted and
 * posted on X/LinkedIn. Opens in the browser with `--open`.
 */

function topFindings(latest: ScanResult | null): ReproFinding[] {
  if (!latest) return [];
  return enumerateFindings(latest)
    .sort(
      (a, b) =>
        (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9) ||
        a.type.localeCompare(b.type),
    )
    .slice(0, 4);
}

function chip(hex: string, text: string): string {
  return `<span style="display:inline-block;background:${hex}1f;color:${hex};border:1px solid ${hex}66;border-radius:999px;padding:3px 12px;font-size:13px;font-weight:600;margin:3px 6px 0 0">${escapeHtml(text)}</span>`;
}

function renderShareHtml(args: {
  repo: string;
  generatedAt: string;
  score: { score: number; grade: string } | null;
  scansCount: number;
  sparkline: string;
  chips: string;
  findings: ReproFinding[];
  proofCount: number;
}): string {
  const sc = args.score;
  const accent = sc ? gradeHex(sc.grade) : "#58a6ff";
  const findingsRows =
    args.findings.length === 0
      ? `<div class="muted" style="font-size:15px">No findings in the latest scan — clean repo.</div>`
      : args.findings
          .map((f) => {
            const dot =
              f.severity === "critical" || f.severity === "high"
                ? "#f85149"
                : f.severity === "medium"
                  ? "#d29922"
                  : "#58a6ff";
            return `<div class="finding"><span class="dot" style="background:${dot}"></span><span class="fsrc">${escapeHtml(f.source)}</span><span class="fdesc">${escapeHtml(f.description)}</span></div>`;
          })
          .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PITSTOP — ${escapeHtml(args.repo)}</title>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="og:title" content="OpenPitStop scored ${escapeHtml(args.repo)} — ${sc ? sc.score + "/100 (" + sc.grade + ")" : "no scan yet"}"/>
<meta name="og:description" content="OpenPitStop scans repos, gates AI agents, and seals every report with a tamper-evident signature. npx openpitstop try"/>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1200px;height:630px;overflow:hidden}
  body{background:#0d1117;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{width:1200px;height:630px;display:flex;flex-direction:column;padding:44px 52px 34px;position:relative;background:radial-gradient(1200px 420px at 88% -8%, ${accent}1c, transparent 60%)}
  header{display:flex;align-items:center;gap:20px}
  .mark{font-size:27px;font-weight:800;letter-spacing:0.5px;flex:0 0 auto}
  .mark b{color:${accent}}
  .repo{color:#8b949e;font-size:16px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .when{color:#8b949e;font-size:13px;flex:0 0 auto}
  main{flex:1;display:flex;gap:64px;align-items:center;margin-top:22px}
  .left{flex:0 0 300px}
  .score{font-size:150px;font-weight:800;line-height:1;color:${accent};font-variant-numeric:tabular-nums}
  .score small{font-size:34px;font-weight:600;color:#8b949e}
  .grd{font-size:40px;font-weight:800;color:${accent};margin-top:8px}
  .sub{color:#8b949e;font-size:15px;margin-top:10px}
  .right{flex:1;min-width:0}
  .chips{display:flex;flex-wrap:wrap}
  .trend{margin-top:16px;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:14px 16px}
  .trend h4{color:#8b949e;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px}
  .findings{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin-top:14px}
  .findings h4{color:#8b949e;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px}
  .finding{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:15px}
  .finding + .finding{border-top:1px solid #21262d}
  .dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
  .fsrc{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:0.4px;flex:0 0 72px}
  .fdesc{color:#e6edf3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  footer{margin-top:22px;padding-top:16px;border-top:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;color:#8b949e;font-size:13px}
  footer b{color:${accent}}
  .muted{color:#8b949e}
</style>
</head>
<body><div class="wrap">
  <header>
    <div class="mark">PITSTOP</div>
    <div class="repo" title="${escapeHtml(args.repo)}">${escapeHtml(args.repo)}</div>
    <div class="when">${escapeHtml(args.generatedAt.slice(0, 19).replace("T", " "))}</div>
  </header>
  <main>
    <div class="left">
      ${sc ? `<div class="score">${sc.score}<small>/100</small></div><div class="grd">${escapeHtml(sc.grade)}</div>` : `<div class="score" style="font-size:52px">no scan</div><div class="grd">—</div>`}
      <div class="sub">OpenPitStop Score · health of the repo</div>
    </div>
    <div class="right">
      <div class="chips">${args.chips}</div>
      <div class="trend"><h4>Score across ${args.scansCount} scan(s)</h4>${args.sparkline}</div>
      <div class="findings"><h4>Top findings</h4>${findingsRows}</div>
    </div>
  </main>
  <footer>
    <span>npx openpitstop try · scan / verify / gate / digest</span>
    <span>permanent proof: <b>${args.proofCount}</b> committed repro test(s)</span>
  </footer>
</div></body></html>`;
}

export const share = new Command("share")
  .description(
    "Generate a 1200×630 self-contained share card (PITSTOP_CARD.html) with the OpenPitStop Score, " +
      "integrity/evidence status and top findings — built to be screenshotted and posted.",
  )
  .argument("[repo]", "path to the repo (default: current dir)", ".")
  .option("-o, --open", "open the card in the default browser", false)
  .action((repoArg: string, options: { open?: boolean }) => {
    const repo = path.resolve(repoArg);
    const model = buildModel(repo);
    const hist = loadHistory(repo);

    if (hist.scans.length === 0) {
      console.log(
        chalk.yellow(
          `no scan history in ${path.join(repo, ".pitstop")} — run \`pitstop try\` or \`pitstop scan\` first.`,
        ),
      );
      return;
    }

    const sc = model.latestScan ? computeScore(model.latestScan) : null;
    const accent = sc ? gradeHex(sc.grade) : "#58a6ff";
    const scores = hist.scans.map((s) => computeScore(s).score);
    const spark = svgTrend(scores, "#58a6ff");

    const latestEv = model.latestScan ? checkEvidence(model.latestScan) : null;
    const evStatus =
      latestEv?.status === "verified"
        ? `signed ${latestEv.digest.slice(0, 8)}…`
        : latestEv?.status === "tampered"
          ? "evidence TAMPERED"
          : "evidence untracked";

    const chips: string[] = [];
    chips.push(`${sc?.score ?? 0}/100 ${sc?.grade ?? "?"}`);
    chips.push(
      model.integrity
        ? `integrity ${model.integrity.catches} catch · ${model.integrity.selfCorrected} self-corrected`
        : "integrity not checked",
    );
    chips.push(evStatus);

    const findings = topFindings(model.latestScan);
    const badgeSvg = sc ? renderBadgeSvg(sc) : "";

    const html = renderShareHtml({
      repo,
      generatedAt: model.generatedAt,
      score: sc ? { score: sc.score, grade: sc.grade } : null,
      scansCount: hist.scans.length,
      sparkline: spark,
      chips: chips.map((c) => chip(accent, c)).join(""),
      findings,
      proofCount: model.proofs.length,
    });

    const out = path.join(repo, "PITSTOP_CARD.html");
    fs.writeFileSync(out, html);
    console.log(chalk.cyan(`\nShare card written to ${out}`));
    console.log(
      chalk.dim(`   open it, screenshot at 1200×630, post it. Fully self-contained.\n`) +
        (badgeSvg ? chalk.dim(`   README badge also renders: ${chalk.cyan("[OpenPitStop score](PITSTOP_BADGE.svg)")}\n`) : ""),
    );
    if (options.open) {
      const cmd =
        process.platform === "win32"
          ? `start "" "${out}"`
          : process.platform === "darwin"
            ? `open "${out}"`
            : `xdg-open "${out}"`;
      exec(cmd);
      console.log(chalk.dim("   opened in your default browser."));
    }
  });