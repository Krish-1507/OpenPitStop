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
  { name: "check", cli: "check quick", description: "guided quick/deep/ship check with findings, skipped checks and next steps" },
  { name: "languages", cli: "languages", description: "show language, parser, analyzer and verification support" },
  { name: "map", cli: "map", description: "map candidate routes, entry points, auth/data evidence and infrastructure" },
  { name: "scan", cli: "scan", description: "measure the repo: score, secrets, deps, tests, duplication, a11y" },
  { name: "pen", cli: "pen --fix", description: "boot the app, fire real attacks, write failing-first repro tests + safe patches" },
  { name: "drive", cli: "drive", description: "drive an agent to fix one root cause, tamper-evident" },
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

/**
 * Per-agent layout. Paths intentionally match the long-standing `install`
 * targets; the registry exists so onboarding can offer one agent at a time
 * without changing the default all-agents install.
 */
export type AgentId =
  | "claude-code"
  | "cursor"
  | "opencode"
  | "antigravity"
  | "kilo-code"
  | "gemini-cli"
  | "codex";

export interface AgentDefinition {
  id: AgentId;
  name: string;
  /** Executable names that indicate the tool is installed. */
  binaries: string[];
  /** Home-relative directories that indicate the tool is installed or used. */
  homeDirs: string[];
  /** Project-relative directories that indicate this project is configured for the tool. */
  projectDirs: string[];
  note?: string;
  projectTargets(cwd: string): InstallTarget[];
  homeTargets(home: string): InstallTarget[];
}

const p = (root: string, ...parts: string[]) => path.resolve(root, ...parts);
const h = (root: string, ...parts: string[]) => path.join(root, ...parts);

export const AGENT_DEFINITIONS: AgentDefinition[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    binaries: ["claude"],
    homeDirs: [".claude"],
    projectDirs: [".claude"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".claude", "commands", "pitstop.md"), tool: "Claude Code (project)", level: "project" },
      { path: p(cwd, ".claude", "skills", "pitstop", "SKILL.md"), tool: "Claude Code Skill", level: "project", transform: "skill" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".claude", "commands", "pitstop.md"), tool: "Claude Code (user)", level: "home" },
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    binaries: ["cursor", "cursor-agent"],
    homeDirs: [".cursor"],
    projectDirs: [".cursor"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".cursor", "commands", "pitstop.md"), tool: "Cursor (project)", level: "project" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".cursor", "commands", "pitstop.md"), tool: "Cursor (user)", level: "home" },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    binaries: ["opencode"],
    homeDirs: [".config/opencode", ".opencode"],
    projectDirs: [".opencode"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".opencode", "commands", "pitstop.md"), tool: "OpenCode (project)", level: "project" },
      { path: p(cwd, ".opencode", "command", "pitstop.md"), tool: "OpenCode (project, legacy)", level: "project" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".config", "opencode", "commands", "pitstop.md"), tool: "OpenCode (user)", level: "home" },
      { path: h(home, ".opencode", "commands", "pitstop.md"), tool: "OpenCode (user, legacy)", level: "home" },
    ],
  },
  {
    id: "antigravity",
    name: "Antigravity",
    binaries: [],
    homeDirs: [".agent", ".agents"],
    projectDirs: [".agent", ".agents"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".agent", "workflows", "pitstop.md"), tool: "Antigravity (project)", level: "project", transform: "workflow" },
      { path: p(cwd, ".agents", "workflows", "pitstop.md"), tool: "Antigravity (project, plural legacy)", level: "project", transform: "workflow" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".agent", "workflows", "pitstop.md"), tool: "Antigravity (user)", level: "home", transform: "workflow" },
      { path: h(home, ".agents", "workflows", "pitstop.md"), tool: "Antigravity (user, plural legacy)", level: "home", transform: "workflow" },
    ],
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    binaries: ["kilo", "kilocode"],
    homeDirs: [".kilo", ".config/kilo", ".kilocode"],
    projectDirs: [".kilo", ".kilocode"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".kilo", "commands", "pitstop.md"), tool: "Kilo Code (project)", level: "project" },
      { path: p(cwd, ".kilocode", "workflows", "pitstop.md"), tool: "Kilo Code (project, legacy — auto-migrated)", level: "project" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".config", "kilo", "commands", "pitstop.md"), tool: "Kilo Code (user)", level: "home" },
      { path: h(home, ".kilocode", "workflows", "pitstop.md"), tool: "Kilo Code (user, legacy — auto-migrated)", level: "home" },
    ],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    binaries: ["gemini"],
    homeDirs: [".gemini"],
    projectDirs: [".gemini"],
    projectTargets: (cwd) => [
      { path: p(cwd, ".gemini", "commands", "pitstop.toml"), tool: "Gemini CLI (project)", level: "project", transform: "gemini" },
    ],
    homeTargets: (home) => [
      { path: h(home, ".gemini", "commands", "pitstop.toml"), tool: "Gemini CLI (user)", level: "home", transform: "gemini" },
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    binaries: ["codex"],
    homeDirs: [".codex"],
    projectDirs: [],
    note: "Codex supports prompts only at user level",
    projectTargets: () => [],
    homeTargets: (home) => [
      {
        path: h(home, ".codex", "prompts", "pitstop.md"),
        tool: "Codex CLI (user)",
        level: "home",
        note: "Codex supports prompts only at user level",
      },
    ],
  },
];

