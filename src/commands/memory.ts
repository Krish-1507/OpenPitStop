import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import {
  addEntry,
  relevantEntries,
  loadEntries,
  type MemoryEntry,
  type MemoryType,
} from "../memory/store.js";

const memory = new Command("memory")
  .description("Recall past decisions, fixes and rejected approaches for this repo")
  .option("--repo <path>", "repo to operate on (defaults to cwd)", ".");

function repoFrom(cmd: Command): string {
  const opts = memory.opts();
  return path.resolve(opts.repo || ".");
}

function typeColor(t: MemoryType): (s: string) => string {
  switch (t) {
    case "decision":
      return chalk.cyan;
    case "fix":
      return chalk.green;
    case "rejection":
      return chalk.red;
  }
}

function printEntry(e: MemoryEntry): void {
  const tc = typeColor(e.type);
  console.log(`  ${tc(e.type.toUpperCase().padEnd(9))} ${chalk.bold(e.summary)}`);
  if (e.context) console.log(`    ${chalk.dim("why: " + e.context)}`);
  if (e.relatedFiles.length) {
    console.log(`    ${chalk.dim("files: " + e.relatedFiles.join(", "))}`);
  }
  console.log(`    ${chalk.dim(e.timestamp)}`);
}

export const add = new Command("add")
  .description("Record a memory entry")
  .argument("<summary>", "what happened")
  .option("--type <type>", "entry type", "decision")
  .option("--context <context>", "why it happened / matters")
  .option("--file <path...>", "related files (relative to repo)")
  .option("--mirror", "also write to repo-local .pitstop/memory.jsonl", false)
  .action((summary: string, opts: any) => {
    const repo = repoFrom(add);
    const type = String(opts.type) as MemoryType;
    if (!["decision", "fix", "rejection"].includes(type)) {
      console.log(chalk.red(`invalid --type "${type}" (decision|fix|rejection)`));
      return;
    }
    const relatedFiles = (opts.file ?? []).map((f: string) =>
      path.relative(repo, path.resolve(repo, f)),
    );
    const entry = addEntry(repo, {
      type,
      summary,
      context: opts.context,
      relatedFiles,
      mirror: opts.mirror,
    });
    console.log(chalk.green("memory saved:"));
    printEntry(entry);
  });

export const list = new Command("list")
  .description("List memory entries, newest first")
  .action(() => {
    const repo = repoFrom(list);
    const entries = loadEntries(repo).sort((a, b) =>
      a.timestamp < b.timestamp ? 1 : -1,
    );
    if (entries.length === 0) {
      console.log(chalk.yellow("no memory entries for this repo"));
      return;
    }
    console.log(chalk.bold(`\nMemory for this repo (${entries.length}):\n`));
    for (const e of entries) printEntry(e);
    console.log("");
  });

export const relevant = new Command("relevant")
  .description("Show memory entries relevant to a file (and its neighbors)")
  .argument("<file>", "path to a file in the repo")
  .action((file: string) => {
    const repo = repoFrom(relevant);
    const entries = relevantEntries(repo, file);
    if (entries.length === 0) {
      console.log(chalk.yellow(`no memory relevant to ${file}`));
      return;
    }
    console.log(chalk.bold(`\nMemory relevant to ${file} (${entries.length}):\n`));
    for (const e of entries) printEntry(e);
    console.log("");
  });

memory.addCommand(add);
memory.addCommand(list);
memory.addCommand(relevant);

export { memory };
