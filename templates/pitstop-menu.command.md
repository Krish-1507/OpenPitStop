---
description: "OpenPitStop menu — show a clickable card of every action and run the one you pick."
---

# /pitstop menu

Show the user a **menu card** of OpenPitStop actions and run the one they choose.

## How to present it
- If your AI tool has an interactive choice/question UI (Claude Code's AskUserQuestion, Cursor's interactive prompt, OpenCode's question prompt, Gemini CLI's selection, etc.), use it to render the options below as a **clickable card**. Selecting an option runs its `pitstop` command.
- If no interactive UI exists, print the card as a numbered list and ask the user to reply with the number.

## OpenPitStop actions
1. Scan — `pitstop scan` — One score for the whole repo (secrets, deps, tests, a11y).
2. Pen-test & fix — `pitstop pen --fix` — Attack the live app; write proof tests + safe fixes.
3. Fix a finding — `pitstop drive <ID>` — Agent fixes one root cause, tamper-proof.
4. Verify — `pitstop verify` — Prove the fix is real, not faked.
5. Gate / CI — `pitstop gate --score 60` — One number that blocks bad commits.
6. Report — `pitstop report` — Shareable HTML/markdown scorecard.
7. Honesty — `pitstop honesty` — The evidence behind every number.
8. Watch — `pitstop watch` — Keep rescans cheap.
9. Memory — `pitstop memory` — What OpenPitStop learned here.
10. Install — `pitstop install -y` — Add the commands + git hook.
11. Full loop — `pitstop prompt` — Run the whole procedure, end to end.
12. What's next — `pitstop next` — Best next step + what's still open.
13. Autopilot — `pitstop fix` — One command: scan → pen --fix → verify → gate (fully evidenced).
14. Ask in plain English — `pitstop ask "<text>"` — "make this safe" → the right command.

After the user picks, run that `pitstop` command (substitute the real finding id for `<ID>` if they chose Fix). Follow its output exactly. Do **not** paste the menu or the command output back to the user.

Then run `pitstop next` and show its **Next-step** and **Pending** card (as a clickable card if your tool supports interactive choices) so the user always sees what to do next and what is still open. (`scan` and `verify` print this card automatically, so for those just surface what they printed.)
