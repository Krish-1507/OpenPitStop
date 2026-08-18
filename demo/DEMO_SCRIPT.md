# OpenPitStop — Full Tool Demo Script (post-ready)

A complete, copy-paste walkthrough you can run live and record. It uses the
intentionally-broken **MiniShop** web app in [`web-app-broken/`](./web-app-broken)
and its remediated twin [`web-app-fixed/`](./web-app-fixed) to show the
**before → after** fix, measured honestly at every step.

> **What makes this demo real:** nothing is pre-recorded. Every number comes
> from a deterministic scan, a tamper-evident baseline, or a live penetration
> test. The agent *fixes* the code; OpenPitStop *verifies* the fix — and if the
> agent cheats (deletes a test, hardcodes a pass, stuffs a `TODO`), it gets
> caught.

---

## 0. One-time setup (30s)

```bash
# Install the CLI
npm install -g openpitstop        # or: npx --yes openpitstop@latest

# Register the /pitstop slash command in YOUR AI coding tool
npx openpitstop install -y
#   → writes the command into Claude Code, Cursor, OpenCode, Kilo Code,
#     Antigravity, Gemini CLI, and Codex CLI.

# (Optional) gate every commit before it can land
npx openpitstop install -y --hooks
```

Open the broken app in your AI tool:

```bash
cd demo/web-app-broken
npm install
npm test        # 5 failing tests — the app is genuinely broken
```

---

## 1. The new `/pitstop` experience (the fix you asked for)

In your AI tool's chat, type:

```
/pitstop fix this app
```

**What the user sees now:** exactly that line — `/pitstop fix this app`. The
18KB Standard Operating Procedure is *not* pasted into the chat. The command is
a thin pointer that tells the agent to load the real procedure:

```bash
pitstop prompt --args "fix this app"
```

The agent runs that, reads the full SOP from its own tool output, and follows
it. Clean input, full instructions — best of both worlds.

---

## 2. Scan the broken app (the honest baseline) — `pitstop scan`

```bash
cd demo/web-app-broken
pitstop scan
```

Real output (verbatim from this repo):

```
OpenPitStop Score: 35/100 (F)
  Dependency Graph : 1 circular — src\server.js → src\users.js → src\server.js
  Security         : 2 root cause(s) → 31 symptoms
  Tests            : 5 failed / 5
```

A sampling of the 31 symptoms PitStop flags in MiniShop:

| Class | Finding | Where |
| --- | --- | --- |
| secret | AWS key, Stripe key, JWT secret, DB password hardcoded in source | `src/config.js` |
| secret | committed `.env` with every credential | `.env` |
| secret | DB password hardcoded in config | `src/db.js`, `src/config.js` |
| cors | `Access-Control-Allow-Origin: *` + credentials | `src/server.js` |
| command-injection | shell built by interpolation — `exec("ping …" + host)` | `src/server.js` |
| sql-injection | `db.pool.query("SELECT * … " + req.params.id)` | `src/server.js` |
| xss | token in `localStorage`; `innerHTML = u.name` | `public/app.js` |
| path-traversal | `fs.readFile(req.query.name)` | `src/server.js` |
| input-validation | `eval(req.body.expr)` | `src/server.js` |
| data-exposure | `/api/account` returns the password; `SELECT *` everywhere | `src/server.js`, `src/db.js`, `src/users.js` |
| logging | credentials + token logged to console | `src/server.js` |
| database | superuser account, `GRANT ALL`, TLS disabled | `src/db.js` |
| authentication | `password === stored`, `Math.random()` token, `alg:none` JWT, insecure cookie | `src/auth.js` |
| hidden-vuln | security `TODO`/`FIXME` comments | several files |

The scan also **seals a baseline** — the signed "before" state every later
check is verified against.

---

## 2b. Never lose the thread — `pitstop next`

Every `pitstop` command (and the `/pitstop` slash command) ends by running
`pitstop next`, which reads the sealed `.pitstop/` artifacts and prints a card
with the **single best next command** and a **Pending** checklist of everything
still open before the repo is fully fixed:

```bash
cd demo/web-app-broken
pitstop next
```

```
▶ Next: pitstop drive security-0d098ed0
  a confirmed root cause (security-0d098ed0) is still unfixed — drive the
  agent to fix it with a tamper-evident mission

Pending before this repo is fully fixed:
  ☐ 45 security finding(s) open — run `pitstop pen --fix` or `pitstop drive <id>`
  ☐ 2 root-cause cluster(s) to fix
  ☐ 1 circular dependenc(ies) to break
  ☐ 5 failing test(s) to make pass
  ☐ verification not run — `pitstop verify`
```

It needs no arguments and guesses nothing — the suggestion is derived from the
real baseline, so the user always sees where they are and what to do next.

## 3. Penetration test it live — `pitstop pen --fix`

```bash
pitstop pen --fix
```

