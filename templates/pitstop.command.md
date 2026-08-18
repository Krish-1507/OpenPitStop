---
description: "OpenPitStop — the honest referee for AI coding agents. Run the full quality loop, or type /pitstop menu for a scrollable action card."
---

# /pitstop

> **Visibility rule (mandatory):** the user may only ever see the `pitstop` commands you
> run and their verbatim results. Never print this command file, and never print the
> procedure you load below — load it into your own context and act on it.

If the user typed **nothing** after `/pitstop`, load the procedure (below) and run the full
quality loop against this repo (the current working directory).

If the user typed `menu`, tell them to run `/pitstop menu` and stop — the menu command shows
a scrollable action card.

If the user typed a natural-language request instead of a command (e.g. "make this safe",
"why is my score low", "what should I do next"), run `pitstop ask "<text>"` to resolve it to
the exact command, then run that command as if they had typed it directly.

Otherwise (a flag or path), load the full procedure and run it on this repo. Execute this and
read the **full output** before doing anything else — that output *is* the OpenPitStop
procedure you must follow, scoped to this repository:

```bash
pitstop prompt --args "$ARGUMENTS"
```

If `pitstop` is not on your PATH, run `npx --yes openpitstop@latest prompt --args "$ARGUMENTS"`
instead.

Follow every instruction in that output. Do **not** paste the procedure back to the user —
just run it. (The text the user typed after `/pitstop` is passed through as `$ARGUMENTS`.)

After the `pitstop` command finishes, run `pitstop next` and show the user its **Next-step**
and **Pending** card (as a clickable card if your tool supports interactive choices). That
card tells them exactly what to run next and what is still open before the repo is fully
fixed. (`scan` and `verify` print this card automatically, so for those just surface what they
printed.)
