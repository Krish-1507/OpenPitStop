# MiniShop (BROKEN) — OpenPitStop demo app

Intentionally vulnerable Node.js + Express 4 e-commerce app used to show
OpenPitStop finding and fixing real problems. **Do not deploy. Do not reuse
these patterns.**

## Run

```bash
npm install
npm test          # 5 failing tests — the app is genuinely broken
npm start         # http://localhost:3000
```

## What's wrong (what PitStop catches)

`pitstop scan` reports **35/100 (F)** — 1 circular dependency, 31 security
symptoms, 5 failing tests. Highlights:

- **Secrets in source & committed `.env`** — AWS key, Stripe key, JWT secret, DB password.
- **Command injection** — `GET /api/ping?host=` builds a shell string by interpolation.
- **SQL injection** — `GET /api/products/:id` and `/api/search` concatenate user input into `db.pool.query`.
- **Reflected XSS** — `GET /api/users/:id` returns `innerHTML`-ready HTML; token stored in `localStorage`.
- **Path traversal** — `GET /api/file?name=` reads arbitrary files with `fs.readFile`.
- **`eval`** — `POST /api/calc` evaluates `req.body.expr`.
- **Data exposure** — `/api/account` returns the password; `SELECT *` everywhere.
- **CORS `*` + credentials**, **`password ===`**, **`Math.random()` token**, **JWT `alg:none`**, insecure cookie.
- **Hidden vuln** — security `TODO`/`FIXME` comments scattered in code.
- **Database** — superuser account, `GRANT ALL`, TLS disabled.
- **Circular dependency** — `server.js ↔ users.js`.

See the remediated version in [`../web-app-fixed`](../web-app-fixed) and the
full walkthrough in [`../DEMO_SCRIPT.md`](../DEMO_SCRIPT.md).
