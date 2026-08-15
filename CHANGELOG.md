# Changelog

All notable changes to this project are documented here.

## [1.2.0] - 2026-08-15

The credibility release: friendly everywhere, honest about the network, and the
one-liner now does the whole onboarding.

### Added

- **Guided first-run (`npx openpitstop`, no args).** Detects your AI tools and
  git repo, then asks: install `/pitstop` into your tools, score *this* repo
  (`try .`), or watch the 90-second demo. Non-TTY prints the one-line menu
  instead. The landing page is now a complete product demo with zero docs
  reading.
- **`PRIVACY.md`.** The auditable version of "zero telemetry, zero SaaS":
  every network call the CLI can make, everything it stores, and how to verify
  both (read the source, firewall-watch a run, run offline). Added to the npm
  package.

### Changed

- **Honest failure paths.** A corrupt or missing lockfile no longer reports
  `Security: 0 issues — clean` — the audit error becomes an honest `skipped`
  with a repair hint (`npm i --package-lock-only`). Same for `pip-audit` and
  `osv-scanner` failures: dependencies that were never scanned are never
  reported as clean.
- **Friendly errors instead of silence or ceremonies.** `pitstop integrity`
  outside a git repo says so with a hint (exit 1) instead of printing a
  meaningless CLEAN verdict; `pitstop pen` on a repo with no `start` script
  and nothing to attack aborts with a one-line hint (exit 2) instead of
  producing an empty report.
- **Global crash handler.** An unexpected error is now a friendly one-liner
  with a bug-report hint and `PITSTOP_DEBUG=1` for the full stack — a crash is
  a bug report, never a bare stack dump on someone's terminal.
- **Windows runthrough.** `watch`, `pen`, `pen --fix` and `scan --ledger`
  verified end-to-end on a real Windows host (live watch delta; 3 PROVEN
  ledger double-charges with sealed evidence; honest pen verdicts including
  the 0-patch case). README's Known Limitations updated to claim exactly
  what was run.

## [1.1.0] - 2026-08-14

The distribution release: the gate gets everywhere — PRs, pre-commit — and the
receipts get published.

### Added

- **GitHub Action (`action.yml`).** A composite action, usable today as
  `uses: Krish-1507/OpenPitStop@main`, and ready to publish as
  `openpitstop/action@v1`: runs `pitstop ci` + `pitstop gate` on every PR,
  posts the verdict as a (deduped, marker-based) PR comment, publishes the
  report to the job summary, and fails the job when the gate fails — so branch
  protection blocks the merge. No baseline yet → warns and passes, never jails
  a fresh repo. See `docs/github-action.md`, including the self-regenerating
  `PITSTOP_BADGE.svg` badge-loop workflow.
- **`pitstop install --hooks`.** Installs the git pre-commit gate hook
  (`.git/hooks/pre-commit`). Every commit is gated before it can land —
  SUSPICIOUS → blocked (exit 1), CONFIRMED_CHEAT → blocked (exit 2). Never
  blocks the first commit of a repo, warns (does not jail) repos without a
  baseline, honors `PITSTOP_CLI`/`PITSTOP_SCORE`, and can be bypassed once
  with `git commit --no-verify`. Removed with
  `pitstop install --uninstall --hooks`. Verified end-to-end on Windows
  (direct hook run, blocked commit, clean commit).
- **`docs/caught-in-the-wild.md`.** Four real, verbatim, redacted catches with
  the actual gate output — focused test (SUSPICIOUS, exit 1), deleted test
  (CONFIRMED_CHEAT, exit 2), assertion edited to match the bug
  (CONFIRMED_CHEAT, exit 2), baseline edited after signing (Evidence:
  TAMPERED, exit 1) — plus the pre-commit blocked/clean transcripts and a
  clean-pass contrast. Screenshot-ready social proof.
- **Demo recording mode.** `scripts/cheat-demo.cjs --fast --no-pitch` reuses
  the cached `node_modules` from `demo-repo-integrity` (skips `npm install`)
  and ends the arc on the CONFIRMED_CHEAT gate box — no pitch, no dead air,
  for the 90-second re-record.

## [1.0.0] - 2026-08-14

The launch release. OpenPitStop is the agent referee, renamed and rebranded from
Guardian CLI — and the entire first-run experience is now zero-friction.

### Added

- **Rebrand: Guardian CLI → OpenPitStop.** Package `openpitstop`, binary `pitstop`, slash
  command `/pitstop`, storage `.pitstop/`, env vars `PITSTOP_*`, evidence scheme
  `pitstop-canonical-sha256-v1`, and rebranded docs/media/CI. The old `guardian`-named CLI
  is deprecated.
