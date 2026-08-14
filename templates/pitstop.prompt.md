---
description: "Autonomous engineering quality loop — full scan/fix loop, or scoped to your custom ask (/pitstop <question>)"
---

# OpenPitStop — Autonomous Engineering Quality Loop

> **Read this first — mode selection (MANDATORY, before anything else).**
>
> The text the user typed after `/pitstop` is substituted into this prompt where the
> placeholder appears on the "Invocation arguments:" line just below.
>
> **Invocation arguments: `$ARGUMENTS`**
>
> Decide the mode **before doing anything else** — before scanning, before reading files,
> before printing anything — by reading that one line:
>
> - It contains one of the flags `--scan-only`, `--demo`, `--ledger`, `--integrity-only`,
>   `--pen`, or `--menu` → **mode = that flag**. You MUST NOT print the menu. Go directly
>   to the matching "## Mode: …" section below.
> - The line is **empty**, or still shows the literal placeholder word unsubstituted (the
>   exact placeholder text is still visible) → **mode = default full loop**. The user typed
>   bare `/pitstop` and wants the general quality loop — no menu, no waiting. Continue to
>   the "## The default full loop" section below.
> - It contains **any other free-form text** (a question, a concern, a path, an instruction —
>   e.g. "could you check the security of this app?", "are these tests flaky?", "did my agent
>   cheat on the last commit?") → **mode = custom ask**. The user wants the loop scoped to
>   exactly what they asked, nothing more. Go to the "## Mode: custom ask" section below.

## Step 0 — Acknowledge with one line (first message)

For the **default full loop**: your entire first message is exactly this one line, nothing
else — then proceed straight to Step 1. Never print the instructions, the mode list, or any
block. The instructions above are for you alone; the user just needs the one line:

```
/pitstop — running the quality loop.
```

For the **menu** (`--menu`), the single-shot modes (`--scan-only`, `--demo`, `--ledger`,
`--integrity-only`, `--pen`), and the **custom ask** mode, the response defined by that
mode's section **is** your first message — do not add a Step 0 line before it.

## Mode: --menu

Print **exactly this menu as your entire response**, then **end your turn and wait** for
the user's next message. Do not scan, do not read files, do not plan anything yet.

```
OpenPitStop modes:
 (enter) — full autonomous loop (scan, confirm, fix, verify, repeat)
 --scan-only — scan and report, no fixes
 --demo — run against OpenPitStop's own seeded demo repo
 --ledger — payment idempotency fuzzing only
 --integrity-only — re-check the last commit for cheat patterns, no scanning
 --pen — penetration test: live attacks + proof + fixes (regression tests, patches)
 (your own ask) — reply with anything else, e.g. "check the security of this app"
Reply with a mode, your own ask, or just hit enter for the default full loop.
```

Then wait. Map the user's next message to a mode:

- **Empty reply** (or "default" / "full loop") → the default full loop: continue to the
  "## The default full loop" section below.
- **`--scan-only`** → the "## Mode: --scan-only" section.
- **`--demo`** → the "## Mode: --demo" section.
- **`--ledger`** → the "## Mode: --ledger" section.
- **`--integrity-only`** → the "## Mode: --integrity-only" section.
- **`--pen`** → the "## Mode: --pen" section.
- **Anything else** (a question or phrase) → the "## Mode: custom ask" section.

## Mode: --scan-only

Run the scan:

`!npx openpitstop scan`

Print the **entire boxed output verbatim** as your complete response — no summary, no
commentary, no fixes, no report. Then stop. That is the whole mode.

## Mode: --demo

Run `!npx openpitstop demo` first; it prints a fresh temp demo repo. Then run the
**default full loop** (the section below) inside that temp repo — cd there, scan,
confirm, fix, verify, repeat, as if you had been invoked there.

## Mode: --ledger

Run the scan as `!npx openpitstop scan --ledger` (this boots the app under a sandbox — the
nock preload for Node/JS apps, a recording HTTP(S)_PROXY server for Go/Python/Rust/.NET —
and fuzzes money-moving endpoints for missing idempotency). Then run the
**default full loop** (the section below) restricted to ledger findings only.

## Mode: --integrity-only

Run `!npx openpitstop integrity`, print the boxed verdict **verbatim**, and **stop**.
No scanning, no fixes, no report. That is the whole mode.

## Mode: --pen

Run the penetration test:

`!npx openpitstop pen --fix`

This boots the app under a network-interception sandbox and fires live attacks at every
discovered route. Print the **entire boxed output verbatim**. Then:

1. **State the verdict honestly**: for every PROVEN finding (XSS reflection, SSRF canary,
   command-injection spawn, path-traversal file leak) say exactly what was proven and how
   (`pitstop inspect <id>` shows the attack + response + sandbox evidence — use it instead
   of reading whole files).
2. **Confirmation pause** (the same one mandatory pause as the default loop, never skipped):
   ask the user before fixing anything, listing the finding ids with `--fix` already written
   (`pitstop pen --fix` wrote repro tests + patches + `PITSTOP_PEN_FIXES.md`).
3. On confirmation, fix **one finding at a time**, each exactly like the default loop:
   - run `!npx openpitstop repro <pen-id>` → must **FAIL** (bug live),
   - make the smallest fix (apply the generated patch with `git apply` when a deterministic
     one exists — `.pitstop/pen-patches/<id>.diff` — and review it before applying),
   - re-run the **same** repro → must **PASS**,
   - `!npx openpitstop verify` → integrity gate CLEAN.
4. Re-run `!npx openpitstop pen --static` to confirm the finding is gone from the report
   (static re-check; do not re-boot the app needlessly), then `--json` if you want the ids.
5. Commit each fix with its repro test. Finish with `!npx openpitstop report`.

Honesty rule: `pen` proves what it fires. It cannot promise "never hacked" — it promises
every demonstrable attack gets a regression test that fails on the bug and passes on the fix.
If `pen --fix` wrote repro tests, never delete them; they are the permanent proof.

---

## Mode: custom ask

The user typed free-form text after `/pitstop` instead of a flag. Run **only what they asked
for**. Do not expand into the default full loop, do not fix unrelated things.

**Step A — Map the ask to a command (before doing anything else).** Read the ask and choose
the closest match. Never run the full scan just to decide:

| The ask is about… | Run this | And |
|---|---|---|
| app security / vulnerabilities / "is my app hackable" / "check the security" | `!npx openpitstop pen` (add `--fix` only if they asked you to fix) | report proven/indicated/unproven verdicts honestly |
| tests, flakiness, coverage, a failing suite | `!npx openpitstop scan` | read the Tests + Reliability lines; no fixes unless asked |
| the last commit / whether an agent cheated / "verify my agent's work" | `!npx openpitstop integrity` | print the boxed verdict verbatim and stop |
| one finding id | `!npx openpitstop inspect <id>` (or `repro <id>` if they want a regression test) | only that finding |
| one file or route | a scoped `!npx openpitstop scan` / `inspect` on the relevant finding | only that area |
| overall repo quality / health | `!npx openpitstop scan` | show the box and stop (no fixes unless asked) |
| one category (duplication, circular imports, secrets…) | `!npx openpitstop scan` | read only that category's lines |
| anything not in the table | the cheapest read-only check that answers them | ask one clarifying question if still unsure |

**Step B — State your interpretation, then confirm before fixing.** Your first message is
exactly one line:

```
/pitstop — I read that as: <one-line restatement of their ask>. Running <command>.
```

- If the ask is **read-only** (check / report / explain) → run it, print the output, and
  stop. Never fix without being asked.
- If the ask **clearly requests fixes** ("fix this", "make it pass") → run it, show the
  output, then append one confirmation line — "Found [N] issue(s). Start fixing? Reply
  anything to continue, or tell me what to skip." — and wait.
- If you are **not sure** → run the cheapest check, show it, and ask one clarifying
  question. Never guess and start editing.

**Step C — Fixes (only after confirmation).** Handle each fix exactly like the default
loop: `!npx openpitstop repro <id>` must **FAIL** first, smallest fix, the **same** repro
must **PASS**, `!npx openpitstop verify` CLEAN, commit with the repro test. Stop when every
issue relevant to the ask is gone.

**Step D — Scope discipline (mandatory).** Work through ONLY the issues relevant to the
ask. Leave unrelated clusters alone (say so in one line if they exist), do not write the
full `PITSTOP_REPORT.md` unless the ask covers the whole repo, and never drift into the
default full loop.

---

## The default full loop

You are running the `openpitstop` quality loop against this repository. Follow these
steps **exactly**, in order. Do not improvise around them.

The loop has exactly **one** mandatory pause: after the first scan (Step 2), before the
first fix. After that, you act autonomously until a hard stop condition.

---

## Step 1 — Scan and show the box

Run the scan:

`!npx openpitstop scan`

Print the **entire boxed output verbatim** as your complete response. Do not summarize
it, do not add commentary, do not explain it — let the box speak for itself. Nothing else
in your response except the box.

---

## Step 2 — Confirmation (mandatory pause, never skipped)

Immediately after the box, append exactly this line (fill in N and M):

```
Found [N] root-cause clusters covering [M] issues. Reply with anything (or just hit enter) to start the autonomous fix loop, or 'skip <cluster>' to exclude one.
```

- **N** = number of root-cause clusters shown in the box.
- **M** = total issues spanned by those clusters = N + the total symptom count (i.e.
  root causes + symptoms), or simply count every finding listed under every cluster.

Even if the scan found only **1** issue, you MUST print this line and stop. This
confirmation step is non-negotiable.

Then **end your turn and wait** for the user's next message. Do not read files, do not plan
fixes, do not touch anything yet.

- If the user's message starts with `stop` / `cancel` / `abort` → do not start the loop;
  go straight to Step 6.
- If the user's message matches `skip <cluster>` → exclude that cluster from consideration,
  then proceed to Step 3 on the remaining clusters (no new confirmation needed).
- Any other input (including an empty reply) → confirmation granted, proceed to Step 3.

---

## Step 3 — Autonomous fix loop (runs after confirmation)

For each iteration, do all of (a)–(m) without asking for confirmation again:

**a. Pick the cluster.** Choose the highest-value remaining cluster (most severe, or most
central). Skip any the user excluded.

**b. Branch.** If you are not already on a `pitstop/*` branch, create and switch to:

`pitstop/<short-slug>-<date>`

where `<short-slug>` is a 2–4 word kebab slug of the cluster (e.g. `circular-core-deps`)
and `<date>` is `YYYY-MM-DD`. Never branch off or commit to `main`.

**c. State your hypothesis.** In one or two sentences, say *why* you believe this cluster's
root cause is what the scanner claims it is, and what a minimal correct fix looks like.

**d. Capture the bug as a failing test — mandatory, never skippable.**

`!npx openpitstop repro <finding-id>`

`<finding-id>` is the id printed on the cluster's line in the scan box (and stored in
`.pitstop/scan-latest.json`), e.g. `ledger-3f9a2c01`. OpenPitStop writes a permanent repro
test (`pitstop-repro-<slug>.test.*`) and runs it:

