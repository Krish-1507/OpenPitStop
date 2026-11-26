# First run, agent setup and trust controls

This guide covers the behavior behind bare `pitstop`, the three guided checks, scoped
finding dismissals and the installer's safety guarantees. Named commands are unchanged:
`try`, `scan`, `gate`, `install`, `flow` and `--help` keep their existing contracts.

## What `pitstop` does

`pitstop` without a command is the guided entry point. It:

1. Detects the project from real files (`package.json`, `tsconfig.json`, lockfiles,
   `requirements.txt`, `go.mod`, `Cargo.toml`, Maven/Gradle files, Dockerfiles, and so on).
2. Detects coding agents from installed executables and existing configuration
   directories. A tool is listed as detected only when there is a real path or executable;
   it is listed as configured only when an OpenPitStop command file exists.
3. Offers a scoped agent integration, showing every file that would be created, updated,
   kept, or skipped before asking for permission.
4. Offers Quick Check, Deep Audit, Ship Check or Skip.
5. Remembers that setup completed in `.pitstop/onboarding.json`, so the next bare
   `pitstop` shows a short returning-user menu instead of repeating the full flow.

`pitstop --setup` repeats the full flow. `pitstop --skip-onboarding` exits immediately.
`pitstop --no-input` never prompts. Non-TTY stdin/stdout always takes the non-interactive
path: it prints a short environment summary and exits without writing files or waiting.

## Agent setup is explicit and reversible

Detection checks both project-level and user-level configuration. It does not claim an
integration works merely because an agent binary exists.

For each target, the installer compares the existing file with the generated content:

| Existing state | Default action |
|---|---|
| File absent | create |
| Identical file | leave unchanged |
| OpenPitStop-managed file, different content | update with a backup |
| User-authored file | leave untouched and report the reason |

The onboarding flow previews the exact paths and asks `Apply these changes? [y/N]`.
`pitstop install` keeps its historical all-targets behavior; add `--agents <ids>` to
configure a subset and `--dry-run` to preview.

Generated files carry a marker (`<!-- openpitstop:managed -->`, or a TOML comment for
Gemini CLI). Updates are backed up under `.pitstop/install-backups/<transaction>/`, and the
exact files created or changed are recorded in `.pitstop/install-manifest.json`.

```bash
pitstop install --rollback
```

Rollback removes files this transaction created and restores replaced files from backup.
A file edited after installation is kept and reported as a conflict unless `--force` is
used. `pitstop install --uninstall` removes managed files only; `--force` removes every
target path.

Supported agent ids: `claude-code`, `cursor`, `opencode`, `antigravity`, `kilo-code`,
`gemini-cli`, `codex`. Codex supports user-level prompts only. Codex App and the Codex VS
Code extension do not currently support custom slash commands; OpenPitStop says so rather
than writing an integration that cannot work.

## Checks at three depths

| Check | What runs | What remains skipped |
|---|---|---|
| `pitstop check quick .` | Project understanding, dependency graph, static security, duplication, accessibility, DevEx | Tests, build/performance, flaky detection and reliability |
| `pitstop check deep .` | Full scan including tests, build, reliability and flaky detection | Tools/layers the repository does not configure |
| `pitstop check ship .` | Full scan + typecheck, lint, build, verification stack, strict release gate | Anything not configured or unavailable, reported explicitly |

The report always includes:

- project understanding: languages, frameworks, package manager, Git, entry points and
  architecture configuration;
- findings grouped by security, dependencies, code quality, reliability, accessibility and
  architecture;
- an explanation of the highest-priority finding: what it is, where it is, why it matters,
  confidence, evidence source, reproduction, verification and a suggested fix;
- verification results, including layers that were not run;
- skipped checks with reasons;
- next steps and a recommended action;
- a sealed artifact at `.pitstop/check-latest.json`.

Quick and deep return `0` when the check completed. Ship returns the strict gate exit code:
`0` verified, `1` failed or insufficient evidence, `2` tampering/cheat. `--json` emits the
same model without the terminal rendering.

## Dismissals are scoped and reconsidered

```bash
pitstop suppress <finding-id> --kind false-positive --reason "why"
pitstop suppress <finding-id> --kind accepted-risk --reason "why" --expires 2026-12-31
pitstop suppress --rule xss --path 'src/legacy/**' --reason "why"
pitstop suppress --list
pitstop suppress --remove <suppression-id>
```

Rules:

- `--reason` is required. Every dismissal is explainable.
- A finding-specific dismissal is tied to the finding's current code fingerprint. If the
  finding's cited line changes (or the whole file, for file-level findings), the dismissal
  no longer matches and the finding is reconsidered on the next scan/check.
- `--expires` makes a temporary acceptance expire without manual cleanup.
- `--rule` dismisses a class; `--path` narrows it to matching repository paths.
- Dismissed findings remain in scan history and reports, are excluded from active counts
  and the score, and are exported to SARIF as suppressed results with the justification.
- An invalid suppression file fails loudly; OpenPitStop does not silently ignore it.

Suppression state lives in `.pitstop/suppressions.json`. It changes scan-reuse inputs, so a
dismissal never reuses a scan computed under the old policy.

## Finding contract

Persisted findings carry a versioned contract:

- stable `id` (used by `pitstop inspect` and `pitstop repro`);
- `title`, `description`, `severity`, `confidence`, `category`;
- file/line when available;
- `sourceTool` and structured evidence entries;
- `reachability` (`reachable`, `unreachable`, `unknown`);
- impact, reproduction, suggested fix and post-fix verification;
- verification status (`verified`, `failed`, `blocked`, `unproven`, `cheat`);
- references and a content-bound fingerprint.

The fingerprint changes when the finding's rule, location or underlying code line changes.
This is what prevents an old dismissal from surviving a rewrite.

`pitstop report --sarif` exports SARIF 2.1.0 with rule-level CWE/OWASP metadata, stable
partial fingerprints, confidence/source/reachability properties and scoped suppressions.

## Limitations

- Detection is based on local paths and executables. It cannot prove an agent will load a
  command file; host versions and configuration still matter.
- Quick Check is intentionally shallow. A clean quick result is not a security verdict.
- Missing tools, unavailable evidence and skipped layers always remain visible. They are
  never converted into a pass.
- Findings are static indications unless a supported reproduction or live test proves them.
- Language support is explicit: detected, parsed, analyzed and verified are separate claims.
  Structural parsing is available for JS/TS and Python; other languages use Tree-sitter when
  installed or a labeled heuristic. See [language support](languages.md).
- Onboarding state is UI preference, not evidence; it never affects a gate or report.