- **Custom asks (`/pitstop <your question>`).** Free-form text after `/pitstop` — e.g.
  `check the security of this app`, `are our tests flaky?`, `did my agent cheat on the
  last commit?` — runs a scoped loop instead of the generic one: the agent maps the ask to
  the right command (`pen` for security, `integrity` for cheats, `scan` for health/tests),
  restates its interpretation in a single line, confirms before fixing anything, and fixes
  only what was asked.

### Changed

- **Bare `/pitstop` now runs, no menu.** Typing `/pitstop` and hitting enter starts the
  full quality loop immediately (scan → confirm → fix → verify → repeat) instead of
  printing a mode menu and waiting. The menu still exists as `/pitstop --menu`; flags
  (`--scan-only`, `--demo`, `--ledger`, `--integrity-only`, `--pen`) and custom asks stay
  as the power paths. Fallback for unsubstituted arguments is the default full loop, never
  a guess.
- **Cleaner first message.** The agent acknowledges with a single line
  (`/pitstop — running the quality loop.`) instead of printing the full instruction block;
  `pitstop prompt` remains the full-transparency preview.
- **Honest first-run copy.** `npx openpitstop try .` scanned in ~2s, but the first-ever
  `npx` run downloads the package first — the Install section now says so and offers
  `npm i -g openpitstop` for instant starts, and the README documents the
  `npx openpitstop install -y` refresh flow for tool command files.

## [0.9.1] - 2026-08-06

### Changed

- **Docs aligned with 0.9.0.** README scan section now lists pip-audit/osv-scanner and
  the native test suites (Go, Rust, Flutter/Dart, .NET, Java); the `/pitstop --ledger`
  prompt description now names both sandboxes (nock preload for Node/JS, recording
  HTTP(S)_PROXY server for other stacks); CONTRIBUTING directory map includes
  `suiteRunner.ts`, `routes.ts` and `src/sandbox/`. Removed the deleted
  `docs/feature-tour.md` reference.

## [0.9.0] - 2026-08-06

### Added

- **README demo GIF + video.** `docs/media/pitstop-demo.gif` (780px, ~34 s)
  and `docs/media/pitstop-demo.mp4` (1080p, ~34 s) — the cheat-catch demo
  captured from the tool's real output (npm-install dead time trimmed), now
  embedded in the README's "See it in 90 seconds" section.
- **README feature tour.** Eleven per-feature GIFs
  (`docs/media/pitstop-{scan,verify,trends,inspect,repro,pen,report,share,honesty,try,watch}.gif`)
  captured from real command output, each embedded in its own "Feature tour"
  section with a one-line caption.
