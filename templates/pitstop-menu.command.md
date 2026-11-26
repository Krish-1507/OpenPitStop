---
description: "OpenPitStop menu — show a scrollable, clickable card of every action and run the one you pick."
---

# /pitstop menu

Show the user a **scrollable, interactive selection list** of OpenPitStop actions, then run the
one they pick. A static block of text is not acceptable — the user must be able to scroll the
list and click or select an option.

## How to present it
- If your AI tool has an interactive choice/selection UI (Claude Code's AskUserQuestion,
  Cursor's interactive prompt, OpenCode's question prompt, Gemini CLI's picker, Codex's
  selection, Windsurf's prompt, Aider's menu, etc.), render the 18 actions below as a
  **scrollable, clickable list**. Selecting an option runs that `pitstop` command on this repo.
- If no interactive UI is available, fall back to a numbered list and ask the user to reply
  with the number — but the scrollable UI is the required behavior whenever the tool supports it.

## OpenPitStop actions
1. Check — `pitstop check quick` — Guided quick/deep/ship check with findings and next steps.
2. Scan — `pitstop scan` — One honest score for the whole repo: secrets, deps, tests, a11y.
3. Languages — `pitstop languages` — Parser, analyzer and verification support per language.
4. Map — `pitstop map` — Candidate routes, entry points, auth/data evidence and infrastructure.
5. Impact — `pitstop impact` — Reverse import graph for the current diff: dependents, routes, tests.
6. Verify — `pitstop verify` — Prove the fix is real (PoVF + proof coverage), not vibes.
7. Gate — `pitstop gate` — Release decision over saved evidence; add `--strict` for release.
8. Report — `pitstop report` — Quality report + proof badge you can paste in a PR.
9. Next — `pitstop next` — What to do next + what's still open (the Pending card).
10. Ask — `pitstop ask "<text>"` — Turn a vague request into the exact command to run.
11. Pen — `pitstop pen` — Adversarial red-team: prove the reported issue actually breaks.
12. Repro — `pitstop repro` — Generate a failing reproduction from a bug report.
13. Digest — `pitstop digest` — Summarize a PR or commit as an honest changelog.
14. Integrity — `pitstop integrity` — Check that reported issues stayed fixed, against sealed evidence.
15. Bench — `pitstop bench` — Score the detector on committed fixtures, with limits.
16. Share — `pitstop share` — Export a tamper-evident proof artifact for others.
17. Install — `pitstop install -y` — (Re)write the /pitstop command into your tools.
18. Help — `pitstop --help` — Full command reference.

After the user picks, run that command and follow its output (and, at the end, `pitstop next`)
exactly as the base `/pitstop` command would.
