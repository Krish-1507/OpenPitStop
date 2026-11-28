# Deep Codebase Intelligence and Engineering Quality Audit

`pitstop audit` is a whole-repository engineering review, not a diff review. It builds a
repository index first, then asks eight measured questions about the code and the way it is
put together. Every finding carries a location, evidence, a confirmation level and a
trade-off; every point in the score traces back to a finding. The default is read-only.

```bash
pitstop audit .
pitstop audit . --mode quick --json
pitstop audit . --category architecture,type-safety --fail-on high
pitstop audit . --eval
```

Quick and deep run offline, execute no repository code and call no model or telemetry
service. Full mode runs the project's existing analyzers, which may execute its test suite or
build and may therefore use their normal network or toolchain access; this is documented in
`--help` and in the report. OpenPitStop itself does not install packages. Audit artifacts stay
under the repository's `.pitstop/` directory, a `--report` target writes where asked, and an
explicitly applied fix plan (`--apply ... --yes`) creates an isolated worktree under
`.pitstop/` without editing the source tree.

## Modes

| Mode | File budget | What it adds | What stays unmeasured |
|---|---|---|---|
| `quick` | 500 | AST/lexical index, deterministic rules, score, risks, report | Security, git churn, full analyzers; disclosed in the report |
| `deep` (default) | 2,500 | Everything in quick plus static security rules, git churn and boundary checks | No test/build execution; security is pattern-based |
| `full` | 2,500 | Deep plus the repository's existing analyzers (security, tests, reliability, build/perf where available) | May execute the project's test/build scripts and use their normal network/toolchain access; still not a penetration test or a coverage run unless the repository provides one |

`--max-files` can lower or raise the budget up to 20,000. `--scope` narrows the index to a
repository-relative directory or file (repeatable). A scope outside the repository is
rejected. `--no-cache` ignores the local index cache, and `--no-persist` skips the audit
report, cache and baseline writes under `.pitstop/`. A plan explicitly requested with
`--fix-plan` is still written because it is the requested output.

## What is indexed

The index is deliberately explicit about its reach:

- JavaScript and TypeScript are parsed with Babel (`@babel/parser`): functions, parameters,
  imports, calls, routes, test declarations, loops, catches, regex literals, numeric and
  string literals, `any` annotations and non-null assertions.
- Python is scanned with an indentation-aware lexical index. It records functions, broad
  `except` handlers, imports, loop bodies and database-shaped calls. It is not a Python AST
  and it does not build a Python call graph.
- Every other supported language is detected by extension, counted in coverage and marked
  `semantic: none`. Its files are never presented as clean; they are disclosed as not
  semantically audited.
- `node_modules`, `.git`, build outputs, virtual environments, package caches,
  dot-directories, and the benchmark/template/demo fixture directories that `pitstop scan`
  also treats as out of scope (for example `bench/` and `templates/`) are excluded. The
  bundled evaluation suite targets its fixtures directly, outside this default walk. Files
  above 400 KB are skipped with a warning.

The resolved call graph only contains calls that resolve through a relative import or a
same-file declaration. Method calls, aliases, reflection and dynamically registered routes
stay unresolved and are counted as such rather than guessed.

## Eight measured areas

The categories and their weights are fixed so two runs can be compared:

| Category | Weight | What is measured |
|---|---:|---|
| Correctness and reliability | 22 | empty or swallowed errors, floating async calls, unhandled failure shapes |
| Maintainability | 18 | long/complex/nested functions, duplication, unused imports and exports, cycles |
| Architecture and design | 14 | import cycles, declared boundary violations, route-to-handler paths |
| Performance and efficiency | 12 | awaits in loops, database/network calls in loops, sync I/O on a request path, repeated calls |
| Code quality and readability | 10 | hardcoded absolute paths, repeated magic numbers, machine-specific values |
| Type safety | 10 | explicit `any`, type-check bypasses, repeated non-null assertions, loose equality |
| Security practices | 8 | regex backtracking, dynamic regex construction, and the existing static security analyzer |
| Testing and verification | 6 | tests without assertions, skipped/todo tests, structural test inventory |

### Rule catalogue

