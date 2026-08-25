# Baseline-Aware Verification

## Why post-fix PASS alone is insufficient

`PASS` after a fix proves the verification exits zero on the *candidate* commit.
It does not prove the verification was capable of detecting the *original*
failure. The verification may have:

- never covered the bug
- been too weak / swallowed the failure
- been edited, deleted, or had its assertion weakened by the agent
- had its expected value / command / config changed
- passed for an unrelated reason (missing dependency, env broken)

The agent can then grade its own homework: **FAIL → PASS** is honest only if
the same verification demonstrably **FAIL**ed on the baseline.

## The stronger model

```
KNOWN BASELINE  ──→  run verification  ──→  MUST FAIL  ──→  seal evidence
                                              │
                                         agent changes
                                              ↓
CANDIDATE       ──→  run SAME verification ──→ MUST PASS ──→ seal evidence
                                              │
                                         compare hashes + integrity
                                              ↓
                                           VERIFIED
```

`VERIFIED` means:

- baseline demonstrated the expected failure
- candidate demonstrates the expected success
- verification identity (command + participant file hashes + config hashes + env) is identical
- evidence integrity (`pitstop-canonical-sha256-v1`) is valid
- diff-scoped integrity detectors report no CONFIRMED_CHEAT on verification files

Anything less downgrades the verdict: `FAILED` (candidate still fails), `UNPROVEN`
(baseline unproven / identity drift), or `INTEGRITY_FAILURE` (tamper / deleted test).

## What baseline-aware verification does

`pitstop baseline-verify` is a **general, repository-agnostic** primitive:

```sh
pitstop baseline-verify . \
  --baseline <sha|ref> \
  --candidate <sha|ref> \
  --command "<shell command>" \
  --test-file <verification file> \
  --config <config file> \
  --id <verification id>
```

- **Isolation** — both commits are checked out in *detached, temporary git worktrees* (`git worktree add --detach`). The user's working tree, index, and branches stay untouched (dirty repos, `HEAD` detached, arbitrary SHAs all handled). Cleanup is guaranteed via `finally { worktree remove }` even after failures.
- **Identity** — the verification's identity is the canonical hash of `{command, cwd, env, sorted fileHashes, sorted configHashes}` (via `digestOf`). Baseline vs candidate hashes must match; otherwise `INTEGRITY_FAILURE`.
- **File participation** — `--test-file`/`--config` files are hashed (`sha256(file content)`) in *each* worktree. Missing → `__missing__`. Any mismatch → `verificationFilesChanged = true`. The `git diff --name-only baseline..candidate` is also consulted; touching a participant file upgrades the verdict.
- **Integrity reuse** — between `baselineSha..candidateSha` the diff is fed to `buildIntegrityReport` (`testTamper`, `hardcodedMatch`, `exitCheat`, etc.). A `CONFIRMED_CHEAT` (whole test file deleted, `process.exit(0)` forced) upgrades to `INTEGRITY_FAILURE` and surfaces the detector evidence.
- **Evidence** — each execution is sealed with `seal()` (`pitstop-canonical-sha256-v1` over the canonical JSON, evidence field excluded). The final comparison document is sealed to `.pitstop/baseline-verify-<timestamp>.json`; `checkEvidence` detects post-write edits.
- **Expected-failure predicate** — `expectedFailure:{exitCode?, stdoutContains?, stderrContains?}` lets callers state what the baseline *should* emit. Without it, **any non-zero** counts as failure — the doc notes this limitation explicitly and the verdict reasons spell out the heuristic. Baseline output containing `ENOENT` / `Cannot find module` while the candidate passes is downgraded to `UNPROVEN`.

## What each verdict means

| Verdict | Meaning |
|---|---|
| `VERIFIED` | baseline FAIL + candidate PASS + identity PASS + integrity PASS. The verification *proves* the fix. |
| `FAILED` | baseline demonstrably failed, candidate still fails. Not yet fixed. |
| `UNPROVEN` | candidate PASS but baseline did not demonstrate failure, or the failure didn't match `expectedFailure`, or the baseline's failure looks like an unrelated environment error. Also used when identity is missing but not yet tampered. |
| `INTEGRITY_FAILURE` | verification files changed/deleted, command changed, evidence tampered, or a detector fired `CONFIRMED_CHEAT`. |

## Gate integration

`pitstop gate` now consults the newest `.pitstop/baseline-verify-*.json` (besides `verify`).  

- `VERIFIED` — no extra gate reason (strongest).
- `UNPROVEN` — reason surfaced, but gate does not hard-block (human judgment).
- `NTEGRITY_FAILURE` / `FAILED` / tampered evidence — gate hard-blocks (`exit 1`, `2` for `CONFIRMED_CHEAT`).

A `PASS` without any `baseline-verify` evidence is therefore *less trustworthy* than a `PASS` with a sealed `VERIFIED` chain — this is stated explicitly in the gate output.

## Example — generic fixture (not MiniShop)

```sh
# baseline commit `abc123` has the bug; verify.js exits 1 when data.txt === "bug"
pitstop baseline-verify . --baseline abc123 --candidate HEAD --command "node verify.js" --test-file verify.js

# → BASELINE commit abc123 … FAIL (exit 1)
#   CANDIDATE commit HEAD … PASS (exit 0)
#   COMPARISON baseline FAIL, candidate PASS, identity PASS → VERIFIED
```

An adversarial demo (baseline already passes) is downgraded:

```sh
# verify.js already passes on the baseline
pitstop baseline-verify . --baseline abc123 --candidate HEAD --command "node verify.js" --test-file verify.js
# → VERDICT UNPROVEN — baseline did not demonstrate the expected failure
```

A verification that was weakened (e.g. `verify.js` edited to `process.exit(0)`) is flagged:

```
# → VERDICT INTEGRITY_FAILURE — verification files changed: verify.js
#    integrity detector CONFIRMED_CHEAT: added process.exit(0) in application code
```

## Limitations — stated honestly

- With only an exit code, OpenPitStop cannot prove the baseline failed *because it detected the intended bug* vs. a broken environment. Supply `expectedFailure:{stdoutContains}` for stronger guarantees; otherwise the report warns.
- The verification hash covers `command` + participating file contents + `env`. Files not listed are not part of the identity; list every file that defines the verification.
- Non-git repos are rejected with `INTEGRITY_FAILURE` and a reason.
- Worktrees require a valid commit SHA; a missing ref is a checked error, not a silent `VERIFIED`.

## Files

- `src/verify/baseline.ts` — library (no CLI I/O)
- `src/commands/baselineVerify.ts` — Commander command `pitstop baseline-verify`
- `src/commands/gate.ts` — augments gate with baseline-aware evidence
- `test/baselineVerify.test.ts` — 15 cases covering VERIFIED/FAILED/UNPROVEN/INTEGRITY_FAILURE, dirty tree, checkout failures, cleanup