- **Cross-stack support (Go, Rust, Dart, .NET, Java).** `detectLanguage` now recognizes
  go.mod / Cargo.toml / pubspec.yaml / .csproj / pom.xml / build.gradle repos, and every
  analyzer that was Node/Python-only now has a real path for the new stacks:
  - **`pitstop scan` runs native test suites** through a new shared runner
    (`src/analyzers/suiteRunner.ts`) that parses each toolchain's real output — `go test
    -json`, `cargo test --format json` (Rust ≥1.70), `flutter test --machine`, dotnet
    test summaries, Maven surefire and Gradle test-result XML. Missing toolchains report
    `skipped` with an honest note; unparseable output is an error, never a guess.
  - **`pitstop scan --security`** falls back to **osv-scanner** (cached per lockfile-set
    in `.pitstop/cache/`) when the tool isn't pip-audit or Node's audit — one
    vulnerability path for every language.
  - **Reliability runs and perf guard** (`.pitstop/cache/reliability-*.json`) work for
    the new stacks: builds via `go build ./...`, `cargo build`, `flutter build web`,
    `dotnet build`, `mvn package -DskipTests` / `gradle assemble`.
  - **`pitstop repro`** knows the new frameworks (`go`, `cargo`, `flutter`, `dotnet`,
    `maven`, `gradle`), places tests in the right directory per stack
    (`_test.go`, `test/`, `tests/`), and **refuses honestly** to generate non-perf
    repros for stacks without a proven native recipe (the old behavior silently produced
    un-runnable Node tests).
- **`pitstop pen` + `--ledger` proxy sandbox for non-Node apps.** A recording
  `HTTP_PROXY` (`src/sandbox/proxy.ts`) replaces the nock preload for Go/Python/Rust/.NET
  apps: known payment-gateway hosts get mocked success receipts written to the same
  gateway JSONL contract (evidence stays sealed and unchanged), SSRF canaries answer
  in-band, every other outbound host is blocked (502) and recorded — no byte leaves the
  machine. HTTPS is refused (502 CONNECT) with an honest `indicated` ceiling, and
  command-injection in proxy mode is reported `indicated` (the proxy cannot observe
  spawns). Java/Dart are refused for ledger (their clients ignore `HTTP_PROXY`).
  `PITSTOP_START` overrides native start-command guessing (`manage.py`, `go run .`,
  `cargo run`, `dotnet run`, `mvn spring-boot:run`, gradle `bootRun`).
- **Multi-language route discovery.** `src/analyzers/routes.ts` finds routes in JS,
  Python, Go (gin/echo/chi/gorilla/net-http), Rust (axum/actix), Java (Spring), C#
  (ASP.NET) and Dart (shelf), now shared by `pitstop pen`'s static/dynamic phases and
  ledger mode's endpoint discovery.
- **Unit tests for the new modules** (`test/proxy.test.ts`, `test/routes.test.ts`):
  canary/blocked/gateway/loopback/CONNECT proxy behaviour over real sockets, and the
  route matchers per language.

### Changed

- **README voice.** The README now opens with **"Why I built this"** — a
  first-person story framing OpenPitStop as the author's own daily-driver
  workflow tool (no invented user base), plus a zero-setup **`npx
  openpitstop try .`** call-to-action ("two seconds, your repo, your score")
  and explicit dogfooding claims (CI scans a real repo with OpenPitStop on every
  push; the evidence-chain regression tests came from OpenPitStop catching a bug
  in itself).

## [0.8.4] - 2026-08-06

### Changed

- **README overhaul.** The README now opens with a standout **"See it in 90
  seconds"** hook (the scripted cheat-catch arc), a "loop at a glance" ASCII
  diagram, and a complete **"Every command"** reference — all 23 commands
  grouped by job (measure / fix loop / integrity & anti-cheat / penetration
  test / proof & reports / setup), so every command is one glance away.
- **`docs/demo.md`** gained **Act 0 — the 90-second wow** (the cheat-demo arc,
  moved from the footnote to the opening), and **`LAUNCH.md`** now leads its
  "Show, don't tell" section with the cheat-catch demo.

## [0.8.3] - 2026-08-06

### Fixed

- **The evidence chain actually verifies now.** `canonicalize` hashed keys
  whose value was `undefined`, but `JSON.stringify` drops those keys when the
  sealed document is written — so every scan's stored digest never matched the
  file on disk, and every gate reported `Evidence: TAMPERED` for baselines it
  had just written itself. The canonicalizer now matches JSON serialization
  semantics (undefined-valued keys are omitted), so a fresh scan → gate is
  `verified`. Regression-tested in `test/evidence.test.ts` (round-trip,
  tamper, missing, order-independence).
- **`scripts/cheat-demo.cjs` ACT 3** now force-removes the test file
  (`git rm -f`), which previously failed silently because ACT 2 leaves local
  modifications in it — the demo now reliably shows the full
  SUSPICIOUS (exit 1) → CONFIRMED_CHEAT (exit 2) arc.

### Added

- **`scripts/cheat-demo.cjs` — the 90-second cheat-catch demo.** A fully
  scripted, deterministic arc on a real repo (`demo-repo-integrity`, a float
  bug with a failing jest test): ACT 1 scans an honest baseline (1 failed),
  ACT 2 a lazy "agent" focuses the suite on the passing tests — gate blocks
  with `SUSPICIOUS` (exit 1) — ACT 3 it deletes the failing test — gate blocks
  with `CONFIRMED_CHEAT` (exit 2). The tamper-evident baseline verifies on
  every run. Point `PITSTOP_CLI` at a build (`node D:/OpenPitStop-cli/dist/cli.js`)
  or use `npx openpitstop`.
- **Runtime-proof verdicts for static pen findings** (`pitstop pen`): every
  static finding now carries a live verdict — `proven` (its proving dynamic
  attack fired and the canary came back), `indicated` (static rule fired but
  the dynamic phase couldn't confirm), `unproven` (dynamic phase ran and found
  no evidence for this rule), or `not-tested`. The box, markdown report and
  HTML report all render a per-finding runtime note plus a summary line
  ("Static findings verified live: 1 proven · 1 indicated · 3 unproven").
  Proven static findings also get replayable repro tests via `--fix`, and
  `pitstop repro <id>` asserts the proving dynamic class (fails first, then
  passes once fixed).

## [0.8.2] - 2026-08-06

### Added

- **Patch-validity regression suite** (`npm test`, runs in CI on Linux +
  Windows): every `pen --fix` patch must pass real `git apply --check` —
  clean files, UTF-8 BOM'd files, top/end-of-file insertions, multi-line
  hunks — plus hunk-math self-consistency checks. Guards the "corrupt patch
  at line N" bug class from ever shipping again.
- **`docs/demo.md`** — the 2-minute judge's demo script (scan → pen → repro
  → drive).
- **LAUNCH.md "How we prioritized"** — the feature-ranking story: every
  phase exists to make it harder for an agent to lie about being done, and
  what was deliberately not built (cloud, dashboard, auth, plugins).

## [0.8.1] - 2026-08-06

### Fixed

- **`pen --fix` patches are now `git apply`-valid.** Hand-rolled hunks were
  rejected by `git apply` ("corrupt patch at line N"); patches are now built in
  git's canonical unified-diff shape (context lines counted once, `+` lines
  interleaved at their positions, exactly one trailing newline) and apply
  cleanly — verified on a real BOM'd-file project (helmet headers live,
  `x-powered-by` gone after applying).
- **UTF-8 BOM tolerance:** `package.json` / start-script parsing in the pen
  static and dynamic phases no longer crashes on BOM'd files (seen in the
  wild from Windows editors).
- **`pitstop drive` verdicts for runtime findings:** pen findings are now
  verified by the repro test (must FAIL first, then PASS after the agent's
  fix) instead of the static score, which has no baseline in pen-only repos.
  Static `verify` is still shown as context.
- **`spinner.warn`** used when the dynamic phase aborts (app failed to boot,
  or user interrupted) instead of a green success spinner.
- **Evidence window isolation** in the dynamic phase: outbound-connection
  evidence is filtered to the current attack (`n > nextN`), so a previous
  attack's connection can no longer be credited to a later route.
- **SSRF host recording** now reads `req.headers.host` so findings show the
  real target host.

## [0.8.0] - 2026-08-06

### Added (the pen-test release)

- **`pitstop pen` — a real penetration test, honestly delivered.** Two phases:
  a static heuristic pass (secrets with entropy checks, route discovery for
  JS+Python, and rule sets for SQL injection, command injection, path
  traversal, SSRF, XSS sinks, prototype pollution, weak CORS, missing security
  headers, cookie flags, rate limiting and more) plus a live dynamic phase that
  boots the app's own `start` script under a sandbox and fires attack traffic
  at it. Findings carry severity + a strict confidence level:
  - `PROVEN` only when the sandbox evidence contains the attack canary: the
    recorded outbound HTTP receipt for SSRF, a recorded `child_process` spawn
    containing the payload marker for command injection, or the marker
    reflected in the response body for XSS. No magic — proof or "indicated".
  - The sandbox intercepts and records every outbound HTTP (nock + fetch
    wrapper) so nothing reaches the real network; raw sockets and UDP are
    blocked; child processes are recorded, never blocked (it is your own start
    script). Every proof line is sealed into `.pitstop/pen-*.json`.
  - `--fix` writes one failing-then-passing repro test per fixable finding
    plus deterministic `.diff` patches (e.g. `app.disable("x-powered-by")`,
    helmet) that you apply with `git apply` — OpenPitStop never edits your source.
  - Exit contract: `0` = no high/critical, `1` = high/critical present,
    `2` = dynamic aborted with nothing found.
- **`pitstop ready-check` — the "is it worth scanning again?" gate.** Compares
  the newest modified file against the sealed baseline timestamp: `0` = the
  tree is unchanged, reuse the baseline; `1` = re-scan needed. `--json` for
  scripts.
- **`pitstop budget` — the token-economy bill.** Counts every scan, verify,
  pen run, repro test and ledger operation from the evidence history and
  estimates compute seconds per reliability run — OpenPitStop's honest wall-clock
  proxy for model-token spend, plus reuse advice.
- **`pitstop scan --reuse`** — returns the sealed baseline (score, findings,
  everything) without re-running anything when the source tree is unchanged.
  The loop that reads this: `ready-check` → `scan --reuse` → work → verify.
- **`pitstop watch`** — the live shield. Polls the tree (default 10s, min 2s)
  and re-runs the fast static pass the moment a file changes, printing the
  score delta and new security issues.
- **`pitstop drive <finding-id>`** — hands one finding to *your own agent*
  (via `PITSTOP_AGENT` env or `--agent` with a `{prompt}` placeholder),
  instructing it to make the repro test fail first, then pass, then verify.
  OpenPitStop verifies the result itself and never edits your code.

### Changed

- `pitstop repro` now also understands pen findings (`pen-latest.json`):
  `pitstop repro pen-xxxx` records the exploit as a failing-then-passing
  regression test that boots the app under the pen sandbox itself.
- `pitstop inspect` deep-dives pen findings: the exact attack fired, the
  observed response, the sandbox evidence lines, the suggested fix and the
  repro command.
- `templates/pitstop.prompt.md`: new `--pen` mode block (run the pen, print
  the box, inspect, fix one finding at a time through the repro FAIL→PASS
  loop, re-check) and the **k2 token economy** step (ready-check before every
  re-scan, `scan --reuse` in the loop, verify during iteration with full
  reliability runs only on the final pass, stop when re-scanning without
  edits).
- `package.json`: `typecheck` script added; `files` whitelist ships the pen
  sandbox template.

## [0.7.0] - 2026-08-05

### Added (the viral release)

- **`pitstop share` — the share card.** One command renders a 1200×630 fully
  self-contained HTML card (`PITSTOP_CARD.html`): the big OpenPitStop Score,
  score-per-scan sparkline, integrity/evidence chips, and the top findings.
  Built to be screenshotted and posted on X/LinkedIn; `--open` launches it in
  your browser. No external assets, `og:title`/`twitter:card` meta baked in.
- **`pitstop digest [--days N] [--md]`** — the human progress story. Reads the
  `.pitstop` history and answers "what happened to this repo?": score movement,
  what got fixed vs regressed, gate results, integrity catches and
  self-corrections, the flakiest tests, and what's still open. `--md` writes a
  shareable `PITSTOP_DIGEST.md`.
- **`pitstop honesty [--html]`** — the AI-honesty proof. One verdict distilled
  from the evidence chain, the integrity-gate history (cheat catches +
  self-corrections), the verify delta, and the committed repro tests — the
  artifact that says "this AI agent's work is provably not cheating".
  `--html` writes a self-contained `PITSTOP_HONESTY.html` certificate.
- **`pitstop report --badge-json`** — writes `PITSTOP_BADGE.json` in the
  shields.io `endpoint` schema, so the OpenPitStop Score badge can be hosted and
  embedded as `https://img.shields.io/endpoint?url=<hosted.json>`.

