# Regression Verification — a fix must not break what already worked

`pitstop regression-check` — per-check comparison of previously verified
behavior against the candidate.

## The model

```
BASELINE (previously verified)      CANDIDATE (current results)
  ✓ check A                           ✓ check A
  ✓ check B                           ✗ check B      ← REGRESSION
  ✓ check C                           ✓ check C
```

A successful fix must satisfy the requirement AND avoid breaking previously
working behavior. This command compares check-level results (per-test names
where the runner exposes them — TAP/`node --test`, spec reporters ✓/✕,
jest/mocha `PASS`/`FAIL` per file, pytest `path::name`, go `--- PASS/FAIL:` —
falling back to a single suite-level check when output is unparseable) between
a baseline and the candidate, both executed in isolated worktrees of their
commits.

## Classification — not every difference is a regression

| Classification | Meaning |
|---|---|
| `REGRESSION` | previously **verified passing**, now failing — the only true regression |
| `FIXED` | previously failing, now passing |
| `UNCHANGED` | same outcome both sides (pass/pass **or fail/fail** — already-broken behavior is not a regression) |
| `NEW_FAILURE` | a check that did not exist at the baseline and fails (new check, suite red — flagged, but honestly not a regression of old behavior) |
| `NEW_PASS` | a check that did not exist at the baseline and passes |
| `UNPROVEN` | flaky across candidate runs, a baseline check that vanished from the candidate run (possibly deleted — the integrity gate flags deleted test files), or an execution that could not be trusted |

## Usage

```sh
# git mode: run the command at the baseline ref and the candidate ref
pitstop regression-check . --command "node --test" --baseline <ref>

# evidence mode: compare against a sealed recorded baseline
pitstop regression-check . --command "node --test" --record     # record once
pitstop regression-check . --command "node --test" --baseline-evidence .pitstop/regression-baseline.json

# flakiness detection
pitstop regression-check . --command "npm test" --baseline <ref> --runs 3
```

Exit codes: `0` NO_REGRESSION · `1` REGRESSION · `2` UNPROVEN · `3` INTEGRITY_FAILURE.

## Flaky / non-deterministic tests — documented limits

- With the default `--runs 1`, a flaky candidate check is **indistinguishable
  from a regression and will be classified REGRESSION**. That is the honest
  reading of one observation.
- `--runs <n>` executes the candidate n times (each run a fresh checkout of
  the same commit). A check with both a pass and a fail across runs is
  classified `UNPROVEN (flaky)` — surfaced, never silently trusted.
- The **baseline is always a single run**: a flaky baseline check can still
  mislabel a check as `FIXED` or hide a regression. This limitation is real
  and accepted; per-side multi-run is a possible future extension.
- Non-deterministic checks that happen to pass consistently across runs are
  not detectable at all.

## Evidence

Each run seals `.pitstop/regression-<timestamp>.json`: the command and its
hash, baseline/candidate refs and SHAs, suite exit codes, every check's
classification with baseline/candidate outcomes, regressions, new failures,
fixes, unproven list, verdict and reasons — sealed with the standard
`pitstop-canonical-sha256-v1` digest. Evidence-mode baseline files
(`.pitstop/regression-baseline.json`, written by `--record`) are sealed too;
a tampered baseline file is `INTEGRITY_FAILURE` and nothing is classified.

## Gate integration

`pitstop gate` folds in the newest regression report: `REGRESSION` (including
new failures) **hard-blocks**, listing the regressed checks; tampered evidence
hard-blocks; `UNPROVEN` surfaces as a reason; no report leaves the gate
unchanged.

## What this proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| Which previously verified checks now fail, by name, with sealed evidence | That the checks cover the behavior that matters (coverage is the suite author's responsibility) |
| That fixed/new/unchanged differences are not inflated into regressions | Determinism — flaky behavior is only detectable with `--runs > 1`, and baseline-side flakes remain invisible |
| That the comparison ran against the actual commits (isolated worktrees, sanitized environment) | Semantic correctness of *why* a check fails |

## Files

- `src/verify/regression.ts` — parsing, classification, sealing
- `src/commands/regressionCheck.ts` — `pitstop regression-check` CLI
- `src/commands/gate.ts` — regression hard-block
- `test/regressionCheck.test.ts` — 16 integration tests
