import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import path from "node:path";
import { runVerifyStack, sealStackResult, type StackLayerKind } from "../verify/stack.js";
import { addEntry } from "../memory/store.js";

export const verifyStack = new Command("verify-stack")
  .description(
    "Run the repo's FULL verification stack — unit / integration / e2e tests, type checks, " +
      "lints, builds — whatever the repo actually has, with a deterministic FAILURE DIAGNOSIS " +
      "per layer (type-error TSxxxx, missing-dependency, assertion-failure, lint rule, " +
      "syntax, timeout, environment). Diagnoses failures so fixes are targeted — never " +
      "random edits until the error disappears. Seals evidence; feeds the gate.",
  )
  .argument("[repo]", "path to the repo", ".")
  .option("--only <layer>", "run only these layers: unit,integration,e2e,typecheck,lint,build", (v: string) => v.split(",").map((s) => s.trim()) as StackLayerKind[])
  .option("--timeout <ms>", "per-layer timeout in ms")
  .option("--json", "machine-readable output")
  .action(async (repoArg: string, opts: any) => {
    const repo = path.resolve(repoArg);
    const result = sealStackResult(
      await runVerifyStack({ repo, only: opts.only, timeoutMs: opts.timeout ? Number(opts.timeout) : undefined }),
    );

    if (opts.json) {
      console.log(JSON.stringify({
        repo: result.repo, verdict: result.verdict,
        layers: result.layers, reasons: result.reasons,
        failedLayers: result.failedLayers, sealedPath: result.sealedPath,
      }, null, 2));
    } else {
      const lines: string[] = [];
      for (const l of result.layers) {
        const mark = l.status === "PASS" ? chalk.green("✓") : l.status === "FAIL" ? chalk.red("✗") : chalk.dim("—");
        const counts = l.counts && l.counts.total > 0 ? chalk.dim(` ${l.counts.passed}/${l.counts.total}`) : "";
        const dur = l.durationMs ? chalk.dim(` ${Math.round(l.durationMs / 100) / 10}s`) : "";
        lines.push(`${mark} ${l.id.padEnd(12)} ${l.status.padEnd(8)}${counts}${dur}${chalk.dim(` ${l.command || l.skipReason || ""}`)}`);
        if (l.status === "FAIL" && l.diagnosis) {
          lines.push(`    ${chalk.yellow("diagnosis:")} ${l.diagnosis.category} — ${l.diagnosis.summary}`);
          if (l.diagnosis.locations.length) lines.push(`    ${chalk.dim("at:")} ${l.diagnosis.locations.slice(0, 5).join(", ")}`);
          if (l.failing?.length) lines.push(`    ${chalk.dim("failing:")} ${l.failing.slice(0, 5).join("; ")}`);
        }
      }
      const vColor = result.verdict === "STACK_PASS" ? "green" : result.verdict === "STACK_FAIL" ? "red" : "yellow";
      lines.push("");
      lines.push(`${chalk.bold("VERDICT:")} ${chalk[vColor as "green"](result.verdict)}`);
      for (const r of result.reasons) lines.push(chalk.dim(`· ${r}`));
      console.log(
        boxen(lines.join("\n"), {
          title: " PITSTOP — VERIFICATION STACK ",
          titleAlignment: "center",
          borderStyle: "double",
          padding: 1,
          borderColor: vColor as any,
        }),
      );
      if (result.sealedPath) console.log(chalk.dim(`\nSealed evidence written to ${result.sealedPath}\n`));
    }

    addEntry(repo, {
      type: "fix",
      summary: `verify-stack: ${result.verdict}`,
      context: result.failedLayers.length ? `failed: ${result.failedLayers.join(", ")}` : "all configured layers pass",
    });

    process.exitCode = result.verdict === "STACK_PASS" ? 0 : result.verdict === "STACK_FAIL" ? 1 : 2;
  });

export default verifyStack;
