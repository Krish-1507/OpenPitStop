# OpenPitStop privacy and execution boundaries

OpenPitStop is a local CLI with no telemetry service, hosted account requirement or
automatic update checker. Its built-in intent routing and static pattern analysis do
not call a language model. External tools, repository scripts and an explicitly launched
coding agent have their own behavior and privacy policies.

## Network activity

| Operation | Possible connection and data |
|---|---|
| npm installation / npx | Package downloads from the configured registry |
| Dependency audits | npm audit, pip-audit or osv-scanner may send dependency information to their configured services |
| Opt-in Semgrep | Registry configurations may download rules; behavior also depends on the installed tool's configuration |
| Tests, builds, verification commands and app startup | Execute repository/operator-defined code, which can access the network with the current process permissions |
| HTTP acceptance criteria | Send the requests declared in the acceptance contract |
| Live pen / ledger | Run inside a Linux Docker container with networking disabled; the preload/proxy records supported traffic internally |
| External coding agent (`drive` or your host CLI) | May send prompts and repository context to its configured provider and consume provider credits |

The built-in static pass does not upload source. This is not a blanket guarantee about
the external tools or scripts invoked by a full workflow. To require offline execution,
enforce it with a firewall or isolated environment; disconnected audits may report skipped
results, and network-dependent verification may fail.

## Live testing

Live pen, ledger and their replay tests require Docker. The app and attack runner share
a disposable container with networking disabled, a read-only root, a non-root user,
no Linux capabilities, and resource limits. Only a sanitized staging copy is mounted
read-only. The real repository, host home, Docker socket and environment credentials
are not mounted or forwarded. Common credential filenames and `.env*` are omitted;
secrets embedded in ordinary source files are still part of that source.

The preload/proxy provides observation inside the OS boundary. Containers share the
host kernel and are not a guarantee against kernel/runtime vulnerabilities. Use
a maintained Docker installation and a trusted runtime image. Ordinary tests, builds
and acceptance commands outside live security retain their documented host permissions.

## Stored data

- `.pitstop/`: scan and verification results, security evidence, activity history,
  dependency-audit caches, plans, memory and content snapshots for scan reuse.
- `PITSTOP_*` reports, HTML cards and badges requested by the workflow.
- Generated `pitstop-repro-*` tests and patch proposals. Automatic `fix` can apply
  supported source patches on a new branch; `--no-apply` still writes repros and reports.
- Installation writes command/skill files in the displayed project and user locations;
  optional hooks change the repository's git hooks.
- Deep verification creates temporary worktrees. Holdout and acceptance configuration
  can live outside the repository, and holdout full evidence is stored externally.

Scan snapshots contain file paths and hashes, not file bodies or raw environment values.
Other reports and evidence may contain snippets, request/response information or sensitive
findings. Review artifacts before publishing them or sending them to an agent.

Evidence digests detect content changes that do not update the digest. They are not
authenticated signatures and do not protect against a writer who recomputes the hash.
Use trusted CI and filesystem permissions for authoritative evidence and hidden holdouts.

## Costs and retention

Local checks do not use model credits. `budget` reports recorded activity and test/build
time; it does not know your provider's bill. External agent usage is charged according
to that agent's provider configuration. Drive enforces shared launch/time/prompt
limits and records reservations in `.pitstop/agent-budget-latest.json`. An optional
dollar ceiling delegates enforcement to a supported provider; unsupported providers
refuse it. Actual tokens and actual cost remain explicitly unknown.

Dependency audits use local caches; full scan reuse has its own bounded freshness policy.
Artifacts persist locally until removed. Keep baselines and repros needed by your
verification workflow; removing them removes that evidence, not the underlying risk.

## Inspect the implementation

Start with `src/analyzers/security.ts`, `src/sandbox/`, `templates/pen/preload.cjs`,
`src/commands/drive.ts`, `src/verify/acceptance.ts` and `src/scanCache.ts`.
See [release controls](docs/release-controls.md) for enforced boundaries and remaining
limits, and the [engineering assessment](docs/engineering-review.md) for the broader review.
