import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import { analyzeLanguages } from "../languages/index.js";
import { buildAttackSurface, type AttackSurfaceMap } from "../languages/map.js";
import { buildArchitectureMap, type ArchitectureMap } from "../architecture/map.js";

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

export function renderArchitectureMap(map: ArchitectureMap): string {
  const lines: string[] = [];
  lines.push(chalk.bold("OpenPitStop architecture map"));
  lines.push(chalk.dim(path.relative(process.cwd(), map.repo) || "."));
  lines.push("");
  lines.push(`${chalk.bold("Modules")} (${map.modules.length})`);
  for (const module of map.modules.slice(0, 40)) {
    lines.push(`  ${module.path.padEnd(24)} ${chalk.dim(`${module.files} file(s) · ${module.role} · in ${module.inbound} / out ${module.outbound}`)}`);
  }
  if (map.modules.length > 40) lines.push(chalk.dim(`  … ${map.modules.length - 40} more`));
  lines.push("");
  lines.push(`${chalk.bold("Module dependencies")} (${map.dependencies.length})`);
  if (map.dependencies.length === 0) lines.push(chalk.dim("  none resolved from the available import graph"));
  for (const dependency of map.dependencies.slice(0, 60)) {
    lines.push(`  ${dependency.from} → ${dependency.to} ${chalk.dim(`(${dependency.imports} import(s))`)}`);
  }
  if (map.dependencies.length > 60) lines.push(chalk.dim(`  … ${map.dependencies.length - 60} more`));
  lines.push("");
  lines.push(`${chalk.bold("Circular dependencies")} (${map.cycles.length})`);
  if (map.cycles.length === 0) lines.push(chalk.dim("  none discovered"));
  for (const cycle of map.cycles.slice(0, 12)) lines.push(`  ${cycle.join(" → ")}`);
  lines.push("");
  lines.push(`${chalk.bold("Routes")} (${map.routes.length} candidate${map.routes.length === 1 ? "" : "s"})`);
  if (map.routes.length === 0) lines.push(chalk.dim("  none discovered from parsed sources"));
  for (const route of map.routes.slice(0, 80)) {
    lines.push(`  ${route.method.padEnd(6)} ${route.path}${route.privileged ? chalk.yellow(" privileged-candidate") : ""} — ${route.file}:${route.line}`);
  }
  if (map.routes.length > 80) lines.push(chalk.dim(`  … ${map.routes.length - 80} more`));
  lines.push("");
  lines.push(chalk.bold("Entry points"));
  lines.push(map.entryPoints.length ? map.entryPoints.map((entry) => `  ${entry}`).join("\n") : chalk.dim("  none discovered"));
  lines.push("");
  lines.push(`${chalk.bold("External services")} (declared dependencies)`);
  if (map.externalServices.length === 0) lines.push(chalk.dim("  none identified from dependency manifests"));
  for (const service of map.externalServices) {
    lines.push(`  ${service.displayName}: ${service.evidence.join(", ")} ${chalk.dim(`(${service.files.join(", ")})`)}`);
  }
  lines.push("");
  lines.push(`${chalk.bold("Data relationships")} (${map.dataRelationships.length} candidate${map.dataRelationships.length === 1 ? "" : "s"})`);
  if (map.dataRelationships.length === 0) lines.push(chalk.dim("  none found in schema/ORM/SQL declarations"));
  for (const relationship of map.dataRelationships.slice(0, 40)) {
    lines.push(`  ${relationship.from} → ${relationship.to} ${chalk.dim(`(${relationship.kind}, ${relationship.file}:${relationship.line})`)}`);
  }
  if (map.dataRelationships.length > 40) lines.push(chalk.dim(`  … ${map.dataRelationships.length - 40} more`));
  lines.push("");
  lines.push(`${chalk.bold("Data flows")} (${map.dataFlows.length} import-path candidate${map.dataFlows.length === 1 ? "" : "s"})`);
  if (map.dataFlows.length === 0) lines.push(chalk.dim("  none found from route files to data-access files"));
  for (const flow of map.dataFlows.slice(0, 40)) {
    lines.push(`  ${flow.from} → ${flow.to} ${chalk.dim(`via ${flow.via}`)}`);
  }
  lines.push("");
  lines.push(`${chalk.bold("Architecture boundaries")} (${map.boundaries.configured} configured rule(s))`);
  if (map.boundaries.configured === 0) lines.push(chalk.dim("  no architecture config — no boundary conclusion"));
  else if (map.boundaries.violations.length === 0) lines.push(chalk.dim("  no static import violations found"));
  else for (const violation of map.boundaries.violations.slice(0, 30)) {
    lines.push(`  ${violation.from} → ${violation.to} ${chalk.yellow(`(${violation.target})`)}${violation.reason ? chalk.dim(` — ${violation.reason}`) : ""}`);
  }
  lines.push("");
  lines.push(chalk.dim("Limits:"));
  for (const limit of map.limits) lines.push(chalk.dim(`  - ${limit}`));
  return lines.join("\n");
}

export const map = new Command("map")
  .description("map the attack surface or the architecture from parsed sources and the dependency graph")
  .argument("[repo]", "repository path", ".")
  .option("--architecture", "show modules, dependencies, cycles, services, data relationships and boundaries")
  .option("--json", "machine-readable map")
  .action(async (repoArg: string, opts: { json?: boolean; architecture?: boolean }) => {
    const repo = path.resolve(repoArg);
    if (opts.architecture) {
      const architecture = await buildArchitectureMap(repo);
      if (opts.json) {
        console.log(JSON.stringify(architecture, null, 2));
        return;
      }
      console.log(renderArchitectureMap(architecture));
      return;
    }
    const analysis = await analyzeLanguages(repo);
    const surface = buildAttackSurface(analysis);
    if (opts.json) {
      console.log(JSON.stringify(surface, null, 2));
      return;
    }
    console.log(renderAttackSurface(surface));
  });
