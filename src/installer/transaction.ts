import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isManagedContent,
  renderContent,
  resolveCommandTemplatePath,
  type InstallTarget,
} from "./targets.js";

export type InstallAction = "create" | "update" | "unchanged" | "skip";

export type OverwriteMode = "never" | "managed" | "all";

export interface InstallPlanEntry {
  target: InstallTarget;
  path: string;
  content: string;
  action: InstallAction;
  reason?: string;
}

export interface InstallPlan {
  entries: InstallPlanEntry[];
  overwrite: OverwriteMode;
  counts: { create: number; update: number; unchanged: number; skip: number };
}

export interface InstallPlanOptions {
  /** Template read from templates/pitstop.command.md unless provided. */
  templateText?: string;
  /**
   * never: leave every existing file alone (legacy default).
   * managed: refresh files that OpenPitStop generated, never touch user files.
   * all: overwrite everything (explicit --force/-y).
   */
  overwrite?: OverwriteMode;
}

function digest(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function countActions(entries: InstallPlanEntry[]): InstallPlan["counts"] {
  return entries.reduce(
    (counts, entry) => {
      counts[entry.action]++;
      return counts;
    },
    { create: 0, update: 0, unchanged: 0, skip: 0 },
  );
}

/**
 * Build a side-effect-free install plan. Callers can print exactly which files
 * would change, ask for permission, and only then call applyInstallPlan.
 */
export function buildInstallPlan(
  targets: InstallTarget[],
  opts: InstallPlanOptions = {},
): InstallPlan {
  const templateText = opts.templateText ?? fs.readFileSync(resolveCommandTemplatePath(), "utf8");
  const overwrite = opts.overwrite ?? "never";
  const seen = new Set<string>();
  const entries: InstallPlanEntry[] = [];

  for (const target of targets) {
    const absolute = path.resolve(target.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const content = renderContent(target, target.inlineBody ?? templateText);
    let action: InstallAction;
    let reason: string | undefined;

    if (!fs.existsSync(absolute)) {
      action = "create";
    } else {
      let existing = "";
      try {
        existing = fs.readFileSync(absolute, "utf8");
      } catch (error) {
        action = "skip";
        reason = `could not read existing file: ${(error as Error).message}`;
        entries.push({ target, path: absolute, content, action, reason });
        continue;
      }
      if (existing === content) {
        action = "unchanged";
      } else if (overwrite === "all") {
        action = "update";
      } else if (overwrite === "managed" && isManagedContent(existing)) {
        action = "update";
      } else {
        action = "skip";
        reason = isManagedContent(existing)
          ? "existing OpenPitStop file kept (overwrite not authorised)"
          : "existing file is not managed by OpenPitStop; left untouched";
      }
    }
    entries.push({ target, path: absolute, content, action, reason });
  }

  return { entries, overwrite, counts: countActions(entries) };
}

export interface InstallManifestEntry {
  path: string;
  action: "create" | "update";
  digestAfter: string;
  backup?: string;
}

export interface InstallTransaction {
  id: string;
  at: string;
  repo: string;
  entries: InstallManifestEntry[];
}

export interface InstallManifest {
  schemaVersion: 1;
  transactions: InstallTransaction[];
}

export interface ApplyResult {
  transaction: InstallTransaction;
  changed: InstallPlanEntry[];
  unchanged: InstallPlanEntry[];
  skipped: InstallPlanEntry[];
}

export interface RollbackConflict {
  path: string;
  reason: string;
}

export interface RollbackResult {
  transactionId: string | null;
  restored: string[];
  removed: string[];
  conflicts: RollbackConflict[];
}

function manifestPath(repo: string): string {
  return path.join(repo, ".pitstop", "install-manifest.json");
}

function readManifest(repo: string): InstallManifest {
  const file = manifestPath(repo);
  if (!fs.existsSync(file)) return { schemaVersion: 1, transactions: [] };
  let parsed: Partial<InstallManifest>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as Partial<InstallManifest>;
  } catch (error) {
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.transactions)) {
    throw new Error(`invalid install manifest at ${file}`);
  }
  for (const transaction of parsed.transactions) {
    if (!transaction || typeof transaction.id !== "string" || !Array.isArray(transaction.entries)) {
      throw new Error(`invalid install transaction in ${file}`);
    }
  }
  return parsed as InstallManifest;
}

