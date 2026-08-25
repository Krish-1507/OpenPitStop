# The Evidence Chain — "why should I trust this verdict?"

`pitstop explain` — one command that answers that question from REAL evidence,
without reading source code.

## The chain

OpenPitStop's verification capabilities each seal their own evidence document
into `.pitstop/`. `explain` aggregates the newest of each into one ordered,
explainable chain:

```
TASK
 ↓
BASELINE        baseline-verify-*.json     (FAIL → PASS on the same verification)
 ↓
STATE           state-verify-*.json        (claims vs disk/git)
 ↓
TESTS           scan-latest.json           (suite results from the scan)
 ↓
ACCEPTANCE      acceptance-*.json          (requirement contracts)
 ↓
SECURITY        scan-latest / pen-latest   (findings as evidence)
 ↓
REGRESSION      regression-*.json          (previously passing → now failing)
 ↓
INTEGRITY       verify-*.json              (agent-cheat detectors)
 ↓              (+ verifier-check, holdout)
EVIDENCE        sealed chain document
 ↓
VERDICT
```

Only components that actually ran appear with a real status. The honesty
contract:

| Status | Meaning |
|---|---|
| `PASS` | the component ran and its verdict was positive |
| `FAIL` | the component ran and its verdict was negative — **blocks** |
| `TAMPERED` | the evidence document failed its own seal, or is unreadable — **blocks** |
| `UNPROVEN` | the component ran but could not classify (flaky, non-discriminating, suspicious) |
| `SKIPPED` | the underlying tool reported the category as skipped (not installed / not applicable) |
| `NOT_CONFIGURED` | never run — no evidence document exists. **Never rendered as a pass.** |

## The verdict is derived, never asserted

- **BLOCKED** — any FAIL or TAMPERED item. The "Why" section quotes the
  underlying reasons (e.g. "REGRESSION — previously passing check(s) now
  failing — check B", with baseline PASS / candidate FAIL).
- **VERIFIED** — a strong verification (baseline-aware, acceptance, or
  holdout) passed AND nothing is unproven or failing.
- **UNPROVEN** — everything else, including "nothing has run yet". The output
  says exactly what would strengthen it.

The chain itself is sealed (`pitstop-canonical-sha256-v1`) into
`.pitstop/explain-<timestamp>.json`, so the explanation is citable and
tamper-evident like every other OpenPitStop artifact. Serialization of the
chain content is deterministic (canonical key-sorted JSON) — the same evidence
always produces the same chain.

## Usage

```sh
pitstop explain                # the chain + verdict
pitstop explain --verbose      # per-item command, timestamps, digests, reasons
pitstop explain --json         # machine-readable, includes the canonical form
```

Exit codes: `0` VERIFIED · `1` BLOCKED · `2` UNPROVEN.

## What this proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| What was actually verified, against which commits, with which commands | That the verification coverage is complete — NOT_CONFIGURED items are gaps, not passes |
| That each evidence document is intact (seals re-verified at explain time) | That the underlying requirement was well-specified |
| Why the verdict is what it is, item by item | More than the evidence contains — an UNPROVEN verdict stays UNPROVEN |

## Tests

`test/chain.test.ts` — 11 tests: all-pass, partial (NOT_CONFIGURED honesty),
skipped categories, regression failure, CONFIRMED_CHEAT, missing evidence,
tampered and malformed evidence, explain rendering, deterministic
serialization, and unproven-downgrades-the-verdict.
