/**
 * pen/fix.ts — `pitstop pen --fix`.
 *
 * What --fix actually does (and what it refuses to do):
 *   1. Writes a permanent repro test for every finding that has a replayable
 *      attack (dynamic) or a stable credential fragment (secrets). The test
 *      FAILS while the bug exists — that is the fail-first contract.
 *   2. Generates deterministic patches for the small set of fixes that are
 *      provably safe to suggest as `git apply`-able diffs:
 *        - `app.disable("x-powered-by")` (no behavior change)
 *        - `helmet()` middleware, only when helmet is already installed
 *      Everything else gets a precise manual fix note in PITSTOP_PEN_FIXES.md.
 *   3. NEVER modifies the user's source. Patches are written to
 *      .pitstop/pen-patches/ and the user (or their agent) applies them.
 */

import fs from "node:fs";
import path from "node:path";
import { generatePenRepro } from "../repro/pen.js";
import type { PenFinding, PenResult } from "./types.js";

export interface PenFixOutcome {
  repros: { findingId: string; file: string }[];
  patches: { findingId: string; file: string; diffPath: string; note: string; findingIds: string[] }[];
  fixesMd: string;
}

/* ------------------------------------------------------------------ */
/* unified-diff builder: pure-insertion hunks in git's canonical form. */
/* OpenPitStop's deterministic fixes NEVER delete user lines — they only  */
/* insert. In the hunk, every ` ` (context) line counts toward BOTH    */
/* sides and appears ONCE, with `+` lines interleaved at their         */
/* positions — exactly the shape `git diff` emits, which `git apply`   */
/* parses unambiguously (including UTF-8 BOM'd first lines).           */
/* ------------------------------------------------------------------ */

