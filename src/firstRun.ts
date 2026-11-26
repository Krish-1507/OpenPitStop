import { spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import chalk from "chalk";
import boxen from "boxen";
import { createSpinner } from "./ui/spinner.js";
import { renderCheck, type CheckMode } from "./checks/report.js";
import { readLatestCheck, runCheck } from "./checks/run.js";
import {
  applyInstallPlan,
  buildInstallPlan,
  type InstallPlan,
} from "./installer/transaction.js";
import {
  getSubcommandTargetsFor,
  targetsForAgents,
  type AgentId,
} from "./installer/targets.js";
import {
  detectAgents,
  detectProject,
  type AgentDetection,
  type ProjectDetection,
} from "./onboarding/detect.js";
import {
  isOnboardingComplete,
  loadOnboardingState,
  saveOnboardingState,
} from "./onboarding/state.js";

/**
 * Bare `pitstop` — the guided entry point.
 *
 * It never replaces an existing command: `try`, `scan`, `gate`, `install` and
 * `--help` keep their own behavior. This flow detects the project, offers a
 * scoped agent integration with an exact preview and permission gate, then runs
 * Quick Check, Deep Audit or Ship Check through the same implementations the
 * named commands use.
 *
 * Non-TTY (CI, pipes): prints a short, non-blocking status and exits. No files
 * are written and no prompt is ever left waiting on stdin.
 */

export interface FirstRunOptions {
  setup?: boolean;
  yes?: boolean;
  input?: boolean;
  skipOnboarding?: boolean;
}

/** Run a named command through the same CLI entry point; used for --help. */
function runCli(args: string[]): void {
  const cli = process.argv[1];
  if (!cli) return;
  spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env: { ...process.env } });
}

function banner(): void {
  console.log(
    boxen(
      chalk.bold("OpenPitStop") +
        "\nYour independent engineering and security layer." +
        "\n" +
        chalk.dim("Find what others miss · Fix what matters · Prove it's fixed"),
      { padding: 1, borderStyle: "round", borderColor: "cyan", title: " " },
    ),
  );
}

function projectLines(project: ProjectDetection): string[] {
  const git = project.git.isRepo
    ? `${project.git.branch ?? "detached"}${project.git.hasCommits ? "" : " · no commits yet"}`
    : "no";
  return [
    `${chalk.bold("Project")}: ${project.name}`,
    `${chalk.bold("Location")}: ${chalk.cyan(project.displayPath)}`,
    `${chalk.bold("Project type")}: ${project.type}`,
    `${chalk.bold("Package manager")}: ${project.packageManager}`,
    `${chalk.bold("Git repository")}: ${git}`,
    `${chalk.bold("Languages")}: ${project.languages.join(", ")}`,
    ...(project.frameworks.length > 0 ? [`${chalk.bold("Frameworks")}: ${project.frameworks.join(", ")}`] : []),
  ];
}

function agentLines(agents: AgentDetection[]): string[] {
  if (agents.length === 0) return [chalk.dim("  No supported coding agents detected.")];
  return agents.map((agent) => {
    const mark = agent.installed ? chalk.green("[✓]") : chalk.dim("[ ]");
    const detail = agent.installed
      ? chalk.dim(` — ${agent.evidence.join(", ")}`)
      : chalk.dim(" — not detected");
    const configured = agent.configured ? chalk.green(" · OpenPitStop configured") : "";
    return `  ${mark} ${agent.name}${configured}${detail}`;
  });
}

function printPreview(plan: InstallPlan, agents: AgentDetection[], selected: AgentId[]): void {
  const names = agents.filter((agent) => selected.includes(agent.id)).map((agent) => agent.name);
  console.log(`\n${chalk.bold("Preview")} ${chalk.dim(`(${names.join(", ") || selected.join(", ")})`)}`);
  const entries = plan.entries;
  const created = entries.filter((entry) => entry.action === "create");
  const updated = entries.filter((entry) => entry.action === "update");
  const unchanged = entries.filter((entry) => entry.action === "unchanged");
  const skipped = entries.filter((entry) => entry.action === "skip");
  for (const entry of created) console.log(`  ${chalk.green("+ create")}  ${entry.path} ${chalk.dim(`(${entry.target.tool})`)}`);
  for (const entry of updated) console.log(`  ${chalk.cyan("↻ update")}  ${entry.path} ${chalk.dim(`(${entry.target.tool}; backup kept)`)}`);
  if (unchanged.length > 0) console.log(`  ${chalk.dim(`= ${unchanged.length} file(s) already current`)}`);
  for (const entry of skipped) console.log(`  ${chalk.yellow("⚠ keep")}    ${entry.path} ${chalk.dim(`— ${entry.reason}`)}`);
  console.log(
    chalk.dim(
      `\n${created.length + updated.length} file(s) will change; ${unchanged.length} already current; ${skipped.length} left untouched.`,
    ),
  );
}