### Changed

- `share`/`honesty`/`digest` verify the baseline **evidence signature** and
  surface `verified` / `tampered` / `untracked` status — a tampered baseline
  flips the honesty verdict to SUSPICIOUS.
- Converted format helpers (`escapeHtml`, `svgTrend`) to exports for reuse.

## [0.6.0] - 2026-08-05

### Added

- **`pitstop try` — the 2-second wow, on any repo.** Static-analyze an existing
  project with zero setup (no install, no tool config, no curated fixture) and
  get its OpenPitStop Score in ~1–2s. Runs the cheap analyzers (dependency graph,
  npm audit with its cache, duplication, accessibility, DevEx) and honestly
  notes that tests/build/flaky are a `pitstop scan` detail. The result is
  persisted as a sealed baseline, so verify/gate pick up where it left off.
- **`pitstop gate [--score 60]` — the agentless commit gate.** One command
  answers "is this safe to commit?" with a plain exit code, no AI tool needed:
  checks the score against a threshold, the regression risk, the integrity diff
  since HEAD, and the baseline evidence signature. `0` = PASS (safe to commit),
  `1` = FAIL (skip the commit), `2` = CONFIRMED_CHEAT (block hard). `--json`
  emits a machine-readable verdict for CI. Drop it in as a pre-commit hook or
  the last line of a CI job.
