# OpenPitStop: engineering assessment and product direction

Reviewed **2026-11-26** against the 1.11.0 release, with the 1.10.0 review of 2026-09-25 kept below.
This is a code review and primary-source capability comparison, not a head-to-head
detection benchmark. No production application was attacked during the review.

## The product worth building

OpenPitStop already has more substance than an agent-completion checker. Its opportunity is
to make an engineering workflow portable across coding agents: repository context, a scoped
plan, independent execution, architecture policy, security evidence, regression checks and
an explainable release decision.

The strongest promise is **“make every change reviewable and every verdict explainable.”**
“Eliminate every software-engineering problem” and “hack an app in every possible way” are
not testable promises. Detection coverage, execution boundaries and evidence freshness are
where the project should earn trust. More command names or stronger adjectives will not
substitute for those guarantees.

## What 1.11.0 changes

The release closes four gaps this review named: first-run clarity, language and change-impact
visibility, a measured detector, and a portable agent interface. It does not close the
remaining authority, execution and coverage gaps.

| Area | Shipped | Evidence and limits |
|---|---|---|
| First run | Bare `pitstop` detects the project and installed agents, previews every file it would write and asks before writing; `check quick\|deep\|ship` answers "which command do I run?" | Non-interactive runs print status and exit without writing; existing user files are left alone; `install --rollback` restores generated files. |
| Language support | `pitstop languages` publishes four support levels and the exact parser per language; `map` and `impact` consume the same matrix | Structural JS/TS parsing, Python via the standard `ast` module, and 12 tree-sitter grammars when installed. Dependency graphs remain JS/TS/Python-only. |
| Change impact | `impact` walks the reverse import graph from a diff; `plan` seals the impact it was written against | Import-graph evidence only. Dynamic dispatch, reflection and undeclared path aliases stay invisible. |
| MCP | `pitstop mcp` exposes six tools over stdio JSON-RPC: understand, map, scan, release gate, reproduce and bench | The agent cannot author a verdict: `pitstop_release_gate` computes it locally and defaults to strict, where only `VERIFIED` passes. The server has no network listener. |
| Benchmark | `pitstop bench` scores 22 committed fixtures: 8/8 expected findings detected across 8 vulnerable/fixed pairs, 100% precision and recall, with two documented misses, one documented false positive and one skipped stack | Curated canonical examples, not a field sample. The 100% is not a general accuracy claim. |
| Security depth | Infrastructure, dependency-hygiene and business-logic passes in `scan`; static risk/reachability triage; scoped, expiring `suppress` | Pattern-based and `indicated`. CodeQL, Trivy and Checkov execution is still not wired. |

## How the implementation works

| Area | Source | Role and limits |
|---|---|---|
| Entry and routing | `src/cli.ts`, `src/intent.ts`, `src/commands/ask.ts` | Commander command dispatch; deterministic phrase matching and structured argv execution |
| Repository context | `src/understand/index.ts` | Languages, tools, scripts, entry points, modules, CI, ownership and architecture configuration; structural discovery rather than semantic comprehension |
| Plan and policy | `src/verify/plan.ts`, `src/verify/architecture.ts` | Sealed expected paths, import rules, protected paths and diff checks; policy enforcement at verification time |
| Measurement | `src/analyzers/`, `src/report/score.ts` | Built-in heuristics plus installed external tools; weighted score over available categories |
| Security | `src/pen/`, `src/analyzers/ledger/`, `src/sandbox/`, `templates/pen/` | Pattern detection, local dynamic probes, payment scenarios and repro/patch generation |
| Verification | `src/verify/` | Baseline, actual state, contracts, holdouts, regression and verifier-health checks |
| Decision | `src/verify/gateMatrix.ts`, `src/verify/flow.ts` | Ordered evidence decisions; configured stages must not disappear behind a green aggregate |
| Agent interface | `templates/`, `src/commands/drive.ts`, `src/mcp/` | Instructions, optional invocation of an external coding agent and a stdio MCP server. The agent's own credentials, permissions and costs apply; MCP tool results are computed by the CLI, not the agent |
| Language adapters | `src/languages/` | Capability matrix, parser discovery and structural parsing; JS/TS, Python and optional tree-sitter grammars, with explicit file caps and skipped files |
| Benchmark | `src/bench/`, `bench/` | Fixture loader, scenario scoring and published ratios with denominators; curated fixtures, not field measurements |
| History and communication | `src/evidence.ts`, `src/memory/`, report/next/digest/trends commands | Content-digested artifacts, decisions, progress and next actions |