| Rule | Category | Confirmation |
|---|---|---|
| `function-too-long` | maintainability | confirmed above 80 lines |
| `function-too-complex` | maintainability | confirmed at cyclomatic complexity 15 or more |
| `deeply-nested-code` | maintainability | confirmed at five or more control-flow levels |
| `duplicate-function` | maintainability | structural: normalised five-token prefix plus 90% token similarity across functions; same-file same-name pairs are skipped |
| `unused-import` | maintainability | confirmed by binding-use analysis |
| `unused-export` | maintainability | unproven: no consumer in the audited file set, but it may be a published API |
| `empty-catch` | correctness | confirmed empty catch / broad empty `except` |
| `swallowed-error` | correctness | potential: catch logs and continues without rethrowing or narrowing |
| `floating-async-call` | correctness | potential: async call neither awaited nor caught |
| `await-in-loop` | performance | structural: sequential awaits in a loop; impact depends on iteration count and latency |
| `database-or-network-call-in-loop` | performance | potential N+1 shape; the call is never executed to prove latency |
| `sync-io-on-request-path` | performance | structural: blocking I/O reachable from a resolved route |
| `repeated-identical-call` | performance | structural: same call and arguments repeated in one function |
| `hardcoded-url` | maintainability | confirmed duplicated environment URL across files |
| `hardcoded-absolute-path` | readability | confirmed machine-specific absolute path |
| `magic-number` | readability | potential: repeated raw numeric literal across files |
| `regex-backtracking` | security | potential: nested-quantifier shape associated with catastrophic backtracking |
| `dynamic-regexp` | security | potential: `RegExp` constructed from a non-literal |
| `any-usage` | type-safety | confirmed explicit `any` (parameter, return, cast or annotation) |
| `type-check-bypass` | type-safety | confirmed `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` |
| `non-null-assertions` | type-safety | confirmed repeated `!` assertions |
| `loose-equality` | type-safety | confirmed non-null `==` / `!=` |
| `test-without-assertion` | testing | potential: no known assertion in the test callback |
| `skipped-tests` | testing | confirmed `skip` / `todo` test declaration |
| `import-cycle` | architecture | confirmed cycle in the resolved import graph |
| `boundary-violation` | architecture | confirmed import forbidden by `openpitstop.architecture.json` |
| `security-static` | security | confirmation follows the existing static analyzer; not proof of exploitability |

The `unused-export` consumer count includes value and type-only imports, named
re-exports such as `export { Foo } from "./types.js"`, and type references in
function signatures. A used `import * as ns` or an `export *` barrel makes every
target export potentially reachable, so those targets are not called unused. The
count is relative to the audited file set: a scoped run says so in the finding.

## The finding contract

Each finding answers the questions a reviewer would ask before acting:

- **Where**: file and line range, plus a symbol when one is known.
- **Why it matters here**: the observed pattern, not a generic lint description.
- **Confirmation**: `confirmed` (the pattern is definitely present), `potential` (the shape
  is present but impact depends on runtime context) or `unproven` (a lead that needs a
  human decision, such as an unused export that may be public API).
- **Confidence**: how sure the rule is about its own observation, separate from severity.
- **Evidence**: at least one source/detail pair, usually with a short redacted excerpt.
- **Suggestion**: what to change, the trade-off, and whether the tool can produce a safe
  deterministic patch.

Findings are deduplicated by rule, file and an anchor. When a symbol is available the
anchor contains the symbol plus the measured line text and an occurrence index; without a
symbol it is a hash of the measured block plus an occurrence index. Anchoring to text rather
than a bare line range keeps a finding's identity when unrelated lines are inserted or removed
above it, and the occurrence index keeps repeated identical blocks distinct. A duplicate never
consumes two score deductions. The stable fingerprint is `rule|file|anchor`; the short
`aud-...` id is for display and cross-references.

## Engineering Quality Score

The score is a weighted average of category scores on a 0-100 scale:

```text
raw_points = base(severity) x confirmation_factor x confidence_factor
category_deduction = sum(raw_points x decay[rank within category])
category_score = max(0, 100 - category_deduction)
overall = sum(category_score x weight for measured categories) / measured_weight
```

| Input | Values |
|---|---|
| Base points | critical 30, high 18, medium 9, low 3 |
| Confirmation factor | confirmed 1.0, potential 0.7, unproven 0.3 |
| Confidence factor | high 1.0, medium 0.85, low 0.65 |
| Diminishing decay | 1.0, 0.75, 0.55, 0.4, 0.3, 0.25, 0.2, then 0.2 |
| Severity cap | confirmed critical caps overall at 79; confirmed high caps it at 89 |
| Grades | 95+ excellent, 80+ strong, 70+ fair, 60+ weak, below 60 critical |

