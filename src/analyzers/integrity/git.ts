import fs from "node:fs";
import path from "node:path";
import { safeExec } from "../util.js";
import { languageOf, makeChange, linesToDiff } from "./helpers.js";
import type { FileChange, DiffLine, FileStatus } from "./types.js";

/**
 * Acquire the set of changed files (before/after content + added/removed lines)
 * for a git diff range, so the integrity detectors can run scoped to the diff.
 *
 * `to` omitted => compare `from` against the current working tree (unstaged +
 * staged + untracked). `to` given => compare the two refs.
 *
 * LINE ENDINGS: Windows git (core.autocrlf) typically checks out CRLF working
 * trees. Diff output from git is always LF, but raw file content is not — so
 * before/after content is normalized to `\n` here; all detectors then
 * pattern-match LF-only text regardless of platform.
 */

interface ParsedDiff {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  added: DiffLine[];
  removed: DiffLine[];
}

function gitOk(repo: string, args: string[]): boolean {
  return safeExec("git", args, repo).code === 0;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function showAtRef(repo: string, ref: string, file: string): string | undefined {
  const r = safeExec("git", ["show", `${ref}:${file}`], repo);
  if (r.code !== 0) return undefined;
  return normalizeEol(r.stdout);
}

function readWorking(repo: string, file: string): string | undefined {
  try {
    return normalizeEol(fs.readFileSync(path.join(repo, file), "utf8"));
  } catch {
    return undefined;
  }
}

function stripPrefix(p: string): string {
  // git diff prints "a/foo" / "b/foo" (or "/dev/null").
  if (p === "/dev/null") return "/dev/null";
  return p.replace(/^(a\/|b\/)/, "");
}

/** Parse a unified diff (-U0) into per-file added/removed lines + status. */
function parseUnified(text: string): ParsedDiff[] {
  const files: ParsedDiff[] = [];
  let cur: ParsedDiff | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flush = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("diff --git")) {
      flush();
      cur = { oldPath: "", newPath: "", status: "modified", added: [], removed: [] };
      const m = raw.match(/diff --git a\/(.*) b\/(.*)$/);
      if (m) {
        cur.oldPath = stripPrefix("a/" + m[1]);
        cur.newPath = stripPrefix("b/" + m[2]);
      }
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith("new file")) {
      cur.status = "added";
      continue;
    }
    if (raw.startsWith("deleted file")) {
      cur.status = "deleted";
      continue;
    }
    if (raw.startsWith("rename from")) {
      cur.oldPath = stripPrefix(raw.slice("rename from ".length).trim());
      cur.status = "renamed";
      continue;
    }
    if (raw.startsWith("rename to")) {
      cur.newPath = stripPrefix(raw.slice("rename to ".length).trim());
      continue;
    }
    if (raw.startsWith("--- ")) {
      cur.oldPath = stripPrefix(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith("+++ ")) {
      cur.newPath = stripPrefix(raw.slice(4).trim());
      continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLine = parseInt(m[1], 10);
        newLine = parseInt(m[2], 10);
      }
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      cur.added.push({ line: newLine++, text: raw.slice(1) });
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      cur.removed.push({ line: oldLine++, text: raw.slice(1) });
    } else if (raw.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  flush();
  return files;
}

function mergeByNewPath(a: ParsedDiff[], b: ParsedDiff[]): ParsedDiff[] {
  const byPath = new Map<string, ParsedDiff>();
  for (const f of [...a, ...b]) {
    const key = f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath;
    const existing = byPath.get(key);
    if (existing) {
      existing.added.push(...f.added);
      existing.removed.push(...f.removed);
      if (f.status === "added" || f.status === "deleted") existing.status = f.status;
    } else {
      byPath.set(key, { ...f });
    }
  }
  return [...byPath.values()];
}

/** Get all changed files for the given ref range. */
export function getDiff(repo: string, from: string, to?: string): FileChange[] {
  let parsed: ParsedDiff[];
  if (to) {
    const r = safeExec("git", ["diff", "-U0", from, to], repo);
    parsed = parseUnified(r.stdout);
  } else {
    const unstaged = safeExec("git", ["diff", "-U0", from], repo).stdout;
    const staged = safeExec("git", ["diff", "--cached", "-U0", from], repo).stdout;
    parsed = mergeByNewPath(parseUnified(unstaged), parseUnified(staged));
    // Untracked files count as additions against the working tree.
    const others = safeExec("git", ["ls-files", "--others", "--exclude-standard"], repo).stdout;
    for (const f of others.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (f.startsWith("node_modules/") || f.startsWith(".pitstop/") || f.startsWith("dist/")) {
        continue;
      }
      const content = readWorking(repo, f);
      if (content == null) continue;
      parsed.push({
        oldPath: "/dev/null",
        newPath: f,
        status: "added",
        added: linesToDiff(content),
        removed: [],
      });
    }
  }

  const out: FileChange[] = [];
  for (const p of parsed) {
    const newPath = p.newPath !== "/dev/null" ? p.newPath : p.oldPath;
    const oldPath = p.oldPath !== "/dev/null" ? p.oldPath : p.newPath;
    let before: string | undefined;
    let after: string | undefined;
    if (p.status === "added") {
      before = undefined;
      after = to ? showAtRef(repo, to, newPath) : readWorking(repo, newPath);
    } else if (p.status === "deleted") {
      before = showAtRef(repo, from, oldPath);
      after = undefined;
    } else {
      before = showAtRef(repo, from, oldPath);
      after = to ? showAtRef(repo, to, newPath) : readWorking(repo, newPath);
    }
    if (before == null && after == null) continue;
    out.push(makeChange(newPath, p.status, before, after, p.added, p.removed));
  }
  return out;
}

/** Resolve default refs. `from` defaults to HEAD~1 (or HEAD if that's invalid). */
export function resolveRefs(repo: string, from?: string, to?: string): { from: string; to?: string } {
  let resolvedFrom = from ?? "";
  if (!resolvedFrom) {
    resolvedFrom = gitOk(repo, ["rev-parse", "--verify", "HEAD~1"]) ? "HEAD~1" : "HEAD";
  }
  return { from: resolvedFrom, to };
}

export { languageOf };
