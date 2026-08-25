# External State Verification

`pitstop state-verify` — **do not trust the AI agent's claim about what it did.**

A coding agent can receive a successful tool response (`HTTP 200`, a green tool
badge, a confident natural-language summary) while the actual filesystem or Git
state says otherwise: the file was never written, was written empty, was
reverted, or a *different* file changed. The orchestration layer then continues
on a belief, not on a fact. State verification closes that gap by inspecting
the repository independently.

## What it proves — and what it does NOT

| | |
|---|---|
| **PROVES**   | "Did the claimed state change actually occur?" — file exists / changed / vanished, on disk and in git, with hashes and porcelain status as evidence. |
| **DOES NOT PROVE** | "Is the resulting code correct?" Semantic correctness remains the job of `pitstop verify`, `repro`, `baseline-verify`, and the integrity gate. |

This distinction is printed on every verdict box.

## Usage

```sh
# verify structured claims against the ACTUAL repo state
pitstop state-verify . --claim modified:src/auth.ts
pitstop state-verify . --claim created:src/new.ts --claim deleted:src/old.ts

# config / dependency claims are just path claims on the files that define them
pitstop state-verify . --claim modified:config/app.json        # "configuration changed"
pitstop state-verify . --claim modified:package.json           # "dependency added"

# strong BEFORE/AFTER: snapshot first, verify against it later
pitstop state-verify . --snapshot --path src/auth.ts --path src/cart.ts
pitstop state-verify . --claim modified:src/auth.ts --before .pitstop/state-snapshot-*.json

# machine readable
pitstop state-verify . --claim modified:src/auth.ts --json
```

Exit codes: `0` STATE_VERIFIED · `1` STATE_MISMATCH · `2` UNPROVEN · `3` INTEGRITY_FAILURE.

## How the actual state is derived

Every signal comes from the filesystem or git — never from the agent's words:

- **filesystem** — existence, byte size, line count, `sha256` content hash
- **git status** — `git status --porcelain -- <path>` (`" M"`, `"??"`, `" D"`, …)
- **git HEAD** — `git show HEAD:<path>` gives the before-state for tracked files
  (read byte-exact; a stripped newline would fake a diff)
- **before-state resolution order** (strongest first):
  1. a sealed `--before` snapshot from an earlier run,
  2. git HEAD content (tracked files),
  3. unknown → claims that need a before-state become `UNPROVEN`, never guessed.

**Performance:** snapshots are *targeted* — only claimed paths are touched.
Files over 8 MB are recorded (size/status) but not hashed. No repo-wide scan
is performed by this command.

## Verdict semantics

| Verdict | Meaning |
|---|---|
| `STATE_VERIFIED` | every claim was independently observed on disk and in git |
| `STATE_MISMATCH` | observed state **contradicts** a claim (unchanged hash, file still exists, wrong file changed, path never existed) |
| `UNPROVEN` | the claim could not be established: no before-state for an untracked file, empty created file, whitespace-only diff, hash unavailable |
| `INTEGRITY_FAILURE` | not a git repository — state cannot be verified against git |

`STATE_MISMATCH` dominates `UNPROVEN`; a mismatch means reality contradicts the
claim, an unproven means OpenPitStop refuses to vouch either way.

## Adversarial behavior (what the agent may try)

| Attack | Detection |
|---|---|
| claims "modified" but changed nothing | content hash identical to before-state → `STATE_MISMATCH` |
| changed a *different* file than claimed | claimed path mismatches + `otherChangedFiles` lists what actually moved |
| changed and immediately reverted | hash equals before-state → `STATE_MISMATCH` |
| created an empty file (failed write) | 0-byte file → `UNPROVEN` ("likely a failed write") |
| whitespace-only / line-ending-only edit | whitespace-stripped comparison → `UNPROVEN` ("no substantive modification") |
| claims "modified" on an untracked file with no history | no before-state → `UNPROVEN` (use `--snapshot` for a real before-state) |
| claims "deleted" a file that never existed | no before-state shows it existed → `UNPROVEN` |
| edits the state-verify report afterwards | `seal()` digest breaks → `checkEvidence` reports `tampered`; the gate hard-blocks |
| tampers with the BEFORE snapshot | `readStateSnapshot` rejects it (digest check) and the CLI falls back to git HEAD with a loud warning |

## Evidence

Each run writes a sealed `.pitstop/state-verify-<timestamp>.json` containing:
the claims, per-claim before/after snapshots (hash, size, line count, git
status), the **HEAD commit SHA** that pins the evidence to an exact git state,
observed signals, verdict, reasons, and other working-tree changes — all
covered by the standard `pitstop-canonical-sha256-v1` digest from
`src/evidence.ts`. Snapshots (`.pitstop/state-snapshot-*.json`) are sealed the
same way and carry the same commit SHA.

## Gate integration

`pitstop gate` consults the newest state-verify report:

- `STATE_MISMATCH` / `UNPROVEN` → surfaced as gate **reasons** (a state mismatch
  is not automatically a failed task — the human decides),
- `INTEGRITY_FAILURE` or **tampered evidence** → gate exits non-zero.

## Limitations (stated honestly)

- A hash change proves *content* changed — not that the change is meaningful,
  correct, or complete. That is verification's job, not state verification's.
- For untracked files without a snapshot there is no before-state; OpenPitStop
  says `UNPROVEN` rather than pretending.
- Files >8 MB are not hashed (size/status only) — recorded in the evidence.
- Renames are observed as delete+create by git porcelain; claim both halves
  explicitly if you need both proven.

## Files

- `src/verify/state.ts` — library (snapshots, claim evaluation, sealing)
- `src/commands/stateVerify.ts` — `pitstop state-verify` CLI
- `src/commands/gate.ts` — folds the latest state verdict into the gate
- `test/stateVerify.test.ts` — 23 real filesystem/git integration tests
