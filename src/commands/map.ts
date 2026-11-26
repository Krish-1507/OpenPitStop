import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { analyzeLanguages } from "../languages/index.js";
import { buildAttackSurface, type AttackSurfaceMap } from "../languages/map.js";

export function renderAttackSurface(map: AttackSurfaceMap): string {
  const lines: string[] = [];
  lines.push(chalk.bold("OpenPitStop attack surface map"));
  lines.push(chalk.dim(path.relative(process.cwd(), map.repo) || "."));
  lines.push("");
  lines.push(`${chalk.bold("Routes")} (${map.routes.length} candidate${map.routes.length === 1 ? "" : "s"})`);
  if (map.routes.length === 0) lines.push(chalk.dim("  none discovered from parsed sources"));
  for (const route of map.routes.slice(0, 80)) {
    const flag = route.privileged ? chalk.yellow(" privileged-candidate") : "";
    lines.push(`  ${route.method.padEnd(6)} ${route.path}${flag} — ${route.file}:${route.line}`);
  }
  if (map.routes.length > 80) lines.push(chalk.dim(`  … ${map.routes.length - 80} more`));
  lines.push("");

  lines.push(`${chalk.bold("Entry points")}`);
  lines.push(map.entryPoints.length ? map.entryPoints.map((entry) => `  ${entry}`).join("\n") : chalk.dim("  none discovered"));
  lines.push("");

  lines.push(`${chalk.bold("Authentication / authorization candidates")}`);
  lines.push(map.authenticationFiles.length ? map.authenticationFiles.map((file) => `  ${file}`).join("\n") : chalk.dim("  none found by path evidence"));
  lines.push("");

  lines.push(`${chalk.bold("Data-access candidates")}`);
  lines.push(map.dataAccessFiles.length ? map.dataAccessFiles.map((file) => `  ${file}`).join("\n") : chalk.dim("  none found by path evidence"));
  lines.push("");

  if (map.infrastructure.length) {
    lines.push(`${chalk.bold("Infrastructure")}`);
    for (const item of map.infrastructure) {
      lines.push(`  ${item.displayName}: ${item.files.slice(0, 5).join(", ")}${item.files.length > 5 ? ", …" : ""}`);
    }
    lines.push("");
  }

  lines.push(chalk.dim("Limits:"));
  for (const limit of map.limits) lines.push(chalk.dim(`  - ${limit}`));
  return lines.join("\n");
}

export const map = new Command("map")
  .description("map public route, entry-point and auth/data candidates from parsed sources")
  .argument("[repo]", "repository path", ".")
  .option("--json", "machine-readable attack-surface map")
  .action(async (repoArg: string, opts: { json?: boolean }) => {
    const analysis = await analyzeLanguages(path.resolve(repoArg));
    const surface = buildAttackSurface(analysis);
    if (opts.json) {
      console.log(JSON.stringify(surface, null, 2));
      return;
    }
    console.log(renderAttackSurface(surface));
  });
