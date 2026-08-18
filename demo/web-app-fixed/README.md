# MiniShop (FIXED) — OpenPitStop demo app

The remediated counterpart to [`../web-app-broken`](../web-app-broken). This is
what the agent produces after `pitstop drive` / `pitstop verify`. It is *not* a
gold-plated example — it is the realistic result of fixing one root cause at a
time.

## Run

```bash
npm install
DB_PASSWORD=dummy JWT_SECRET=dummy npm test     # 5 passing
npm start                                        # http://localhost:3000
```

> `.env.example` lists the required variables. The test suite sets them itself.

## What was fixed (vs. the broken twin)

- **Secrets** → `process.env` only, fail-fast if missing; `.env` gitignored.
- **Dependencies** → `express@4.17.1→4.21.2` (+ `helmet`), `lodash@4.17.4→4.17.21`,
  added `bcryptjs`, `express-rate-limit`, `cors` allowlist.
- **Command injection** → validated host, no shell in `/api/ping`.
- **SQL injection** → parameterized `?` queries; named columns (no `SELECT *`).
- **XSS** → `escapeHtml` + `textContent` (no `innerHTML`); `httpOnly` cookie.
- **Path traversal** → reads confined to `uploads/`.
- **`eval`**, **`alg:none`** → removed; `JWT` verifies `algorithms:["HS256"]`.
- **Auth** → `bcrypt.compare`, `crypto.randomBytes(32)` tokens, secure cookie.
- **Circular dependency** → `server.js ↔ users.js` broken.
- **Database** → scoped role, `rejectUnauthorized:true`, row-level security.

## Verified result

`pitstop scan` reports **86/100 (A-)** — 0 circular, 5/5 tests passing, only a
moderate transitive `body-parser` advisory from `express@4.21.2` (a real,
honest residual). `pitstop verify` → **VERIFIED**.

See [`../DEMO_SCRIPT.md`](../DEMO_SCRIPT.md) for the full before/after run.
