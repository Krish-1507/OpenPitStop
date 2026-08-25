# Repo Discipline — Understand → Contract → Plan → Change → Inspect → Verify → Attack → Holdout → Architecture/Regressions → Gate

OpenPitStop's pipeline for AI-agent changes. The deep-verification layers
(baseline, state, acceptance, holdout, regression, verifier health) are
covered in their own docs; this document covers the stages that make the
referee *repo-aware*: understanding the repo, planning before patching,
enforcing architecture/boundaries, verifying the whole stack, and the `flow`
orchestrator.

## 1. `pitstop understand` — repo awareness

Builds the sealed **understanding artifact** (`.pitstop/understanding.json`)
that every downstream stage reads instead of re-guessing:

- languages (primary + secondary), frameworks, package manager
- verification commands: test / typecheck / lint / build / integration / e2e
  (from npm scripts, tsconfig.json, eslint presence, test-layer discovery)
- test layers (unit/integration/e2e discovery), CI provider + workflows
- module map (top-level dirs with inferred roles), entry points
- CODEOWNERS ownership rules (last-matching-pattern-wins, GitHub semantics)
- the **architecture config** when present (`openpitstop.architecture.json`
  or `.pitstop/architecture.json`) — invalid configs fail loudly, never
  silently no-op

## 2. `pitstop plan` — plan before patching

A change is planned BEFORE it is made. The plan is a sealed contract:

```sh
pitstop plan . --goal "add greeting endpoint" \
  --step "add module" --step "wire route" \
  --path "src/greet/**" \
  --verify-command "node --test"
```

- `expectedPaths` declares what the change may touch — everything else is
  scope creep.
- `verification.commands` declares how the change will be proven.
- `pitstop plan --show` renders the latest plan and live scope status.

The plan does not make a change safe — it makes the change **accountable**.

## 3. `pitstop architecture-check` — does the change fit the system?

Checks the diff (working tree or ref range) against the declared rules and
the repo's real structure:

| Check | Verdict impact |
|---|---|
| **boundaries** — declared import rules (`src/core/**` must not import `src/ui/**`), resolved through the actual import graph of changed files | VIOLATIONS (blocking) |
| **forbidden paths** — secrets, generated code (`**/.env*`) | VIOLATIONS (blocking) |
| **protected paths** — auth, deployment, CI: require explicit human approval | APPROVAL_REQUIRED (exit 2) until `--approved` |
| **shortcuts** — the AI-cheat detectors (suppressions, hardcoded passes, mock overreach, forced exits) run on the diff | confirmed → VIOLATIONS; suspicious → approval |
| **ownership** — CODEOWNERS routing for touched paths | informational |
| **plan scope** (`--against-plan`) — files changed vs files the plan declared | out-of-plan → VIOLATIONS (blocking) |

Verdicts: `CONFORMS` · `APPROVAL_REQUIRED` · `VIOLATIONS` · `INTEGRITY_FAILURE`.

A change can pass every test and still be wrong for the system — this is the
check for that.

## 4. `pitstop verify-stack` — beyond "did the test pass?"

Runs every verification layer the repo actually has: unit / integration / e2e
(discovered), **type checks** (npm script or `tsc --noEmit`), **lints**
(npm script or eslint), **builds** — each sealed with pass/fail, durations,
counts and failing names.

The critical piece is the **failure diagnosis**: when a layer fails,
OpenPitStop classifies WHY deterministically and hands back a targeted
diagnosis instead of "it failed":

| Diagnosis | Trigger | Meaning |
|---|---|---|
| `type-error` | `error TSxxxx` | a signature changed somewhere — check the named locations |
| `missing-dependency` | `Cannot find module` | environment/dependency, not behavior |
| `assertion-failure` | AssertionError / failing test names | behavior changed — read the failing checks |
| `syntax-error` | SyntaxError / build failed | the file does not parse |
| `lint-violation` | rule ids | which rules, where |
| `environment` | ECONNREFUSED / EADDRINUSE / EACCES | port/permission — maybe not the code |
| `timeout` | exceeded budget | possible hang or interactive prompt |
| `unclassified` | anything else | honest: read the captured output |

OpenPitStop never auto-edits in response to a failure — it diagnoses and hands
the evidence back. Layers that don't apply are `SKIPPED` with the reason.

## 5. `pitstop flow` — the pipeline in one command

```sh
pitstop flow . \
  --baseline <ref> --command "node --test" \
  --contract ./acceptance.json \
  --suite <holdout-dir> \
  --plan-scope --require baseline,acceptance
```

Runs: **understand** → **contract** (when configured) → **plan-scope +
architecture** → **verify-stack** → **baseline** + **regression** (when
configured) → **holdout** (when configured) → **GATE** (the single verdict,
over every sealed layer). Stages with no configured input are SKIPPED and
their gate layers render NOT_CONFIGURED — never invented. `attack-the-verifier`
(`verifier-check`) is deliberately NOT automatic: it is an explicit operator
action by design.

## What this proves — and what it does NOT

| PROVES | DOES NOT PROVE |
|---|---|
| The change respects the repo's DECLARED boundaries, protected paths and plan scope | That the architecture config itself is complete or well-designed |
| Every configured verification layer passes, with diagnosed failures | That unconfigured layers (skipped/absent) are satisfied |
| The change landed inside its declared scope | That the plan covered everything worth planning |

## Files

- `src/understand/index.ts` — repo understanding + architecture config + CODEOWNERS
- `src/verify/plan.ts` — plan artifact + scope comparison
- `src/verify/architecture.ts` — boundary/protected/forbidden/shortcut/scope checks
- `src/verify/stack.ts` — verification stack + failure diagnosis
- `src/verify/flow.ts` — pipeline orchestrator
- `test/repoDiscipline.test.ts` — 17 integration tests