- **Tamper-evident evidence chain.** Every scan, verify and integrity document
  OpenPitStop writes is sealed with a `sha256` digest computed over its own
  canonical content (`pitstop-sha256-canonical-v1`, deterministic key-sorted
  JSON). Editing the JSON after the fact — inflating a score, deleting a
  finding — breaks the digest. `pitstop verify` and `gate` recompute it on
  read: baselines that carried a pre-0.6.0 unsigned write are reported as
  "untracked", ones with a broken digest are flagged `TAMPERED` (and block the
  gate). Verify reports carry their own signature too.

### Changed

- **`pitstop verify` shows the evidence line.** The box now prints
  `evidence: ✓ signed <digest>` / `✗ TAMPERED`, and the verify JSON records the
  check result.
- **Duplicate-function detector is ~12× faster.** The devex clone pass no
  longer re-tokenizes every function body for every pair; bodies and bigram
  counts are computed once and pairs are pre-filtered by length balance. Scan
  of OpenPitStop's own repo: devex 5.7s → 0.5s, `pitstop try` 11s → 1.7s.
- **UTF-8 BOM tolerance.** `.pitstop/*.json` documents written by PowerShell
  or editors with a BOM (which `JSON.parse` rejects) are now read correctly.

## [0.5.0] - 2026-08-05

### Changed

