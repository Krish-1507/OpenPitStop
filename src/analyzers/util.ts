import { execaSync, execa, type SyncResult } from "execa";
import fs from "node:fs";
import path from "node:path";

export type Language =
  | "js"
  | "python"
  | "go"
  | "rust"
  | "dart"
  | "dotnet"
  | "java"
  | "unknown";

/**
 * All external tool invocation goes through execa, which resolves PATH /
 * PATHEXT (`.cmd` / `.exe` shims) correctly on Windows — the raw
 * node:child_process execFile cannot spawn npm-installed `.cmd` shims there.
 * `reject: false` + try/catch makes these wrappers never throw.
 */

export function commandExists(cmd: string): boolean {
  try {
    execaSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export function safeExec(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 120000,
): { code: number; stdout: string; stderr: string } {
  const asStr = (v: unknown): string => (typeof v === "string" ? v : v instanceof Buffer ? v.toString() : "");
  let res: SyncResult;
  try {
    res = execaSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
      reject: false,
    });
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  }
  return {
    code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
    stdout: asStr(res.stdout),
    stderr: asStr(res.stderr),
  };
}

/**
 * Async twin of safeExec for analyzers that should run in parallel (security,
 * tests, reliability, perf all spend their time waiting on subprocesses).
 */
export async function safeExecAsync(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 120000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const asStr = (v: unknown): string => (typeof v === "string" ? v : v instanceof Buffer ? v.toString() : "");
  try {
    const res = await execa(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
      reject: false,
    });
    return {
      code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
      stdout: asStr(res.stdout),
      stderr: asStr(res.stderr),
    };
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  }
}

/** 1-based line number of a character index in a string. */
export function lineOf(content: string, index: number): number {
  let line = 1;
  const end = Math.min(index, content.length);
  for (let i = 0; i < end; i++) if (content[i] === "\n") line++;
  return line;
}

export function detectLanguage(repo: string): Language {
  if (fs.existsSync(path.join(repo, "package.json"))) return "js";
  if (
    fs.existsSync(path.join(repo, "requirements.txt")) ||
    fs.existsSync(path.join(repo, "pyproject.toml")) ||
    fs.existsSync(path.join(repo, "setup.py"))
  )
    return "python";
  if (fs.existsSync(path.join(repo, "go.mod"))) return "go";
  if (fs.existsSync(path.join(repo, "Cargo.toml"))) return "rust";
  if (
    fs.existsSync(path.join(repo, "pubspec.yaml")) ||
    fs.existsSync(path.join(repo, "pubspec.lock"))
  )
    return "dart";
  if (
    fs.existsSync(path.join(repo, "pom.xml")) ||
    fs.existsSync(path.join(repo, "build.gradle")) ||
    fs.existsSync(path.join(repo, "build.gradle.kts"))
  )
    return "java";
  // .NET projects are commonly nested in src/ folders, so probe the tree.
  if (walkFiles(repo, [".csproj", ".fsproj", ".vbproj"]).length > 0) return "dotnet";
  return "unknown";
}

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".pitstop",
  "coverage",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  // Fixture / seed directories that are not part of the codebase under analysis.
  "demo-repo",
  "templates",
]);

/**
 * Newest file mtime under a repo (skipping generated/ignored dirs), used to
 * detect whether a baseline scan has gone stale relative to the working tree.
 */
export function newestModifiedFile(root: string): { file: string; mtimeMs: number } | null {
  let best: { file: string; mtimeMs: number } | null = null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(path.join(dir, e.name));
          if (!best || st.mtimeMs > best.mtimeMs) {
            best = { file: path.join(dir, e.name), mtimeMs: st.mtimeMs };
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return best;
}

export function walkFiles(root: string, exts: string[]): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (exts.includes(path.extname(e.name))) out.push(path.join(dir, e.name));
      }
    }
  }
  return out;
}

export function dirSize(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total;
}