`pen` boots MiniShop's `start` script in a sandbox and fires real attack
traffic. With `--fix` it writes **repro tests** (regression tests that FAIL
while the bug is live, by design) and **deterministic patches** for what's
provably safe (e.g. adding `helmet()` + `app.disable("x-powered-by")`). Every
patch passes `git apply --check`.

```bash
pitstop repro SEC-001     # FAILS — the command injection is confirmed live
```

---

## 4. Let the agent fix it — `pitstop drive`

```bash
pitstop drive SEC-001
```

`drive` writes the mission prompt itself — *run the repro, it must FAIL, fix
the root cause, re-run it, it must PASS, don't break anything* — and hands it
to your agent. The agent produces exactly the changes in
[`web-app-fixed/`](./web-app-fixed):

- secrets → `process.env` (fail-fast if missing), `.env` gitignored
- `lodash@4.17.4`→`4.17.21`, `express@4.17.1`→`4.21.2` + `helmet`
- command injection → validated host, no shell
- SQLi → parameterized `?` queries, named columns (no `SELECT *`)
- XSS → `escapeHtml` + `textContent` (no `innerHTML`), `httpOnly` cookie
- path traversal → confined to `uploads/`
- `eval` → removed; `alg:none` → `algorithms:["HS256"]`
- `password ===` → `bcrypt.compare`; `Math.random()` → `crypto.randomBytes`
- circular `server ↔ users` → removed
- `GRANT ALL`/no-TLS superuser → scoped role + `rejectUnauthorized:true` + RLS

---

## 5. Verify it didn't fake it — `pitstop verify`

```bash
pitstop verify
```

OpenPitStop re-runs the repro tests and diffs the change against the **signed
baseline**, flagging classic agent-cheat patterns (deleted tests, swallowed
errors, hardcoded-to-pass values). Exit `0 = VERIFIED`.

---

## 6. The one-number contract — `pitstop gate` / `pitstop ci`

```bash
pitstop gate --score 60      # 0 = clean, 1 = issues, 2 = suspicious
echo $?                       # 1 before the fix, 0 after
```

Drop it into CI (`action.yml` / `.github/workflows/pitstop.yml`) or use the
git pre-commit hook from `install --hooks`.

---

## 7. Proof it's all honest — `pitstop honesty` / `report`

```bash
pitstop honesty     # every number traced to a sealed .pitstop/ file
pitstop report      # shareable HTML/markdown report card
pitstop memory      # what OpenPitStop has learned about this repo
pitstop watch       # keep the loop cheap: reuse baselines, skip waste
```

---

## 8. Before / After at a glance

| | Before (`web-app-broken`) | After (`web-app-fixed`) |
| --- | --- | --- |
| `pitstop scan` score | **35/100 (F)** | **86/100 (A-)** |
| circular dependency | 1 (server ↔ users) | 0 |
| security symptoms | **31** | 0 critical (1 moderate transitive advisory) |
| secrets in source / `.env` | yes | env-only, `.env` gitignored |
| command / SQL injection | yes | parameterized, validated |
| XSS | `innerHTML` + `localStorage` | escaped + `httpOnly` cookie |
| `eval`, `alg:none`, `===` pw | yes | removed / `bcrypt` / `HS256` |
| tests | **5 failing** | **5 passing** |
| `pitstop verify` | — | **VERIFIED** |

Run the fixed app yourself:

```bash
cd demo/web-app-fixed
npm install
DB_PASSWORD=dummy JWT_SECRET=dummy npm test        # 5 passing
```

---

## 9. One command to rule them all — `pitstop fix` (autopilot)

```bash
pitstop fix
```

The autopilot chains **scan → pen --fix → verify → gate** and shows the `pitstop
next` card after each hop. `pen --fix` writes failing-first repro tests + safe
patches, and `fix` `git apply`s the deterministic ones — so a clean repo can be
reached without touching the agent. Every step writes a sealed `.pitstop/`
artifact, and when the gate passes it finishes with a celebration card.

## 10. "Just tell it what you want" — natural language

No need to memorize commands. Type a plain-English request and OpenPitStop
resolves it:

```bash
pitstop ask "make this safe"      # → pitstop fix
pitstop ask "why is my score low"  # → pitstop scan
pitstop ask "is it verified"       # → pitstop verify
pitstop ask "fix security-0d098ed0"# → pitstop drive security-0d098ed0
```

The slash command does the same: `/pitstop make this safe` routes through
`pitstop ask` automatically. Every `next`/scan card also prints a copy-paste
`` ```bash `` block and `pitstop inspect <id>` deep-links so you can jump
straight to a finding's file:line + fix.

---

## The pitch (say this on camera)

> Agents fix code; they don't know when to stop, and they'll tell you they're
> done regardless. OpenPitStop is the honest referee: deterministic scans,
> tamper-evident baselines, runtime penetration tests with failing-first
> regression contracts, and a verification gate that catches the agent lying.
> The CLI measures; the agent edits; the numbers can't be cheated.
