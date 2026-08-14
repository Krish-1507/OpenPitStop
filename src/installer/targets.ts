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
}

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
