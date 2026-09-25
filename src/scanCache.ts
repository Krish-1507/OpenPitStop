import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checkEvidence, digestOf } from "./evidence.js";
import type { ScanResult } from "./analyzers/types.js";

const SKIP = new Set([".git", ".pitstop", "node_modules", "dist", "build", "coverage", ".next", ".venv", "venv", "__pycache__", ".pytest_cache", ".cache", "target"]);
const REPORT = /^PITSTOP_(REPORT|PEN_REPORT|PEN_FIXES|BADGE|CARD)\.(md|html|svg)$/;
export const SCAN_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

export interface RepoSnapshot { digest: string; files: Record<string, string>; head: string | null }
export interface ScanCache {
  schema: 1;
  inputs: string;
  snapshot: RepoSnapshot;
}
export interface ScanCacheOptions { reliabilityRuns?: number; ledger?: boolean }

/** Hash content, paths and file modes, including dot-directories and deletions.
 * Unreadable/oversized files or symlinks disable reuse; never guess that they are unchanged.
 * No file contents or environment values are written into the snapshot.
 */
export function snapshotRepo(repo: string): RepoSnapshot | null {
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  let count = 0;
  try {
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name) || REPORT.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error("symlink outside snapshot boundary");
        if (entry.isDirectory()) { walk(file); continue; }
        if (!entry.isFile()) throw new Error("unsupported file type");
        const stat = fs.statSync(file);
        bytes += stat.size;
        if (++count > 100000 || stat.size > 32 * 1024 * 1024 || bytes > 256 * 1024 * 1024) throw new Error("snapshot budget exceeded");
        files[path.relative(repo, file).replace(/\\/g, "/")] = createHash("sha256")
          .update(String(stat.mode)).update("\0").update(fs.readFileSync(file)).digest("hex");
      }
    };
    walk(repo);
    let head: string | null = null;
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true }).trim();
    } catch { /* non-git repositories can still be scanned */ }
    return { files, head, digest: digestOf({ files, head }) };
  } catch { return null; }
}

export function scanInputs(opts: ScanCacheOptions = {}): string {
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  return digestOf({ schema: 1, version, node: process.version, platform: process.platform,
    reliabilityRuns: opts.reliabilityRuns ?? 2, ledger: opts.ledger ?? false,
    semgrep: process.env.PITSTOP_SEMGREP_CONFIG ?? "", semgrepBin: process.env.PITSTOP_SEMGREP ?? "",
    path: process.env.PATH ?? "", nodeEnv: process.env.NODE_ENV ?? "" });
}

export function checkScanReuse(repo: string, opts: ScanCacheOptions = {}): { scan?: ScanResult; reason?: string; changedFile?: string } {
  try {
    const scan: ScanResult = JSON.parse(fs.readFileSync(path.join(repo, ".pitstop", "scan-latest.json"), "utf8").replace(/^\uFEFF/, ""));
    if (checkEvidence(scan).status !== "verified") return { reason: "baseline evidence is missing or modified" };
    if (scan.mode === "try") return { reason: "quick preview is not a full scan" };
    if (opts.ledger || scan.ledger) return { reason: "live payment checks must run again" };
    const cache = scan.cache;
    if (!cache || cache.schema !== 1) return { reason: "baseline has no content snapshot; run a full scan once" };
    const age = Date.now() - Date.parse(scan.timestamp);
    if (!Number.isFinite(age) || age < 0 || age > SCAN_CACHE_MAX_AGE_MS) return { reason: "baseline expired; external dependencies and tools may have changed" };
    if (cache.inputs !== scanInputs(opts)) return { reason: "scan options, engine or environment changed" };
    const current = snapshotRepo(repo);
    if (!current) return { reason: "could not safely fingerprint every input; full scan required" };
    if (cache.snapshot.digest !== current.digest) {
      const changedFile = [...new Set([...Object.keys(cache.snapshot.files), ...Object.keys(current.files)])]
        .sort().find((f) => cache.snapshot.files[f] !== current.files[f]);
      return { reason: changedFile ? "repository content changed" : "git HEAD changed", changedFile };
    }
    return { scan };
  } catch { return { reason: "no readable scan baseline; run a full scan" }; }
}