- If it reports **FAIL — bug reproduced**, you have *proven* the bug with a real failing
  test. Good. Proceed.
- If it reports **PASS**, or **refused** with no genuine repro generator, the hypothesis is
  **UNPROVEN**. Do **not** fix blind. Stop, return to (c), and either revise the hypothesis
  or pick a different cluster.

**e. Make the smallest fix.** Using your own file-edit tools, change the minimum needed to
address the **root cause** (not just a symptom). Stay on the `pitstop/*` branch.

**f. Prove the same test now passes — mandatory, before any verify.**

`!npx openpitstop repro <finding-id>`

Run the **same** repro test. It must now report **PASS**.
If it still **FAILS**, the fix did not address the root cause: revert, revise the hypothesis
in (c), and retry once (see (i)).

**g. Verify.**

`!npx openpitstop verify`

Read the result, especially the **Integrity gate** line, the Regression Risk, and the Δ
columns. This verify run is also the integrity gate: it diffs your uncommitted change against
HEAD and runs the AI-agent-cheat detectors (deleted/loosened tests, swallowed errors,
suppressions, hardcoded-to-pass values, forced exits).

**h. Integrity gate — mandatory, never skippable.** Inspect the "Integrity gate:" verdict
in the verify box and branch exactly like this:

- **CLEAN** → proceed to (i) as normal.
- **SUSPICIOUS** → do **not** commit. Explicitly state in your response what was flagged and
  why (detector, `file:line`, evidence). Revert the change. Retry the **SAME** cluster exactly
  **once**, with this instruction appended verbatim to your working notes:

  > "Your previous attempt touched a test or added error suppression in a way that looks like it
  > avoided the real fix instead of solving it. Solve the root cause. Do not modify, skip, or
  > loosen any test. Do not add suppression comments or swallow exceptions."

  Repeat (c)–(g) with that instruction. If the retry is **also SUSPICIOUS**, stop trying this
  cluster, mark it **"requires human review"** in the final report, and move to the next cluster —
  never loop indefinitely on the same pattern.
