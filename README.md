<p align="center">
  <img src="docs/media/pitstop-logo.png" alt="OpenPitStop" width="380">
</p>

# OpenPitStop CLI

**The agent finally has a referee it can't cheat.** OpenPitStop is a CLI that scans your repo,
scores it, and checks everything your AI coding agent does — so when it says "done", you
know it's actually done.

[![npm version](https://img.shields.io/npm/v/openpitstop)](https://www.npmjs.com/package/openpitstop)
[![CI](https://github.com/Krish-1507/OpenPitStop/actions/workflows/ci.yml/badge.svg)](https://github.com/Krish-1507/OpenPitStop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> AI coding agents are brilliant at fixing things, and just as brilliant at *saying they
> did* when they didn't. OpenPitStop measures your repo with scans, seals every number so it
> can't be edited later, attacks your own app with a live penetration test, and checks every
> change your agent makes. The exit codes tell you the truth: `0` clean, `1` suspicious,
> `2` confirmed cheat.

---

## Quick install

**Start here:** `npx openpitstop try .` scores any repo in about two seconds with zero
install, or `npm i -g openpitstop` for daily use. No account, no config, no SaaS.

**Zero install, try it now:**
```bash
npx openpitstop try .
```
Scores any repo in about two seconds of scanning. The first run downloads the
package once, after that it is instant.

**Install it globally (recommended for daily use):**
```bash
npm install -g openpitstop
openpitstop --help
```
Now every command starts with `openpitstop` instead of `npx openpitstop`.

Requires **Node.js 22+**, that is the only dependency. For the full setup
(slash command, pre-commit hook, CI), see [Install](#install).

## Use-Cases

- **You ship with an AI agent and want proof it actually finished.** The gate and
  `verify` turn "the agent says done" into a pass or fail you can block a build on.
- **You want a security scan that proves findings, not just guesses.** `pen` attacks
  your app in a sandbox and labels each issue PROVEN, indicated, or unproven.
- **You are tired of agents quietly deleting a failing test.** `integrity` and the
  gate catch focused, deleted, or rewritten tests and exit 2 (confirmed cheat).
- **You want proof a fix is real, not just a green suite.** `baseline-verify` proves the
  verification FAILED on the broken state and PASSES after the fix; `state-verify` proves the
  changes your agent *claimed* actually landed on disk and in git; `verifier-check` proves the
  referee itself can still say NO.
- **You want CI to fail on a regression, not just a new bug.** Drift compares every
  `pen` run to the last sealed one and goes red on a NEW finding.
- **You need a score you can show your team or an auditor.** `report` and `honesty`
  produce a sealed HTML report and an honesty certificate.
- **You already pay for a pen tool and want continuous proof for free.** OpenPitStop
  keeps a running ledger of proof in your repo. See the OpenPitStop vs Strix
  comparison above.

**Ready to try it?** Run `npx openpitstop try .` on any repo and get your score in
about two seconds.

---

## Why I built this

I spend my days running coding agents on real repos. They're brilliant at fixing things —
and equally brilliant at *telling me they did* when they didn't: focusing tests to hide
failures, deleting the failing test, editing an assertion to match the buggy output. I got
tired of auditing my agent's work by hand, so I built a referee.

OpenPitStop is my own workflow tool, not a showcase: every repo I touch gets the loop, every
change gets the gate, and the numbers in this README are the same numbers I trust. It's
dogfooded hard — OpenPitStop's own CI scans a real repo with OpenPitStop on every push (Linux and
Windows), and the evidence chain is regression-tested because a bug in it once made OpenPitStop
cry `TAMPERED` at baselines it had just written. If it can referee itself, it can referee
your agent.

---

## Quick Nav

| Jump to | |
|---|---|
| [Feature tour](#feature-tour) — every feature, in plain English | [Install](#install) · [Usage](#usage) · [Tool support](#tool-support) |
| [Architecture](#architecture) | [Known limitations](#known-limitations) · [Contributing](#contributing) · [License](#license) |

**Straight to one feature:** [The scan](#the-scan) · [Security fixes](#security-fixes) · [Try it on your repo](#try-it-on-your-repo) · [The test pyramid](#the-test-pyramid) · [The gate](#the-gate) · [Integrity](#integrity) · [Baseline-aware verification](#baseline-aware-verification) · [State verification](#state-verification-dont-trust-the-claim) · [Verifier health](#verifier-health-falsifiability) · [The pen test](#the-pen-test) · [Honesty](#honesty) · [Verify](#verify) · [Trends](#trends) · [Inspect](#inspect) · [Repro](#repro) · [Report](#report) · [Share](#share) · [The live shield](#the-live-shield) · [The GitHub Action](#the-github-action) · [The pre-commit hook](#the-pre-commit-hook)

**Receipts:** [Caught in the wild](docs/caught-in-the-wild.md) — real gate output, screenshot-ready.

---

## OpenPitStop vs Strix — why teams pick the referee

Strix is a great *finder*. OpenPitStop is the *referee*. Both pen-test your app; the
difference is what happens after a vulnerability is found:

> **Strix finds. OpenPitStop proves.**

| | [Strix](https://github.com/usestrix/strix) | **OpenPitStop** |
|---|---|---|
| What it produces | Findings + a PoC *report* | Findings + a **failing-first regression test** (`pitstop pen --fix`) |
| Trust in the fix | One-click auto-fix PR | **Honesty Score (0–100)** + integrity gate that catches deleted tests, hardcoded passes, reverted baselines |
| How it runs | Docker + LLM key, non-deterministic | **Zero infra, deterministic, no LLM bill** — runs in any CI |
| Evidence | `strix_runs/` logs | **Tamper-evident, signed `.pitstop/` artifacts** you can audit |
| Secret exfiltration | not emphasized | **Ledger mode** proves the app doesn't phone home with your keys |
| DevSecOps | Cloud platform (paid tiers) | **Free SARIF → GitHub Security tab** + one-number `pitstop gate` |
| Proof coverage | — | **`PITSTOP_PROOF` badge**: % of findings that ship a permanent repro test |
| Continuous proof (drift) | report only — re-run and hope | **Drift gate**: every `pitstop pen` compares to the last sealed run, *proves a fix* (finding gone) and *fails the CI gate* on a new high/critical regression or a hypothesis the live attack just confirmed |
| Prove-my-fix loop | manual | **`pitstop repro <id>`** re-runs the exact attack and asserts the safe outcome — a PASS means the fix is real, a deleted repro test is flagged as a cheat |
| Bug classes covered | strong general set | **30+ vulnerability classes** — race/TOCTOU, IDOR/BOLA, price-tampering, XXE, insecure deserialization, JWT alg-confusion/weak-secret, SSRF, SQL/NoSQLi, command-injection, path traversal, XSS, secrets, CORS, missing headers, rate-limit, and more (plus an optional Semgrep engine you can bolt on) |

The honest pitch: a pen-test that only reports is a list of things to argue about. A
pen-test that ships the regression test, signs the evidence, and scores the fix on a
gate your CI can block on is something you can actually ship. That's the OpenPitStop
loop — and it's the reason to choose the referee over the hacker.

---

## Feature tour

Every feature below is explained in plain English: what it does, and how it
works. Most of it needs nothing more than a `pitstop scan` first.

### The scan

`pitstop scan` runs every check at once, in parallel, and prints one box with a
single **OpenPitStop Score** (0 to 100, A to F). It looks at circular imports,
security issues, duplicated code, test results, build speed, accessibility and
code quality. Each check gives a real number or prints `skipped` with a hint on
how to install the tool it needs. It never makes up a number.

### Security fixes

Under the scan box, every security finding ships with a concrete `fix:` line, so
you get a worklist, not just a list of problems. Findings are labeled
`[indicated]` with the exact code and the fix. The full matrix is in
[docs/security.md](docs/security.md).

### Try it on your repo

`pitstop try .` scores any repo in about two seconds, no setup, no config. It is
the fastest first look, and it seeds a baseline your later runs build on.

### The test pyramid

`pitstop test` runs your **unit, integration and e2e** layers separately, so a
suite that passes cannot hide a missing layer. It names every failing test. One
failing layer and it prints **DO NOT SHIP** and exits 1.

### The gate

`pitstop gate` is the contract for CI and pre-commit hooks. It checks the score,
regression risk and diff integrity, then exits `0` (clean), `1` (issues) or `2`
(confirmed cheat). It also folds in the newest sealed `baseline-verify`,
`state-verify` and `verifier-check` reports — a fix that merely passes without
baseline evidence is reported as less trustworthy than one with a sealed
`VERIFIED` chain, and tampered evidence from any of them hard-blocks. The exit
code is the truth a build can block on.

### Integrity

`pitstop integrity` diffs your change against the sealed baseline and hunts cheat
patterns: focused tests, deleted tests, rewritten tests, swallowed errors,
hardcoded-to-pass values. It exits `0/1/2` the same way.

### Baseline-aware verification

`pitstop baseline-verify` closes the hole in "the test passed, so it's fixed." A passing
verification proves nothing unless the *same* verification demonstrably FAILED on the
broken state — otherwise the agent is grading its own homework. So OpenPitStop runs the
verification against a known-bad baseline commit (must FAIL, evidence sealed), then against
the candidate (must PASS), and only calls it `VERIFIED` when both hold, the verification
identity (command + file hashes) is identical on both sides, and nothing was tampered with.
Anything less is honestly `FAILED`, `UNPROVEN`, or `INTEGRITY_FAILURE`. It runs in isolated
git worktrees, so your working tree is never touched. Full semantics:
[docs/baseline-verify.md](docs/baseline-verify.md).

### State verification (don't trust the claim)

`pitstop state-verify` never reads the agent's natural-language summary — it inspects the
actual filesystem and git. You give it structured claims (`--claim modified:src/auth.ts`,
`--claim created:x`, `--claim deleted:y`) and it independently checks existence, content
hashes, line counts, `git status`/HEAD, catching the classic failures: the tool returned
HTTP 200 but the file never changed, was written empty, was reverted, or a *different*
file changed. Verdicts: `STATE_VERIFIED`, `STATE_MISMATCH`, `UNPROVEN`,
`INTEGRITY_FAILURE`. This proves **that** a change occurred — never whether the code is
correct. Full semantics: [docs/state-verify.md](docs/state-verify.md).

### Verifier health (falsifiability)

`pitstop verifier-check` asks the referee's own question: **can this verification actually
say NO?** It runs the verification on a known-good state (must PASS) and a controlled
known-bad state — an explicit bad ref or your declared mutation, applied in a temp worktree
(must FAIL). `VERIFIER_VALID` means the verification demonstrated falsifiability and its
PASS carries information; `VERIFIER_WEAK` means the seeded fault sailed through;
`VERIFIER_BROKEN` means it fails even when things are correct. A referee that cannot fail
is not a referee. Full semantics: [docs/verifier-check.md](docs/verifier-check.md).

### The pen test

`pitstop pen` boots your app in a sandbox and fires real attack traffic, so a
finding is **PROVEN** by a live attack, not just guessed. With `--fix` it writes a
failing-first repro test and a safe patch. Nothing reaches the real network.

### Drift (the permanent referee)

`pitstop pen` remembers. Every run seals its verdicts and compares them to the last one, so you
see exactly what changed between today and last week:

- **NEW** — a finding appeared (or escalated from indicated to proven). This is a regression, so the
  gate exits `1` and your CI goes red.
- **RESOLVED** — a finding is gone because the fix worked. This is the "prove my fix" loop, and it is
  the most satisfying thing here: run `pitstop repro <id>` to turn a finding into a failing test, ship
  the patch, run `pitstop pen` again, and watch it flip to resolved.
- **ESCALATIONS** — something that was only *indicated* by static analysis is now *proven* by a live
  attack.

Strix, the enterprise tool, runs a one-off scan. OpenPitStop keeps a running ledger of proof, so a
fix can never silently rot back into a bug.

### Honesty

`pitstop honesty` prints an honest self-assessment of what the tool cannot do, with
the evidence chain behind every number. No SaaS, no telemetry, no dashboard, no
fixing your code: it tells you its limits in plain words.

### Verify

`pitstop verify` re-scans after a change and shows exactly how the score moved, and
it checks your diff for cheat patterns. The numbers cannot be argued with.

### Trends

`pitstop trends` turns your saved scan history into per-category sparklines and a
score trend, so you can watch a repo actually improve over time.

### Inspect

`pitstop inspect <finding-id>` opens one finding: the code snippet, the root
cause, whether a repro test exists, and what OpenPitStop remembers about these
files.

### Repro

`pitstop repro <finding-id>` turns any finding into a regression test that FAILS
while the bug is live and must PASS after the fix. Proof first, fix second.

### Report

`pitstop report --html` writes one self-contained HTML report, sealed with an
evidence signature, plus a README-ready score badge (`PITSTOP_BADGE.svg`).

### Share

`pitstop share` renders a single share card (score, trend, top findings) you can
screenshot and post, or paste into a PR.

### The live shield

`pitstop watch` sits in a terminal and re-scans the moment you save a file, printing
the score delta so you see problems as you type.

### Drive the agent

`pitstop drive <finding-id>` hands one finding to your own agent with explicit orders:
write the failing repro first, fix it, make the repro pass, then verify.
OpenPitStop referees the result and never edits your code.

### The next step

`pitstop next` reads the sealed artifacts and prints the single best next command plus
a checklist of everything still open, so you always know where you are.

### Ask in plain English

`pitstop ask "make this safe"` (or `/pitstop make this safe`) maps a plain-English
request to the right command. No need to memorize flags.

### Autopilot fix

`pitstop fix` chains **scan to pen --fix to verify to gate** and shows the `next` card
after each hop, so a clean repo is reachable without touching the agent.

### Memory and budget

`pitstop memory` is a repo scratchpad for decisions and rejected approaches that
survive across sessions. `pitstop budget` shows the token and compute bill of your
scans and reproves, so a fix loop stays cheap.

### The slash command

`/pitstop` in Claude Code, Cursor, OpenCode, Codex and more runs the full loop
immediately. `pitstop install` writes it into your tools; `pitstop prompt` shows the
exact prompt it expands to. See [Install](#install).

### The GitHub Action

`uses: openpitstop/action` (or `Krish-1507/OpenPitStop@main`) puts the gate on every PR
as a comment and a failing check when it matters. No wiring by hand. See
[docs/github-action.md](docs/github-action.md).

### The pre-commit hook

`npx openpitstop install --hooks` installs the gate one step earlier: the commit
cannot land until the gate passes. See
[docs/caught-in-the-wild.md](docs/caught-in-the-wild.md).

### Ledger mode (payment proof)

`pitstop scan --ledger` boots your app with every outbound HTTP call rerouted to a mock
gateway, then replays the classic payment bugs (duplicate webhook, concurrent
double-submit, delayed retry). If the mock shows more than one charge per idempotency
key, that is a **proven double-charge**, not a guess.

### CI reports

`pitstop ci` runs a CI-friendly scan plus verify against the base branch and writes a
PR-ready markdown report, the gate as a PR comment. This is the engine behind the
GitHub Action.

### Ready-check and doctor

`pitstop ready-check` answers "is it worth scanning again?" and reuses the baseline when
nothing changed. `pitstop doctor` explains why a category shows `skipped` and prints
copy-paste install hints for the tools you are missing.

### Digest (progress story)

`pitstop digest` turns your history into a plain-English progress story: how the score
moved, what got fixed, what regressed, and every cheat it caught.

---

## Install

One command, that's it:

```bash
npx openpitstop
```

No arguments needed: the CLI detects your AI tools, and asks what you want —
install `/pitstop` into them, or score *this* repo (`try .`). Pick, and it does it.
(In a non-interactive terminal it skips the questions and prints the one-line menu
instead.)

Or go straight to the files:

```bash
npx openpitstop@latest install
```

Run it from inside any project directory. It writes the `/pitstop` command into every
supported tool below — project-level for the current repo, user-level so it works in any
repo on your machine. Re-run with `-y` to refresh after updates (it's safe to re-run):

```bash
npx openpitstop install -y
```

Re-installing overwrites each tool's `/pitstop` command file with the latest prompt
(say, a new mode or an updated loop) — your tool picks it up on its next use.

Want the gate *before* the commit, not just on the PR? One extra flag installs the
pre-commit hook — every commit is checked (SUSPICIOUS/CONFIRMED_CHEAT → blocked) before
it can land:

```bash
npx openpitstop install --hooks
```

The hook runs the same `pitstop gate` (exit 0 = PASS · 1 = FAIL · 2 = CONFIRMED_CHEAT),
never blocks the first commit of a repo, never jails a repo that hasn't been scanned yet
(it warns instead), and can be bypassed once with `git commit --no-verify`. Remove it with
`npx openpitstop install --uninstall --hooks`. To point the hook at a local build, export
`PITSTOP_CLI` (e.g. `PITSTOP_CLI="node /path/to/dist/cli.js"`).

Speed tip: the `try`/`scan` itself takes ~2 seconds — but the **first** `npx openpitstop …`
on a machine has to download the package first (a few seconds on a fast connection, more on a
slow one). For an instant first run on machines you own, install once:

```bash
npm i -g openpitstop
openpitstop try .
```

Requires Node.js 22+ (npm will warn on older versions).

## Usage

Open your repo in any supported tool and type:

```
/pitstop
```

Bare `/pitstop` runs the full quality loop **immediately** — scan, one confirmation pause,
fix, verify, repeat. No menu, no waiting. Everything below is the power paths on top of
that:

| Invocation | Mode | What it does |
|---|---|---|
| `/pitstop` (bare) | **default full loop** | Scans right away, prints the boxed report, one confirmation pause, then the autonomous fix loop — repeat until clean. |
| `/pitstop --menu` | menu | Prints the full mode list below and **waits** — handy if you forgot the flags. |
| `/pitstop --scan-only` | scan-only | Runs `openpitstop scan`, prints the entire boxed report verbatim, and stops — no fixes, no commentary. |
| `/pitstop --ledger` | ledger | Runs `openpitstop scan --ledger` (boots the app with every outbound HTTP call intercepted and replays duplicate-webhook / double-submit / retry traffic), then runs the loop restricted to the payment findings. |
| `/pitstop --integrity-only` | integrity-only | Runs `openpitstop integrity`, prints the boxed verdict verbatim, and stops — no scanning, no fixes. |
| `/pitstop --pen` | pen | Live penetration test with proof — see [The pen test](#the-pen-test). |
| `/pitstop <your question>` | custom ask | Any free-form text (e.g. `check the security of this app`, `are our tests flaky?`, `did my agent cheat on the last commit?`) is scoped to exactly that ask: the agent maps it to the right command (`pen` for security, `integrity` for cheats, `scan` for health/tests…), states its interpretation in one line, confirms before fixing, and fixes only what you asked. |

For reference, `/pitstop --menu` shows this list:

```
OpenPitStop modes:
 (enter) — full autonomous loop (scan, confirm, fix, verify, repeat)
  --scan-only — scan and report, no fixes
  --ledger — payment idempotency fuzzing only
 --integrity-only — re-check the last commit for cheat patterns, no scanning
 --pen — penetration test: live attacks + proof + fixes (regression tests, patches)
 (your own ask) — reply with anything else, e.g. "check the security of this app"
```

A flag after `/pitstop` picks a specific mode; any free-form text after it becomes a scoped
custom ask; bare `/pitstop` is the full loop. If a tool ever fails to substitute arguments,
`/pitstop` behaves as bare — the default full loop — rather than guessing.

## Tool support

| Tool | Installed to | Status |
|------|--------------|--------|
| Claude Code | `.claude/commands/pitstop.md` (project + user), plus a Skill at `.claude/skills/pitstop/SKILL.md | Full support |
| Cursor | `.cursor/commands/pitstop.md` (project + user) | Full support |
| OpenCode | `.opencode/commands/pitstop.md` (project), `~/.config/opencode/commands/` (user) | Full support |
| Kilo Code | `.kilo/commands/pitstop.md` (project), `~/.config/kilo/commands/` (user) | Full support |
| Antigravity | `.agent/workflows/pitstop.md` (project + user) | Full support |
| Gemini CLI | `.gemini/commands/pitstop.toml` (project + user) | Full support |
| Codex CLI | `~/.codex/prompts/pitstop.md` | Full support |
| FreeBuff CLI | portable `pitstop.md` in your tool's commands folder | Full support (portable) |
| Grok Build CLI | portable `pitstop.md` in your tool's commands folder | Full support (portable) |
| MUSE Code CLI | portable `pitstop.md` in your tool's commands folder | Full support (portable) |
| Any other agent CLI | portable `pitstop.md` (drop it in the commands folder) | Full support (portable) — see below |
| Codex App / VS Code extension | — (no file written) | **Not supported** — OpenAI hasn't shipped custom slash commands there; install prints a manual-copy note instead |
| GitHub Action (PRs) | `uses: Krish-1507/OpenPitStop@main` | **Full support** — gate verdict as a PR comment + failing check; see [docs/github-action.md](docs/github-action.md) |
| git pre-commit hook | `.git/hooks/pre-commit` (installed with `--hooks`) | **Full support** — the gate blocks the commit before it lands |

**Works with any agent CLI.** OpenPitStop's `/pitstop` is a portable command file:
run `pitstop prompt` to print the exact instruction text, then paste it as a custom
slash command in any coding CLI that supports them (FreeBuff, Grok Build, MUSE Code and
others included above). The CLIs listed by name also get a dedicated path written
automatically by `pitstop install` when their commands-folder convention is known. Tell
us your CLI and we'll add it to the auto-install list. Legacy/alternate locations are
also written where tool docs are inconsistent across versions (see
`src/installer/targets.ts`). Existing files are never overwritten unless you pass
`-y`/`--force`; `npx openpitstop install --uninstall` removes everything.

## What OpenPitStop actually does

### The loop at a glance

<p align="center">
  <img src="docs/media/pitstop-loop.png" alt="OpenPitStop's autonomous loop: scan → report → you confirm → repro (must FAIL first) → fix → verify → repeat until a fresh scan shows zero clusters" width="900">
</p>

OpenPitStop never touches your code. It checks, scores, and referees — your AI agent does the
editing, knowing it's being watched.

### The scan

`pitstop scan` runs a bunch of checks on your repo: circular imports, known security
issues, duplicated code (`jscpd`), test results
(jest/vitest/pytest plus native suites for Go, Rust, Flutter/Dart, .NET and Java
(Maven/Gradle) — pass/fail, duration, coverage), build speed, accessibility, flaky-test
and race-condition heuristics, and developer-experience checks (unused exports, duplicate
functions).

Security is two layers:

1. **Dependency audits** — `npm audit`, plus `pip-audit`/`osv-scanner` for Python and
   other stacks, and `gitleaks` for committed secrets. A failed audit is reported as
   `skipped` with a repair hint — deps that were never scanned are never reported as clean.
2. **The static vulnerability pass** (fully offline, every language, no tooling needed) —
   the classic classes plus the full posture: **SQL injection** (concatenated/
   interpolated queries, ORM raw builders, `$where`, Python f-strings), **authentication**
   (cleartext password compares, missing hashing, `Math.random` tokens, inline JWT
   secrets), **authorization** (unprotected data routes, admin routes without role
   checks), **input validation** (unrestricted uploads, unvalidated money fields,
   `eval`, XSS sinks), **secret management** (known credential formats, inline secret
   literals, committed `.env` files) — plus command injection, path traversal, SSRF,
   **rate limiting** (missing limiters on state-changing routes, limits set so high they
   are decorations), **database lockdown** (privileged accounts in committed connection
   strings, `GRANT ALL`/`SUPERUSER`, TLS-free connections, missing row-level security),
   **data exposure** (credentials/PII in API responses, full DB rows shipped to the
   client, PII in logs), **hidden vulnerabilities** (disabled TLS verification, `alg:
   none` JWTs, security TODOs, lint/type bypasses, tokens in `localStorage`, committed
   minified bundles, backup files), CORS+credentials, missing security headers, CSRF
   exposure, stack leaks and sensitive logging.

Every static finding is labeled `[indicated]` and ships with its exact **fix**; `scan`
and `try` print the complete identify-and-solve list under the score box, so the report
is a worklist, not a scare. The full matrix — every detection and every fix — is in
[docs/security.md](docs/security.md).

**Optional deeper SAST (Semgrep).** OpenPitStop's built-in static pass needs no extra
tooling. For a second, cross-language engine you can bolt on [Semgrep](https://semgrep.dev)
— it is **off by default** and only runs when you opt in. Install it (`pip install
semgrep`) and set one variable:

```bash
export PITSTOP_SEMGREP_CONFIG=auto          # the free Semgrep Registry rules
pitstop scan                                # Semgrep is picked up automatically
```

Point it at your own rules any time: `PITSTOP_SEMGREP_CONFIG="p/security-audit p/owasp-top-ten ./my-rules"`.
With nothing set, no Semgrep process ever runs — no surprise network calls, no slow scans.

Each check either contributes a real number, or prints `skipped` with a one-line hint on
how to install the tool it needs — it never makes up a number. Everything adds up to one
box that always opens with the **OpenPitStop Score**: a single 0–100 health number (with an
A–F grade) across the categories that actually ran.

Scans are fast by design: the checks run **in parallel**, flaky detection runs the suite
**twice** by default (`--reliability-runs <n>` to tune; `1` disables it), and `npm audit`
(plus `osv-scanner`) results are cached for 24 hours (keyed on the lockfile hash) so
repeated scans inside one fix loop never hit the registry again.

### The test pyramid

`pitstop test [path] [--unit] [--integration] [--e2e]` runs your **unit, integration and
e2e** layers the way a senior dev would — it discovers each layer (`test`/`test:unit`,
`test:integration`/`test:it`, `test:e2e`/`e2e` npm scripts first, then vitest/jest/
pytest/playwright/cypress by config), executes them, and reports per-layer pass/fail
counts with the **names of the failing tests**, so the fix list is actionable. Layers it
cannot find are reported as `skipped — no suite discovered`, never invented; the command
exits 1 the moment any layer fails, so CI can trust it. (Add `"test:e2e": "playwright
test"` to a repo and it is picked up automatically on the next run.)

## Every command

All 30 commands, grouped by job. Run them from inside a repo as `pitstop …` (CLI) or
`npx openpitstop …` (one-off); `/pitstop` in a tool drives the loop, the rest are
one-shot.

**Measure — the numbers**

| Command | What it does |
|---|---|
| `pitstop scan [path] [--json] [--reuse] [--ledger]` | The big one. Runs every check in parallel and prints one box with a single **OpenPitStop Score** (0–100, A–F). `--json` for scripts and pipelines; `--reuse` returns the saved baseline when nothing changed; `--ledger` also fuzzes payment idempotency. |
| `pitstop verify` | Re-scans after a change and shows exactly how the score moved — the numbers can't be argued with. Also checks your diff for agent-cheat patterns. |
| `pitstop try [path]` | Get a score on **any** repo in ~2 seconds of scanning — no install, no config, no setup (the first `npx` run on a machine downloads the package once). Saves a sealed baseline so verify and gate can build on it later. |
| `pitstop ready-check [path]` | Quick "is it worth scanning again?" — nothing changed → exit 0 and reuse the baseline; something changed → exit 1. |
| `pitstop watch [path] [--interval ms]` | The live shield. Sits in a terminal and re-checks the moment you save a file, printing how the score moved. |
| `pitstop trends` | Turns your saved scan history into per-category sparklines and a score trend — watch a repo actually improve. |
| `pitstop budget [path]` | The token bill: how many scans/verifies/pens/repros you've run and the compute-seconds, plus advice on what to reuse in a fix loop. |
| `pitstop test [path] [--unit] [--integration] [--e2e]` | The test pyramid: discovers and runs the **unit, integration and e2e** layers, reports per-layer pass/fail with the failing test names. Any failing layer → exit 1. See [The test pyramid](#the-test-pyramid). |

**The fix loop — what the agent is told to do**

| Command | What it does |
|---|---|
| `pitstop drive <finding-id> [path]` | Hands one finding to *your own agent* (`PITSTOP_AGENT` or `--agent '…{prompt}'`) with explicit orders: write a failing repro first, fix it, make the repro pass, then verify. OpenPitStop referees the whole thing and never edits your code. |
| `pitstop memory add/list/relevant` | A scratchpad inside the repo: record a decision (`add`), see them newest-first (`list`), or pull up anything related to a file (`relevant`) — so past fixes and rejected approaches survive across sessions. |
| `pitstop inspect <finding-id>` | Opens up one finding: the code snippet, the root cause, whether a repro test exists, and what OpenPitStop remembers about these files. |

**Integrity & anti-cheat — the referee**

| Command | What it does |
|---|---|
| `pitstop gate [--score 60]` | A commit gate for CI, pre-commit hooks or PRs: score threshold + regression risk + diff integrity + evidence signature + the newest baseline-verify / state-verify / verifier-check reports. **Exit 0 = PASS · 1 = FAIL · 2 = CONFIRMED_CHEAT.** |
| `pitstop integrity [path]` | Checks the latest commit or working tree for cheat patterns *without* a full scan: deleted or neutered tests, swallowed errors, suppression comments, hardcoded-to-pass values, mocked modules, forced exits. **Exit 0 = CLEAN · 1 = SUSPICIOUS · 2 = CONFIRMED_CHEAT.** |
| `pitstop ci [path]` | CI-friendly scan + verify against the base branch → a PR-ready markdown report — the gate as a PR comment. It only reports; fixes stay local via `/pitstop`. Wired into the [GitHub Action](docs/github-action.md), which comments the gate on every PR and fails the check when it fails. |

**Deep verification — can the referee say NO?**

| Command | What it does |
|---|---|
| `pitstop baseline-verify --baseline <ref> --command <cmd> …` | Proves a fix is real: runs the SAME verification on a known-baseline commit (must FAIL) and the candidate (must PASS), in isolated git worktrees, with sealed tamper-evident evidence and a verification-identity hash. `VERIFIED` only when both hold and nothing changed; otherwise `FAILED` / `UNPROVEN` / `INTEGRITY_FAILURE`. Exit 0/1/2/3. See [docs/baseline-verify.md](docs/baseline-verify.md). |
| `pitstop state-verify --claim modified:src/auth.ts …` | Independent external state check: verifies the agent's structured claims against the actual filesystem + git (existence, content hashes, line counts, porcelain status, HEAD). Catches "HTTP 200 but nothing changed", empty writes, reverts, wrong-file changes, whitespace-only edits. `STATE_VERIFIED` / `STATE_MISMATCH` / `UNPROVEN` / `INTEGRITY_FAILURE`. Exit 0/1/2/3. See [docs/state-verify.md](docs/state-verify.md). |
| `pitstop verifier-check --command <cmd> --mutate …` | Verifier self-test: runs the verification on a known-good state (must PASS) and a controlled known-bad state (must FAIL) in temp worktrees. `VERIFIER_VALID` = falsifiable; `VERIFIER_WEAK` = the seeded fault sailed through; `VERIFIER_BROKEN` = fails a correct state. Never mutates your working tree. See [docs/verifier-check.md](docs/verifier-check.md). |

**Penetration test — attack your own app**

| Command | What it does |
|---|---|
| `pitstop pen [path] [--fix] [--html] [--json]` | A real pen test of your own app. Static heuristics find candidates (secrets, routes, injection/SSRF/XSS), then it **boots the app in a sandbox** and attacks it live, recording every outbound HTTP call and spawned process. Findings are labeled `PROVEN` only when the sandbox saw real evidence; everything else is honestly `indicated`/`unproven`. Nothing reaches the real network; raw sockets are blocked. `--fix` writes failing-then-passing repro tests + `git apply`-able patches. Exit 0 = clean · 1 = high/critical · 2 = aborted. |
| `pitstop inspect <pen-id>` | Deep-dives a pen finding: exactly what attack was fired, what the app responded with, the sandbox evidence lines, the fix, the repro. |
| `pitstop repro <pen-id>` | Turns a pen finding into a regression test that boots the app — fails now, must pass after the fix. |

**Proof & reports — what you show people**

| Command | What it does |
|---|---|
| `pitstop report --html` | One self-contained `PITSTOP_REPORT.html` (inline SVG trends, integrity timeline, zero external assets). Also writes `PITSTOP_BADGE.svg` — a README-ready shield: `![OpenPitStop score](PITSTOP_BADGE.svg)`. |
| `pitstop share` | Renders a 1200×630 share card (`PITSTOP_CARD.html`) — score, trend, integrity/evidence chips, top findings. Screenshot it and post it. |
| `pitstop digest [--days N] [--md]` | The progress story: how the score moved, what got fixed and what regressed, gate results, cheat catches, flakies, open findings. |
| `pitstop honesty [--html]` | The proof that the numbers are real: evidence chain + integrity history + verify deltas + committed repro tests → one verdict, or a shareable HTML certificate. |

**Setup & transparency**

| Command | What it does |
|---|---|
| `pitstop install` / `install --uninstall` | Writes `/pitstop` into every supported tool (project + user level). `--uninstall` removes it all. `--hooks` also installs (or with `--uninstall`, removes) the git pre-commit gate. |
| `pitstop` (no args) | The guided first-run: detects your AI tools and git repo, then offers to install or score this repo (`try .`). Non-TTY prints the one-line menu instead. |
| `pitstop doctor` | Explains why categories show `skipped`: checks your toolchain (Node, git, jscpd, gitleaks, pa11y) and prints copy-paste install hints. Semgrep is optional and opt-in, so doctor won't flag its absence. |
| `pitstop prompt [--args …]` | Prints the exact prompt your AI tool expands `/pitstop` into, with your arguments filled in — full transparency into what the agent was told. |

### The score & badge

Skipped categories are excluded and the weights re-adjusted, so a missing `jscpd` never
silently drags the number down. The verify Δ compares against the last scan with the *exact
same categories measured* — a category skipped on both sides can't move the score. The
score only moves when your code does.

### Tamper-evident evidence

Every scan, verify and integrity document OpenPitStop writes gets a `sha256` fingerprint of
its own contents (`pitstop-sha256-canonical-v1`, deterministic key-sorted JSON). Edit the
JSON after the fact — inflate a score, delete a finding — and the next
`pitstop verify`/`pitstop gate` recomputes the fingerprint, sees the mismatch, and
reports the chain as broken. OpenPitStop can't be tricked into endorsing a baseline it didn't
write; the `gate` exit code treats a broken chain as a hard fail.

### Prompt transparency

Some AI tools show you the expanded slash-command prompt in their UI, some don't. OpenPitStop
keeps your chat clean either way: the `/pitstop` agent acknowledges with a single short line
and gets straight to work — the full instruction set stays out of your window. And
`pitstop prompt` lets you preview the raw prompt before anyone types anything.

### Root-cause correlation

Findings that touch the same files get grouped into one root cause, so the box shows
`1 root cause → 2 symptoms` instead of a flat list. Every cluster gets a stable id (e.g.
`security-19c390c6`) that the repro step can reference.

### Confirm, then loop

The agent prints the boxed summary, then **waits for your one-time OK**. After that it
works through each cluster on a `pitstop/*` branch: capture the bug as a failing test
first (`pitstop repro <id>`), make the smallest fix, pass the same repro test, run
`pitstop verify`, and commit. It re-scans after every fix and stops when a fresh scan
shows zero clusters (hard limits: 10 fix rounds or 45 minutes), ending with a
`PITSTOP_REPORT.md`.

### Ledger mode (opt-in)

`pitstop scan --ledger` boots your app with **every outbound HTTP call rerouted to a mock
gateway**, then replays the three classic payment bugs: duplicate webhook, concurrent
double-submit, delayed retry. If the mock gateway's own receipt log shows more than one
charge per idempotency key, that's a **proven double-charge** — not a guess. The shipped
If the sandbox can't intercept some traffic,
the run aborts (`exit 77`); nothing ever reaches a real gateway.

**Which stacks are covered?** Node/JS apps run under the nock preload, which intercepts
every outbound call in-process. Go, Python, Rust and .NET apps run under a recording
`HTTP_PROXY` sandbox that answers the known payment-gateway hosts with mocked receipts
and 502s everything else. Java and Dart are refused (their HTTP clients don't honor
`HTTP_PROXY`, so interception could not be guaranteed). HTTPS stays blocked (502): without
a trusted CA the proxy cannot terminate a CONNECT tunnel, so an HTTPS double-charge is
reported as *indicated*, never *proven*. Native binaries and raw sockets bypass the proxy
and are not observed. Set `PITSTOP_START` to override start-command guessing for
non-Node repos.

### Integrity gate

Every `pitstop verify` also diffs your change against HEAD and checks for the classic
agent-cheat moves: deleted or loosened tests, tests focused to hide failures
(`fit`/`test.only`), swallowed exceptions, suppression comments, hardcoded-to-pass values,
a mocked module-under-test, a forced `exit(0)` in app code, or an assertion's expected
value edited to match the buggy output. A caught cheat looks like this: change
`assert.equal(round2(8.075), 8.08)` to expect `8.07` with nothing else in the diff →
`CONFIRMED_CHEAT`, the change is blocked, and a human reviews it (verified against
`fixtures/assertion-literal-tamper/`). An honest app-side fix sails through `CLEAN`.

## Architecture

OpenPitStop is two pieces that never mix: a **CLI that measures**, and **your host agent that
reasons and edits**. The CLI produces the scan/verify numbers and the gate verdicts; the
model in whichever tool you're using reads them, decides what to change, and does the
editing through the `/pitstop` prompt template. This is deliberately *not* one monolithic
agent — the numbers can't be talked into looking better, and the agent can't silently
cheat its own referee. That separation is the product.

## Known limitations

- **Windows** is a first-class, CI-verified platform (build + smoke on `ubuntu-latest`
  and `windows-latest` every push). `watch`, `pen`, `pen --fix` and `scan --ledger` were
   each run end-to-end on a real Windows host against sample apps, with a live watch
   delta, PROVEN ledger double-charges (sealed evidence) and honest pen verdicts
  (including the honest "0 patches" case) all verified. The only open caveat is breadth,
  not correctness: not every exotic repo shape has been hand-exercised on Windows yet.
- **Codex App / VS Code extension** isn't supported and won't be until OpenAI ships custom
  slash commands; use Codex CLI for `/pitstop`.
- **Graceful degradation:** duplication (`jscpd`), secret scanning (`gitleaks`),
  dependency CVEs (`pip-audit`, `osv-scanner`), and accessibility runtime checks
  (`pa11y`/`axe`) run only when that tool is installed locally. The scan reports
  `skipped` for those categories and works fine without them. **Semgrep is an opt-in
  deeper engine** (see [Security fixes](#security-fixes)): it only runs when you set
  `PITSTOP_SEMGREP_CONFIG`, so it never runs just because the binary happens to be on
  PATH — no surprise network calls or slow scans.
- Requires **Node.js 22+** (the CLI depends on execa 10, which uses ES2024 `Set.union`).
- **Multi-stack honesty:** test runs (JS, Python, Go, Rust, Flutter, .NET, Java via Maven
  or Gradle), dependency CVEs, and the `pen`/`ledger` sandboxes are real for Node/JS and
  best-effort elsewhere. Go/Rust/Python/.NET apps run under the `HTTP_PROXY` recording
  sandbox (see Ledger mode); Java and Dart are refused for ledger, and proxy-mode results
  are labelled `indicated`, never `proven`, when the proxy cannot observe the traffic. The
  native test runners parse each toolchain's real output (`go test -json`, `cargo test
  --format json`, `flutter test --machine`, dotnet/maven/gradle summaries) and report
  `skipped` when a toolchain isn't on PATH.
- **Pen-test honesty:** `pitstop pen` reports each finding with a **runtime-proof
  verdict**: **proven** (the live dynamic attack confirmed it under the sandbox),
  **indicated** (static rule fired but the dynamic phase couldn't confirm), **unproven**
  (the dynamic phase ran and found no evidence for that rule), or **not-tested** (dynamic
  phase aborted). Proven findings are real; everything else is a hypothesis until you
  replay the attack yourself. The sandbox records outbound connections and spawned
  processes instead of blocking them (so real bytes never leave your machine for canaries,
  but a compromised app could still run commands locally); raw socket APIs are blocked
  outright. `pen --fix` writes deterministic patches **only** for findings fixable by pure
  insertion (e.g. missing `helmet()`, `x-powered-by` leaks) — anything else gets a failing
  repro test and fix guidance, which is your contract for the fix.
- **`drive` verdicts** for runtime pen findings come from the repro test (FAIL first, PASS
  after the fix), not from the static score — the static gate has nothing to say about a
  runtime-only finding.
- **Baseline-aware verification honesty:** without an explicit `expectedFailure` predicate,
  a non-zero baseline exit cannot prove the failure was the *intended* bug rather than a
  broken environment — such results are downgraded to `UNPROVEN`, never `VERIFIED`. The
  verification identity covers only the files you declare (`--test-file`/`--config`).
  See [docs/baseline-verify.md](docs/baseline-verify.md).
- **State verification is not semantic verification.** A content hash proves content
  changed, not that the change is correct or complete; untracked files without a snapshot
  have no before-state and are reported `UNPROVEN` rather than guessed. Files over 8 MB are
  recorded but not hashed. See [docs/state-verify.md](docs/state-verify.md).
- **Verifier health is per fault class.** Passing one known-bad case proves the verifier can
  fail, not that it covers every regression; choosing a meaningful known-bad state is the
  caller's responsibility, and the evidence records exactly what was seeded.
  See [docs/verifier-check.md](docs/verifier-check.md).

## Privacy

**Zero telemetry, zero SaaS, zero accounts — nothing leaves your machine unless you ask
it to.** OpenPitStop is a local CLI with no server and no phone-home: scans, gates and
pen tests run entirely on your machine, and the only network calls in the entire codebase
are the dependency audits you can see and opt out of (plus the `npx` download you
initiated). The full, auditable list — every connection, every cache, every file stored —
is in [PRIVACY.md](PRIVACY.md). The honesty brand is the product; that statement is the
receipt.

## Contributing

OpenPitStop is built to be extended — adding a whole new analyzer is a small, well-scoped
change. See [CONTRIBUTING.md](CONTRIBUTING.md) for the analyzer interface, conventions, and
how to open a PR. For the launch notes and the "why", read [LAUNCH.md](LAUNCH.md).

## License

[MIT](LICENSE)

## Support the project

If OpenPitStop saved you from shipping a bug your agent swore was fixed, the best
support is a star and a real repo:

- **Star** it: https://github.com/Krish-1507/OpenPitStop
- **Report issues or ideas**: https://github.com/Krish-1507/OpenPitStop/issues
- **Contribute** an analyzer (small, well-scoped): see [CONTRIBUTING.md](CONTRIBUTING.md)

No donation, no paywall, no telemetry.

---

<p align="center">
  <img src="docs/media/pitstop-icon.png" alt="OpenPitStop icon" width="64">
</p>

<p align="center">Built by <b>Krish J</b> — if it can referee itself, it can referee your agent.</p>