export function insertionPatch(rel: string, oldLines: string[], inserts: { after: number; lines: string[] }[]): string {
  if (inserts.length === 0) return "";
  const oldLen = oldLines.length;
  const sorted = [...inserts].sort((a, b) => a.after - b.after);
  const first = sorted[0].after;
  const last = sorted[sorted.length - 1].after;
  const ctx = 3;
  const start = Math.max(0, first - ctx);
  const end = Math.min(oldLen, last + ctx);
  const ctxCount = end - start;
  const plusCount = sorted.reduce((n, ins) => n + ins.lines.length, 0);

  const body: string[] = [];
  let cursor = start;
  for (const ins of sorted) {
    while (cursor < ins.after && cursor < oldLen) {
      body.push(" " + oldLines[cursor]);
      cursor++;
    }
    for (const l of ins.lines) body.push("+" + l);
  }
  while (cursor < end) {
    body.push(" " + oldLines[cursor]);
    cursor++;
  }

  return [
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${start + 1},${ctxCount} +${start + 1},${ctxCount + plusCount} @@`,
    ...body,
  ].join("\n") + "\n";
}

/* ------------------------------------------------------------------ */

function findExpressAppFile(repo: string): { file: string; line: number; lineText: string } | null {
  const stack = [repo];
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
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".pitstop" || e.name === "dist" || e.name === "build") continue;
        stack.push(p);
      } else if (e.isFile() && /\.(js|mjs|cjs|ts)$/i.test(e.name)) {
        try {
          const lines = readLines(p);
          for (let i = 0; i < lines.length; i++) {
            if (/const\s+app\s*=\s*express\s*\(/.test(lines[i])) {
              return { file: p, line: i + 1, lineText: lines[i] };
            }
          }
        } catch {
          /* skip */
        }
      }
    }
  }
  return null;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** Content of a line with a leading UTF-8 BOM (common after Windows tools) stripped. */
const noBom = (l: string) => l.replace(/^\uFEFF/, "");

export function runFixes(repo: string, result: PenResult, packages: string[]): PenFixOutcome {
  const repros: PenFixOutcome["repros"] = [];
  const patches: PenFixOutcome["patches"] = [];
  const patchDir = path.join(repo, ".pitstop", "pen-patches");
  fs.mkdirSync(patchDir, { recursive: true });

  for (const f of result.findings) {
    const outcome = generatePenRepro(repo, f);
    if (outcome.ok && outcome.file) repros.push({ findingId: f.id, file: outcome.file });
  }

  const expressApp = findExpressAppFile(repo);
  const helmetInstalled = packages.includes("helmet");

  // Patches are merged PER FILE so that `git apply` works in any order and
  // each .diff is cumulative: the target state is computed from the ORIGINAL
  // file plus every deterministic change, then emitted as one hunk.
  interface FilePatch {
    rel: string;
    file: string;
    anchor: number;
    importLine: string | null;
    after: string[];
    findingIds: string[];
  }
  const byFile = new Map<string, FilePatch>();

  for (const f of result.findings) {
    // x-powered-by: disable it right after app creation. Behavior-neutral.
    if (f.type === "info-leak-header" && expressApp) {
      const rel = path.relative(repo, expressApp.file).replace(/\\/g, "/");
      const lines = readLines(expressApp.file);
      const already = lines.some((l) => /disable\s*\(\s*["']x-powered-by["']/.test(l));
      if (!already) {
        const fp = byFile.get(rel) ?? {
          rel,
          file: expressApp.file,
          anchor: expressApp.line,
          importLine: null,
          after: [],
          findingIds: [],
        };
        if (!fp.after.includes(`app.disable("x-powered-by");`)) fp.after.push(`app.disable("x-powered-by");`);
        fp.findingIds.push(f.id);
        byFile.set(rel, fp);
      }
    }

    // helmet: only patch when the dependency is already installed.
    if (f.type === "missing-security-headers" && expressApp && helmetInstalled) {
      const rel = path.relative(repo, expressApp.file).replace(/\\/g, "/");
      const lines = readLines(expressApp.file);
      const already = lines.some((l) => /\bhelmet\s*\(/.test(l));
      if (!already) {
        const isEsm = lines.some((l) => /^import\b/.test(noBom(l))) || /^\s*import\s+express\b/.test(noBom(lines[0] ?? ""));
        const importLine = isEsm ? `import helmet from "helmet";` : `const helmet = require("helmet");`;
        const fp = byFile.get(rel) ?? {
          rel,
          file: expressApp.file,
          anchor: expressApp.line,
          importLine: null,
          after: [],
          findingIds: [],
        };
        fp.importLine ??= importLine;
        if (!fp.after.includes(`app.use(helmet());`)) fp.after.push(`app.use(helmet());`);
        fp.findingIds.push(f.id);
        byFile.set(rel, fp);
      }
    }
  }

  for (const fp of byFile.values()) {
    const lines = readLines(fp.file);
    const inserts: { after: number; lines: string[] }[] = [];
    if (fp.importLine) inserts.push({ after: 0, lines: [fp.importLine] });
    if (fp.after.length) inserts.push({ after: fp.anchor, lines: fp.after });
    const diff = insertionPatch(fp.rel, lines, inserts);
    if (!diff) continue;
    const diffPath = path.join(patchDir, `${fp.findingIds[0]}-fix.diff`);
    fs.writeFileSync(diffPath, diff, "utf8");
    patches.push({
      findingId: fp.findingIds[0],
      file: fp.rel,
      diffPath: path.relative(repo, diffPath).replace(/\\/g, "/"),
      findingIds: fp.findingIds,
      note:
        fp.after.join(", ") +
        (fp.importLine ? " (plus the helmet import)" : "") +
        " inserted after the Express app creation line — one cumulative patch for this file, applies cleanly on its own",
    });
  }

  const fixesMd = buildFixesMd(repo, result, repros, patches);
  return { repros, patches, fixesMd };
}

function buildFixesMd(
  repo: string,
  result: PenResult,
  repros: { findingId: string; file: string }[],
  patches: PenFixOutcome["patches"],
): string {
  const reproBy = new Map(repros.map((r) => [r.findingId, r.file]));
  const patchBy = new Map<string, PenFixOutcome["patches"][number]>();
  for (const p of patches) for (const id of p.findingIds) patchBy.set(id, p);
  const L: string[] = [];
  L.push(`# OpenPitStop Pen Test — Fix Plan`);
  L.push("");
  L.push(`_${result.timestamp}_ — ${result.repo}`);
  L.push("");
  L.push(`How to use this file:`);
  L.push(`1. Every replayable finding now has a **repro test** that FAILS while the bug is live.`);
  L.push(`2. Apply deterministic patches with \`git apply\`, or hand the finding id to your agent:`);
  L.push(`   \`pitstop drive <id>\` or tell your agent \`pitstop repro <id>\` → fix → \`pitstop verify\`.`);
  L.push(`3. When the repro test PASSES and \`pitstop pen\` reports the finding gone, it is fixed — not vibes.`);
  L.push("");
  for (const f of result.findings) {
    L.push(`## ${f.severity.toUpperCase()} — ${f.title} \`${f.id}\``);
    L.push("");
    L.push(`- **Confidence**: ${f.confidence} · **Type**: ${f.type}`);
    const where = f.file
      ? path.relative(repo, f.file).replace(/\\/g, "/") + (f.line ? `:${f.line}` : "")
      : f.route
        ? `${f.route} (${f.method})`
        : "—";
    L.push(`- **Where**: \`${where}\``);
    L.push("");
    L.push(f.description);
    L.push("");
    const reproFile = reproBy.get(f.id);
    if (reproFile) {
      L.push(`- **Repro test**: \`${reproFile}\` — run with \`npx openpitstop repro ${f.id}\`. It FAILS now; make it PASS.`);
    }
    const patch = patchBy.get(f.id);
    if (patch) {
      L.push(`- **Deterministic patch**: \`git apply ${patch.diffPath}\` — ${patch.note}.`);
      L.push(`  Verify with \`npx openpitstop repro ${f.id}\` + \`npx openpitstop verify\`.`);
    }
    if (f.fix) {
      L.push(`- **Fix guidance**: ${f.fix}`);
    }
    L.push("");
  }
  L.push(`---`);
  L.push(`OpenPitStop can't promise "never hacked" — it CAN promise this: every demonstrable attack here`);
  L.push(`has a regression test that fails on the bug and passes on the fix. Ship with those tests green.`);
  L.push("");
  return L.join("\n");
}