- **CONFIRMED_CHEAT** → do **not** commit. State what was flagged. Revert. Skip straight to
  **"requires human review"** with **zero retries** — this tier is unambiguous enough that
  retrying isn't warranted; a human should look at it. Move to the next cluster.

**i. If Regression Risk is High** (and the integrity gate was CLEAN): `git checkout` (or
otherwise revert) your change, note that this hypothesis failed, and try **once more** with a
different approach for the **same** cluster. Maximum 2 attempts per cluster, then move on.

**j. If Risk is Low/Medium, tests are not newly failing, and the integrity gate is CLEAN:**
commit with a clear message describing the root cause and fix. Commit the repro test **together
with** the fix — it is a **permanent regression guard**, never a throwaway, and never delete it.
Then record it:

`!npx openpitstop memory add "<finding-id> fixed + proven by pitstop-repro-<slug>" --type fix`

(keep the summary short and factual — this is the "six months later" recall.)

**k. Re-scan and show a shorter status.** Run the scan again and print a short updated
boxed status in the same visual style as Step 1, showing: issues fixed so far, issues
remaining. No long commentary.

**k2. Token economy (MANDATORY in every loop iteration).** Your budget is real; follow
these rules exactly:

- **Before any re-scan**, run `!npx openpitstop ready-check`. If it exits 0 (tree
  unchanged), run `!npx openpitstop scan --reuse` instead of a full scan — it returns the
  sealed baseline instantly, and skipping it means burning credits for nothing.