Categories with no measured signal (for example security in quick mode) are excluded and
the remaining weights are re-normalised, so a shallow mode is not punished for what it
never attempted. A confirmed severe finding still caps the overall score: category averages
must not hide a critical defect.

Score transparency has three properties:

1. `score.deductions` lists every applied point with its finding id, rule, raw points and
   post-decay points. The sum of a category's points equals its deduction total.
2. `score.band` reports the precision band and `score.confidence` the evidence quality;
   parse failures and files in languages without rule coverage widen the band and can lower
   confidence, but they are not counted as findings.
3. The report prints the measured weight and any category note, such as "security is not
   measured in quick mode" or "structural test inventory; line coverage is not inferred".
4. Per-rule and global finding budgets can omit findings, so a capped run's score is an upper
   bound on the evidence it displays. The report then says the complete view is unavailable.
   The global budget reserves one finding per affected category first, so a noisy category
   cannot make another category look clean. Suppressed findings are exempt from both budgets.

The score is an engineering signal, not a certification. It is sensitive to repository size,
scope and the file budget: a 500-file budget on a 5,000-file repository describes those 500
files, not the repository. Always read coverage and limits with the number.

## Lifecycle, baselines and suppressions

With persistence enabled, a sealed report is written to `.pitstop/audit-latest.json` and
`.pitstop/audit-latest.md`, plus a timestamped pair. The next run compares stable
fingerprints:

- `new`: not present in the previous sealed audit.
- `existing`: present in both runs.
- `resolved`: in the previous audit, absent now from a file and category this run actually
  examined. Files outside the scope, skipped by the budget or left unparsed, and categories
  not selected in the current run are never labelled resolved. The old finding is listed under
  `resolved`; it does not deduct points.
- `suppressed`: matched a local suppression. It stays visible with a reason, leaves the
  active count and score, and is not silently deleted.

The baseline is only used if its top-level evidence digest verifies and, when present, its
nested `contentDigest` also verifies. A missing, malformed or tampered baseline is reported
and skipped, not trusted. An artifact from another repository, or one
whose report was scoped, budget-limited or otherwise incomplete, is skipped for lifecycle
comparisons because it only contains what it examined; use a complete run as the baseline. Suppressions live in
`.pitstop/audit-suppress.json`:

```json
{
  "suppressions": [
    { "fingerprint": "unused-import|src/worker.ts|symbol:path|content:1a2b3c4d5e6f:0", "reason": "kept for the platform shim", "expires": "2026-12-31" }
  ]
}
```

A date-only expiry covers that whole UTC day; an explicit timestamp is exact. An expired
suppression, or one with an unparseable expiry, is ignored with a warning. The
suppressed finding stays visible in the Markdown and JSON with its reason and expiry, even
when the active finding budget is reached, and it leaves the score. A suppression is not a
claim that the code is correct; it is a time-limited, auditable decision.

## Risk prediction

Risks are separate from findings. They combine index shape, findings, coverage, churn and
the repository's own verification commands to describe what could go wrong next. Each
prediction carries the assumption that would have to hold, a confidence level, an impact
and a horizon. Predictions are never counted as confirmed defects and never deduct score
points.

Up to eight risks are emitted for the categories this run measured, covering:

- churn hotspots that also contain medium/high findings;
- complex route handlers without a nearby same-stem test file;
- import cycles in actively changing modules;
- a missing test inventory or a thin structural test count;
- no detectable test/typecheck/lint/build command;
- unsupported languages counted but not semantically audited;
- widespread explicit `any` usage;
- a failing existing test suite in full mode.

Git churn is read locally. If git is unavailable, blocked, or the directory is not a
repository, the report says so and skips churn-based risks rather than treating them as zero.

## The report

The Markdown report has fifteen sections, in order:

1. Executive summary
2. Scope, method and limits
3. Repository profile
4. Engineering Quality Score
5. Score breakdown
6. Confirmed findings
7. Potential and unproven findings
8. Architecture and dependencies
9. Performance and unnecessary operations
10. Type safety, readability and hardcoding
11. Security posture
12. Testing and verification
13. Predicted risks
14. Strengths and positive signals
15. Prioritized recommendations

