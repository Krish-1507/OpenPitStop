import { Command } from "commander";
import chalk from "chalk";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `pitstop prompt` — transparency: print the exact `/pitstop` prompt your AI
 * tool will receive, with the user's invocation arguments substituted. Some
 * tools show the raw prompt in their UI, some don't; this command guarantees
 * the user can always see exactly what the agent was told.
 */

function templatePath(): string {
  return fileURLToPath(new URL("../../templates/pitstop.prompt.md", import.meta.url));
}

export const prompt = new Command("prompt")
  .description("Print the exact /pitstop prompt your AI tool receives, with arguments substituted")
  .option("--args <text>", "invocation arguments to substitute into $ARGUMENTS", "")
  .option("--out <path>", "write the rendered prompt to a file instead of stdout")
  .action((options: { args: string; out?: string }) => {
    const p = templatePath();
    if (!fs.existsSync(p)) {
      console.log(chalk.red(`template not found at ${p} — this build has no templates/pitstop.prompt.md`));
      return;
    }
    let rendered = fs.readFileSync(p, "utf8").replace(/\$ARGUMENTS/g, options.args ?? "");

    const header =
      `# Rendered /pitstop prompt (arguments: "${options.args ?? ""}")\n` +
      `# This is exactly what your AI tool expands /pitstop to and sends to the agent.\n\n`;

    if (options.out) {
      const outPath = options.out;
      rendered = `<!-- Rendered by \`pitstop prompt --args "${options.args ?? ""}"\` -->\n` + rendered;
      fs.writeFileSync(outPath, rendered);
      console.log(chalk.dim(`rendered prompt written to ${outPath}\n`));
      return;
    }

    process.stdout.write(header);
    process.stdout.write(rendered);
  });
