---
description: "OpenPitStop — the honest referee for AI coding agents. Run the full quality loop, or type /pitstop menu for a clickable action card."
---

# /pitstop

If the user typed **nothing** after `/pitstop`, or typed `menu`, show the OpenPitStop **menu card** (see the "Menu card" section at the bottom) and let them pick an action.

If the user typed a natural-language request instead of a command name (e.g. "make this safe", "why is my score low", "what should I do next"), run `pitstop ask "<text>"` to resolve it to the exact command, then run that command as if they had typed it directly.

Otherwise, load the full procedure and run it on this repo (the current working directory). Execute this and read the **full output** before doing anything else — that output *is* the OpenPitStop procedure you must follow, scoped to this repository:

```bash
pitstop prompt --args "$ARGUMENTS"
```

If `pitstop` is not on your PATH, run `npx --yes openpitstop@latest prompt --args "$ARGUMENTS"` instead.

Follow every instruction in that output. Do **not** paste the procedure back to the user — just run it. (The text the user typed after `/pitstop` is passed through as `$ARGUMENTS` above.)

After the `pitstop` command finishes, run `pitstop next` and show the user its **Next-step** and **Pending** card (as a clickable card if your tool supports interactive choices). That card tells them exactly what to run next and what is still open before the repo is fully fixed. (`scan` and `verify` print this card automatically, so for those just surface what they printed.)

---

## Menu card

Present a clickable menu of OpenPitStop actions using your tool's interactive selection UI if it has one (e.g. Claude Code AskUserQuestion, Cursor interactive prompt, OpenCode question prompt). If no interactive UI exists, print the numbered card and ask the user to reply with a number.

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

After the user picks, run that `pitstop` command (substitute the real finding id for `<ID>`). Follow its output exactly. Do not paste the menu back to the user.
