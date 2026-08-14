# Show HN: OpenPitStop — a `/pitstop` slash-command that turns your coding agent into an autonomous fixer

> The first thing you see is the box. That box is the whole product thesis.

```
╔══════════════════  PITSTOP — Repository Scan Complete  ══════════════════╗
║   Dependency Graph : 2 circular — src/userService.js → src/userRepo.js →  ║
║   src/userService.js                                                      ║
║   Security         : 1 issues — high dependency: lodash: Command Injection ║
║   Root Causes      : 1 root cause(s) → 2 symptom(s)                       ║
║   1. MEDIUM circular: circular dependency: src/userService.js → ...       ║
║   Tests            : 2 failed / 2 — 5832ms, 38.46% cov                    ║
║   Awaiting confirmation to begin autonomous fixing.                       ║
╚═══════════════════════════════════════════════════════════════════════════╝
```

## The one-liner

One command installs it everywhere — project-level in the repo you're in, user-level so it
works in any repo:

```bash
npx openpitstop install
```

Re-run it after updates with `-y` to refresh without prompts:
`npx openpitstop install -y`. Then `/pitstop` just works in Claude Code, Cursor, OpenCode,
Antigravity, Kilo Code, Codex CLI, and Gemini CLI.

OpenPitStop is two pieces glued together: a **deterministic CLI** that scans your repo and
produces numbers, and **your existing coding agent's reasoning** — the CLI does the
measuring, your agent does the editing, and a prompt template makes them loop until the repo
is actually clean.

## Why this exists

Your agent is great at fixing code. It's terrible at *knowing when to stop* — it fixes the
one thing it noticed and declares victory. OpenPitStop gives it an honest feedback loop:

1. **Scan** → `openpitstop` runs real tools (`npm audit`, `jest`, a dependency-graph pass,
   a structural duplicate-function detector) and prints a **boxed root-cause summary** —
   circular deps, security issues, broken tests, copy-paste, flaky tests, unused exports.
2. **Confirm** → the agent prints *"Found N root-cause clusters covering M issues. Reply
   with anything to start."* and **stops**. One pause, never skipped. Nothing is edited until
   you approve.
3. **Loop** → the agent branches to `pitstop/*`, states a hypothesis, makes the *smallest*
   fix, runs `pitstop verify` (re-runs tests and diffs against the baseline → **Regression
   Risk**, gated by the **integrity gate** that scans the diff for AI-agent-cheat patterns),
   commits, and re-scans.
4. **Stop** → a fresh scan showing **zero actionable clusters** ends it:
   `nothing left to fix, nothing broken.` Then `pitstop report` writes `PITSTOP_REPORT.md`.

## What's honest about it

- **It never edits your code itself.** The CLI is deterministic and safe; the agent does the
  reasoning. No mystery black box.
- **Skips are visible.** No jscpd installed? It says `skipped — jscpd not found`. No HTML in
  the repo? It says so. You always know what was and wasn't checked.
- **Heuristics are labeled.** Race-condition smells and duplicate-function detection are
  structural guesses and are marked as such — never presented as certainty.
- **The agent can't cheat its own referee.** Every `verify` also diffs the change against HEAD
  and flags deleted/loosened tests, swallowed errors, suppression comments, hardcoded-to-pass
  values, and forced exits. SUSPICIOUS reverts and retries the same cluster once with a stricter
  "solve the root cause" instruction; CONFIRMED_CHEAT goes straight to a human.
- **Hard safety rules** are baked into the prompt: no force-pushes, no `.env`, no deleting
  files with incoming references, everything on a `pitstop/*` branch.
- **Memory.** Every fix it makes is recorded and recalled on later scans, so the loop gets
  smarter on your actual codebase over time.

## Try it in under 2 minutes — no messy codebase needed

Don't want to point it at your own repo yet? The repo ships an intentionally-broken demo
project seeded with a circular dependency, a hardcoded secret, a known-CVE dependency,
duplicated code, and failing tests.

```bash
npx openpitstop demo
```

That copies the demo into a temp dir, wires up `/pitstop`, and prints where to open it.
Open it in Claude Code / Cursor / OpenCode / Kilo Code / Antigravity / Codex CLI / Gemini
CLI, type `/pitstop`, hit enter, and watch the whole loop: scan box → confirm → fix →
verify → re-scan → report. No menu, no waiting — bare `/pitstop` just runs. Flags pick a
single mode (`--scan-only`, `--demo`, `--ledger`, `--integrity-only`, `--pen`), any
question scopes the run (`/pitstop check the security of this app` maps to the pen test,
restates its interpretation in one line, confirms before fixing, and fixes only what you
asked), and `/pitstop --menu` prints the full mode list on demand.

