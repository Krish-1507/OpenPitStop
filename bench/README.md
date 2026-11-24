# The OpenPitStop benchmark

`pitstop bench` measures the built-in static security check against the fixtures in this
directory. Every number published in [docs/benchmark.md](../docs/benchmark.md) comes from
this folder, and anyone with a checkout can reproduce it.

## Running it

```bash
pitstop bench                  # the report for these fixtures
pitstop bench --json           # machine-readable, for a CI job or a notebook
pitstop bench --markdown       # the tables used in the docs
pitstop bench --filter sql     # one slice while iterating
pitstop bench --strict         # exit non-zero when a recorded expectation is not met
```

The command reads fixtures and writes nothing: no `.pitstop` directory, no cache, no
formatting. `--strict` fails on `crashed`, `missed`, `partial`, `noisy`, `newly-detected`,
`not-reproduced` and `unexpected-coverage`. It does not fail on skipped coverage, because a
stack the check cannot read is reported honestly instead of hidden.

## A scenario

```
bench/scenarios/<id>/
  scenario.json    the contract: what this fixture proves
  repo/            a small repository the analyzer is pointed at
```

| Field | Meaning |
|---|---|
| `id` | Must match the directory name, so a verdict is traceable to one folder. |
| `title` | One line a reviewer can read in a report. |
| `kind` | One of the seven kinds below. |
| `stack` | Language label used by the per-stack view, e.g. `node`, `python`, `rust`. |
| `checks` | Checks to run; currently `["security"]` (the default). |
| `expect.findings` | Categories (and optional repo-relative files) that must be reported. |
| `expect.forbid` | Categories that must not be reported. |
| `pairOf` | For `fixed`: the vulnerable twin, whose findings are the forbidden set. |
| `note` | Why this fixture exists. The report keeps it with the scenario. |

### Kinds and verdicts

| Kind | Records | Passes as | Otherwise |
|---|---|---|---|
| `vulnerable` | defects the check must report | `detected` (all expected) or `partial` (some) | `missed` (none) |
| `fixed` | the corrected twin of `pairOf`; forbids exactly the paired findings | `clean` | `noisy` |
| `benign` | a category the check must not claim | `clean` | `noisy` |
| `known-miss` | a defect the rules do not reach, kept on purpose | `as-documented` | `newly-detected` (the fixture is stale) |
| `known-false-positive` | a pattern the rules report although it is mitigated | `as-documented` | `not-reproduced` |
| `unsupported` | a stack no rule reads | `skipped` | `unexpected-coverage` (the manifest is wrong) |
| `broken` | a repository the check must survive | `survived` | `crashed` |

## Scoring

- `precision = detected / (detected + false positives)` over scored fixtures.
- `recall = detected / (detected + missed)` over expected findings.
- A **false pass** is a vulnerable fixture that produced no finding at all.
- **Documented misses** and **documented false positives** are listed and kept out of the
  ratios: they are the limits the benchmark exists to publish, not hidden failures.
- A **skipped** fixture is never counted as clean, and it never enters precision or recall.
- A **pair is discriminating** when the vulnerable fixture is detected and its fixed twin is
  quiet. A pair where either side was skipped or crashed is `inconclusive`, not a pass.

## Adding a fixture

1. Create `scenarios/<id>/repo/` with the smallest repository that shows one defect, or one
   fix, and nothing else.
2. Write `scenario.json` by hand. For `fixed`, add `pairOf` and leave `expect` empty: the
   paired findings define the forbidden set.
3. Record the defect, not the analyzer output: the category a reviewer would name and the
   file they would point at. The fixture states the defect; the run measures whether the
   check finds it. Copying the analyzer output into `expect` would make recall meaningless.
4. If the check misses a real defect, the fixture is a `known-miss`. If it reports a
   mitigated pattern, the fixture is a `known-false-positive`. Neither is a reason to delete
   the fixture.
5. Run `pitstop bench` and update the tables in `docs/benchmark.md`.

Rules for a fixture: one defect per repository, no network or credentials, no generated or
secret files, and no edit to `src/` that exists only for a fixture. The benchmark measures
the shipped check, so a fixture that needs the analyzer changed is a product decision, not a
benchmark change.

## What this does not measure

Fixtures are curated near-misses, not a random sample; precision here describes this set.
The timing covers the analyzer pipeline in-process, not CLI startup, network or agent calls.
Dynamic checks, Docker isolation and exploit proof live in `pitstop pen`, not here. The full
list is in [docs/benchmark.md](../docs/benchmark.md#limits).