async function askChoice(
  rl: readline.Interface,
  question: string,
  choices: Array<[string, string]>,
): Promise<string> {
  while (true) {
    console.log("");
    choices.forEach(([key, description], index) => {
      console.log(`  ${chalk.cyan(String(index + 1))}. ${description} ${chalk.dim(`[${key}]`)}`);
    });
    const raw = (await rl.question(`\n${chalk.bold(question)} `)).trim().toLowerCase();
    if (raw === "q" || raw === "quit" || raw === "exit") return "quit";
    const number = Number(raw);
    if (!Number.isNaN(number) && number >= 1 && number <= choices.length) return choices[number - 1][0];
    if (choices.some(([key]) => key === raw)) return raw;
    console.log(chalk.yellow("  (pick a number, or q to quit)"));
  }
}

async function askYes(rl: readline.Interface, question: string): Promise<boolean> {
  const raw = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  return raw === "y" || raw === "yes";
}

async function runSelectedCheck(mode: CheckMode): Promise<boolean> {
  const label = mode === "quick" ? "Quick Check" : mode === "deep" ? "Deep Audit" : "Ship Check";
  const spin = createSpinner(
    mode === "quick" ? "Understanding the project and running fast checks" : `Running ${label}`,
  );
  try {
    const report = await runCheck(process.cwd(), mode);
    spin.succeed(`${label} complete`);
    console.log(renderCheck(report));
    if (report.evidencePath) console.log(chalk.dim(`\nEvidence: ${report.evidencePath}\n`));
    return true;
  } catch (error) {
    spin.fail(`${label} failed`);
    console.error(chalk.red(`\n${(error as Error).message}\n`));
    return false;
  }
}

async function chooseAgents(
  rl: readline.Interface,
  agents: AgentDetection[],
): Promise<AgentId[]> {
  console.log(`\n${chalk.bold("Choose coding agents")}`);
  agents.forEach((agent, index) => {
    const detected = agent.installed ? chalk.green("detected") : chalk.dim("not detected");
    const configured = agent.configured ? chalk.green(" · configured") : "";
    console.log(`  ${chalk.cyan(String(index + 1))}. ${agent.name} — ${detected}${configured}`);
    if (agent.note) console.log(`     ${chalk.dim(agent.note)}`);
  });
  const raw = (await rl.question("\nEnter numbers separated by commas (or press Enter to skip): ")).trim();
  if (!raw) return [];
  const selected: AgentId[] = [];
  for (const part of raw.split(",").map((value) => value.trim())) {
    const index = Number(part);
    if (!Number.isNaN(index) && index >= 1 && index <= agents.length) selected.push(agents[index - 1].id);
  }
  return [...new Set(selected)];
}

