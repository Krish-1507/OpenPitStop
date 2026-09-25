import { candidateRun } from "../candidate.js";
import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import { analyzeStatic } from "../pen/static.js";
import { runDynamic } from "../pen/dynamic.js";
import { applyStaticProof } from "../pen/proof.js";
import { loadPenLatest, persistPen } from "../pen/store.js";
import { computePenDrift } from "../pen/drift.js";
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
async function runPenImpl(repo: string, opts: PenOptions): Promise<PenResult> {
  const staticOutcome = analyzeStatic(repo);

  // Previous sealed run, for drift detection (read before we overwrite it).
  const prev = loadPenLatest(repo);

  const staticFindings: PenFinding[] = [...staticOutcome.findings];

  let dynamicEnabled = !opts.staticOnly;
  let staticProof: PenResult["staticProof"] | undefined;
  let dynamic: PenResult["dynamic"] = {
    status: opts.staticOnly ? "skipped" : "ok",
    note: opts.staticOnly ? "static-only requested; no app was started" : undefined,
    routesProbed: 0,
    attacks: 0,
    bootMs: 0,
    durationMs: 0,
    outboundEvents: 0,
  };

  // Friendly early abort: nothing to boot, nothing to attack. This is a
  // "pen cannot meaningfully run here" exit (2), not a finding.
  const hasApp =
    fs.existsSync(path.join(repo, "package.json")) &&
    (() => {
      try {
        return Boolean(
          JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).scripts?.start,
        );
      } catch {
        return false;
      }
    })();
  if (dynamicEnabled && !hasApp && !process.env.PITSTOP_START && staticOutcome.routes.length === 0) {
    const d: PenResult["dynamic"] = {
      status: "aborted",
      note: "no app to attack — no `start` script and no routes found",
      routesProbed: 0,
      attacks: 0,
      bootMs: 0,
      durationMs: 0,
      outboundEvents: 0,
    };
    const result: PenResult = {
      timestamp: new Date().toISOString(),
      repo,
      mode: "pen",
      staticEnabled: true,
      dynamicEnabled: true,
      dynamic: d,
      staticProof: applyStaticProof(staticFindings, { status: "aborted", note: d.note, findings: [] }).summary,
      packages: staticOutcome.packages,
      findings: applyStaticProof(staticFindings, { status: "aborted", note: d.note, findings: [] }).findings,
      summary: summarizeFindings(staticFindings),
    };
    return result;
  }

  const findings: PenFinding[] = [];
  if (dynamicEnabled) {
    const spin = opts.json ? null : createSpinner(
      `Booting the app under the pen sandbox and attacking ${staticOutcome.routes.length} route(s)…`,
    );
    try {
      const d = await runDynamic(repo, staticOutcome.routes);
      if (d.status === "aborted") {
        spin?.warn(`Dynamic phase aborted — ${d.note ?? "app did not respond"}`);
      } else {
        spin?.succeed(`Dynamic phase done — ${d.routesProbed} routes, ${d.attacks} attacks`);
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
      spin?.fail("Dynamic phase failed");
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

  // Drift vs the previously sealed run — only when the two runs are comparable
  // (same dynamic phase status), so an aborted run never fabricates resolutions.
  const comparable = prev && prev.dynamic && dynamic.status === prev.dynamic.status;
  const drift = comparable ? computePenDrift(prev!.findings, findings, prev!.timestamp) : undefined;

  return {
    timestamp: new Date().toISOString(),
    repo,
    mode: "pen",
    staticEnabled: true,
    dynamicEnabled,
    dynamic,
    staticProof,
    drift,
    packages: staticOutcome.packages,
    findings,
    summary: summarizeFindings(findings),
  };
}

export function penExitCode(result: PenResult): number {
  if (result.summary.critical + result.summary.high > 0 || result.drift?.regression) return 1;
  if (result.dynamicEnabled && result.dynamic.status !== "ok") return 2;
  return 0;
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
            "  Live attacks run in a disposable Docker container with external networking disabled.\n" +
              "  The app receives a sanitized copy; host credentials and source write access are excluded.\n",
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
    process.exitCode = penExitCode(result);

    const md = renderPenMarkdown(result);
    fs.writeFileSync(path.join(repo, "PITSTOP_PEN_REPORT.md"), md, "utf8");
    if (options.html) {
      fs.writeFileSync(path.join(repo, "PITSTOP_PEN_REPORT.html"), renderPenHtml(result), "utf8");
    }

    const fixes = options.fix ? runFixes(repo, result, result.packages) : undefined;
    if (fixes) fs.writeFileSync(path.join(repo, "PITSTOP_PEN_FIXES.md"), fixes.fixesMd, "utf8");

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

    if (fixes) {
      const outcome = fixes;
      console.log(chalk.green(`\n--fix: wrote ${outcome.repros.length} repro test(s), ${outcome.patches.length} patch(es)`));
      for (const r of outcome.repros) {
        console.log(chalk.dim(`  repro: ${r.file} (fails now → passes after the fix)`));
      }
      for (const p of outcome.patches) {
        console.log(chalk.dim(`  patch: git apply ${p.diffPath} — ${p.note}`));
      }
      console.log(chalk.dim(`  plan: ${path.join(repo, "PITSTOP_PEN_FIXES.md")}`));
    }

    if (result.drift) {
      const d = result.drift;
      const parts: string[] = [];
      if (d.new.length) parts.push(`${d.new.length} NEW${d.regression ? " (regression)" : ""}`);
      if (d.resolved.length) parts.push(`${d.resolved.length} resolved`);
      if (d.escalations.length) parts.push(`${d.escalations.length} escalated`);
      if (parts.length) {
        console.log(
          chalk.dim(
            `Drift vs last run${d.baselineTimestamp ? ` (${d.baselineTimestamp})` : ""}: ${parts.join(" · ")}`,
          ),
        );
      } else {
        console.log(chalk.dim("Drift vs last run: no change"));
      }
    }
  });

export default pen;

export function runPen(...args: Parameters<typeof runPenImpl>): ReturnType<typeof runPenImpl> {
  return candidateRun(args[0], () => runPenImpl(...args));
}
