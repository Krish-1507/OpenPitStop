# OpenPitStop GitHub Action

One line in your workflow file, and every PR gets a referee it can't cheat:

```yaml
- uses: Krish-1507/OpenPitStop@main
```

The action runs the OpenPitStop scan + gate against your code, posts the verdict
as a PR comment, and **fails the job when the gate fails** — so branch protection
can block the merge. It is diagnostic-only and read-only: OpenPitStop never edits
your code, ever.

## Quick start

`.github/workflows/pitstop.yml`:

```yaml
name: OpenPitStop gate
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  pull-requests: write   # lets the action post/update the gate comment

jobs:
  pitstop:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # needed to diff the PR against its base branch
      - uses: Krish-1507/OpenPitStop@main
```

That's the whole setup. On the next PR you'll see a comment like this:

> **OpenPitStop Gate**
>
> **PASS** — safe to merge
>
> - OpenPitStop Score: **74/100 (B)** · Integrity: **CLEAN** · Gate exit code: `0`

…and when an agent tries to cheat, the comment flips to **CONFIRMED_CHEAT —
blocked** and the job fails, which fails the check, which blocks the merge.

### What the gate checks

- OpenPitStop Score vs your threshold (`score` input, default 60)
- Integrity diff since the base branch: focused tests, deleted tests,
  assertion literals edited to match buggy output, swallowed errors,
  suppression comments, mocked module-under-test, forced exits
- Regression risk vs the base branch's baseline (tests, perf, security, duplication)
- The baseline's tamper-evident evidence signature

Exit codes (the gate never lies): `0` clean · `1` fail — human review ·
`2` confirmed cheat — blocked.

## Options

| Input | Default | Purpose |
|---|---|---|
| `score` | `60` | Minimum OpenPitStop Score to pass (`0` disables the check). |
| `version` | `latest` | Pin the CLI, e.g. `1.1.0`, for reproducible gates. |

## The badge loop

Every README that shows a `PITSTOP_BADGE.svg` is free distribution. Wire it up
once — the badge regenerates itself on every push to `main`:

```yaml
# .github/workflows/pitstop-badge.yml
name: OpenPitStop badge
on:
  push:
    branches: [main]
  schedule:
    - cron: "0 3 * * 1"   # weekly refresh, so the badge tracks reality

permissions:
  contents: write

jobs:
  badge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Scan and regenerate the badge
        run: |
          npx --yes openpitstop@latest scan --reuse || npx --yes openpitstop@latest scan
          npx --yes openpitstop@latest report --badge
      - name: Commit the fresh badge
        run: |
          git config user.name "OpenPitStop Bot"
          git config user.email "actions@github.com"
          git add PITSTOP_BADGE.svg PITSTOP_REPORT.md .pitstop || true
          git commit -m "chore: refresh OpenPitStop badge" || echo "no changes"
          git push || echo "nothing to push"
```

Then add one line to your README:

```markdown
[![OpenPitStop score](PITSTOP_BADGE.svg)](https://github.com/Krish-1507/OpenPitStop#readme)
```

The first run scans your repo and writes the badge (plus a sealed baseline, which
is also what arms the PR gate above). After that, every push refreshes it. The
badge in your README is a conversation starter: *"what is that? — oh, a referee
for my AI agents."*

## No baseline yet? Nothing breaks

If the repo has never been scanned, the action comments "no baseline — run the
badge job once to arm the gate" and does **not** fail the job. Adoption first,
enforcement later.

## Publishing as `openpitstop/action`

This action ships from the OpenPitStop repo itself, so `uses:
Krish-1507/OpenPitStop@main` works today. For the shortest possible one-liner —
`uses: openpitstop/action@v1` — publish a copy under the `openpitstop` GitHub org:

1. Create the `openpitstop/action` repo (the org's first repo).
2. Copy `action.yml` and `docs/github-action.md` into it, and commit.
3. Tag the release `v1` (and `v1.x` as it evolves) — actions are referenced by
   tag, and mutable refs like `main` are bad practice for consumers.
4. Optional: point the badge doc link back at the action repo.

The action itself needs no build step and no dependencies — it's a composite
action that pulls `openpitstop` from npm on the runner.

## Local, before the commit even lands

The Action gates the PR. The pre-commit hook gates the agent *before it can
commit*:

```bash
npx openpitstop install --hooks
```

Same verdict, same exit codes, one second earlier in the pipeline. See the
README's Install section.