- **Faster scans (2.7× on the demo repo).** The four subprocess-bound analyzers (security audit,
  tests, perf build, reliability suite runs) now run **in parallel**; flaky detection defaults to
  **2 sequential suite runs** (was 3 — 2 is the minimum that can detect a changed outcome);
  `npm audit` results are **cached** keyed on the lockfile hash (24h TTL) so repeated scans inside
  one fix loop stop hitting the registry; jest now caches into `.pitstop/cache/jest` so repeat
  scans skip jest's cold start. `pitstop scan --reliability-runs <n>` tunes the flaky-detector
  cost (1 disables flaky detection, with an honest note).
- **`pitstop demo` is now self-contained.** It no longer runs `npm install` in the hot path and
  never writes slash commands into the user's tool configs (`~/.claude` etc. stay untouched — that
  remains an explicit `pitstop install`). Demo node_modules is linked (directory junction on
  Windows, symlink elsewhere) from the fixture's own checkout or a persistent `~/.pitstop/cache`
  — a one-time cached install only happens if neither exists. Demo scans run the suite once, so
  the wow lands in seconds, and stale `.pitstop` baselines are wiped from the temp copy while
  caches are kept.
- **Skipped categories now carry install hints.** When a scan category prints `skipped` because a
  tool is missing (`jscpd`, `pa11y`, `gitleaks`/`semgrep`), the box line includes the one-liner to
  fix it — `pitstop doctor`-lite right inside the report.
- **Spinner fixes.** Spinners now render on stdout instead of stderr (PowerShell 5.1 painted every
  frame as a red error record — the first `scan` on Windows looked broken), and non-TTY/CI runs
  print plain `✓/✗` lines instead of a frozen spinner glyph.

### Added

