# OpenPitStop — the 2-minute demo (judge's script)

This is the story: **your AI agent finally has a referee it can't cheat.**
Every command below is real, deterministic output — nothing is pre-recorded.

Total time: ~2 minutes. You need Node 22+ and git. No AI tool required.

---

## Act 0 — the 90-second wow (skip if you're on a strict 2 minutes)

This is the part people screenshot — a lazy agent getting caught **twice**:

```bash
node scripts/cheat-demo.cjs   # from the repo checkout; also ships in the npm package
                              # (node_modules/openpitstop/scripts/cheat-demo.cjs)
# PITSTOP_CLI="node /path/to/dist/cli.js" → run it against a local build
```

A fully scripted, deterministic arc against a real repo with a real failing
jest test:

```
ACT 1  honest baseline              →  1 failed test, scanned and sealed
ACT 2  agent focuses passing tests  →  GATE: SUSPICIOUS     (exit 1) — blocked
ACT 3  agent deletes the test       →  GATE: CONFIRMED_CHEAT (exit 2) — blocked
       (tamper-evident evidence chain verifies the whole way)
```

Safe to run in a live room, and it's the whole product in miniature. Then
continue to Act 1.

## Act 1 — a broken repo, scored honestly (0:00–0:40)

```bash
npx openpitstop demo
```

OpenPitStop copies an intentionally-broken app into a temp dir and scans it
immediately. You get the boxed report: circular dependency, known-CVE
dependency, failing tests, a hardcoded secret — each with its own finding id.

Then point it at a repo that matters:

```bash
cd <your-project>
npx openpitstop scan
```

Exit code **0 = clean, 1 = issues found, 2 = suspicious**. That contract is
the whole product: the numbers are sealed, tamper-evident, and can't be
talked into looking better.

## Act 2 — the real penetration test (0:40–1:20)

```bash
npx openpitstop pen --fix
```

`pen` boots your app's own `start` script inside a sandbox and fires attack
traffic at it: command injection, SSRF, XSS, rate limiting, missing headers.
For each route it records *proof* — the exact request and the app's response.

- Every finding carries a **runtime-proof verdict** — **proven** (the live
  attack confirmed it under the sandbox), **indicated**, **unproven**, or
  **not-tested** — never oversold. The report's summary line says exactly
  how many static findings were proven live, e.g.
  `Static findings verified live: 1 proven · 1 indicated · 3 unproven`.
- `--fix` writes two things:
  - **repro tests** — permanent regression tests that FAIL while the bug is
    live (that's the contract, by design);
  - **deterministic patches** for what's provably safe to auto-generate
    (missing `helmet()`, `x-powered-by` leaks) — every patch passes
    `git apply --check` (regression-tested in CI).

### Act 2b — the proof that sticks (drift)

Run `pen` again after a fix:

```bash
npx openpitstop pen
```

This run is compared against the last sealed pen run. You see the delta, not
just a fresh score: a finding that was PROVEN and is now gone shows as
**RESOLVED** (the fix worked), a regression shows as **NEW** and fails the gate,
and a static indication that became a live proof shows as an **ESCALATION**.
Most scanners hand you a one-off report. This one keeps a running ledger of
proof, so a fix can't silently rot back into a bug.

## Act 3 — the agent fixes it, and we verify it didn't fake it (1:20–2:00)

```bash
npx openpitstop repro <finding-id>   # FAILS first — the bug is real
npx openpitstop drive <finding-id>   # hands it to YOUR agent (claude/codex/...)
```

`drive` writes the mission prompt itself: *run the repro, it must FAIL, fix
the root cause, re-run it, it must PASS, don't break anything.* Then OpenPitStop
verifies the result — not the agent's claims:

- the **repro test** must flip FAIL → PASS;
- `pitstop verify` diffs the change against the signed baseline and flags
  deleted tests, swallowed errors, hardcoded-to-pass values — the classic
  agent-cheat patterns.

```bash
npx openpitstop verify   # VERIFIED / NOT VERIFIED — no grey
```

## The one-liner pitch

> Agents fix code; they don't know when to stop, and they'll tell you they're
> done regardless. OpenPitStop is the honest referee: deterministic scans,
> tamper-evident baselines, runtime penetration tests with failing-first
> regression contracts, and a verification gate that catches the agent lying.
> The CLI measures; the agent edits; the numbers can't be cheated.

## If they want depth

- `npx openpitstop install` — registers the `/pitstop` slash command in
  Claude Code, Cursor, OpenCode, Codex CLI, Gemini CLI.
- `npx openpitstop honesty` — the evidence report: every number traced to a
  sealed file.
- `pitstop gate` / `pitstop ci` — the same contract as a CI gate.
- `node scripts/cheat-demo.cjs` — **Act 0** above: the 90-second cheat-catch arc.
- `npx openpitstop watch` / `ready-check` / `budget` — the token economy
  that keeps the agent loop cheap (reuse sealed baselines, skip waste).
- `docs/` — this repo's CI runs the patch-validity + evidence regression
  suites on Linux and Windows on every push.
