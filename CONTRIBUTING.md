# Contributing to OpenPitStop

OpenPitStop is a small, dependency-light TypeScript CLI. The most valuable thing you can add is
a **new analyzer** — a new dimension of the scan. This guide is written around that path,
but it also covers setup, conventions, and how to open a PR.

## Development setup

Requires **Node.js ≥ 22** (execa 10 needs `Set.union`, an ES2024 feature). CI uses Node 22.

```bash
npm install
npm run build      # tsc → dist/  (the CLI runs from dist/, not src/)
npm run dev        # tsx watch src/cli.ts — live-reloading entry point
```

No test framework is used inside the CLI itself. Verification is hands-on: `npm run build`,
then run the real commands against a test repo (see [Testing](#testing)).

## How the engine is organized

```
src/analyzers/        one file per analyzer (the Phase-1 scan dimension)
  types.ts            every analyzer's result type + ClusterFinding + ScanResult
  index.ts            runAllAnalyzers() — the registration point
  util.ts             shared helpers (walkFiles, safeExec, commandExists, lineOf, ...)
  suiteRunner.ts      multi-language test-suite runner (go/cargo/flutter/dotnet/maven/gradle parsers)
  routes.ts           language-aware route discovery (shared by pen and ledger)
src/analyzers/integrity/  diff-scoped AI-agent-cheat detectors (testTamper, exceptionSwallow,
  suppressionCreep, hardcodedMatch, mockOverreach, exitCheat, assertionLiteralTamper) —
  wired into `pitstop verify`
src/sandbox/          non-Node sandboxing (recording HTTP(S)_PROXY server + start-command resolvers)
src/installer/         slash-command install targets (Claude, Cursor, OpenCode, Antigravity,
  Kilo Code, Gemini CLI, Codex) + the template transforms (skill / workflow frontmatter
  rewrites, gemini TOML conversion)
src/graph/correlate.ts   flattens findings into ClusterFinding[] and clusters them
src/graph/integrity.ts   combines detector output into one verdict (CLEAN/SUSPICIOUS/CONFIRMED_CHEAT)
src/commands/         the CLI surface (scan, verify, integrity, report, memory, demo, ci, install)
src/report/format.ts  PITSTOP_REPORT.md + boxed renderers
src/verify/metrics.ts verify metrics + Regression Risk classification
templates/pitstop.prompt.md  the /pitstop slash-command that drives the agent
```

Data flows: **analyzer → `ScanResult` → `collectFindings` (correlate) → clusters → scan box
→ verify/report**. A new analyzer only needs to plug into the first three links; everything
downstream adapts automatically.

## Adding a new analyzer

Add a new dimension to the scan. Say you want to detect `console.log` calls left in
production code. Here are the steps, in order:

### 1. Define the result type in `src/analyzers/types.ts`

Every analyzer returns a result object. It MUST have a `status` of `"ok" | "skipped" |
"error"`, an optional `note` string, and the fields your analyzer produces:

```ts
export interface LoggingResult {
  status: "ok" | "skipped" | "error";
  note?: string;
  issues: ScanIssue[]; // ScanIssue = { type, severity, file?, line?, description }
}
```

Add it to `ScanResult`:

```ts
export interface ScanResult {
  // ...
  logging: LoggingResult;
}
```

### 2. Create `src/analyzers/logging.ts`

Export `analyzeLogging(repo: string): LoggingResult`. Use the shared helpers from
`util.ts` — they handle the boring, error-prone parts:

```ts
import fs from "node:fs";
import path from "node:path";
import { walkFiles, lineOf } from "./util.js";
import type { LoggingResult } from "./types.js";

const JS_EXTS = [".js", ".jsx", ".ts", ".tsx"];

export function analyzeLogging(repo: string): LoggingResult {
  const skipped = (note: string): LoggingResult => ({ status: "skipped", note, issues: [] });

  const files = walkFiles(repo, JS_EXTS);
  if (files.length === 0) return skipped("no JS/TS files found");

  const issues = [];
  for (const f of files) {
    const content = fs.readFileSync(f, "utf8");
    for (const m of content.matchAll(/console\.(log|debug)\(/g)) {
      issues.push({
        type: "logging",
        severity: "warning",
        file: f,
        line: lineOf(content, m.index),
        description: "console.log/debug left in source (consider a logger)",
      });
    }
  }
  return { status: "ok", issues };
}
```

Note how findings carry `file` (+ `line` where sensible) — that is what lets the correlation
engine attach them to a root-cause cluster. Findings with no files will never cluster.

### 3. Register it in `src/analyzers/index.ts`

```ts
import { analyzeLogging } from "./logging.js";
// in runAllAnalyzers:
logging: analyzeLogging(repo),
```

### 4. Show it in the scan box — `src/commands/scan.ts`

`renderBox()` builds one `label(...)` line per analyzer. Follow the existing pattern
exactly: a `skipped` branch (yellow, with `note`), a `status === "ok"` branch that prints
counts colored by severity:

```ts
const lg = r.logging;
if (lg.status === "ok") {
  const body =
    lg.issues.length > 0
      ? chalk.yellow(`${lg.issues.length} issue(s)`)
      : chalk.green("0 issues");
  lines.push(`${label("Logging")}: ${body}`);
} else {
  lines.push(`${label("Logging")}: ${chalk.yellow("skipped")} — ${lg.note ?? "unavailable"}`);
}
```

### 5. Feed it into clustering — `src/graph/correlate.ts`

`collectFindings()` converts analyzer output into `ClusterFinding`s. Add your source to the
`ClusterFinding.source` union in `types.ts` (`"security" | "duplication" | "graph" | "a11y" |
"reliability" | "devex" | "logging"`), then append a block:

```ts
for (const i of r.logging.issues) {
  findings.push({
    source: "logging",
    severity: i.severity,
    type: i.type,
    description: i.description,
    files: i.file ? [path.relative(repo, i.file)] : [],
  });
}
```

`correlate()` does the rest — findings sharing files (or files within 1–2 graph hops) group
into clusters, and the highest-scoring finding becomes the root cause.

### 6. (Optional but nice) Surface it in `src/report/format.ts`

The report box shows one summary line per dimension. Add a matching line so `pitstop report`
aggregates your dimension too.

### 7. (Optional) Make it verifiable in `src/verify/metrics.ts`

If your analyzer produces a number that matters (issue count, duration), wire it into
`metricsOf()`/`deltasOf()` and the verify table in `src/commands/verify.ts` so the loop can
measure "is this getting better or worse?"

You do **not** need to touch `src/commands/ci.ts` — it reuses `runScan`, so your analyzer is
present in `pitstop ci` and the GitHub Action comment automatically.

## Conventions (read these — they're the review criteria)

- **Never throw.** Every analyzer returns `{ status: "skipped" | "error", note }` when it
  can't run (missing tool, no matching files, timeout). A scan must never crash because one
  dimension failed. Wrap risky work in `try/catch` and degrade to `skipped`.
- **Graceful skip, always.** Missing `jscpd`/`pa11y`/`ts-prune` → skip with a note, don't
  error. "skipped — tool not found" is a feature.
- **Label your heuristics.** Anything that is a structural guess (race smells, duplicate
  functions, clickable-`div` a11y) must say so in a comment and in the description. Never
  present a heuristic as ground truth.
- **Caps and timeouts.** Use `safeExec(..., timeoutMs)` for subprocesses and cap file sweeps
  (see `MAX_RUNTIME_FILES`, `MAX_DUP_FINDINGS`, `MAX_SUITE_MS`). Scans must stay fast.
- **Use `util.ts`.** `walkFiles` already ignores `node_modules`, `dist`, `.git`, `.pitstop`,
  `demo-repo`, etc. Do not hand-roll traversal.
- **Severity vocabulary.** `critical / high / medium / low / info` — `correlate.ts`'s
  `SEVERITY_RANK` scores clusters by severity + graph centrality. Unknown severities are
  treated as `medium`; pick deliberately.
- **`demo-repo` is a fixture.** It's intentionally broken and excluded from real scans. Test
  your analyzer on real code and a scratch repo you create, not just the demo.
- **No new runtime dependencies without discussion.** The CLI ships zero heavy deps; if your
  analyzer needs one, prefer shelling out to an installed tool (like every other analyzer)
  and open an issue to discuss.

## Testing

```bash
npm run build
node dist/cli.js scan .              # scan this repo (a11y/perf will skip — that's correct)
node dist/cli.js scan demo-repo       # the seeded-broken repo: expect a real cluster
node dist/cli.js demo                 # full loop rehearsal in a temp dir
node fixtures/assertion-literal-tamper/verify.mjs  # integrity detector fixture (cheat vs honest)
```

For a full-loop test: run `node dist/cli.js demo`, `cd` into the printed temp dir, then walk
the slash-command steps by hand — `scan` → confirm → fix → `verify` → `memory add` →
`scan` → `report`. The loop must reach `nothing left to fix, nothing broken.` with a
`PITSTOP_REPORT.md` written.

## Opening a pull request

- Branch from `master` with a short descriptive name (`feature/logging-analyzer`).
- One logical change per PR. A new analyzer is one PR; a refactor is another.
- Run `npm run build` and a smoke scan before pushing.
- Describe in the PR body: what the analyzer detects, what it skips (and why), and a sample
  of its output. Screenshots of the scan box before/after are very welcome.
- `main`/`master` is protected: CI runs `npm ci && npm run build` plus a smoke scan of
  `demo-repo`. Make sure your change is green there.

## Code of conduct

Be kind, be specific, and assume good faith. Every analyzer ships an honest caveat about
what it can and can't prove — the same spirit applies to review comments.
