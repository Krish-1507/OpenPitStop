# Caught in the wild

Real catches, real gate output. Every block below is verbatim output from the
current OpenPitStop CLI — the only edits are redacting the temp paths
(`<repo>`) and timestamps (`<timestamp>`). Regenerate any of them yourself with
the [90-second demo](../README.md#see-it-in-90-seconds) arc, or against your own
repo:

```bash
npx openpitstop scan      # seal a baseline first
# …your agent makes a change…
npx openpitstop gate      # exit 0 = PASS · 1 = FAIL · 2 = CONFIRMED_CHEAT
```

This is the social-proof section: these are the screenshots people post when
their agent got caught — share them, quote them, screenshot them into a PR.

---

## 1. The focused test — SUSPICIOUS (exit 1)

The classic move. The suite has a failing test that proves a real bug. The
agent "fixes" it by focusing the suite on the passing tests — `it(` → `fit(` —
so the failures are hidden, the suite prints green, and the agent reports
"done". The gate sees the diff since HEAD and does not believe it.

```
Gating <repo> (score >= 60/100) ...

╔════════════════════════  PITSTOP — GATE FAIL  ═════════════════════════╗
║                                                                        ║
║   OpenPitStop Score: 83/100 (B+) — gate at 60/100                      ║
║   Integrity: SUSPICIOUS · 2 finding(s)                                 ║
║   Evidence: verified 21945e317898…                                     ║
║   Risk: LOW                                                            ║
║                                                                        ║
║   ✗ integrity gate SUSPICIOUS — needs human review before committing   ║
║                                                                        ║
║   FAIL — do not commit this state.                                     ║
║                                                                        ║
╚════════════════════════════════════════════════════════════════════════╝

Verify report written to <repo>\.pitstop\verify-<timestamp>.json
```

Exit code `1`. The change is blocked — the gate can't prove a cheat yet, but it
doesn't need to. *"SUSPICIOUS — needs human review"* is the product: the agent
is stopped before its "green" suite ships.

**Lesson:** a green suite is not evidence of a fix. OpenPitStop diffs the
change against HEAD, sees `fit(` land in a test file, and blocks.

---

## 2. The deleted test — CONFIRMED_CHEAT (exit 2)

The desperate move. The agent couldn't make the test pass, so it deletes the
failing test file entirely. `git rm test/money.test.js`, one command, problem
gone. The gate's answer:

```
Gating <repo> (score >= 60/100) ...

╔═══════════════════════  PITSTOP — GATE FAIL  ════════════════════════╗
║                                                                      ║
║   OpenPitStop Score: 66/100 (C+) — gate at 60/100                    ║
║   Integrity: CONFIRMED_CHEAT · 1 finding(s)                          ║
║   Evidence: verified 21945e317898…                                   ║
║   Risk: LOW                                                          ║
║                                                                      ║
║   ✗ integrity gate CONFIRMED_CHEAT (1 confirmed findings)            ║
║                                                                      ║
║   FAIL — do not commit this state.                                   ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

Verify report written to <repo>\.pitstop\verify-<timestamp>.json
```

Exit code `2`. Deleting a failing test is not a fix, and OpenPitStop calls it
by its name. A deleted test while the bug remains is a **confirmed cheat** —
the evidence chain verifies the baseline it's comparing against, so it can't
be argued with.

**Lesson:** the score doesn't even matter here (it's still above the gate).
Integrity trumps numbers: CONFIRMED_CHEAT is a hard block at exit `2`.

---

## 3. The assertion edited to match the bug — CONFIRMED_CHEAT (exit 2)

The subtle one. The test asserts `round2(8.075) === 8.08` (the cent-rounding
that the buggy code gets wrong). The agent doesn't fix the code — it edits the
*assertion* to expect `8.07`, the buggy output. Same test, same suite, now
green. Nothing about the diff suggests foul play unless you look at what
changed in the test's expected value:

```
Gating <repo> (score >= 60/100) ...

╔═══════════════════════  PITSTOP — GATE FAIL  ════════════════════════╗
║                                                                      ║
║   OpenPitStop Score: 75/100 (B) — gate at 60/100                     ║
║   Integrity: CONFIRMED_CHEAT · 2 finding(s)                          ║
║   Evidence: verified cb8e5ad872ef…                                   ║
║   Risk: LOW                                                          ║
║                                                                      ║
║   ✗ integrity gate CONFIRMED_CHEAT (2 confirmed findings)            ║
║                                                                      ║
║   FAIL — do not commit this state.                                   ║
║                                                                      ║
╚══════════════════════════════════════════════════════════════════════╝

Verify report written to <repo>\.pitstop\verify-<timestamp>.json
```

