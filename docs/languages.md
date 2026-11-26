# Language support and the analysis boundary

OpenPitStop separates the core engine (findings, evidence, verification, reporting,
agent integration) from language-specific discovery and parsing. Adding a language
means adding an adapter, not changing the core.

## Support levels

A recognized file extension is not support. Levels are cumulative and reported
explicitly:

| Level | Meaning |
|---|---|
| Detected | A marker or real source file identifies the language. |
| Parsed | A parser produced structure: symbols, imports, and/or routes. |
| Analyzed | Meaningful checks run on that structure or source. |
| Verified | A supported issue and its fix were reproduced and independently verified. |

`Verified` is an evidence outcome. It is never inferred from an extension, a
successful parse, or a scanner exit code. A run that has not verified a language
reports `unproven`.

## Inspect this repository

```bash
pitstop languages .
pitstop languages . --json
```

The report shows, per language:

- detection evidence and file count;
- parser status and backend (`babel`, `python-ast`, `tree-sitter`, or `heuristic`);
- analysis status;
- test and build commands that the repository appears to provide;
- frameworks, dependency manifests and entry points;
- verification status;
- infrastructure files (Docker, Terraform, Kubernetes, Helm, GitHub Actions, SQL,
  YAML/JSON configuration);
- which optional tools are installed, enabled, missing, or not relevant.

`pitstop languages` is read-only. Full `pitstop scan` also records the language
analysis in `.pitstop/scan-latest.json` under `languageAnalysis`.

## Parsers

| Languages | Backend | Claim |
|---|---|---|
| JavaScript, TypeScript, JSX, TSX | `@babel/parser` | Structural parse: symbols, imports/requires, route calls. |
| Python | Python AST, run in an isolated interpreter process | Structural parse: functions/classes, imports, Flask/FastAPI/Django-style routes. No project code is imported. |
| Java, Go, C#, PHP, Ruby, C, C++, Rust, Kotlin, Swift, Dart | Tree-sitter **when the user installs a grammar**; otherwise a labeled heuristic | A heuristic result is a lead finder, never a structural parse. Missing grammars do not become passes. |

Tree-sitter and language grammars are intentionally **not** bundled dependencies.
They bring native builds and install-size cost; OpenPitStop detects local grammars
and falls back honestly when they are absent. To enable one, install it in the
repository or environment where PitStop runs, for example:

```bash
npm i -D tree-sitter tree-sitter-go
```

`pitstop languages` reports whether the matching grammar was found.

## Detection priority

1. **First priority:** JavaScript/TypeScript, Python.
2. **Second priority:** Java, Go, C#/.NET, PHP, Ruby.
3. **Third priority:** C, C++, Rust, Kotlin, Swift, Dart.

Source-only repositories are detected from recognized source files even without a
manifest. A lone `.h` file is deliberately ambiguous and does not claim C or C++.

## Security tools

Existing behavior is preserved:

- offline static security rules run for every recognized language;
- `npm audit`, `pip-audit` or OSV-Scanner cover dependencies where available;
- Gitleaks runs when installed;
- Semgrep deeper SAST is opt-in with `PITSTOP_SEMGREP_CONFIG`.

CodeQL, Trivy and Checkov are detected and shown in the tool plan, but this build
does **not** execute them. They are never reported as clean or as having run.

## Attack-surface map

```bash
pitstop map .
pitstop map . --json
```

`map` uses the same parsed sources to list:

- candidate HTTP routes with file and line;
- route candidates whose path/file suggests privileged or administrative access;
- entry points;
- authentication/authorization files found by path evidence;
- data-access files found by path evidence;
- infrastructure files;
- explicit limits.

Routes and path labels are leads. The map does not prove reachability, live
exposure, authentication coverage, or authorization behavior.

## What Phase 2 does not claim

- No language is `Verified` without a supported reproduction and independent fix
  verification.
- Structural parsing is not full semantic analysis.
- Dependency graphs remain JS/TS/Python-only in this build.
- Cross-file taint and business-logic analysis are not implemented by the parser
  layer.
- CodeQL, Trivy and Checkov execution is not wired into scans.
- Parse limits are explicit: 80 source files per language, and skipped files are
  reported.