The demo source is at [`demo-repo/`](demo-repo/) if you want to read exactly what it plants
in the code before you watch it get fixed.

## What it won't do (yet)

- It won't fix things the scanners can't see — if a tool isn't installed, that dimension is
  honestly skipped.
- It won't reformat your entire codebase; it fixes *root causes the scan actually finds*.
- It's deliberately conservative: one cluster at a time, max 2 attempts per cluster, 10
  iterations max, then it stops and tells you what's left.

## Show, don't tell

- **Cheat-catch (90 s):** the scripted moment where a lazy agent tries to fake a green
  suite — and the gate catches it with exit 1, then exit 2. Run
  `node scripts/cheat-demo.cjs` (or point it at a local build with
  `PITSTOP_CLI="node /path/to/dist/cli.js"`). Deterministic, live-room safe.
- **Demo (2 min):** the box above is real output — or run `npx openpitstop demo` locally.
- **Report sample:** a full `PITSTOP_REPORT.md` is generated after every loop.
- **CI:** pitstop runs in CI too — `pitstop ci` diffs a PR against its base branch and
  posts one comment (`build-and-smoke` status in the badge below).

[![CI](https://github.com/Krish-1507/OpenPitStop/actions/workflows/ci.yml/badge.svg)](https://github.com/Krish-1507/OpenPitStop/actions/workflows/ci.yml)

## How we prioritized

The challenge asks for core logic over surface polish, so every feature was
ranked against one question: **does this make it harder for an agent to lie
about being done?** Nothing that failed that test shipped — and some of it
was built and deleted.

- **Phase 1 — the referee.** Deterministic scan + the exit-code contract
  (0 clean / 1 issues / 2 suspicious). Without this there is no product, so
  it came first and took longest. No scoring yet — just honest numbers.
- **Phase 2 — proof of the numbers.** The tamper-evident evidence chain:
  every scan is sealed, edits to a sealed report are detectable, `gate`
  exits 2 on confirmed tampering. Trusting a referee is only sound if the
  referee can't be edited. (The first integrity check was a shell script;
  it was deleted and rebuilt in TypeScript the moment it couldn't prove its
  own integrity.) The chain survived its own corruption bug in 0.8.x — a
  canonicalizer that hashed `undefined`-valued keys which `JSON.stringify`
  drops, so every gate cried "TAMPERED" at baselines it had just written —
  caught by running the demo, fixed, and regression-tested.
- **Phase 3 — the loop economics.** `watch`/`ready-check`/`budget`/
  `scan --reuse`: an agent loop that re-runs everything on every iteration
  burns credits and patience; a loop that knows when nothing changed and
  returns the sealed baseline in zero time is what makes the loop usable at
  all. This shipped before "prettier reports".
- **Phase 4 — the last mile of honesty: prove it live.** `pen` boots the
  app under a sandbox and attacks it for real — and only then are findings
  called **proven**. Every static finding also carries a runtime-proof
  verdict (proven / indicated / unproven / not-tested), so nothing is
  oversold. Each finding gets a repro test that FAILS on the bug, and
  `drive` makes the agent prove FAIL → PASS. `pen --fix` only auto-generates
  patches that are provably safe (pure insertions) and regression-tests that
  every patch passes `git apply`.
- **The cheat-catch demo.** `scripts/cheat-demo.cjs` is the whole thesis in
  90 seconds: a lazy agent focuses the suite on the passing tests (gate
  blocks, exit 1), then deletes the failing test (gate blocks, exit 2) —
  while the tamper-evident baseline keeps verifying. Deterministic, scripted,
  safe to run in a live room.

**Deliberately not built** (and why): no cloud/dashboard (the numbers are
local and auditable — that's the point), no plugin marketplace (the
`/pitstop` command installs from one template), no auth/teams (this is a
quality gate, not a SaaS), and no "AI score" that mixes model output into
the measurement (the referee must be deterministic to be a referee). Each
was sketched, found to dilute the thesis, and cut.

The git history shows the cuts in order: `scan` → `try`/`gate`/evidence →
`share`/`honesty` → `pen`/`watch`/`drive`/`budget`. Four phases, each one a
layer of the same promise: *the agent finally has a referee.*

## Built for the boring, important stuff

The pitch isn't "AI writes your code." It's: **the agent finally has a referee.** A loop
that measures, a loop that knows when it's done, and a report that says what actually
changed. Clone it, run the demo, and break it on your messiest repo — that's the review
feedback that matters.

---

*OpenPitStop is MIT licensed. Found it useful, or found a way it breaks? Open an issue, or come
extend it — `CONTRIBUTING.md` walks through adding a whole new analyzer in ~10 minutes.*
