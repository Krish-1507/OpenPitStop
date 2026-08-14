import { Command } from "commander";
import chalk from "chalk";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { safeExec, safeExecAsync } from "../analyzers/util.js";
import { runScan, renderBox } from "./scan.js";
import { createSpinner } from "../ui/spinner.js";

/**
 * `pitstop demo` — the first-touch wow, kept self-contained on purpose:
 *
 * - NO writes outside the OS temp dir (+ a node_modules cache under
 *   ~/.pitstop/cache so repeat demos skip the registry entirely). It never
 *   installs slash commands into the user's tool configs — that stays an
 *   explicit, user-invoked `pitstop install` — so a demo cannot surprise you
 *   with files in ~/.claude etc.
 * - NO npm install in the hot path. node_modules is linked from (1) the
 *   fixture's own checkout, (2) the user-level cache, and only as a last
 *   resort (3) a one-time cached install with --no-audit --no-fund. A directory
 *   junction/symlink is used where the platform allows it, because physically
 *   copying ~25MB of jest on Windows costs ~15s of Defender scanning.
 */

function repoRoot(): string {
  return path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

/** Link (junction on Windows, symlink elsewhere) `candidate` -> `dest`; never throws. */
function linkModules(candidate: string, destPath: string): boolean {
  if (!fs.existsSync(candidate)) return false;
  try {
    if (process.platform === "win32") {
      fs.symlinkSync(candidate, destPath, "junction");
    } else {
      fs.symlinkSync(candidate, destPath, "dir");
    }
    return true;
  } catch {
    /* platform/permission — fall back to a physical copy */
  }
  try {
    fs.cpSync(candidate, destPath, { recursive: true });
    return fs.existsSync(destPath);
  } catch {
    return false;
  }
}

/** Resolve node_modules for the temp demo: cache → fixture → one-time cached install. */
async function ensureDeps(demoName: string, src: string, tmp: string): Promise<boolean> {
  const cacheRoot = path.join(os.homedir(), ".pitstop", "cache", demoName);
  const cacheModules = path.join(cacheRoot, "node_modules");
  const target = path.join(tmp, "node_modules");

  // 1) A ready copy — user cache first (stable), then the fixture's own checkout.
  for (const candidate of [cacheModules, path.join(src, "node_modules")]) {
    if (fs.existsSync(candidate) && linkModules(candidate, target)) return true;
  }

  // 2) One-time install INTO the cache (never the repo's fixture, so the
  //    checkout stays pristine), then link. --no-audit/--no-fund: it is a
  //    manually-triggered demo, and every repeat run hits the cache instead.
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.copyFileSync(path.join(src, "package.json"), path.join(cacheRoot, "package.json"));
    const lock = path.join(src, "package-lock.json");
    if (fs.existsSync(lock)) fs.copyFileSync(lock, path.join(cacheRoot, "package-lock.json"));
  } catch {
    /* ignore copy errors — the install will fail loudly if the manifest is missing */
  }
  const install = await safeExecAsync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--loglevel=error"],
    cacheRoot,
    240000,
  );
  if (install.code !== 0) return false;
  return linkModules(cacheModules, target);
}

export const demo = new Command("demo")
  .description(
    "Recreate an intentionally-broken OpenPitStop demo repo in a fresh temp dir (default: " +
      "demo-repo, or pass demo-repo-integrity / demo-repo-fintech / demo-repo-generators), " +
      "initialize git, and scan it RIGHT NOW so you see the boxed report without any setup. " +
      "Self-contained: nothing is written outside the OS temp dir (slash-command install is " +
      "a separate, explicit step).",
  )
  .argument("[demo]", "demo fixture directory name (default: demo-repo)", "demo-repo")
  .action(async (demoArg: string) => {
    const repoRootDir = repoRoot();
    const demoName = path.basename(demoArg);
    const src = path.join(repoRootDir, demoName);
    if (!fs.existsSync(src)) {
      console.log(`demo repo ${demoName} not found at ${src}`);
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-demo-"));
    fs.cpSync(src, tmp, { recursive: true, filter: (p) => !/node_modules$/.test(p) });

    // A fixture's checked-in .pitstop records a previous repo path and stale
    // baselines — wipe those so the temp repo starts clean, but KEEP the cache
    // dir (npm-audit JSON + jest cache) so the first demo scan is fast.
    const pitstopDir = path.join(tmp, ".pitstop");
    if (fs.existsSync(pitstopDir)) {
      for (const f of fs.readdirSync(pitstopDir)) {
        if (f === "cache") continue;
        try {
          fs.rmSync(path.join(pitstopDir, f), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }

    // Deps: source → cache → one-time cached install. If we get here without
    // node_modules, tests/reliability/perf print "skipped" and the box still
    // ships the other analyzers — the demo degrades, it doesn't hang.
    const ready = await ensureDeps(demoName, src, tmp);
    if (ready) {
      console.log(chalk.dim("demo deps ready (cached — no registry hit)."));
    } else {
      console.log(
        chalk.yellow(
          "npm install did not complete — tests/reliability/perf will print `skipped`; " +
            "the rest of the box still runs.",
        ),
      );
    }

    // The autonomous loop (branch, revert, commit) and the verify integrity gate
    // both need a git repo. Initialize one and commit a clean baseline so the
    // fix loop diffs against it.
    const init = safeExec("git", ["init"], tmp);
    if (init.code !== 0) {
      console.log(chalk.yellow("git init failed — the integrity gate will not be able to diff fixes."));
    } else {
      safeExec("git", ["config", "user.email", "pitstop@demo.local"], tmp);
      safeExec("git", ["config", "user.name", "OpenPitStop Demo"], tmp);
      const add = safeExec("git", ["add", "-A"], tmp);
      if (add.code !== 0) {
        console.log(chalk.yellow("git add failed — baseline commit skipped."));
      } else {
        const commit = safeExec("git", ["commit", "-m", "demo baseline"], tmp);
        console.log(
          commit.code === 0
            ? chalk.dim("git baseline committed (integrity gate will diff fixes against it).")
            : chalk.yellow("git commit failed — verify's integrity gate will not see a baseline."),
        );
      }
    }

    // The wow moment: scan the seeded-broken demo repo RIGHT NOW and show the
    // boxed report, so a first-time user sees the whole product without needing
    // an AI tool, a browser tab, or any setup. Flaky detection is trimmed to 1
    // suite run so the demo lands fast.
    const spin = createSpinner("Scanning the demo repo (this is the report your agent will see)");
    try {
      const { result } = await runScan(tmp, { reliabilityRuns: 1 });
      spin.succeed("Demo scan complete");
      console.log("\n" + renderBox(result));
    } catch (err: any) {
      spin.fail("Demo scan failed");
      console.log(chalk.yellow(`could not scan the demo repo: ${err?.message ?? err}`));
    }

    console.log(
      `\n${chalk.bold("Next:")} cd ${tmp}, open it in Claude Code/Cursor/OpenCode, type /pitstop, hit enter.\n` +
        `The agent will fix the findings above, cluster by cluster, and loop until the score is clean.` +
        `\n(To register the /pitstop slash command in your tools, run \`pitstop install\` in that repo — ` +
        `it writes into your tool configs, so it is never done silently by the demo.)`,
    );
  });