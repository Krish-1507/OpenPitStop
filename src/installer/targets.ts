import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface InstallTarget {
  path: string;
  tool: string;
  level: "project" | "home";
  transform?: "skill" | "workflow" | "gemini";
  note?: string;
  /** Pre-rendered command body (used for generated subcommands). When set, the
   * installer writes this directly instead of reading a template file. */
  inlineBody?: string;
}

/** A PitStop subcommand exposed as its own slash command (e.g. /pitstop-scan)
 * so the host tool's native `/` dropdown becomes a clickable menu, plus the
 * interactive `/pitstop menu` card. */
export interface Subcommand {
  name: string;
  cli: string;
  description: string;
  special?: "menu";
}

export const SUBCOMMANDS: Subcommand[] = [
  { name: "menu", cli: "menu", description: "show a clickable menu card of every OpenPitStop action", special: "menu" },
  { name: "scan", cli: "scan", description: "measure the repo: score, secrets, deps, tests, duplication, a11y" },
  { name: "pen", cli: "pen --fix", description: "boot the app, fire real attacks, write failing-first repro tests + safe patches" },
  { name: "fix", cli: "drive", description: "drive an agent to fix one root cause, tamper-evident" },
  { name: "verify", cli: "verify", description: "re-run repros, diff against the sealed baseline, catch agent cheating" },
  { name: "gate", cli: "gate --score 60", description: "one-number contract for CI / pre-commit (0 clean, 1 issues, 2 suspicious)" },
  { name: "report", cli: "report", description: "generate a shareable HTML/markdown scorecard" },
  { name: "honesty", cli: "honesty", description: "trace every number to sealed, tamper-evident evidence" },
  { name: "watch", cli: "watch", description: "keep the loop cheap: reuse baselines, skip redundant work" },
  { name: "memory", cli: "memory", description: "show what OpenPitStop has learned about this repo" },
  { name: "next", cli: "next", description: "show the suggested next step and everything still pending" },
  { name: "fix", cli: "fix", description: "autopilot: scan → pen --fix → verify → gate, fully evidenced" },
  { name: "ask", cli: "ask", description: "natural-language router: 'make this safe' → the right command" },
  { name: "install", cli: "install -y", description: "(re)install the slash command and git hooks" },
];

/** Absolute project-level targets, relative to the given repo/cwd. */
export function projectTargets(cwd: string): InstallTarget[] {
  const p = (...parts: string[]) => path.resolve(cwd, ...parts);
  return [
    { path: p(".claude", "commands", "pitstop.md"), tool: "Claude Code (project)", level: "project" },
    {
      path: p(".claude", "skills", "pitstop", "SKILL.md"),
      tool: "Claude Code Skill",
      level: "project",
      transform: "skill",
    },
    { path: p(".cursor", "commands", "pitstop.md"), tool: "Cursor (project)", level: "project" },
    { path: p(".opencode", "commands", "pitstop.md"), tool: "OpenCode (project)", level: "project" },
    {
      path: p(".opencode", "command", "pitstop.md"),
      tool: "OpenCode (project, legacy)",
      level: "project",
    },
    // Antigravity workflows: markdown files in .agent/workflows/ (singular,
    // current docs) with YAML frontmatter `description` + title + steps,
    // invoked as /pitstop. Older versions/3rd-party guides use the plural
    // .agents/workflows/ — write both, one is harmless dead weight.
    {
      path: p(".agent", "workflows", "pitstop.md"),
      tool: "Antigravity (project)",
      level: "project",
      transform: "workflow",
    },
    {
      path: p(".agents", "workflows", "pitstop.md"),
      tool: "Antigravity (project, plural legacy)",
      level: "project",
      transform: "workflow",
    },
    // Kilo Code current docs: slash commands live in .kilo/commands/ (project)
    // and ~/.config/kilo/commands/ (global). .kilocode/workflows/ is the LEGACY
    // location the new extension auto-migrates on startup — kept for old builds.
    { path: p(".kilo", "commands", "pitstop.md"), tool: "Kilo Code (project)", level: "project" },
    {
      path: p(".kilocode", "workflows", "pitstop.md"),
      tool: "Kilo Code (project, legacy — auto-migrated)",
      level: "project",
    },
    {
      path: p(".gemini", "commands", "pitstop.toml"),
      tool: "Gemini CLI (project)",
      level: "project",
      transform: "gemini",
    },
  ];
}

/** Absolute user-level (home) targets. */
export function homeTargets(): InstallTarget[] {
  const h = (...parts: string[]) => path.join(os.homedir(), ...parts);
  return [
    {
      path: h(".codex", "prompts", "pitstop.md"),
      tool: "Codex CLI (user)",
      level: "home",
      note: "Codex supports prompts only at user level",
    },
    { path: h(".claude", "commands", "pitstop.md"), tool: "Claude Code (user)", level: "home" },
    { path: h(".cursor", "commands", "pitstop.md"), tool: "Cursor (user)", level: "home" },
    // OpenCode current docs: global commands in ~/.config/opencode/commands/;
    // ~/.opencode/commands/ is the older location — keep both.
    {
      path: h(".config", "opencode", "commands", "pitstop.md"),
      tool: "OpenCode (user)",
      level: "home",
    },
    {
      path: h(".opencode", "commands", "pitstop.md"),
      tool: "OpenCode (user, legacy)",
      level: "home",
    },
    // Antigravity global workflows (home) mirror the project layout.
    {
      path: h(".agent", "workflows", "pitstop.md"),
      tool: "Antigravity (user)",
      level: "home",
      transform: "workflow",
    },
    {
      path: h(".agents", "workflows", "pitstop.md"),
      tool: "Antigravity (user, plural legacy)",
      level: "home",
      transform: "workflow",
    },
    { path: h(".config", "kilo", "commands", "pitstop.md"), tool: "Kilo Code (user)", level: "home" },
    {
      path: h(".kilocode", "workflows", "pitstop.md"),
      tool: "Kilo Code (user, legacy — auto-migrated)",
      level: "home",
    },
    {
      path: h(".gemini", "commands", "pitstop.toml"),
      tool: "Gemini CLI (user)",
      level: "home",
      transform: "gemini",
    },
  ];
}

