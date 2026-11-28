import { execaSync, execa, type SyncResult } from "execa";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLanguageFrom } from "../languages/adapters.js";
import type { Language } from "../languages/types.js";

export type { Language } from "../languages/types.js";

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

interface ExecCapture {
  code: number;
  stdout: string;
  stderr: string;
}

const CAPTURE_LIMIT = 50 * 1024 * 1024;

function asString(v: unknown): string {
  return typeof v === "string" ? v : v instanceof Buffer ? v.toString() : "";
}

/**
 * A pipe can be unavailable in a restricted sandbox. Some spawns then fail
 * before the child starts and expose no stdout/stderr at all. Retry only a
 * genuine spawn/permission failure with file descriptors; a command that ran
 * and legitimately exited non-zero is never re-run, because that could repeat
 * its side effects.
 */
function captureUnavailable(result: ExecCapture, detail = ""): boolean {
  if (result.code === 0) return false;
  return /(?:EPERM|EACCES|EMFILE|ENFILE|ENOENT)/i.test(detail + " " + result.stderr);
}

function readCapture(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.length > CAPTURE_LIMIT ? text.slice(0, CAPTURE_LIMIT) : text;
  } catch {
    return "";
  }
}

function captureFiles(): { dir: string; out: string; err: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-exec-"));
  return { dir, out: path.join(dir, "stdout"), err: path.join(dir, "stderr") };
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    fs.closeSync(fd);
  } catch {
    // The child may already have closed it; nothing useful to report.
  }
}

function removeQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of a temporary capture directory.
  }
}

function safeExecWithFiles(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): ExecCapture {
  let files: { dir: string; out: string; err: string };
  try {
    files = captureFiles();
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  }
  let outFd: number | undefined;
  let errFd: number | undefined;
  try {
    outFd = fs.openSync(files.out, "w");
    errFd = fs.openSync(files.err, "w");
    // execa's public types only model pipe/ignore/inherit, while Node accepts
    // an inherited file descriptor here. The runtime path is covered by tests.
    const res = execaSync(file, args, {
      cwd,
      stdio: ["ignore", outFd, errFd],
      timeout: timeoutMs,
      windowsHide: true,
      reject: false,
    } as any);
    closeQuietly(outFd);
    closeQuietly(errFd);
    outFd = undefined;
    errFd = undefined;
    return {
      code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
      stdout: readCapture(files.out),
      stderr: readCapture(files.err),
    };
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  } finally {
    closeQuietly(outFd);
    closeQuietly(errFd);
    removeQuietly(files.dir);
  }
}

export function safeExec(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 120000,
): { code: number; stdout: string; stderr: string } {
  let res: SyncResult;
  try {
    res = execaSync(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: CAPTURE_LIMIT,
      reject: false,
    });
  } catch (err: any) {
    const result = { code: -1, stdout: "", stderr: err?.message ?? String(err) };
    return captureUnavailable(result, result.stderr) ? safeExecWithFiles(file, args, cwd, timeoutMs) : result;
  }
  const result = {
    code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
    stdout: asString(res.stdout),
    stderr: asString(res.stderr),
  };
  const spawnDetail = String((res as any).shortMessage ?? "") + " " + String((res as any).originalMessage ?? "");
  return captureUnavailable(result, spawnDetail) ? safeExecWithFiles(file, args, cwd, timeoutMs) : result;
}

/**
 * Async twin of safeExec for analyzers that should run in parallel (security,
 * tests, reliability, perf all spend their time waiting on subprocesses).
 */
async function safeExecAsyncWithFiles(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: Record<string, string | undefined> | undefined,
): Promise<ExecCapture> {
  let files: { dir: string; out: string; err: string };
  try {
    files = captureFiles();
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  }
  let outFd: number | undefined;
  let errFd: number | undefined;
  try {
    outFd = fs.openSync(files.out, "w");
    errFd = fs.openSync(files.err, "w");
    // See the sync fallback: a file descriptor is valid at runtime even though
    // execa's public option type stops at pipe/ignore/inherit.
    const res = await execa(file, args, {
      cwd,
      stdio: ["ignore", outFd, errFd],
      timeout: timeoutMs,
      windowsHide: true,
      reject: false,
      ...(env ? { env } : {}),
    } as any);
    closeQuietly(outFd);
    closeQuietly(errFd);
    outFd = undefined;
    errFd = undefined;
    return {
      code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
      stdout: readCapture(files.out),
      stderr: readCapture(files.err),
    };
  } catch (err: any) {
    return { code: -1, stdout: "", stderr: err?.message ?? String(err) };
  } finally {
    closeQuietly(outFd);
    closeQuietly(errFd);
    removeQuietly(files.dir);
  }
}

export async function safeExecAsync(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = 120000,
  env?: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const res = await execa(file, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: CAPTURE_LIMIT,
      reject: false,
      ...(env ? { env } : {}),
    });
    const result = {
      code: typeof res.exitCode === "number" ? res.exitCode : res.failed ? 1 : -1,
      stdout: asString(res.stdout),
      stderr: asString(res.stderr),
    };
    const spawnDetail = String((res as any).shortMessage ?? "") + " " + String((res as any).originalMessage ?? "");
    return captureUnavailable(result, spawnDetail) ? safeExecAsyncWithFiles(file, args, cwd, timeoutMs, env) : result;
  } catch (err: any) {
    const result = { code: -1, stdout: "", stderr: err?.message ?? String(err) };
    return captureUnavailable(result, result.stderr) ? safeExecAsyncWithFiles(file, args, cwd, timeoutMs, env) : result;
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
  return detectLanguageFrom(
    (relativePath) => fs.existsSync(path.join(repo, relativePath)),
    // .NET projects are commonly nested in src/ folders, so probe the tree.
    (extensions) => walkFiles(repo, extensions).length > 0,
  );
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
  "bench",
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
