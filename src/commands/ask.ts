import { Command } from "commander";
import chalk from "chalk";
import boxen from "boxen";
import { matchIntent } from "../intent.js";
import { brandHeader } from "../brand.js";

/**
 * `pitstop ask` — natural-language entry point. Tell it what you want in plain
 * English ("make this safe", "why is my score low") and it resolves to the
 * exact `pitstop` command, then prints a copy-paste block to run it.
 *
 * The slash-command templates route free-text `/pitstop <anything>` here so
 * users never need to remember command names.
 */
export const askCmd = new Command("ask")
  .description(
    "Natural-language router: resolve a plain-English request to the right pitstop command. " +
      'e.g. `pitstop ask "make this safe"` → `pitstop fix`.',
  )
  .argument("<text...>", "what you want, in plain English")
  .option("--json", "print machine-readable JSON")
  .action((textArg: string[], options: { json?: boolean }) => {
    const text = textArg.join(" ");
    const match = matchIntent(text);

    if (options.json) {
      console.log(JSON.stringify({ text, ...(match ?? { command: null, label: null }) }, null, 2));
      return;
    }

    console.log(brandHeader());
    if (!match) {
      console.log(
        boxen(
          chalk.yellow("I couldn't map that to a command yet.\n\n") +
            chalk.dim("Try one of: ") +
            "\n  " +
            chalk.cyan("pitstop ask \"make this safe\"") +
            "\n  " +
            chalk.cyan("pitstop ask \"why is my score low\"") +
            "\n  " +
            chalk.cyan("pitstop ask \"what's next\"") +
            "\n  " +
            chalk.cyan("pitstop ask \"is it verified\"") +
            "\n  " +
            chalk.cyan("pitstop menu") +
            " — see every action",
          { title: " PITSTOP — Ask ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "yellow" },
        ),
      );
      return;
    }

    console.log(
      boxen(
        `${chalk.bold("Understood: ")}${match.label}\n\n` +
          `${chalk.bold("Run:")} ${chalk.cyan(match.command)}\n`,
        { title: " PITSTOP — Ask ", titleAlignment: "center", borderStyle: "round", padding: 1, borderColor: "green" },
      ),
    );
    console.log(chalk.dim("Run it:") + "\n```bash\n" + match.command + "\n```");
  });

export default askCmd;
