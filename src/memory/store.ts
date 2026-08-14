import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { safeExec } from "../analyzers/util.js";
import { buildEdges } from "../analyzers/dependencyGraph.js";

export type MemoryType = "decision" | "fix" | "rejection";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: MemoryType;
  summary: string;
  context: string;
  relatedFiles: string[];
}

const GLOBAL_DIR = path.join(os.homedir(), ".pitstop", "memory");
const LOCAL_MIRROR = path.join(".pitstop", "memory.jsonl");

/**
 * Identify "this repo" by hashing the git remote URL (fallback: absolute path).
 * The hash determines the memory file name so memory is stable across checkouts.
 */
export function identifyRepo(repo: string): string {
  const r = safeExec("git", ["config", "--get", "remote.origin.url"], repo, 10000);
  const remote = r.stdout.trim();
  const seed = remote || path.resolve(repo);
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

export function globalMemoryPath(repo: string): string {
  return path.join(GLOBAL_DIR, `${identifyRepo(repo)}.jsonl`);
}

export function localMemoryPath(repo: string): string {
  return path.join(repo, LOCAL_MIRROR);
}

export function loadEntries(repo: string): MemoryEntry[] {
  const paths = [globalMemoryPath(repo), localMemoryPath(repo)];
  const entries: MemoryEntry[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const e = JSON.parse(t) as MemoryEntry;
        if (e.id) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
        }
        entries.push(e);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return entries;
}

export interface AddInput {
  type: MemoryType;
  summary: string;
  context?: string;
  relatedFiles?: string[];
  mirror?: boolean;
}

export function addEntry(repo: string, input: AddInput): MemoryEntry {
  const entry: MemoryEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: input.type,
    summary: input.summary,
    context: input.context ?? "",
    relatedFiles: input.relatedFiles ?? [],
  };
  const globalPath = globalMemoryPath(repo);
  fs.mkdirSync(path.dirname(globalPath), { recursive: true });
  fs.appendFileSync(globalPath, JSON.stringify(entry) + "\n");

  if (input.mirror) {
    const local = localMemoryPath(repo);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.appendFileSync(local, JSON.stringify(entry) + "\n");
  }
  return entry;
}

/**
 * 1–2 hop undirected neighborhood of the given files in the dependency graph,
 * as a set of absolute paths. Used to decide whether a memory entry is
 * "relevant" to a file or cluster.
 */
export function buildNeighborhood(repo: string, files: string[]): Set<string> {
  const absFiles = files.map((f) => path.resolve(repo, f));
  const built = buildEdges(repo);
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  if (built) {
    for (const [u, deps] of built.edges) {
      link(u, u);
      for (const v of deps) {
        link(u, v);
        link(v, u);
      }
    }
  }
  const neighborhood = new Set<string>(absFiles);
  const queue: [string, number][] = absFiles.map((f) => [f, 0]);
  while (queue.length) {
    const [n, d] = queue.shift() as [string, number];
    if (d >= 2) continue;
    for (const nb of adj.get(n) ?? []) {
      if (!neighborhood.has(nb)) {
        neighborhood.add(nb);
        queue.push([nb, d + 1]);
      }
    }
  }
  return neighborhood;
}

export function relevantEntriesForFiles(repo: string, files: string[]): MemoryEntry[] {
  const neighborhood = buildNeighborhood(repo, files);
  const seen = new Set<string>();
  const out: MemoryEntry[] = [];
  for (const e of loadEntries(repo)) {
    const hit = e.relatedFiles.some((f) => neighborhood.has(path.resolve(repo, f)));
    if (!hit) continue;
    if (e.id) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    out.push(e);
  }
  // newest first
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  return out;
}

export function relevantEntries(repo: string, filePath: string): MemoryEntry[] {
  return relevantEntriesForFiles(repo, [filePath]);
}