- **`pitstop repro` for circular dependencies.** A circular group can now be captured as a
  permanent repro test: the test loads every member of the cycle and asserts it initializes
  cleanly (import() under node:test, require under jest/vitest — dynamic import is refused by
  jest's VM and a repro that fails for an environmental reason would be a lie). ESM cycles throw
  at load time (TDZ) and genuinely FAIL; CJS cycles may load lazily and PASS, which is honestly
  reported as "hypothesis unproven".
- **Verify baseline staleness warning.** `pitstop verify` now detects files changed after the
  baseline scan and prints a prominent ⚠ warning (also recorded as `stale: true` in the verify
  report JSON) instead of silently presenting a delta against an outdated snapshot.

### Fixed

- `pitstop trends` verify-history lines rendered a chalk function as `(...arguments_) => …`; the
  score cell is now colored and formatted correctly.
- Published tarball cleanup: stale `demo-repo-fintech/PITSTOP_REPORT.md`, `PITSTOP_BADGE.svg`
  and leftover `.gitkeep` placeholders no longer ship (`.npmignore` added; fixtures cleaned).

## [0.4.0] - 2026-08-05

### Added (the WOW release)

- **OpenPitStop Score.** Every scan box now opens with a single 0–100 health score + A–F grade,
  weighted across the categories that actually ran (skipped categories are excluded and weights
  renormalized, so a missing `jscpd` never silently tanks the number). `pitstop verify` gained a
  "OpenPitStop score" Δ row: the baseline/current comparison only patches categories that measured
  in both runs, so the score only moves when the code does — never when a tool is missing.
- **`pitstop inspect <finding-id>`** — deep dive on any finding id from a scan box: severity,
  exact location, ±6-line code snippet with the target line highlighted, root-cause cluster
  context (root cause vs symptom), whether a permanent repro test is committed, and OpenPitStop's
  memory of the files. Ledger/perf findings get their evidence details too.
- **`pitstop trends`** — per-category sparklines + a score trend across the
  `.pitstop/scan-*.json` history, plus a verify timeline with risk and integrity verdicts.
- **`pitstop report --html`** — self-contained single-file HTML report: score hero with inline
  badge, summary table, root-cause clusters, before/after, inline-SVG trend charts, integrity-gate
  timeline, zero external assets. Every `pitstop report` also writes `PITSTOP_BADGE.svg`, a
  README-ready shield badge (`![OpenPitStop score](PITSTOP_BADGE.svg)`), and the markdown report
  embeds it.
- **`pitstop doctor`** — toolchain health check: Node/git/npm plus jscpd, gitleaks, semgrep,
  pa11y with copy-paste install hints — one command explains exactly why categories print
  "skipped".
- **`pitstop prompt [--args …]`** — prints the exact rendered `/pitstop` prompt (with the
  invocation arguments substituted) so users can preview what their AI tool will send, in every
  supported tool, regardless of how the tool's UI renders slash commands.
- **Cleaner `/pitstop` first message.** The agent used to print the full instruction block
  (mode, sequence, guardrails) as its opening message so users could see the prompt in every
  tool; it now acknowledges with a single line (`/pitstop — running the quality loop.`) and
  proceeds, keeping the chat window clean. `pitstop prompt` remains the full-transparency
  path (preview the exact rendered prompt anytime).
- **`pitstop scan --json`** — raw scan result as clean JSON for pipelines (no banner/spinner
  pollution); **live spinners** (ora, previously an unused dependency) on `scan` and `demo`.
- **`pitstop demo` wow moment** — the demo command now scans the seeded-broken demo repo and
  prints the full boxed report immediately, so first-time users see the product without needing
  an AI tool, a browser tab, or any setup.

### Fixed

- **`pitstop --version` returned a hardcoded `0.1.0`.** It now reads the real version from
  `package.json` (was out of sync since the package was renamed to `openpitstop`).

## [0.3.1] - 2026-08-05

### Fixed

- **CI was red on `master` (all jobs): `TypeError: TEXT_ENCODINGS.union is not a function`.**
  The CLI depends on execa 10, which requires Node ≥ 22 (`Set.prototype.union`, ES2024);
  both workflows pinned Node 20, where that method does not exist. CI (`ci.yml`, `pitstop.yml`)
  now uses Node 22 and the `package.json` engines field is corrected from `>=18` to `>=22`
  (the published `0.3.0` engines metadata was misleading). The smoke test (`node dist/cli.js
  scan demo-repo`) was verified green locally on Node 22 — same version CI now uses.

## [0.3.0] - 2026-08-05

**Published to npm as `openpitstop@0.3.0`.**

### Added (one-command install & use)

- **True one-command install**: `npx openpitstop@latest install` writes `/pitstop` into every
  supported tool in one shot — project-level into the current repo, user-level so it works in any
  repo. Runs idempotently with `-y`/`--force` (`npx openpitstop@latest install -y` re-runs cleanly
  after updates).
- **Gemini CLI support** — first non-Markdown target. `install` now writes `.gemini/commands/pitstop.toml`
  (project) and `~/.gemini/commands/pitstop.toml` (user) via a new `gemini` transform that converts the
  prompt template to `{ description = "...", prompt = """ ... """ }`. Verified to load and route (model
  quota blocked a full live run on test day, parse OK).
- **Antigravity user/global targets** — `~/.agent/workflows/pitstop.md` + `~/.agents/workflows/pitstop.md`
  (already had the project-level pair).
- **Correct OpenCode user-level path** — global commands now also go to `~/.config/opencode/commands/`
  (the current documented location; the older `~/.opencode/commands/` layout is kept as legacy). Verified
  resolved from a fresh, project-less directory.

## [0.1.0] - 2026-08-05

### Changed

- **Published package renamed `pitstop-cli` → `openpitstop`.** The npm name
  `pitstop-cli` is already taken by an unrelated maintainer, so `npx pitstop-cli`
  could never resolve to this project. The package is now published as
  `openpitstop` (verified free on npm at rename time); both the existing `pitstop`
  bin and a new `openpitstop` bin are shipped, and every docs/prompt/generated-repro
  reference (`npx openpitstop scan`, `!npx openpitstop repro …`, …) was updated to
  match.

### Fixed (found during the release audit)

- **`src/analyzers/tests.ts` / `src/analyzers/reliability.ts` — tests analyzer silently blind to real failures (Windows + npx).**
  Under `npx`, `node_modules/.bin` is added to `PATH`, so `commandExists("jest")` matched the POSIX shim
  `node_modules/.bin/jest`, which `execFileSync` cannot spawn on Windows (spawn fails in ~5 ms with empty
  output). The analyzer then reported `jest produced no JSON` and counted 0 tests, hiding genuinely failing
  test suites from `scan` and `verify` (verified with a repo whose suite had 2 failing tests show up as
  "skipped — jest produced no JSON" / verify `0 passed · 0 failed`). The runner now prefers the repo-local
  JS binary (`node node_modules/jest/bin/jest.js`, `node node_modules/vitest/vitest.mjs`) exactly like
  `src/repro/framework.ts` already did. Re-verified: the same repo now scans as `2 failed / 4 —
  5321ms, 86.04% cov` and verify reports the true test deltas.

- **`src/repro/framework.ts` — jest/vitest repros could report a false `FAIL — bug reproduced`.**
  `runTestFile` passed the absolute test-file path to jest/vitest. When the repo path contained a Windows
  8.3 short path segment (e.g. `C:\Users\KRISH_~1\...` vs the long `krish_b9e9r0w`), jest could not match
  the file against `rootDir`, exiting with `No tests found` — which `pitstop repro` surfaced as a `FAIL`
  even though the exploit/assertions never ran. The runner now passes a repo-relative path to jest/vitest
  (node-test/pytest continue to use the absolute path). Re-verified on two finding types (ledger, security):
  the generated tests now genuinely FAIL with the bug present and genuinely PASS after the fix.

## [0.2.0] - 2026-08-05

**Published to npm as `openpitstop@0.2.0`** (verified live: `npx openpitstop@latest install`
and `npx openpitstop@latest demo demo-repo` work from a clean dir against the registry package).
The npm name `pitstop-cli` is owned by an unrelated package and cannot be used.

### Added

- **New integrity detector `assertionLiteralTamper` (pattern `assertion-expected-value-changed`, confidence
  `confirmed`).** Flags commits whose *entire* diff is a swapped literal RHS on a test assertion — same
  subject, same surviving suffix, changed expected value (JS `toBe|toEqual|toStrictEqual|toBeCloseTo|toMatch|toMatchObject`,
  Python `assertEqual`/`assertTrue`/`assertFalse`/`assert … ==|!=|<|>`, string-aware mid-line parsing, CRLF-safe).
  Any accompanying app change, added/deleted file, comment, or non-swap line suppresses all findings (an honest
  spec update is indistinguishable from a cheat). Covered by `fixtures/assertion-literal-tamper/` (baseline /
  cheat / honest + `verify.mjs`).

- **`windows-latest` CI job.** `.github/workflows/ci.yml` now runs build + smoke (`node dist/cli.js scan
  demo-repo`) on both `ubuntu-latest` and `windows-latest` via a matrix.

- **Installer targets expanded and made honest (`src/installer/targets.ts`, `src/commands/install.ts`).**
  Antigravity now receives workflow-formatted commands (`description`-only frontmatter + title + steps) in
  both `.agent/workflows/` and `.agents/workflows/`; Kilo Code's home target moved to the current
  `~/.config/kilo/commands/` (`.kilo/commands/` + legacy `.kilocode/workflows/` kept); Codex CLI unchanged.
  The Codex App / VS Code extension is **not** claimed as supported — no file is written, and the install
  summary prints that OpenAI hasn't shipped custom slash commands there (manual copy of the prompt is the
  only option). The install table now reports honest per-tool statuses (✅ Installed / ⚠️ Manual copy needed).

