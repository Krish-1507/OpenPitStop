import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import { analyzeStatic } from "../pen/static.js";
import { runDynamic } from "../pen/dynamic.js";
import { applyStaticProof } from "../pen/proof.js";
import { persistPen } from "../pen/store.js";
import { runFixes } from "../pen/fix.js";
import { renderPenBox, renderPenMarkdown, renderPenHtml } from "../pen/report.js";
import { summarizeFindings, type PenFinding, type PenResult } from "../pen/types.js";
import { createSpinner } from "../ui/spinner.js";

export interface PenOptions {
  staticOnly?: boolean;
  fix?: boolean;
  json?: boolean;
  html?: boolean;
}

/**
 * `pitstop pen` — the headline act. Static pass first (zero setup, no
 * network), then — unless `--static` — a LIVE dynamic pass: the app is booted
 * under the pen sandbox and attacked. Everything is recorded, everything is
 * sealed, and `--fix` turns every replayable finding into a regression test.
 */
export async function runPen(repo: string, opts: PenOptions): Promise<PenResult> {
  const staticStart = Date.now();
  const staticOutcome = analyzeStatic(repo);
  const staticMs = Date.now() - staticStart;

  const staticFindings: PenFinding[] = [...staticOutcome.findings];

  let dynamicEnabled = !opts.staticOnly;
  let staticProof: PenResult["staticProof"] | undefined;
  let dynamic: PenResult["dynamic"] = {
    status: "ok",
    note: undefined,
    routesProbed: 0,
    attacks: 0,
    bootMs: 0,
    durationMs: 0,
    outboundEvents: 0,
  };

  const findings: PenFinding[] = [];
  if (dynamicEnabled) {
    const spin = createSpinner(
      `Booting the app under the pen sandbox and attacking ${staticOutcome.routes.length} route(s)…`,
    );
    try {
      const d = await runDynamic(repo, staticOutcome.routes);
      if (d.status === "aborted") {
        spin.warn(`Dynamic phase aborted — ${d.note ?? "app did not respond"}`);
      } else {
        spin.succeed(`Dynamic phase done — ${d.routesProbed} routes, ${d.attacks} attacks`);
      }
      const proof = applyStaticProof(staticFindings, d);
      findings.push(...proof.findings, ...d.findings);
      staticProof = proof.summary;
      dynamic = {
        status: d.status,
        note: d.note,
        routesProbed: d.routesProbed,
        attacks: d.attacks,
        bootMs: d.bootMs,
        durationMs: d.durationMs,
        outboundEvents: d.outboundEvents,
      };
    } catch (err: any) {
      spin.fail("Dynamic phase failed");
      const d = { status: "aborted" as const, note: (err as Error).message, findings: [] };
      const proof = applyStaticProof(staticFindings, d);
      findings.push(...proof.findings);
      staticProof = proof.summary;
      dynamic = {
        status: "aborted",
        note: (err as Error).message,
        routesProbed: 0,
        attacks: 0,
        bootMs: 0,
        durationMs: 0,
        outboundEvents: 0,
      };
    }
  } else {
    findings.push(...staticFindings);
  }

  return {
    timestamp: new Date().toISOString(),
    repo,
    mode: "pen",
    staticEnabled: true,
    dynamicEnabled,
    dynamic,
    staticProof,
    packages: staticOutcome.packages,
    findings,
    summary: summarizeFindings(findings),
  };
}

export const pen = new Command("pen")
  .description(
    "Penetration test your own app: static heuristics (secrets, taint, config hygiene) plus a LIVE " +
      "dynamic attack phase — the app is booted under a network-interception sandbox and attacked. " +
      "Every finding carries its proof; `--fix` writes failing-then-passing regression tests and safe patches.",
  )
  .argument("[repo]", "path to the repo to pen-test (default: current dir)", ".")
  .option("--static", "static pass only — do NOT boot the app (the dynamic phase is opt-out, not opt-in)")
  .option("--fix", "write repro tests + deterministic patches + PITSTOP_PEN_FIXES.md")
  .option("--html", "also write PITSTOP_PEN_REPORT.html")
  .option("--json", "print the raw pen result as JSON")
  .action(async (repoArg: string, options: { static?: boolean; fix?: boolean; html?: boolean; json?: boolean }) => {
    const repo = path.resolve(repoArg);
    if (!fs.existsSync(repo)) {
      console.log(chalk.red(`repo not found: ${repo}`));
      process.exitCode = 2;
      return;
    }

    if (!options.json) {
      console.log(
        chalk.cyan(
          `\nPen-testing ${repo}${options.static ? " (static pass only)" : ""} ...\n`,
        ),
      );
      if (!options.static) {
        console.log(
          chalk.dim(
            "  The dynamic phase boots the app's `start` script under a sandbox that intercepts all\n" +
              "  outbound HTTP and records every spawn. Nothing reaches the real network. Raw sockets are\n" +
              "  blocked; child processes run and are logged (it is your own start script).\n",
          ),
        );
      }
    }

    const result = await runPen(repo, {
      staticOnly: options.static,
      fix: options.fix,
      json: options.json,
      html: options.html,
    });

    const { file } = persistPen(repo, result);

    const md = renderPenMarkdown(result);
    fs.writeFileSync(path.join(repo, "PITSTOP_PEN_REPORT.md"), md, "utf8");
    if (options.html) {
      fs.writeFileSync(path.join(repo, "PITSTOP_PEN_REPORT.html"), renderPenHtml(result), "utf8");
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(renderPenBox(result));
    console.log(
      chalk.dim(
        `\nEvidence sealed to ${file}\n` +
          `Report: ${path.join(repo, "PITSTOP_PEN_REPORT.md")}` +
          (options.html ? ` · ${path.join(repo, "PITSTOP_PEN_REPORT.html")}` : "") +
          "\n",
      ),
    );

    if (options.fix) {
      const outcome = runFixes(repo, result, result.packages);
      fs.writeFileSync(path.join(repo, "PITSTOP_PEN_FIXES.md"), outcome.fixesMd, "utf8");
      console.log(chalk.green(`\n--fix: wrote ${outcome.repros.length} repro test(s), ${outcome.patches.length} patch(es)`));
      for (const r of outcome.repros) {
        console.log(chalk.dim(`  repro: ${r.file} (fails now → passes after the fix)`));
      }
      for (const p of outcome.patches) {
        console.log(chalk.dim(`  patch: git apply ${p.diffPath} — ${p.note}`));
      }
      console.log(chalk.dim(`  plan: ${path.join(repo, "PITSTOP_PEN_FIXES.md")}`));
    }

    // Exit contract: 0 = no high/critical findings, 1 = high/critical present,
    // 2 = pen could not meaningfully run (dynamic aborted with nothing found).
    if (result.summary.critical + result.summary.high > 0) process.exitCode = 1;
    else if (result.dynamicEnabled && result.dynamic.status === "aborted" && result.findings.length === 0) {
      process.exitCode = 2;
    }
  });

export default pen;
