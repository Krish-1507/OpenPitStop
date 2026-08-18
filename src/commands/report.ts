import { Command } from "commander";
import path from "node:path";
import fs from "node:fs";
import chalk from "chalk";
import { buildModel, renderTerminal, renderMarkdown, renderHtml, renderProofBadgeSvg } from "../report/format.js";
import { computeScore, renderBadgeSvg } from "../report/score.js";
import { buildSarif } from "../report/sarif.js";

export const report = new Command("report")
  .description("Generate a repository analysis report from scan/verify history")
  .argument("[repo]", "path to the repo to report on", ".")
  .option("--html", "also write a self-contained PITSTOP_REPORT.html (zero external assets)")
  .option("--sarif", "also write PITSTOP_REPORT.sarif — upload to GitHub code scanning (Security tab)")
  .option(
    "--badge-json",
    "also write PITSTOP_BADGE.json — a shields.io `endpoint`-schema badge you can host " +
      "(https://img.shields.io/endpoint?url=<hosted.json>)",
  )
  .action(async (repoArg: string, options: { html?: boolean; sarif?: boolean; badgeJson?: boolean }) => {
    const repo = path.resolve(repoArg);
    console.log(chalk.cyan(`\nGenerating report for ${repo} ...\n`));

    const model = buildModel(repo);
    console.log(renderTerminal(model));

    const md = renderMarkdown(model);
    const mdPath = path.join(repo, "PITSTOP_REPORT.md");
    fs.writeFileSync(mdPath, md);

    if (model.latestScan) {
      const sc = computeScore(model.latestScan);
      const badgePath = path.join(repo, "PITSTOP_BADGE.svg");
      fs.writeFileSync(badgePath, renderBadgeSvg(sc));
      console.log(
        chalk.dim(`\nBadge (README-ready) written to ${badgePath}\n`) +
          chalk.dim(`   embed with: ![OpenPitStop score](PITSTOP_BADGE.svg)\n`),
      );
      if (options.badgeJson) {
        const payload = {
          schemaVersion: 1,
          label: "pitstop",
          message: `${sc.score}/100 ${sc.grade}`,
          color: sc.grade[0] === "A" ? "brightgreen" : sc.grade[0] === "B" ? "green" : sc.grade[0] === "C" ? "yellow" : "red",
          cacheSeconds: 3600,
        };
        const jsonPath = path.join(repo, "PITSTOP_BADGE.json");
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n");
        console.log(
          chalk.dim(`Shield badge JSON written to ${jsonPath}\n`) +
            chalk.dim(`   host it and use: https://img.shields.io/endpoint?url=<url>/PITSTOP_BADGE.json\n`),
        );
      }
    }

    // Proof-coverage badge — the "we prove, not just report" signal for README/CI.
    if (model.proofCoverage?.hasPen) {
      const proofBadge = path.join(repo, "PITSTOP_PROOF.svg");
      fs.writeFileSync(proofBadge, renderProofBadgeSvg(model.proofCoverage.pct));
      console.log(
        chalk.dim(`Proof-coverage badge written to ${proofBadge}`) +
          chalk.dim(` — embed: ![OpenPitStop proof](PITSTOP_PROOF.svg)\n`),
      );
    }

    console.log(chalk.dim(`\nReport written to ${mdPath}\n`));

    if (options.sarif) {
      const sarif = buildSarif(repo, model);
      const sarifPath = path.join(repo, "PITSTOP_REPORT.sarif");
      fs.writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
      console.log(
        chalk.dim(`SARIF written to ${sarifPath}`) +
          chalk.dim(` — upload to GitHub: gh api /repos/<owner>/<repo>/code-scanning/sarifs\n`),
      );
    }

    if (options.html) {
      const htmlPath = path.join(repo, "PITSTOP_REPORT.html");
      fs.writeFileSync(htmlPath, renderHtml(model));
      console.log(chalk.dim(`HTML report written to ${htmlPath}\n`));
    }
  });
