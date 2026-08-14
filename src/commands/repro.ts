import { Command } from "commander";
import path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import { repro } from "../repro/index.js";

export const reproCmd = new Command("repro")
  .description(
    "Generate and run a permanent repro test for a finding id from scan-latest.json: " +
      "it must FAIL while the bug is present and PASS only after the fix.",
  )
  .argument("<finding-id>", "finding id shown in the scan box / scan-latest.json")
  .argument("[repo]", "path to the repo", ".")
  .option("-w, --write-only", "write the repro test but do not run it")
  .action(
    async (findingId: string, repoArg: string, options: { writeOnly?: boolean }) => {
      const repo = path.resolve(repoArg);
      const result = await repro(repo, findingId, { writeOnly: options.writeOnly });

      switch (result.status) {
        case "no-scan":
        case "not-found":
          console.log(chalk.yellow(`\n${result.reason}\n`));
          return;
        case "refused":
          console.log(
            boxen(
              `pitstop repro ${findingId}\n\n${chalk.yellow("Not generated:")}\n${result.reason}`,
              {
                title: " PITSTOP — Repro Refused (honest, not fabricated) ",
                titleAlignment: "center",
                borderStyle: "round",
                padding: 1,
                borderColor: "yellow",
              },
            ),
          );
          return;
        case "generated":
          console.log(
            chalk.green(`\nWrote repro test ${chalk.bold(result.file)} (not run — --write-only)\n`),
          );
          return;
        case "generated-and-ran": {
          const r = result.ran!;
          const pass = r.passed;
          const paint = pass ? chalk.green : chalk.red;
          const borderColor = pass ? "green" : "red";
          const verdict = pass ? "PASS — bug not reproduced (hypothesis unproven)" : "FAIL — bug reproduced";
          console.log(
            boxen(
              `pitstop repro ${result.findingId}\n\n` +
                `Test file: ${chalk.bold(result.file)}\n` +
                `Framework: ${r.framework ?? "unknown"}${r.timedOut ? " (timed out)" : ""}\n\n` +
                `${paint(verdict)}\n\n` +
                (pass
                  ? "The repro did NOT fail. Under the new contract this means the hypothesis is\n" +
                    "unproven — stop and re-diagnose instead of fixing blind."
                  : "The repro FAILED, so the bug is real and captured as a failing test.\n" +
                    "Fix it, then re-run the SAME repro test and confirm it now PASSES.") +
                `\n\n${chalk.dim(r.stdout || r.stderr || "").slice(0, 2000)}`,
              {
                title: ` PITSTOP — Repro ${pass ? "PASS" : "FAIL"} `,
                titleAlignment: "center",
                borderStyle: pass ? "round" : "double",
                padding: 1,
                borderColor,
              },
            ),
          );
          // exit non-zero when the repro failed (i.e. bug is present) so callers/CI can gate on it.
          process.exitCode = pass ? 0 : 1;
          return;
        }
      }
    },
  );

export default reproCmd;