## Defects addressed before 1.11.0

| Finding | Previous behavior | Change and regression evidence |
|---|---|---|
| Natural language stopped at advice | `ask` printed a command; several advertised phrases were missing | Recognized checks now execute internally; mutation/live attack/agent actions need explicit execution. Preview and JSON modes do not execute. `test/intent.test.ts` covers dispatch, refusals and propagated failure exits. |
| Cache could reuse changed input | Modification timestamps missed deletion, hidden directories and backdated edits; options and seals were not checked | Content snapshots, seal validation, options/engine identity, one-hour expiry and pre/post measurement comparison. `test/scanCache.test.ts` covers these false-reuse cases. |
| Autopilot did not invoke fix generation | `fix` called the scan-only `runPen`, searched old patch files, used the legacy gate and omitted its final exit status | Explicit generation, current-run patch list, protected-path/plan checks, isolated branch, security recheck and stack/architecture/security gate. `test/penWorkflow.test.ts` exercises patch application and failure propagation. |
| Security findings vanished on non-app repos | No start script/routes caused an empty result even for static findings | Static mode works on libraries; aborted dynamic runs retain findings. |
| JSON changed command semantics | `pen --json` returned before exit-code assignment and fix generation | Structured output now preserves failure exits and requested artifacts. |
| Gate did not recognize actual proof fields | Security mapping looked at `proofStatus`/`verdict`, while findings use `confidence`/`runtimeProof` | Real proven high/critical findings block; aborted/skipped live checks remain unproven. |
| Unproven could look successful in automation | Legacy scan-only gate intentionally returned exit 0 | `gate --strict` only allows VERIFIED; natural-language release requests select it. Compatibility remains explicit. |
| Current pipeline failure could be hidden | A failed stage could coexist with older passing evidence | Current stage failures override a passing aggregate; baseline refs also reach acceptance/holdout in flow. |
| Wrong process could satisfy HTTP verification | Readiness could be answered by a server already on the port | Refuse an already-responsive readiness URL; skip HTTP criteria if boot was not established. HTTP body reading stays within the request timeout. |
| Generated short-file patches had phantom context | Splitting a newline-terminated file added a nonexistent final line to the hunk | Remove the terminator entry before generating the diff; verify a real generated patch with git apply. |
| Cost display overstated evidence | Latest aliases inflated run counts; cache files were presented as saved requests | Count history once and label stored cache entries honestly; no fabricated model bill. |

The complete 1.11.0 suite passed **301 tests** on Windows and in Linux CI after these code
changes, with normal process permissions. The initial restricted 1.10.0 run could not clean
up a test-owned HTTP server; that exposed the wrong-process verification hazard above.
Validation is limited to the included fixtures, not a claim of broad production or
cross-platform certification.

## Comparison with existing projects

### Strix: specialize differently, compare fairly

