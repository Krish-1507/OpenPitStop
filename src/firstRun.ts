import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import chalk from "chalk";
import boxen from "boxen";

/**
 * The bare `npx openpitstop` first-run: a guided 60-second tour that turns the
 * one-liner into the whole product demo with zero docs reading.
 *
 * Non-TTY (CI, pipes): prints the short menu instead of blocking.
 *
 * Interactive flow:
 *   1. detect what's here (AI tools installed, git repo, project kind)
 *   2. offer: install /pitstop into your tools, try this repo, see the 90s demo
 *   3. run the chosen action via the CLI itself (spawned, identical behavior)
 */

const TOOL_HOME_DIRS: Array<[string, string]> = [
  [".claude", "Claude Code"],
  [".cursor", "Cursor"],
  [".kilo", "Kilo Code"],
  [".config/kilo", "Kilo Code"],
  [".gemini", "Gemini CLI"],
  [".codex", "Codex CLI"],
  [".config/opencode", "OpenCode"],
];

function detectedTools(): string[] {
  const home = os.homedir();
  const found = new Set<string>();
  for (const [rel, name] of TOOL_HOME_DIRS) {
    try {
      if (fs.existsSync(path.join(home, rel))) found.add(name);
    } catch {
      /* ignore */
    }
  }
  // Antigravity lives at project level (.agent/) — mention it when present.
  try {
    if (fs.existsSync(path.join(process.cwd(), ".agent"))) found.add("Antigravity");
  } catch {
    /* ignore */
  }
  return [...found];
}

function isGitRepo(dir: string): boolean {
  try {
    const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return r.status === 0 && r.stdout.trim() === "true";
  } catch {
    return false;
  }
}

function hasProject(dir: string): boolean {
  const markers = [
    "package.json",
    "requirements.txt",
    "pyproject.toml",
    "setup.py",
    "go.mod",
    "Cargo.toml",
    "pom.xml",
  ];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

/** Spawn this same CLI for the chosen action — one code path for everything. */
function runCli(args: string[], cwd: string): number {
  const cliPath = process.argv[1] ?? path.join(process.cwd(), "dist", "cli.js");
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    stdio: "inherit",
    env: { ...process.env },
    timeout: 20 * 60 * 1000,
  });
  return typeof r.status === "number" ? r.status : 1;
}

async function askChoice(
  rl: readline.Interface,
  question: string,
  choices: Array<[string, string]>,
): Promise<string> {
  const label = (i: number) => `${i + 1}`;
  while (true) {
    console.log("");
    choices.forEach(([key, desc], i) => console.log(`  ${chalk.cyan(label(i))}. ${desc}`));
    const raw = (await rl.question(`\n${chalk.bold(question)} `)).trim();
    if (raw.toLowerCase() === "q" || raw.toLowerCase() === "quit") return "q";
    const n = Number(raw);
    if (!Number.isNaN(n) && n >= 1 && n <= choices.length) return choices[n - 1][0];
    if (choices.some(([k]) => k === raw)) return raw;
    console.log(chalk.yellow("  (pick a number, or q to quit)"));
  }
}

export async function guidedFirstRun(): Promise<void> {
  const cwd = process.cwd();
  const tools = detectedTools();
  const git = isGitRepo(cwd);
  const project = hasProject(cwd);

  console.log(
    boxen(
      chalk.bold("OpenPitStop") +
        "\nThe referee your AI agent can't cheat." +
        "\n" +
        chalk.dim(
          "Deterministic scans, tamper-evident baselines, runtime pen tests,\n" +
            "and a verification gate — exit 0 = clean, 1 = suspicious, 2 = confirmed cheat.",
        ),
      { padding: 1, borderStyle: "round", borderColor: "cyan", title: " " },
    ),
  );

  const bits: string[] = [];
  if (git) bits.push(chalk.green("git repo ✓"));
  if (project) bits.push(chalk.green("a project I can scan ✓"));
  if (tools.length > 0) bits.push(chalk.green(`detected: ${tools.join(", ")}`));
  if (bits.length === 0) bits.push(chalk.dim("nothing detected yet — that's fine"));
  console.log(`\nHere's what I found: ${bits.join("  ·  ")}`);

  if (!process.stdout.isTTY) {
    console.log(
      chalk.dim(
        "\nNot an interactive terminal, so no questions — here's everything in one line:\n" +
          "  npx openpitstop try .       score THIS repo in ~2 seconds\n" +
          "  npx openpitstop install     add the /pitstop slash-command to your AI tools\n" +
          "  npx openpitstop demo        watch the 90-second cheat-catch demo\n" +
          "  npx openpitstop --help      every command\n",
      ),
    );
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const choices: Array<[string, string]> = [
      ["install", `Install /pitstop into ${tools.length > 0 ? tools.join(", ") : "your AI tools"} (one command, then type /pitstop in any repo)`],
      ...(project
        ? [["try", "Score THIS repo (npx openpitstop try . — ~2 seconds of scanning)"] as [string, string]]
        : [["demo", "Run the 90-second demo (a real repo where the agent gets caught twice)"] as [string, string]]),
      ["menu", "Just show the full command menu"],
    ];

    const pick = await askChoice(rl, "What do you want to do?", choices);

    if (pick === "q") {
      console.log(chalk.dim("\nAnytime. The one-liner that does the most: `npx openpitstop try .`"));
      return;
    }
    if (pick === "menu") {
      console.log(chalk.dim("\nRunning `npx openpitstop --help` …"));
      runCli(["--help"], cwd);
      return;
    }
    if (pick === "try") {
      console.log(chalk.dim("\nScoring this repo …"));
      runCli(["try", cwd], cwd);
      return;
    }
    if (pick === "demo") {
      console.log(chalk.dim("\nRunning the scripted demo …"));
      runCli(["demo"], cwd);
      return;
    }
    if (pick === "install") {
      console.log(chalk.dim("\nInstalling the /pitstop slash-command …"));
      const code = runCli(["install"], cwd);
      if (code === 0 && project) {
        const again = await askChoice(rl, "Installed. Want to see what it does on this repo?", [
          ["try", "Score this repo right now"],
          ["no", "No thanks"],
        ]);
        if (again === "try") runCli(["try", cwd], cwd);
      }
      return;
    }
  } finally {
    rl.close();
  }
}