export function getTargets(cwd: string): InstallTarget[] {
  return [...projectTargets(cwd), ...homeTargets()];
}

/** Locate templates/pitstop-menu.command.md — the interactive menu card. */
export function resolveMenuTemplatePath(): string {
  const fromModule = fileURLToPath(
    new URL("../../templates/pitstop-menu.command.md", import.meta.url),
  );
  if (fs.existsSync(fromModule)) return fromModule;
  const fromCwd = path.resolve(process.cwd(), "templates", "pitstop-menu.command.md");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return resolveCommandTemplatePath();
}

/** Render the command body for one subcommand (menu reuses the menu template;
 * the rest are thin pointers to a `pitstop` CLI subcommand). */
function subcommandBody(sc: Subcommand): string {
  if (sc.special === "menu") {
    return fs.readFileSync(resolveMenuTemplatePath(), "utf8");
  }
  return [
    "---",
    `description: "OpenPitStop — ${sc.description}"`,
    "---",
    "",
    `# /pitstop ${sc.name}`,
    "",
    "Run this OpenPitStop command and follow its full output:",
    "",
    "```bash",
    `pitstop ${sc.cli}`,
    "```",
    "",
    "If `pitstop` is not on your PATH, use `npx --yes openpitstop@latest " + sc.cli + "`. Do not paste the command output back to the user.",
    "",
    "When it finishes, run `pitstop next` and show the user the **Next-step** and **Pending** list it prints (as a clickable card if your tool supports interactive choices). Note: `scan` and `verify` already print this card automatically, so for those just surface what they printed.",
    "",
  ].join("\n");
}

/**
 * Generate one InstallTarget per subcommand, derived from every *command-style*
 * main target (a file named `pitstop.md` / `pitstop.toml`) in project + home
 * layouts. Skills (SKILL.md) and unsupported tools (targets with a `note`,
 * i.e. Codex) are skipped. Each subcommand keeps the parent's transform so the
 * Gemini TOML / Antigravity workflow rewriting still applies.
 */
export function getSubcommandTargets(cwd: string): InstallTarget[] {
  const mains = [...projectTargets(cwd), ...homeTargets()];
  const out: InstallTarget[] = [];
  for (const t of mains) {
    if (t.note) continue;
    const base = path.basename(t.path);
    const m = base.match(/^pitstop\.(md|toml)$/);
    if (!m) continue;
    const ext = m[1];
    const dir = path.dirname(t.path);
    for (const sc of SUBCOMMANDS) {
      out.push({
        path: path.join(dir, `pitstop-${sc.name}.${ext}`),
        tool: t.tool,
        level: t.level,
        transform: t.transform,
        inlineBody: subcommandBody(sc),
      });
    }
  }
  return out;
}

/** Locate templates/pitstop.prompt.md relative to this module or cwd. */
export function resolveTemplatePath(): string {
  const fromModule = fileURLToPath(
    new URL("../../templates/pitstop.prompt.md", import.meta.url),
  );
  if (fs.existsSync(fromModule)) return fromModule;
  const fromCwd = path.resolve(process.cwd(), "templates", "pitstop.prompt.md");
  if (fs.existsSync(fromCwd)) return fromCwd;
  throw new Error("could not locate templates/pitstop.prompt.md");
}

/**
 * Locate templates/pitstop.command.md — the SHORT slash-command body that the
 * user actually sees when they type `/pitstop`. It is a thin pointer that tells
 * the agent to load the full SOP via `pitstop prompt --args "$ARGUMENTS"`, so
 * the user's chat shows only `/pitstop` (+ their extra text), never the giant
 * 18KB prompt. Falls back to the full prompt for backward compatibility.
 */
export function resolveCommandTemplatePath(): string {
  const fromModule = fileURLToPath(
    new URL("../../templates/pitstop.command.md", import.meta.url),
  );
  if (fs.existsSync(fromModule)) return fromModule;
  const fromCwd = path.resolve(process.cwd(), "templates", "pitstop.command.md");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return resolveTemplatePath();
}

/**
 * Render the file content for a target. The Claude Code skill variant rewrites
 * the frontmatter to { name, description } as skills require. The Antigravity
 * workflow variant normalizes the frontmatter to `description` only (their
 * required field) and keeps the title + numbered steps body as-is. The Gemini
 * CLI variant converts to TOML ({ description = "...", prompt = """ body """ }),
 * the format .gemini/commands/*.toml files must use.
 */
export function renderContent(target: InstallTarget, templateText: string): string {
  if (target.transform === "skill") {
    const m = templateText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return templateText;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    return `---\nname: pitstop\ndescription: ${description}\n---\n\n${body}`;
  }
  if (target.transform === "workflow") {
    const m = templateText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return templateText;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    return `---\ndescription: ${description}\n---\n\n${body}`;
  }
  if (target.transform === "gemini") {
    const m = templateText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return templateText;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    let description = descMatch ? descMatch[1].trim() : "";
    description = description.replace(/^"|"$/g, "");
    return `description = "${description}"\nprompt = """\n${body.trim()}\n"""\n`;
  }
  return templateText;
}