Strix documents agent-driven reconnaissance, browser and HTTP tooling, exploit validation,
security fixes and CI workflows. Its managed offering also documents continuous testing.
Calling it a one-off finder without proof is inaccurate. The local CLI uses a model and
security-testing infrastructure; its capabilities should not be equated with PitStop's
finite deterministic probe library. [Strix repository](https://github.com/usestrix/strix).

PitStop's defensible emphasis is verification around the entire change: architecture,
test integrity, acceptance, regression and explainable evidence. Treat Strix as a potential
specialized engine whose results can be verified, not a straw competitor. No accuracy,
coverage or cost superiority has been measured here.

### Semgrep and CodeQL: analysis engines

Semgrep provides local rule-based scanning and broader security products. PitStop already
has an opt-in Semgrep path. CodeQL creates a database representation and queries it for
security problems. Neither engine should be replaced by a growing list of regular
expressions just to claim more vulnerability classes.
[Semgrep quickstart](https://docs.semgrep.dev/getting-started/quickstart),
[CodeQL documentation](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning).

Recommended direction: normalize external findings with tool version, rule identity,
source location, confidence and reproduction information. Keep tool failures separate
from empty findings. Only Semgrep integration is present today; CodeQL ingestion/execution
is a future milestone.

### ZAP: reusable web-testing infrastructure

ZAP's automation framework defines targets, authentication, active/passive scanning,
API specification imports, job tests and exit policies. That is useful infrastructure
for authenticated web coverage beyond PitStop's built-in probes.
[ZAP automation framework](https://www.zaproxy.org/docs/automate/automation-framework/).

A future adapter should record target scope, authentication coverage and request budgets,
and fail visibly on incomplete runs. It should not imply that a clean unauthenticated
scan examined every authorized user flow.

### Aider: context and cost discipline

Aider documents a ranked repository map that selects relevant symbols within a context
budget, along with provider-dependent prompt caching. This illustrates how context
selection and reuse can matter more than another agent loop.
[Repository maps](https://aider.chat/docs/repomap.html),
[Prompt caching](https://aider.chat/docs/usage/caching.html).

PitStop should send a compact, task-specific packet to the host agent: affected files,
owners, relevant decisions, the plan and exact failed checks. Its deterministic checks
should continue to avoid model calls. A future provider adapter may report actual usage,
but time and character estimates must never masquerade as provider token billing.

## Release controls and remaining work

The 1.11.0 release keeps the 1.10.0 controls (candidate-bound gate evidence, Docker
isolation for live pen/ledger/repro runs, one shared external-agent budget) and adds a
portable interface with the same rule: MCP tool output is CLI evidence, and the gate verdict
is never supplied by the calling agent. [Implementation, setup and limits](release-controls.md).

Finding-specific proof still needs broader coverage: a static observation disappearing
is weaker than a discriminative failing-first repro. Drive now refuses a failing repro
even if a static rescan is clean, requires verification before marking a finding solved,
and stops repeated identical failures.

Authority must still be protected outside the editing agent’s workspace. SHA-256 is
not authentication, approval flags do not prove human identity, and hidden suites need
filesystem permissions. Trusted CI controls and signed attestations remain future work.

## How to earn adoption

Make the first experience small: one sentence, a clear scope, evidence of what ran, and
one useful next action. Keep the full command catalog for experts rather than making it
the onboarding task. The revised README follows that structure.

Keep the published evaluation set honest: vulnerable/fixed pairs, benign near-misses,
documented misses and false positives, unsupported stacks and broken environments. `bench`
scores it on demand and states each denominator. A field sample, execution time and actual
model usage remain unmeasured; do not present the curated 8/8 as field accuracy.

Ship a short demonstration that shows a failure, a minimal fix and the same verification
passing. Keep the transcript and fixture alongside the clip. Launch with an honest support
matrix, contributor-sized issues and a versioned release whose npm behavior matches the
README. GitHub attention is an outcome to earn; it cannot be guaranteed by copywriting.

## Suggested milestones and acceptance bars

| Milestone | Status | Acceptance bar |
|---|---|---|
| Candidate-bound evidence | Delivered (1.10.0) | No previously passing layer can authorize a changed candidate without rerunning or an explicitly valid reuse policy |
| Isolated security runner | Delivered (1.10.0) | Bypass fixtures cannot reach external network or host secrets; incomplete containment produces no clean verdict |
| Finding-specific proof | Partial | Repro fails for the intended bug, stays identical, passes after the fix and fails again after a deliberate revert; coverage is still limited to findings with a generator |
| Bounded agent work | Partial | Hard total-call/time/context caps; unchanged failure stops the loop; actual provider usage is labeled separately |
| Public benchmark | Delivered (1.11.0) | Reproducible vulnerable/fixed/benign fixtures, published limitations and per-stack results: 22 fixtures, 8/8 detected, 100% precision/recall, documented misses and one skipped stack |
| Stable release | Delivered (1.11.0) | Full tests, typecheck, build, packaged CLI smoke tests and verified installation instructions on supported systems |
| Independent authority | Open | Signed attestations or a verifier outside the editing agent's write access; SHA-256 digests are tamper-evident, not authenticated |
| Editor and execution coverage | Open | VS Code diagnostics, CodeQL/Trivy/Checkov execution and a diff-scoped review tool are not shipped |
