# Benchmark: the detector, measured on fixtures you can read

`pitstop bench` runs the built-in static security check against a fixed set of small
repositories in [`bench/scenarios`](../bench/scenarios) and reports what it found against what
each fixture records. The fixtures, the expectations and the numbers live in the repository,
so a claim about detection can be checked instead of believed.

This is a regression and honesty instrument, not a leaderboard. It answers one question —
does the shipped check still find the defects it claims, without inventing defects that are
not there? — and it publishes the cases where the answer is no.

```bash
pitstop bench                 # terminal report
pitstop bench --markdown      # the tables below
pitstop bench --json          # machine-readable report
pitstop bench --strict        # CI: non-zero when a recorded expectation is not met
```

## Published result

Rendered by `pitstop bench --markdown`; the runtime line is machine-specific and printed by
each run.

| Measure | Value |
|---|---|
| Fixtures | 22: 8 vulnerable, 8 fixed, 1 benign, 2 known-miss, 1 known-false-positive, 1 unsupported, 1 broken |
| Pairs | 8 vulnerable/fixed pairs, all discriminating |
| Expected findings | 8 |
| Detected | 8 |
| Missed | 0 |
| Precision | 100% (8 detected / 8 claims on scored fixtures) |
| Recall | 100% (8 detected / 8 expected findings) |
| False passes | 0 vulnerable fixtures produced no finding |
| Documented misses | 2, listed below and kept out of recall |
| Documented false positives | 1, listed below and kept out of precision |
| Skipped coverage | 1 (Rust), reported as not measured, never as clean |
| Runtime | about 0.1 s for the set, in-process |

### Scenarios

| Scenario | Kind | Stack | Verdict | Findings |
|---|---|---|---|---|
| `admin-route-guarded` | fixed | node | clean | none |
| `admin-route-unguarded` | vulnerable | node | detected | authorization |
| `benign-escaped-innerhtml` | known-false-positive | node | as-documented | xss |
| `benign-validated-amount` | benign | node | clean | none |
| `broken-manifest` | broken | node | survived | none |
| `command-injection-exec` | vulnerable | node | detected | command-injection |
| `command-injection-execfile` | fixed | node | clean | none |
| `env-jwt-secret` | fixed | node | clean | none |
| `inline-jwt-secret` | vulnerable | node | detected | authentication |
| `known-miss-sql-in-helper` | known-miss | node | as-documented | none |
| `known-miss-ssrf-via-variable` | known-miss | node | as-documented | none |
| `password-bcrypt-compare` | fixed | node | clean | authentication |
| `password-cleartext-compare` | vulnerable | node | detected | authentication |
| `python-command-injection` | vulnerable | python | detected | command-injection |
| `python-command-injection-fixed` | fixed | python | clean | none |
| `sql-injection-concat` | vulnerable | node | detected | sql-injection |
| `sql-injection-parameterized` | fixed | node | clean | none |
| `ssrf-allowlisted-fetch` | fixed | node | clean | none |
| `ssrf-unvalidated-fetch` | vulnerable | node | detected | ssrf |
| `unsupported-rust-service` | unsupported | rust | skipped | not measured |
| `xss-innerhtml` | vulnerable | node | detected | xss |
| `xss-textcontent` | fixed | node | clean | none |

### Pairs

| Vulnerable fixture | Fixed fixture | Result |
|---|---|---|
| `admin-route-unguarded` | `admin-route-guarded` | discriminating |
| `command-injection-exec` | `command-injection-execfile` | discriminating |
| `inline-jwt-secret` | `env-jwt-secret` | discriminating |
| `password-cleartext-compare` | `password-bcrypt-compare` | discriminating |
| `python-command-injection` | `python-command-injection-fixed` | discriminating |
| `sql-injection-concat` | `sql-injection-parameterized` | discriminating |
| `ssrf-unvalidated-fetch` | `ssrf-allowlisted-fetch` | discriminating |
| `xss-innerhtml` | `xss-textcontent` | discriminating |

A pair is discriminating when the vulnerable fixture is detected and its fixed twin produces
no finding for the same defect at the same file. The fixed twin may still produce a related
finding — `password-bcrypt-compare` does, for the missing rate limiter — and that finding is
shown under `noise` instead of being scored, because the paired defect is gone.

## Documented limits

### Known misses (recall the numbers do not claim)

- `known-miss-sql-in-helper` — the SQL string is built by a helper function and the taint
  crosses a return value. The rules match at the sink, so they see `pool.query(query)` with
  nothing tainted in the window. One hop of data flow is beyond the current engine.
- `known-miss-ssrf-via-variable` — the request value is assigned to `url` one statement
  before `fetch(url)`. Same limit, different sink.

Both are real defects a reviewer must still catch. They are recorded so the gap is visible,
and `newly-detected` would mean the fixture is now stale, not that the benchmark passed.

### Known false positive (precision the numbers do not claim)

- `benign-escaped-innerhtml` — the value reaches `innerHTML` after an `escapeHtml` helper. The
  pattern is mitigated, the rule reports it anyway, and the fixture records that. The finding
  stays out of the precision denominator rather than being deleted.

### Not measured

- `unsupported-rust-service` — the static security rules read JS/TS, Python, Go, Ruby, PHP,
  Java and C# sources. Rust is reported as skipped coverage. A skipped fixture is never
  counted as clean and never enters precision or recall.

## Method

- The benchmark calls the same `analyzeSecurityStatic` the CLI calls. There is no benchmark
  mode and no model call.
- Fixtures are read-only inputs: a run writes no `.pitstop` directory, cache or artifact.
- Expectations describe the defect — the category a reviewer would name and, when location
  matters, the file they would point at. They are never copied from the analyzer output.
- Pairs differ only in the defect and its fix, so a passing pair shows the rule discriminates
  rather than fires on a keyword.
- Verdicts are explicit: `detected`, `partial`, `missed`, `clean`, `noisy`, `as-documented`,
  `newly-detected`, `not-reproduced`, `skipped`, `unexpected-coverage`, `survived`, `crashed`.
  `--strict` turns every unmet expectation into a non-zero exit.
- Every ratio names its denominator: precision is detected findings over detected plus
  false-positive claims; recall is detected over detected plus missed expected findings.

## What 100% means here, and what it does not

100% precision and recall mean the shipped check still matches the canonical examples it
documents, on a set that was chosen to describe those examples. The set is curated and small;
it is not a sample of real repositories, and it cannot estimate field precision or recall.
The honest signals are the shape of the set and the published gaps: 8 paired defects across
two stacks, 2 recorded misses where taint crosses a hop, 1 recorded false positive where a
mitigation is unmodelled, and 1 stack reported as not measured.

## Reproduce and gate

```bash
npm run build
node dist/cli.js bench
node dist/cli.js bench --markdown
node dist/cli.js bench --strict
```

In CI, run `pitstop bench --strict` where the fixtures are available and let a changed
verdict fail the job. When a fixture legitimately changes, update `bench/README.md` and the
tables here in the same change.

## Limits

- The static security check reads JS/TS, Python, Go, Ruby, PHP, Java and C# sources. Other
  stacks are reported as skipped coverage, never as clean.
- Fixtures are curated near-misses rather than a random sample, so precision here describes
  this set and is not a general-world estimate.
- A match is a finding category at a file with confidence `indicated`: a lead, not an exploit
  proof. Dynamic pen testing is measured elsewhere.
- The benchmark runs the analyzer pipeline in-process. CLI startup, network work, Docker
  isolation and agent calls are not part of the timing.
- A known-miss scenario records a limitation on purpose. `newly-detected` means the fixture is
  stale, not that the benchmark failed.
