# Acceptance Verification — did the agent satisfy the requirement?

`pitstop acceptance-verify` — verify **"did the agent actually satisfy the
original task requirements?"**, not "did some tests pass?".

## The problem

An agent can produce a green test suite, a plausible diff and a clean review
while failing the original requirement: it fixes the unit it was shown and
leaves the real user flow broken. OpenPitStop therefore represents the intended
outcome in a structured **acceptance contract** — the source of truth for
success — defined independently of the agent's natural-language self-report.

## The contract

```json
{
  "id": "greet-user-flow",
  "version": 1,
  "requirements": [
    {
      "id": "req-001",
      "description": "users are greeted through the real endpoint",
      "criteria": [
        { "id": "greet-http", "type": "http", "url": "http://127.0.0.1:47193/greet?name=ada",
          "expectStatus": 200, "expectBodyContains": "hello ada" },
        { "id": "greet-unit", "type": "command", "command": "node --test test/feature.test.js" }
      ]
    }
  ],
  "start": { "command": "node server.js", "readyUrl": "http://127.0.0.1:47193/health", "timeoutMs": 15000 },
  "timeoutMs": 30000
}
```

Deterministic criterion types (never an LLM judge):

| Type | Verifies | Evidence recorded |
|---|---|---|
| `command` | exit code (+ optional stdout/stderr substrings), run in a fresh worktree with a sanitized environment | exit code, output excerpt |
| `http` | a real request: status (+ body substring); boots the app via `start` and waits for `readyUrl` | status, body excerpt, duration |
| `fileExists` | presence in the candidate tree | sha256, size |
| `fileContains` | content assertion in the candidate tree | sha256, observed match |

## Source of truth — the agent cannot redefine success

- The contract is executed from a **fresh detached worktree of the candidate
  commit** — uncommitted agent edits do not participate.
- **In-repo contracts are hash-pinned** (`.pitstop/acceptance-pin.json`,
  sealed) on first authorization. Any later change is
  `INTEGRITY_FAILURE` — "the contract CHANGED after authorization — the agent
  may have redefined success" — until a human re-runs with `--authorize`,
  which pins the new version explicitly.
- Contracts living **outside the repository** (a path or
  `PITSTOP_ACCEPTANCE_HOME/<id>`, default `~/.openpitstop/acceptance/<id>`)
  are outside the agent's reach entirely; they are hashed into the evidence.

## Baseline integration — a contract that always passes proves nothing

With `--baseline <ref>`, every criterion also runs on the baseline. Criteria
that already pass there are reported but do not count as evidence of the
agent's work. If **every** criterion passes on the baseline, the verdict is
`UNPROVEN` — "the contract does not discriminate this change". A `SATISFIED`
with baseline reports how many criteria discriminate.

## Verdicts

| Verdict | Meaning |
|---|---|
| `SATISFIED` | all criteria pass (and, with a baseline, ≥1 discriminates) |
| `NOT_SATISFIED` | ≥1 criterion observably failed — the requirement is not met |
| `UNPROVEN` | criteria could not be verified (endpoint unreachable, timeout) or the contract does not discriminate |
| `INTEGRITY_FAILURE` | invalid contract, or the contract changed after authorization without `--authorize` |

Exit codes: `0` SATISFIED · `1` NOT_SATISFIED · `2` UNPROVEN · `3` INTEGRITY_FAILURE.

Gate integration: `NOT_SATISFIED`, `INTEGRITY_FAILURE` and tampered acceptance
evidence hard-block `pitstop gate`; `UNPROVEN` is surfaced as a reason; no
report leaves the gate unchanged.

## Evidence

Each run seals `.pitstop/acceptance-<timestamp>.json`: contract id/path/hash,
candidate and baseline SHAs, per-criterion **expected vs observed** (exit
codes, HTTP status, body excerpts, file hashes), requirement rollup, verdict,
reasons and environment — all covered by the standard
`pitstop-canonical-sha256-v1` digest. The verdict is explainable: every ✓/✗
maps to recorded evidence.

## What this proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| The candidate satisfies the contract's observable criteria, as written | That the contract captures the full requirement — a weak contract is weak verification (baseline mode exposes, but cannot fix, that) |
| Success was not redefined mid-flight (contract pinning + sealed evidence) | Unobservable qualities: UX, performance under load, security beyond the asserted properties |
| The evidence is real and tamper-evident | That the requirement itself was correctly specified |

**Deliberately not an LLM judge.** The core mechanism is deterministic and
independently verifiable — commands, HTTP requests, file contents. An LLM
evaluator could only ever be an optional future layer on top; it must never be
the source of a verdict here.

## Usage

```sh
pitstop acceptance-verify . --contract ./acceptance.json --baseline <ref>
pitstop acceptance-verify . --contract checkout-flow --authorize   # after a deliberate contract change
pitstop acceptance-verify . --contract ./acceptance.json --json
```

## Tests

`test/acceptanceVerify.test.ts` — 12 integration tests on real temp git repos
with a real HTTP service: all-pass (baseline discriminates), one-fails (the
green-unit/broken-endpoint failure mode), unreachable endpoint → UNPROVEN,
boot+readiness probe, contract tamper → INTEGRITY_FAILURE → `--authorize`,
invalid contracts (including a rejected "vibes" criterion — no LLM judging),
non-discriminating baseline, evidence tampering, determinism, dirty-tree
isolation, expected-vs-observed evidence, and gate integration.