- **Bare `/pitstop` now shows a mode menu (Part C).** `templates/pitstop.prompt.md` opens with a mandatory
  mode-selection block: when invoked without arguments (or when the placeholder wasn't substituted) the agent
  prints a menu (full loop / `--scan-only` / `--demo` / `--ledger` / `--integrity-only`) and waits; when a
  flag is present in the invocation arguments it skips the menu and enters that mode directly. The
  `$ARGUMENTS` placeholder appears exactly once in the template so tool-side substitution can't corrupt the
  branch conditions (verified live in OpenCode: bare `/pitstop` → menu + wait; substituted flag → straight
  into the mode).

### Changed

- **All tool spawning migrated from `child_process` shell strings to `execa` (v10).** `src/analyzers/util.ts`
  now implements `safeExec`/`commandExists` via `execaSync` and the `safeExecShell` helper was removed; every
  shell-style invocation was replaced with argv-based ones: `npm install`/`npm run build`/`npm audit --json`
  (stdout captured directly instead of a shell redirect to a temp file), the per-file Python interpreter
  (`python -c …` with stdin), and the async repro runner in `src/repro/framework.ts`. This removes the last
  places that assumed a POSIX shell (`/dev/null`, `&&`, glob/pipe semantics) on any platform.

- **`src/commands/ci.ts` snapshot now pure-git.** The unix-only `git archive | tar` pipeline was replaced with
  `fetchBaseSnapshot()`: it fetches the base SHA into a temp repo (`git fetch --depth=1 <repo> <sha>`) and
  detached-checkouts `FETCH_HEAD`, so `pitstop ci` works on Windows without a `tar` unpacker.

- **CRLF normalization in `src/analyzers/integrity/git.ts`.** Blob/working-tree contents read for `integrity`
  diffing are normalized to `\n` before parsing, so an uncommitted CRLF working-tree edit no longer mangles
  per-line diffs.

### Verified (on real Windows, this session)

Both previously documented bugs were re-run on a real Windows host (Node 22, PowerShell, git for Windows,
`%TEMP%` on an 8.3 short path) and are fixed: the npx `node_modules/.bin` jest shim now fails loudly with the
true `2 failed / 2` suite instead of `jest produced no JSON`, and a `pitstop repro` in an 8.3-path temp repo
genuinely `FAIL — bug reproduced` before the fix and `PASS — bug not reproduced` after. The full
`pitstop demo → /pitstop` loop, `pitstop ci` (base-branch snapshot report), and a `pitstop/*` branch
round-trip were also exercised on Windows.