Section 2 records the requested scope, effective file budget and whether the run has a
complete file view; the reproduce command repeats scope, budget and measured
categories so a scoped or budget-limited result can be recreated instead of silently
becoming a whole-repository run. `--json` returns the report model plus the CLI's
artifact paths, fix-plan path (when requested) and run warnings. `--report <file>` also
writes the Markdown to a chosen path.

The exact printed JSON is sealed with `pitstop-canonical-sha256-v1`; editing it
invalidates the digest. Because the shared seal excludes nested `evidence` fields, an
audit report also carries a `contentDigest` over the full report, including each finding
and risk evidence entry. Editing a finding excerpt therefore breaks `contentDigest` even
though the top-level seal alone would not see that nested field. Older reports without
`contentDigest` remain readable, and their top-level seal is still checked.

## Fix plans are reviewed, isolated and verified

`--fix-plan` writes a sealed `.pitstop/audit-fix-plan.json` containing only deterministic
patches (currently unused-import removal). It never changes source.

`--apply .pitstop/audit-fix-plan.json --yes` is the approval step (a relative plan path
is resolved against the audited repository):

1. The plan must verify its evidence digest and name the same repository.
2. The patch must still match the exact line content; changed lines are skipped, not
   force-applied. Paths that escape the repository, target `.git`/`.pitstop`, or resolve
   outside the isolated worktree are skipped.
3. A separate git worktree is created under `.pitstop/audit-worktrees/` from `HEAD`;
   uncommitted working-tree changes are not copied, so a plan that depends on them will
   skip lines rather than guess. The source working tree is never edited. A worktree with
   applied patches is left for review; a no-op worktree is removed.
4. The relevant verification commands (test, typecheck, lint, build) are run in the
   worktree. A failed command is reported, never hidden. If no patch matched, no command runs.
5. The audit is rerun in deep mode. With a comparable complete sealed deep baseline that
   measured every category, and a complete all-category re-audit, it reports before/after
   scores, resolved fingerprints and regressions; otherwise it reports the after score and
   skips the delta rather than inferring a fix from an incomplete or differently scoped run.
6. Nothing is committed. The user reviews and merges the worktree change.
7. Without `--yes`, the command refuses and exits nonzero.

Applying a plan runs a subset of the repository's own scripts, so the same trust decision
as running the project's test suite applies. The tool does not install dependencies.

## Evaluation suite

`pitstop audit . --eval` runs the bundled local suite. It is deliberately adversarial and
includes negative controls:

| Scenario | Seeded signal | Negative control |
|---|---|---|
| `js-seeded-quality` | N+1 call, empty catch, hardcoded path, unused import, `any`, duplicate copy | `src/clean.ts` must stay clean |
| `js-clean` | no defects | clean repository must score high and produce no false positives |
| `js-cycle` | import cycle | unrelated files must not be reported |
| `regex-safety` | backtracking and dynamic regexp shapes | a safe literal regexp must not fire |
| `floating-promise` | unawaited async call | an awaited call must not fire |
| `python-quality` | broad except, N+1 shape | a handled exception must not fire |
| `unsupported-language` | Go/Rust files | detected with `semantic: none`; no invented findings |
| `architecture-boundary` | forbidden import | a permitted import must not fire |

Each scenario runs twice to check determinism, then verifies: positive recall, negative
precision, maximum finding budget, score bounds, language disclosure, all fifteen sections,
evidence completeness, deduplication and score traceability. The suite reports precision and
recall as measured on these fixtures only. The fixtures are written by the same project as
the rules; this is a regression suite, not an independent benchmark.

## Architecture and integration plan

The capability was added as a new layer rather than a parallel scanner:

- `src/audit/indexer.ts` builds one repository index and reuses the language adapters,
  `findCycles` and `isTestFile`; it does not parse files a second way.
- `src/audit/jsParser.ts` and `pythonIndex.ts` produce serializable per-file indexes, cached
  by content hash. The Babel AST is never persisted.
- `src/audit/rules.ts` applies deterministic rules to the index. `security-static` adapts
  the existing security analyzer's `ScanIssue` results; it does not reimplement it.
- `src/audit/score.ts` is the only place score points are assigned. `run.ts` orchestrates
  index -> rules -> suppressions -> baseline -> score -> risks -> report -> seal.