export const AGENT_IDS: AgentId[] = AGENT_DEFINITIONS.map((agent) => agent.id);

export function getAgentDefinition(id: AgentId): AgentDefinition {
  return AGENT_DEFINITIONS.find((agent) => agent.id === id) as AgentDefinition;
}

export function isAgentId(value: string): value is AgentId {
  return AGENT_IDS.includes(value as AgentId);
}

/** Absolute project-level targets, relative to the given repo/cwd. */
export function projectTargets(cwd: string): InstallTarget[] {
  return AGENT_DEFINITIONS.flatMap((agent) => agent.projectTargets(cwd));
}

/** Absolute user-level (home) targets. Order matches the historical installer. */
const HOME_ORDER: AgentId[] = ["codex", "claude-code", "cursor", "opencode", "antigravity", "kilo-code", "gemini-cli"];

export function homeTargets(home: string = os.homedir()): InstallTarget[] {
  return HOME_ORDER.flatMap((id) => getAgentDefinition(id).homeTargets(home));
}

export function getTargets(cwd: string, home: string = os.homedir()): InstallTarget[] {
  return [...projectTargets(cwd), ...homeTargets(home)];
}

/** Every target for the selected agents, project and home, deduplicated by path. */
export function targetsForAgents(
  cwd: string,
  agents: AgentId[],
  home: string = os.homedir(),
): InstallTarget[] {
  const seen = new Set<string>();
  const out: InstallTarget[] = [];
  for (const id of agents) {
    const definition = getAgentDefinition(id);
    if (!definition) continue;
    for (const target of [...definition.projectTargets(cwd), ...definition.homeTargets(home)]) {
      const key = path.resolve(target.path);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(target);
    }
  }
  return out;
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
 * main target (a file named `pitstop.md` / `pitstop.toml`). Skills (SKILL.md)
 * and unsupported tools (targets with a `note`, i.e. Codex) are skipped. Each
 * subcommand keeps the parent's transform so the Gemini TOML / Antigravity
 * workflow rewriting still applies.
 */
export function getSubcommandTargetsFor(targets: InstallTarget[]): InstallTarget[] {
  const out: InstallTarget[] = [];
  for (const t of targets) {
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

export function getSubcommandTargets(cwd: string, home: string = os.homedir()): InstallTarget[] {
  return getSubcommandTargetsFor([...projectTargets(cwd), ...homeTargets(home)]);
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
 * Marker written into every generated file. New installs are identifiable
 * without guessing; `isManagedContent` still recognizes files generated by
 * older versions so upgrades remain safe.
 */
export const MANAGED_MARKER = "<!-- openpitstop:managed -->";

const MANAGED_PATTERNS = [
  /<!--\s*openpitstop:managed\s*-->/i,
  /^#\s*openpitstop:managed\s*$/im,
  /^#\s*\/pitstop\b/m,
  /description:\s*"?OpenPitStop\b/i,
  /description\s*=\s*"OpenPitStop\b/i,
  /pitstop\s+prompt\s+--args/i,
  /OpenPitStop\s+—/,
];

/** True when a file was generated by OpenPitStop and may be safely refreshed. */
export function isManagedContent(content: string): boolean {
  return MANAGED_PATTERNS.some((pattern) => pattern.test(content));
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
    if (!m) return `${MANAGED_MARKER}\n${templateText}`;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    return `---\nname: pitstop\ndescription: ${description}\n---\n\n${MANAGED_MARKER}\n\n${body}`;
  }
  if (target.transform === "workflow") {
    const m = templateText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return `${MANAGED_MARKER}\n${templateText}`;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    const description = descMatch ? descMatch[1].trim() : "";
    return `---\ndescription: ${description}\n---\n\n${MANAGED_MARKER}\n\n${body}`;
  }
  if (target.transform === "gemini") {
    const m = templateText.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
    if (!m) return `# openpitstop:managed\n${templateText}`;
    const fm = m[1];
    const body = m[2];
    const descMatch = fm.match(/description:\s*(.+?)\s*$/m);
    let description = descMatch ? descMatch[1].trim() : "";
    description = description.replace(/^"|"$/g, "");
    return `# openpitstop:managed\ndescription = "${description}"\nprompt = """\n${body.trim()}\n"""\n`;
  }
  const m = templateText.match(/^(---\s*\n[\s\S]*?\n---\s*\n?)([\s\S]*)$/);
  if (!m) return `${MANAGED_MARKER}\n${templateText}`;
  return `${m[1]}\n${MANAGED_MARKER}\n\n${m[2]}`;
}