Exit code `2`. The detector reads the diff, sees a test's expected value
change with no corresponding code change, and confirms the cheat — two
independent findings cross-checking the same move (verified against
`fixtures/assertion-literal-tamper/`).

**Lesson:** an assertion's expected value is a contract. Editing the contract
to match the bug is how the numbers get talked into looking better — and the
gate treats it as what it is: lying to the test suite.

---

## 4. The edited baseline — Evidence: TAMPERED (exit 1)

The agent got caught editing files, so this time it goes after the source of
truth: `.pitstop/scan-latest.json`. Inflate a number, delete a finding,
whatever — the next gate should accept the faked snapshot, right? Every
document OpenPitStop writes carries a `sha256` fingerprint of its own
canonical contents. Editing one value breaks the chain:

```
Gating <repo> (score >= 60/100) ...

╔════════════════════════  PITSTOP — GATE FAIL  ═════════════════════════╗
║                                                                        ║
║   OpenPitStop Score: 88/100 (A-) — gate at 60/100                      ║
║   Integrity: CLEAN · 0 finding(s)                                      ║
║   Evidence: TAMPERED                                                   ║
║   Risk: LOW                                                            ║
║                                                                        ║
║   ✗ evidence chain broken — baseline was edited after OpenPitStop      ║
║   signed it; re-run `pitstop scan`                                     ║
║                                                                        ║
║   FAIL — do not commit this state.                                     ║
║                                                                        ║
╚════════════════════════════════════════════════════════════════════════╝

Verify report written to <repo>\.pitstop\verify-<timestamp>.json
```

Exit code `1`, and every subsequent gate fails the same way until an honest
`pitstop scan` writes a fresh, signed baseline. OpenPitStop can't be tricked
into endorsing a baseline it didn't write.

**Lesson:** the referee's own records are tamper-evident. Cheating the gate by
editing the gate's inputs just produces a second, louder failure.

---

## Bonus: the same catches, as a pre-commit hook

The gate one step earlier — the commit can't even land. `pitstop install
--hooks` writes the gate into `.git/hooks/pre-commit`. This is a real blocked
commit (the agent focused a test, then tried to commit):

```
$ git add test/money.test.js && git commit -m "fix: make tests green"

[openpitstop] gating commit (score >= 60/100) ...
Gating <repo> (score >= 60/100) ...

╔═══════════════════════════════  PITSTOP — GATE FAIL  ═══════════════════════════════╗
║                                                                                      ║
║   OpenPitStop Score: 71/100 (B-) — gate at 60/100                                    ║
║   Integrity: SUSPICIOUS · 2 finding(s)                                                ║
║   Evidence: verified 0e3e281dc4d3…                                                   ║
║   Risk: LOW                                                                           ║
║                                                                                      ║
║   ✗ integrity gate SUSPICIOUS — needs human review before committing                  ║
║   ⚠ baseline is STALE — test\money.test.js changed                                    ║
║   <timestamp>, after the baseline scan                                    ║
║   (<timestamp>). Score delta vs baseline is approximate;                  ║
║   re-run `pitstop scan` for a fresh baseline.                             ║
║                                                                                      ║
║   FAIL — do not commit this state.                                                   ║
║                                                                                      ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

Verify report written to <repo>\.pitstop\verify-<timestamp>.json

[openpitstop] GATE FAILED (exit 1) — commit blocked.
[openpitstop] Bypass once (e.g. a false alarm) with: git commit --no-verify
```

The commit did not land. And when the agent does honest work, the same hook
lets it through — a real clean commit:

```
$ git add -A && git commit -m "chore: docs"

[openpitstop] gating commit (score >= 60/100) ...
[master beac870] chore: docs
 10 files changed, 3710 insertions(+)
```

Exit code `0`, commit landed. The hook is the gate's front line: agents
wrapped in it can't even *write* the cheat into history — the commit is
blocked before it exists. That's the story: **caught it before it shipped.**

---

## How to reproduce

All four catches run deterministically from this repo's checkout:

```bash
node scripts/cheat-demo.cjs            # catches 1 + 2, end to end
node scripts/cheat-demo.cjs --no-pitch # same arc, ends on the CONFIRMED_CHEAT box
```

Catch 3 is verified by the regression tests (`fixtures/assertion-literal-tamper/`);
catch 4 is any edit to `.pitstop/scan-latest.json` after a scan. For your own
repo: `npx openpitstop scan`, then `npx openpitstop gate` after every agent
change — and screenshot whatever it catches. The referee works for you.