async function setupAgents(
  rl: readline.Interface,
  project: ProjectDetection,
  agents: AgentDetection[],
  preferred: AgentId[] = [],
): Promise<AgentId[]> {
  console.log(`\n${chalk.bold("Connect your coding agents")}`);
  console.log(chalk.dim("OpenPitStop can integrate with your coding agents so they can use it while working on this project."));
  console.log(`\n${chalk.bold("Detected agents:")}`);
  console.log(agentLines(agents).join("\n"));

  const detected = agents.filter((agent) => agent.installed);
  const choices: Array<[string, string]> = [];
  if (detected.length > 0) choices.push(["all", `Add OpenPitStop to all detected agents (${detected.map((agent) => agent.name).join(", ")})`]);
  choices.push(["choose", "Choose which agents to configure"]);
  choices.push(["skip", "Skip for now"]);

  const pick = preferred.length > 0 ? "choose" : await askChoice(rl, "What would you like to do?", choices);
  let selected: AgentId[];
  if (pick === "skip") return [];
  if (pick === "all") selected = detected.map((agent) => agent.id);
  else selected = preferred.length > 0 ? preferred : await chooseAgents(rl, agents);
  if (selected.length === 0) {
    console.log(chalk.dim("\nNo agents selected — nothing was written."));
    return [];
  }

  const mains = targetsForAgents(project.root, selected);
  const subcommands = getSubcommandTargetsFor(mains);
  const plan = buildInstallPlan([...mains, ...subcommands], { overwrite: "managed" });
  const changed = plan.entries.filter((entry) => entry.action === "create" || entry.action === "update");
  printPreview(plan, agents, selected);

  const notes = agents.filter((agent) => selected.includes(agent.id) && agent.note);
  for (const agent of notes) console.log(chalk.dim(`Note: ${agent.name} — ${agent.note}.`));
  if (plan.entries.some((entry) => entry.path.includes(path.join(".codex", "prompts")))) {
    console.log(chalk.dim("Note: Codex App and the Codex VS Code extension do not support custom slash commands yet; Codex CLI can use the installed prompt."));
  }

  if (changed.length === 0) {
    console.log(chalk.green("\nIntegrations are already current — nothing to write."));
    return selected;
  }
  if (!(await askYes(rl, "\nApply these changes?"))) {
    console.log(chalk.dim("No files were written."));
    return [];
  }

  const applied = applyInstallPlan(project.root, plan);
  console.log(chalk.green(`\n✓ ${applied.changed.length} file(s) written.`));
  for (const entry of applied.changed) console.log(`  ${entry.path}`);
  if (applied.skipped.length > 0) {
    console.log(chalk.yellow(`\n${applied.skipped.length} file(s) left untouched because they were not managed by OpenPitStop.`));
  }
  console.log(chalk.dim("\nUndo this integration at any time with: pitstop install --rollback"));
  return selected;
}

async function checkMenu(rl: readline.Interface): Promise<CheckMode | "skip"> {
  console.log(`\n${chalk.bold("Let's understand your project.")}`);
  console.log(chalk.dim("Quick Check is recommended for a first look."));
  const pick = await askChoice(rl, "What would you like OpenPitStop to do?", [
    ["quick", "Quick Check — understand the project and identify obvious problems"],
    ["deep", "Deep Audit — run tests, build and reliability checks too"],
    ["ship", "Ship Check — add typecheck, lint and the strict release gate"],
    ["skip", "Skip for now"],
  ]);
  if (pick === "skip" || pick === "quit") return "skip";
  return pick as CheckMode;
}

async function returningFlow(
  rl: readline.Interface,
  project: ProjectDetection,
  agents: AgentDetection[],
): Promise<void> {
  const latest = readLatestCheck(project.root);
  console.log(`\n${chalk.green("Welcome back.")} ${chalk.dim("Your setup is remembered.")}`);
  console.log(projectLines(project).join("\n"));
  if (latest) {
    console.log(
      chalk.dim(
        `\nLast check: ${latest.mode ?? "unknown"}${latest.score != null ? ` · ${latest.score}/100 (${latest.grade})` : ""}${latest.timestamp ? ` · ${latest.timestamp}` : ""}`,
      ),
    );
  }
  const pick = await askChoice(rl, "What do you want to do?", [
    ["quick", "Quick Check"],
    ["deep", "Deep Audit"],
    ["ship", "Ship Check"],
    ["setup", "Reconfigure coding agents"],
    ["help", "Show the full command list"],
    ["quit", "Exit"],
  ]);
  if (pick === "quit") return;
  if (pick === "help") {
    runCli(["--help"]);
    return;
  }
  if (pick === "setup") {
    const configured = await setupAgents(rl, project, agents);
    const state = loadOnboardingState(project.root);
    saveOnboardingState(project.root, {
      ...state,
      completedAt: state.completedAt ?? new Date().toISOString(),
      configuredAgents: configured.length > 0 ? configured : state.configuredAgents,
      skippedAgentSetup: configured.length === 0,
    });
    return;
  }
  await runSelectedCheck(pick as CheckMode);
}

