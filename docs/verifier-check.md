# Verifier Health — Falsifiability Checking

`pitstop verifier-check` — **a referee that cannot say NO is not a referee.**

## Why falsifiability matters

Every strong verdict OpenPitStop produces (`VERIFIED`, `STATE_VERIFIED`, a
green gate) rests on a verification mechanism: a repro test, a suite run, a
state comparison. If that mechanism only ever produces PASS when things work
but cannot reliably produce FAIL when something is broken, then every verdict
built on top of it is decoration:

```
KNOWN-BAD   →  verification  →  FAIL     (required)
KNOWN-GOOD  →  verification  →  PASS     (required)
both PASS   →  the verifier is insufficient and its PASS carries no information
```

The property is called **falsifiability**: a verification is only trustworthy
evidence if it has demonstrated the ability to detect an intentionally
introduced failure.

## What verifier-check does

It validates the *verifier itself*, not your code:

1. **known-good case** — runs the verification in an isolated temp worktree at
   `--good-ref` (default HEAD). Expected: **PASS**.
2. **known-bad case** — runs the *same* verification against a controlled
   negative state. Expected: **FAIL**. The negative state is either:
   - `--bad-ref <ref>` — an explicit known-bad commit, or
   - declared mutations (`--mutate path=content`, `--mutate-write path=fixture`,
     `--mutate-delete path`) applied **inside a temporary detached worktree**.

## Verdicts

| Verdict | Matrix | Meaning |
|---|---|---|
| `VERIFIER_VALID`   | good→PASS, bad→FAIL | The verification demonstrated it can say NO. Its PASS is evidence. |
| `VERIFIER_WEAK`    | good→PASS, bad→PASS | It cannot detect the seeded fault; its PASS is weak evidence for this fault class. |
| `VERIFIER_BROKEN`  | good→FAIL           | It rejects a correct state — worse than weak. |
| `INTEGRITY_FAILURE`| infra problem       | Bad ref, invalid fixture, mutation target missing, or the verifier itself changed between the two runs (not like-for-like). |

Exit codes: `0` VALID · `1` WEAK/BROKEN · `3` INTEGRITY_FAILURE.

## Safety — explicit, controlled, isolated, reproducible

- **Explicit** — self-testing never runs automatically; you invoke it and name
  the verifier (`--command`, `--id`).
- **Controlled** — the fault is *your* declared mutation or an explicit
  `--bad-ref`. OpenPitStop never invents or auto-applies mutations to a user
  repository, and never mutates the user's working tree: mutations land in a
  temporary detached worktree that is removed afterwards (`finally`).
- **Isolated** — dirty working trees, untracked files and branches are
  untouched (tested).
- **Reproducible** — repeated runs yield the same verdict, exit codes and
  verification hash (tested).
- **Anti-self-deception** — if a declared mutation alters the verification's
  *own* identity files, the report says so explicitly: that run proves the
  harness reports FAIL, **not** that the verifier detects code faults. If the
  verifier changed between the good and bad states for any *other* reason
  (e.g. the bad ref commits a weakened verifier), the result is
  `INTEGRITY_FAILURE` — the comparison is not like-for-like and no health
  verdict is issued. Commit references are resolved with
  `git rev-parse --verify` so a fabricated 40-hex string cannot masquerade as
  a resolvable commit.

## What it proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| The verification mechanism *can* produce FAIL | That the verification covers *every* property that matters — one seeded fault demonstrates falsifiability for that fault class only |
| Its PASS carries information (it could have been FAIL) | That the code under test is correct |
| The harness executes and reports honestly on both states | That the known-bad case is representative of real regressions |

A meaningful known-bad case violates the *property being verified*: remove a
required behavior, break a required condition, weaken a security property,
delete a required file. Trivial mutations (e.g. flipping a comment) prove
nothing and are not special-cased — the report simply shows what happened.

## Evidence

Each run writes a sealed `.pitstop/verifier-check-<timestamp>.json`
(`pitstop-canonical-sha256-v1`) containing: verifier id, command, verification
hash, HEAD commit SHA, both cases (state source, commit SHA, mutation list
with content hashes, expected vs actual, exit codes, output excerpts),
verdict, reasons and notes. Editing the file afterwards breaks the digest and
the gate reports it as tampered.

## Gate integration — design decision

Verifier health is an **explicit verifier-health check**, not a hard commit
requirement:

- `VERIFIER_WEAK` / `VERIFIER_BROKEN` / `INTEGRITY_FAILURE` are **surfaced as
  gate reasons** — a verifier that never demonstrated falsifiability does not
  earn the same trust as one that has — but do not block commits, because the
  report describes the verification tooling, not this tree. Blocking would
  break existing workflows for an optional capability.
- **Tampered verifier-check evidence hard-blocks** (exit ≥ 1), consistent with
  every other evidence chain in OpenPitStop.
- Rationale documented here; revisit by promoting `VERIFIER_WEAK` to a block
  in strict environments if desired.

## Usage

```sh
# validate a repro-style verifier against a seeded fault
pitstop verifier-check . --command "node check.js" \
  --mutate "data.txt=broken" --id check:required-behavior

# validate against an explicit known-bad commit
pitstop verifier-check . --command "npm test" --bad-ref <sha> --id suite:npm-test

# known-bad via a fixture file
pitstop verifier-check . --command "node check.js" --mutate-write "config.json=fixtures/bad.json"
```

## Limitations (stated honestly)

- Falsifiability is demonstrated **per fault class**: passing one known-bad
  case does not certify the verifier against all regressions.
- The check runs the verification in a bare checked-out worktree; verifications
  needing generated artifacts (`node_modules`, builds) must be self-contained
  or installed by the command itself.
- OpenPitStop does not generate mutations for you — choosing a *meaningful*
  known-bad state is the caller's responsibility, and the evidence records
  exactly what was seeded so a reviewer can judge it.

## Files

- `src/verify/verifier.ts` — library (cases, mutations, verdict matrix, sealing)
- `src/commands/verifierCheck.ts` — `pitstop verifier-check` CLI
- `src/commands/gate.ts` — verifier-health surfacing in the gate
- `test/verifierCheck.test.ts` — 17 tests (all 10 required scenarios + gate integration)