function writeManifest(repo: string, manifest: InstallManifest): void {
  const file = manifestPath(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertRestorablePath(repo: string, file: string): void {
  const absolute = path.resolve(file);
  if (!path.isAbsolute(file) || (!inside(repo, absolute) && !inside(os.homedir(), absolute) && !inside(os.tmpdir(), absolute))) {
    throw new Error(`refusing to modify a path outside the repository or home directory: ${file}`);
  }
}

/**
 * Apply a previously previewed plan. Existing files are backed up under
 * .pitstop/install-backups/<transaction>/ before they are replaced, and the
 * manifest records the exact files this run owns for a reliable rollback.
 */
export function applyInstallPlan(repoInput: string, plan: InstallPlan): ApplyResult {
  const repo = path.resolve(repoInput);
  const changed = plan.entries.filter((entry) => entry.action === "create" || entry.action === "update");
  const unchanged = plan.entries.filter((entry) => entry.action === "unchanged");
  const skipped = plan.entries.filter((entry) => entry.action === "skip");

  const id = `install-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const backupDir = path.join(repo, ".pitstop", "install-backups", id);
  const manifestEntries: InstallManifestEntry[] = [];

  try {
    for (const [index, entry] of changed.entries()) {
      assertRestorablePath(repo, entry.path);
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      let backup: string | undefined;
      if (entry.action === "update") {
        fs.mkdirSync(backupDir, { recursive: true });
        backup = path.join(backupDir, `${String(index).padStart(3, "0")}-${path.basename(entry.path)}`);
        fs.copyFileSync(entry.path, backup);
      }
      fs.writeFileSync(entry.path, entry.content);
      manifestEntries.push({
        path: entry.path,
        action: entry.action as "create" | "update",
        digestAfter: digest(entry.content),
        backup,
      });
    }
  } catch (error) {
    // Never leave a half-applied integration behind. Undo only this attempt.
    for (const written of [...manifestEntries].reverse()) {
      try {
        if (written.action === "create") fs.rmSync(written.path, { force: true });
        else if (written.backup) fs.copyFileSync(written.backup, written.path);
      } catch {
        /* best-effort recovery; the original error is the useful one */
      }
    }
    throw new Error(`install failed while writing files; earlier writes were reverted: ${(error as Error).message}`);
  }

  const transaction: InstallTransaction = {
    id,
    at: new Date().toISOString(),
    repo,
    entries: manifestEntries,
  };
  if (manifestEntries.length > 0) {
    const manifest = readManifest(repo);
    manifest.transactions.push(transaction);
    manifest.transactions = manifest.transactions.slice(-20);
    writeManifest(repo, manifest);
  }

  return { transaction, changed, unchanged, skipped };
}

/**
 * Undo the most recent install transaction. A file edited after installation
 * is never destroyed silently: it is reported as a conflict unless force is set.
 */
export function rollbackLastInstall(repoInput: string, opts: { force?: boolean } = {}): RollbackResult {
  const repo = path.resolve(repoInput);
  const manifest = readManifest(repo);
  const transaction = manifest.transactions[manifest.transactions.length - 1];
  if (!transaction) return { transactionId: null, restored: [], removed: [], conflicts: [] };

  const restored: string[] = [];
  const removed: string[] = [];
  const conflicts: RollbackConflict[] = [];

  for (const entry of [...transaction.entries].reverse()) {
    assertRestorablePath(repo, entry.path);
    if (entry.action === "create") {
      if (!fs.existsSync(entry.path)) continue;
      const current = digest(fs.readFileSync(entry.path, "utf8"));
      if (current !== entry.digestAfter && !opts.force) {
        conflicts.push({ path: entry.path, reason: "file changed after installation; keeping it" });
        continue;
      }
      fs.rmSync(entry.path);
      removed.push(entry.path);
      continue;
    }
    if (!entry.backup || !fs.existsSync(entry.backup)) {
      conflicts.push({ path: entry.path, reason: "backup is missing; cannot restore the previous file" });
      continue;
    }
    if (fs.existsSync(entry.path)) {
      const current = digest(fs.readFileSync(entry.path, "utf8"));
      if (current !== entry.digestAfter && !opts.force) {
        conflicts.push({ path: entry.path, reason: "file changed after installation; keeping it" });
        continue;
      }
    }
    fs.mkdirSync(path.dirname(entry.path), { recursive: true });
    fs.copyFileSync(entry.backup, entry.path);
    restored.push(entry.path);
  }

  if (conflicts.length === 0) {
    manifest.transactions.pop();
    writeManifest(repo, manifest);
    try {
      const backupDir = path.join(repo, ".pitstop", "install-backups", transaction.id);
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch {
      /* backup cleanup is best-effort */
    }
  }

  return { transactionId: transaction.id, restored, removed, conflicts };
}

/** Remove manifest references for files that were explicitly uninstalled. */
export function purgeManifestPaths(repoInput: string, paths: string[]): void {
  const repo = path.resolve(repoInput);
  const removed = new Set(paths.map((file) => path.resolve(file)));
  if (removed.size === 0) return;
  const manifest = readManifest(repo);
  for (const transaction of manifest.transactions) {
    transaction.entries = transaction.entries.filter((entry) => !removed.has(path.resolve(entry.path)));
  }
  manifest.transactions = manifest.transactions.filter((transaction) => transaction.entries.length > 0);
  writeManifest(repo, manifest);
}

/** Remove only files that still carry an OpenPitStop marker. */
export function removeManagedTargets(
  targets: InstallTarget[],
  opts: { force?: boolean } = {},
): { removed: string[]; kept: { path: string; reason: string }[] } {
  const seen = new Set<string>();
  const removed: string[] = [];
  const kept: { path: string; reason: string }[] = [];
  for (const target of targets) {
    const absolute = path.resolve(target.path);
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    if (!fs.existsSync(absolute)) continue;
    let content: string;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      kept.push({ path: absolute, reason: `unreadable: ${(error as Error).message}` });
      continue;
    }
    if (!opts.force && !isManagedContent(content)) {
      kept.push({ path: absolute, reason: "not an OpenPitStop-managed file" });
      continue;
    }
    fs.rmSync(absolute);
    removed.push(absolute);
  }
  return { removed, kept };
}