async function firstRunFlow(
  rl: readline.Interface,
  project: ProjectDetection,
  agents: AgentDetection[],
  opts: FirstRunOptions,
): Promise<void> {
  console.log(`\n${chalk.bold("Let's get your project ready.")}\n`);
  console.log(projectLines(project).join("\n"));
  console.log(`\n${chalk.bold("Detecting your environment...")}`);
  console.log(chalk.green("Project understanding: available"));
  console.log(`${chalk.bold("Detected coding agents:")}`);
  console.log(agentLines(agents).join("\n"));

  let configuredAgents: AgentId[] = [];
  let skippedAgentSetup = false;
  if (opts.yes) {
    const detected = agents.filter((agent) => agent.installed).map((agent) => agent.id);
    if (detected.length > 0) {
      console.log(chalk.yellow("\n--yes applies the integration only after you confirm below."));
      configuredAgents = await setupAgents(rl, project, agents, detected);
    }
  } else {
    configuredAgents = await setupAgents(rl, project, agents);
  }
  if (configuredAgents.length === 0) skippedAgentSetup = true;

  const mode = await checkMenu(rl);
  let skippedCheck = false;
  if (mode === "skip") {
    skippedCheck = true;
    console.log(chalk.dim("\nSkipped. Run `pitstop check quick .` whenever you are ready."));
  } else {
    const ok = await runSelectedCheck(mode);
    if (!ok) skippedCheck = true;
  }

  saveOnboardingState(project.root, {
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    lastCheckMode: mode === "skip" ? loadOnboardingState(project.root).lastCheckMode : mode,
    configuredAgents,
    skippedAgentSetup,
    skippedCheck,
  });
  console.log(
    chalk.dim(
      "\nSetup complete. Re-run `pitstop` for the short menu, or `pitstop --setup` to run this setup again.",
    ),
  );
}

function nonInteractive(project: ProjectDetection | null, agents: AgentDetection[]): void {
  if (project) {
    console.log(projectLines(project).join("\n"));
    console.log(`\n${chalk.bold("Detected coding agents:")}`);
    console.log(agentLines(agents).join("\n"));
    console.log(
      chalk.dim(
        "\nNot an interactive terminal — nothing was written and no prompt is waiting.\n" +
          "  pitstop check quick .    fast project check\n" +
          "  pitstop check deep .     full audit\n" +
          "  pitstop check ship .     strict release check\n" +
          "  pitstop install --dry-run  preview agent integrations\n" +
          "  pitstop --help           every command",
      ),
    );
  } else {
    console.log(
      chalk.yellow("\nNo supported project detected in this directory.") +
        chalk.dim(
          "\nRun `pitstop` from a project root, or `pitstop demo` to watch OpenPitStop work on a real repo.\n" +
            "  pitstop --help  every command",
        ),
    );
  }
}

export async function guidedFirstRun(opts: FirstRunOptions = {}): Promise<void> {
  banner();
  if (opts.skipOnboarding) {
    console.log(chalk.dim("\nSkipped. Run `pitstop --help` for every command.\n"));
    return;
  }

  let project: ProjectDetection | null = null;
  let agents: AgentDetection[] = [];
  try {
    project = detectProject(process.cwd());
    agents = detectAgents(process.cwd());
  } catch (error) {
    console.error(chalk.yellow(`Could not fully inspect this directory: ${(error as Error).message}`));
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && opts.input !== false);
  if (!interactive) {
    nonInteractive(project, agents);
    return;
  }

  if (!project || project.type === "Unknown project type") {
    console.log(
      chalk.yellow("\nNo supported project detected in this directory.") +
        chalk.dim("\n\nFrom a project root, re-run `pitstop`.") +
        `\n  ${chalk.cyan("pitstop demo")}   watch the guided demo on a real repo\n` +
        `  ${chalk.cyan("pitstop --help")} every command\n`,
    );
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const complete = isOnboardingComplete(project.root) && !opts.setup;
    if (complete) {
      await returningFlow(rl, project, agents);
    } else {
      await firstRunFlow(rl, project, agents, opts);
    }
  } finally {
    rl.close();
  }
}

/** Exported for tests: pure, no writes. */
export function summarizeEnvironment(project: ProjectDetection, agents: AgentDetection[]): string {
  return [...projectLines(project), "", ...agentLines(agents)].join("\n");
}
