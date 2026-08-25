# Holdout Verification — passing the tests you can see is not passing

`pitstop holdout-verify` — the final, hidden, independent verification.

## The problem: verifier overfitting

An agent that iterates against visible checks slowly learns the **evaluator**,
not the task. It sees the failed checks, the test names, the error messages,
the acceptance criteria, the repeated feedback — and then optimizes for exactly
those. The visible suite goes green while the underlying requirement stays
violated: the boundary case flips, the error path is hardcoded around, the
assertion the agent was shown is satisfied and nothing else.

OpenPitStop therefore separates:

```
ITERATIVE (visible)                 FINAL HOLDOUT (hidden)
────────────────────                ──────────────────────
tests the agent sees + feedback     checks the agent never sees
runs every iteration                runs once, at the final stage
drives development                  delivers the verdict
```

## The security model — stated honestly

- **A hidden file inside the repository is NOT a holdout.** If the agent can
  read it, it is visible. Holdout suites live OUTSIDE the candidate's
  modifiable workspace: an explicit directory, or an id under
  `PITSTOP_HOLDOUT_HOME` (default `~/.openpitstop/holdouts/<id>`).
- **Fresh isolated checkout.** The holdout always executes in a temporary
  detached worktree of the candidate *commit* — never the agent's working
  tree. Injected holdout files land in that worktree and are discarded; they
  never enter the user's tree.
- **The holdout cannot be modified during the final run.** Every suite file is
  hashed before and after execution; any change is
  `HOLDOUT_INTEGRITY_FAILURE` and nothing is verified.
- **Agent-facing output is redacted.** The CLI and the sealed summary in
  `.pitstop/` carry only check ids, severities and verdicts — never commands,
  expected values, or stdout/stderr. Full unredacted evidence is sealed
  OUTSIDE the repo (next to the suite), where an iterating agent gets no
  feedback from it. The summary references the full evidence's digest, and
  both are sealed with the standard `pitstop-canonical-sha256-v1` chain.

## Suite definition (general — no framework, no project)

A suite is a directory with a `holdout.json` manifest plus any files the
checks need:

```json
{
  "id": "grade-boundary",
  "version": 1,
  "description": "hidden boundary checks",
  "checks": [
    {
      "id": "boundary-50-49",
      "severity": "high",
      "command": "node --test holdout/calc.holdout.test.mjs",
      "inject": [{ "src": "calc.holdout.test.mjs", "dest": "holdout/calc.holdout.test.mjs" }],
      "expected": { "exitCode": 0 }
    }
  ],
  "timeoutMs": 60000
}
```

- `command` runs with `cwd` = the fresh candidate worktree; env `PITSTOP_HOLDOUT_DIR`
  points at the suite for checks that reference their own fixtures in place.
- `inject` copies holdout files into the worktree (repo-relative `dest`,
  path-escape rejected) so native test runners can pick them up.
- `expected` defines candidate success (default exit 0; optional
  `stdoutContains` / `stderrContains`).
- The suite hash (over the manifest + every file) is recorded in all evidence.

## Baseline integration — a holdout that can only pass is worthless

```sh
pitstop holdout-verify . --suite <dir-or-id> \
  --baseline <known-bad-ref> --candidate <ref>
```

The same suite runs on the baseline (must FAIL ≥1 check — proof the suite can
discriminate) and the candidate (must PASS all). Outcomes:

| Situation | Verdict |
|---|---|
| candidate all PASS, baseline FAILed the suite | `HOLDOUT_PASS` |
| candidate fails ≥1 check | `HOLDOUT_FAIL` |
| baseline ALSO passes the suite (cannot discriminate) | `HOLDOUT_UNPROVEN` |
| suite modified / unavailable / invalid manifest / bad refs | `HOLDOUT_INTEGRITY_FAILURE` |

Without `--baseline` a `HOLDOUT_PASS` is reported, but explicitly marked
"not baseline-backed" — supply a baseline for strong evidence. This is also
the falsifiability integration: a suite that cannot fail on a known-bad state
is exactly what `HOLDOUT_UNPROVEN` exposes (and `pitstop verifier-check` can
additionally self-test the holdout command against a seeded mutation).

## Verdicts → gate

`pitstop gate` folds in the newest sealed holdout summary:

- `HOLDOUT_FAIL` → **hard block**: "the candidate passed the visible checks but
  FAILED the independent holdout; NOT VERIFIED"
- `HOLDOUT_INTEGRITY_FAILURE` or tampered evidence → hard block
- `HOLDOUT_UNPROVEN` → surfaced as a reason, human judgment
- no holdout report → gate unchanged (backward compatible)

The final story a reviewer sees:

```
Visible checks:  PASS
Holdout:         FAIL
Final:           NOT VERIFIED
```

## Performance — final stage only

Holdout verification never runs automatically during iteration. It is an
explicit command (or a CI/final step), executed once per candidate. Cost is
controlled per suite: `timeoutMs` in the manifest, `--timeout` override, and
the suite author decides how many checks exist. Worktrees are created and
removed per run; nothing scans the repository.

## What this proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| The candidate satisfies checks it could not see, read, or modify | Correctness in general — a holdout is a sample of the requirement space |
| The verdict was not produced by an evaluator the agent learned | That the holdout suite itself is well-designed — that is what baseline mode and `verifier-check` are for |
| The suite was not tampered with during verification | That every hidden requirement worth having is IN the suite |

## Tests

`test/holdoutVerify.test.ts` — 16 integration tests on real temp git repos +
real out-of-repo suites: visible+holdout pass, visible-pass/holdout-fail
(with a genuine overfit solution), holdout tamper mid-run, unavailable suite,
invalid manifest, evidence tampering, baseline discriminative, baseline
non-discriminative, fresh-checkout integrity (dirty tree untouched, injected
files never leak), determinism, redaction guarantees, full-evidence audit,
suite hashing, and gate integration.

## Limitations

- Holdout checks that need installed dependencies must provide them (the
  worktree is a bare checkout).
- A suite author can accidentally write a weak suite; baseline mode turns
  "weak" from invisible into `HOLDOUT_UNPROVEN`, but cannot fix the suite.
- The redaction covers OpenPitStop's own output and artifacts; if the agent
  has arbitrary filesystem access to the suite directory outside the session,
  no in-repo mechanism can prevent reading it — keep suites outside the
  agent's sandbox.