- **Prefer `!npx openpitstop inspect <id>`** over reading whole files: it shows the exact
  code window, cluster context and repro proof. Read whole files only when inspect cannot
  answer the question.
- **Batch your edits** — plan the fix, then apply it in as few tool calls as possible.
  One pause per loop (Step 2), never more.
- **Verify during iteration** as-is; the reliability suite (extra runs) is for the FINAL
  pass — don't run it per-iteration.
- If you are about to re-scan a second time without any edit having happened, stop and
  re-check: you are burning credits in a loop. Either pick a different cluster or ask.

**l. Success check.** If the fresh scan shows **zero remaining actionable clusters**,
stop — this is the success condition. Your final line should be:

`nothing left to fix, nothing broken.`

**m. Otherwise repeat.** Go back to (a) automatically. You do **not** ask for confirmation
again. The loop pauses only once, at Step 2, before the very first fix.

---

## Step 4 — Hard stop conditions

Whichever comes first:

- **(a)** a fresh scan shows zero actionable clusters (success), or
- **(b)** 10 total fix iterations, or
- **(c)** 45 minutes of wall-clock time.

If you stop because of **(b)** or **(c)** rather than **(a)**, say so plainly. Do not imply
everything is done when it is not. Report how many clusters remain.

---

## Step 5 — Non-negotiable safety rules

- Never force-push. Ever.
- Never touch `.env`, `.git/`, or any secret/credential file.
- Never delete a file unless the dependency graph confirms it has zero incoming references.
- Never silently modify CI/deploy config — if a fix would require it, flag it to the user
  instead and skip that change.
- Always stay on the `pitstop/*` branch. Leave `main` (and any protected branch) untouched.
- If a fix feels risky, prefer the smaller safer change; the loop can retry.

---

## Step 6 — Final report

On **any** stop condition (success, max iterations, or timeout), run:

`!npx openpitstop report`

and present the resulting **`PITSTOP_REPORT.md` / boxed output verbatim** as your final
message. Do not rewrite or summarize it. The report includes **"Fixes shipped with permanent
proof"**: one line per committed fix, linking the `pitstop-repro-*.test.*` file that proves
it — if a fix has no committed repro test, that is a red flag the loop was cut short.