- `src/audit/report.ts` renders the fifteen sections; `src/audit/eval.ts` is the separate
  evaluation harness; `src/audit/fixes.ts` owns the approval-based worktree workflow.
- `src/commands/audit.ts` is a thin Commander adapter; `src/cli.ts` registers it beside
  `check` without changing existing commands.

The implementation order was: index and parser, rules, score and risks, report/CLI,
lifecycle and suppressions, fix plans, evaluation suite, then tests and docs. Existing scan,
check, gate, evidence and benchmark paths were left untouched; the audit reads their
artifacts and adapters rather than copying them.

### How it differs from the five existing phases

| Existing capability | Scope | Audit adds |
|---|---|---|
| `scan` | One quick whole-repo score with existing detectors | A repository index, eight weighted areas, traceable score, risks and a fifteen-section review |
| `check quick/deep/ship` | Guided check stack over a change or repository | A read-only engineering review that does not require a git diff; reuses check analyzers in `full` mode |
| `understand` / `map` | Architecture, routes and entry points | Consumes them, then reasons about boundaries, cycles, large functions and risks |
| `verify` / `gate` / `integrity` | Evidence and release decisions | Produces its own sealed report and baseline; no gate verdict is reused or weakened |
| `bench` | Detector benchmark on committed fixtures | Adds a separate audit suite with negative controls and report-integrity checks |

## Performance and scale

- The index is content-hashed and cached under `.pitstop/`. A cache hit avoids parsing but
  does not avoid reading and hashing the file.
- File budgets are enforced before parsing; skipped files are counted in coverage and named
  in the limits, never silently dropped.
- Duplication compares a capped sample and reports the denominator ("compared N of M
  functions") rather than implying a full comparison.
- Active finding output is capped per noisy rule (for example 60 unused imports) and
  globally at 250 after severity ordering, with a warning for each cap and how many findings
  were omitted. Suppressed findings are exempt so a user decision does not disappear. The
  score uses the findings that were produced; any capped run is explicitly marked as a
  budget-limited view and should be read with coverage.
- There is no parallel worker pool. Very large repositories will take longer; `quick` is the
  supported first pass.

## Security and privacy

- No telemetry, account, hosted model or network call is required for quick/deep.
- Full mode and fix verification run the repository's own analyzers/scripts; those may use
  the network, exactly as running the project normally would.
- Evidence excerpts and structured evidence details are short and redacted for common secret
  patterns. Reports and the index cache can still contain file names, code locations and
  extracted literals (for example hardcoded URLs or tokens), so keep `.pitstop/` untracked
  and review artifacts before sharing.
- Path traversal is rejected in scopes and patch targets. Fix plans cannot write absolute
  paths or paths containing `..`.
- The tool never installs packages, starts the application or commits on its own.

## Honest limits

- Rules are pattern- and structure-based. A confirmed finding proves the code shape, not a
  user-visible bug. Potential findings require runtime context.
- Python has lexical coverage, not an AST or call graph. Other languages are detected only.
- Security is static and shallow. It is not taint analysis, a penetration test or a
  dependency audit.
- Severity is an impact estimate for the pattern, not a CVSS score and not a probability.
- The score is not a certification and is not comparable across different repositories,
  scopes or file budgets without reading coverage.
- Import cycles and execution paths depend on resolvable relative imports and recognised
  route registrations; aliases, reflection and dynamic registration stay invisible.
- The evaluation fixtures are not an independent benchmark and do not establish general
  precision or recall.
- A fix plan covers only deterministic patches; it is not an autonomous repair system.
- Fix application starts its isolated worktree from `HEAD`; uncommitted changes in the
  source tree are not copied there, so review a dirty-tree plan before applying it.

## Tests

`test/audit.test.ts` covers parser exports and signature `any` counting, the Python lexical
index, seeded defects and clean controls, unsupported-language disclosure, scope and budget
honesty, suppression and baseline lifecycle, sealed fix-plan validation and tamper rejection,
and score caps/traceability. `test/auditEval.test.ts` runs the bundled evaluation suite and
asserts its report-integrity checks. Run them with `npm test`; typecheck with
`npm run typecheck`.

Related: [languages](languages.md), [architecture](architecture.md), [security](security.md),
[benchmark](benchmark.md), [first-run](first-run.md).
