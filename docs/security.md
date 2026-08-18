# Security coverage — what OpenPitStop finds and how to fix it

Every `pitstop scan` / `pitstop try` runs a deterministic, fully-offline static
security pass over your repo in addition to the dependency audits. Findings are
labeled `[indicated]` — static analysis points at the line and the class of
bug, it does not claim proof (the dynamic `pen` and `ledger` phases exist for
proof). Every finding ships with its exact `fix`, and `scan`/`try` print the
complete identify-and-solve list under the score box.

## The five classic vulnerability classes

### 1. Authentication — "users are who they claim to be"

Detection (all `authentication`):
- Password compared directly with `==` / `===` (cleartext compare, no
  key-derivation function involved).
- Passwords written straight into a store (`INSERT`/`save`/`create` with a
  `password` column and no hash call).
- Auth + password flows present but **no** bcrypt/argon2/scrypt/pbkdf2 anywhere
  in the repo (repo-level finding).
- `Math.random()` used to mint tokens/OTPs/session ids — predictable output.
- JWT signed or verified with a short inline literal secret.
- Auth endpoints with no rate limiter anywhere (repo-level finding).

Fix (what the report tells you):
- Compare only salted hashes: `await bcrypt.compare(input, user.hash)`.
- Store only `bcrypt.hash(password, 12)` — never the plaintext.
- Mint tokens with `crypto.randomBytes(32).toString("hex")`.
- `jwt.sign(payload, process.env.JWT_SECRET)` with a long random env secret.
- `express-rate-limit` on `/login`, `/otp`, `/reset` (5 req/min per IP+user).

### 2. Authorization — "the manager is not the employee"

Detection (all `authorization`):
- Data-handling routes (`/api/account`, `/api/orders`, `/admin/...`) whose
  handler never references `req.user`, `req.session`, a JWT verify, or an auth
  middleware within the handler — broken access control: anyone who can reach
  the route can call it.
- Privileged routes (`/admin/...`, `/moderator/...`, `/dashboard/...`) that
  never reference `role` / `permission` / `isAdmin`.

Fix:
- Guard every protected route: `router.get("/api/account", requireAuth, handler)`
  with a server-side per-request token/session verify.
- Enforce roles server-side on every privileged route *and every page*:
  `if (req.user.role !== "admin") return 403`. Hiding UI is not a control.

### 3. Input validation — "validate file types, size limits, formats"

Detection (all `input-validation`):
- `multer()` / `upload.single(...)` / `express.fileupload()` with no size
  limits and no file-type filter.
- Money fields (`req.body.amount` / `price` / `total` / `quantity` / `fee`)
  read straight off the request with no Number/NaN/finite/range check.
- `eval(...)` and `new Function(...)` with interpolated content.
- Plus the XSS family: `innerHTML` / `insertAdjacentHTML` / `document.write` /
  `dangerouslySetInnerHTML` / `v-html` receiving dynamic or user-derived data.

Fix:
- `multer({ limits: { fileSize: 1MB }, fileFilter: (_, f, cb) => cb(null, ALLOWED_TYPES.has(f.mimetype)) })`.
- Validate money as integers of the smallest unit:
  `Number(v); if (!Number.isSafeInteger(v) || v <= 0) return 400`.
- Never `eval`; use `textContent` / `{expression}` / `v-text` instead of HTML
  sinks, or escape every interpolated value.

### 4. Secret management — "keys live in the environment"

Detection (all `secret`):
- Known credential formats committed in source: private keys
  (`-----BEGIN ... PRIVATE KEY-----`), AWS `AKIA`/`ASIA`, Google `AIza`,
  GitHub `ghp_`/`github_pat_`, Slack `xox[baprs]-`, Stripe `sk_live_`,
  Anthropic `sk-ant-`, OpenAI `sk-`.
- Inline secret assignments: `apiKey:` / `client_secret:` / `jwt_secret:` /
  `password:` with a string literal (non-placeholder) value.
- Signed JWTs committed in source.
- `.env` files present but **not** covered by `.gitignore`.

Fix:
- Rotate any leaked key immediately, then read from the environment:
  `process.env.API_KEY` — never a literal.
- Add `.env` / `.env.*` (keep `.env.example`) to `.gitignore` and confirm with
  `git status`.

### 5. SQL injection — "parameterize, always"

Detection (all `sql-injection`):
- `db.query("SELECT ... " + x)` / `db.query(\`...${x}\`)` style concatenation
  and interpolation in JS drivers (pg, mysql, sqlite, mssql...).
- ORM raw builders receiving interpolated input: `whereRaw`, `orderByRaw`,
  `knex.raw`, `sequelize.literal`, Prisma `$queryRawUnsafe`.
- Mongoose `$where` (runs JS server-side).
- Python: `cursor.execute(f"...{x}")` and `%`-formatting.

Fix:
- Parameterized queries, always: `db.query("SELECT ... WHERE id = $1", [id])`
  (drivers disagree on the placeholder — `?`, `$1`, `:name` — but never build
  the SQL string from input).

## Beyond the five — the full posture

| Category | Example detection | Fix |
|---|---|---|
| `command-injection` | `exec("git log " + x)`, Python `shell=True` + f-string | `execFile`/`spawn` with argv arrays, no shell |
| `path-traversal` | `fs.readFileSync(userPath)` | resolve against a root, verify prefix, `path.basename` |
| `ssrf` | `fetch(req.body.targetUrl)` | allowlist protocols + hosts (https, your domain) |
| `prototype-pollution` | `Object.assign({}, req.body)` / spreading bodies | whitelist keys; strip `__proto__` |
| `cors` | `origin: "*"` + `credentials: true` | exact-origin allowlist |
| `transport` | `fetch("http://...")`, `secure: false` cookies, `ws://` | https/wss, `{ httpOnly, secure, sameSite }` |
| `headers` | Express/Fastify app with no helmet | `app.use(helmet())` |
| `csrf` | cookie sessions + state-changing routes, no CSRF token | `csrf-sync` middleware on all POST/PUT/DELETE |
| `logging` | `console.log(...password...)` | log identifiers, redact secrets |
| `logging` | `res.json({ error: err.stack })` | log the stack server-side, return a correlation id |

## Rate limiting — "scripted abuse is an attack too"

Detection (all `rate-limiting`):
- State-changing endpoints (`app.post/put/delete/patch`) exist but **no** rate
  limiter appears anywhere in the repo (repo-level finding).
- `rateLimit({ max: N })` with N ≥ 100 — a limiter set so high it is a
  decoration, not a defense.
- `windowMs: 0` / `max: 0` — an effectively disabled limiter.

Fix:
- `express-rate-limit` on auth and every state-changing route:
  `windowMs: 60_000, max: 5–10` per IP+account; tune the window for legit
  bursts, never the ceiling for attackers.

## Database lockdown — "the DB role is not a superuser"

Detection (all `database`):
- Connection strings using a privileged account with a committed password:
  `postgres://postgres:postgres@...` (also `root`/`sa`/`admin`/`superuser`).
- `GRANT ALL PRIVILEGES` or `ALTER/CREATE USER|ROLE ... SUPERUSER` in
  migrations.
- Connections without enforced TLS: `sslmode=disable|allow`, `ssl: false`,
  `useSSL: false`, `encrypt: false`.
- Database passwords hardcoded in config (`db_password: "..."` etc.).
- A backend with direct DB access but **no row-level security** anywhere
  (repo-level finding): tenant isolation is one missing `WHERE` clause away
  from leaking everyone's data.

Fix:
- Create a scoped role with only what the app needs
  (`GRANT SELECT, INSERT, UPDATE, DELETE` — no DDL), a strong generated
  password in `.env`, and connect as that role.
- Run migrations with a separate CI-only credential.
- `sslmode=require` on every connection.
- Enable RLS on every table and add policies:
  `ALTER TABLE orders ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON orders USING (tenant_id = current_setting("app.tenant_id"));`
  and set `app.tenant_id` once per request.

## Data exposure — "the client doesn't need the hash"

Detection (all `data-exposure`):
- Credentials or PII in API response bodies:
  `res.json({ ...password/hash/apiKey/ssn... })`.
- Full DB objects shipped to the client: `res.json(user)` /
  `res.json(orders)` — password/hash/internal fields ride along.
- PII logged: `console.log(...cardNumber/ssn/iban/cvv...)`.
- `SELECT * FROM ...` — every column (including secrets) goes to every caller.

Fix:
- Return only what the UI needs: `res.json({ id: user.id, name: user.name })`,
  or `const { password, hash, ...safe } = user; res.json(safe)`, or a
  `toJSON()` that strips secrets.
- Name columns: `SELECT id, email, name FROM users`.
- Log masked tokens: `card.slice(-4)`.

## Hidden vulnerabilities — "the protections that were switched off"

Detection (all `hidden-vulnerabilities`):
- TLS verification silently disabled: `rejectUnauthorized: false`,
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k`, `wget --no-check-certificate`.
- JWTs accepting `alg: "none"` — a forged unsigned token validates.
- Obfuscation into `eval`: `eval(atob(...))`, `eval(Buffer.from(...))`.
- Comments acknowledging an unfinished security gap:
  `// TODO/FIXME/HACK ... password/bypass/insecure/...`.
- Lint/type checks bypassed on security-sensitive lines:
  `eslint-disable-next-line ... password/eval/sql/...`.
- Tokens kept in `localStorage` — any XSS walks away with them.
- Committed minified bundles (logic hidden from review), backup/editor files
  (`*.bak`, `*.old`, `*.swp`, `*~` — older snapshots often hold secrets), and
  `.htpasswd` credential files.

Fix:
- Remove the override: `rejectUnauthorized: true` (the default); pin the CA if
  it's a private cert; never `curl -k` in scripts.
- Verify with an allowlist: `jwt.verify(token, secret, { algorithms: ['HS256'] })`.
- Replace decoder-eval chains with the plain logic.
- Resolve security TODOs now or track them as blocking tickets.
- Fix the underlying issue instead of suppressing it.
- httpOnly + Secure + SameSite cookie for the session.
- Commit source (with maps/signatures), delete backups, `gitignore` `*.bak`.

## The live pen test — proof, not just a report

The static pass above says where a bug *probably* is. `pitstop pen` proves it by
booting your app in a sandbox and firing real attack traffic. Verdicts are
PROVEN (a live attack succeeded), INDICATED (static only), or CLEAN. `--fix`
writes a repro test that FAILS while the bug is live, then a patch. Every run
also produces a **drift** delta against the last sealed run (NEW / RESOLVED /
ESCALATIONS) so a fix is verifiable and a regression can't reach main.

The classes `pen` attacks live, the ones a scanner alone can never confirm:

| Class | What the live attack proves | The fix it hands you |
|---|---|---|
| `race-condition` (TOCTOU) | Two concurrent requests both pass a check that should be exclusive (double-spend, double-submit) | server-side lock / atomic `UPDATE ... WHERE` / unique constraint |
| `idor` (BOLA) | Guessing another user's object id returns their data | per-request ownership check on every object route |
| `price-tampering` | A client-supplied price or quantity is accepted server-side and the order total is wrong | compute totals server-side from the catalog, never trust the body |
| `xxe` | A crafted XML upload reads a local file or makes an outbound call | disable external entities, or use a safe parser |
| `insecure-deserialization` | A poisoned payload triggers code execution or object injection | sign and encrypt the token, or use JSON; never `eval`/`pickle`/`unserialize` on input |
| `jwt-weak-secret` | The token is signed with a guessable secret, so a forged token validates | `jwt.sign(payload, process.env.JWT_SECRET)` with a long random env secret |

The first two (race-condition, idor) are detected statically and proven live; the
rest are confirmed by a live attack. xxe and jwt-weak-secret are marked
non-replayable, because their repro is the live attack itself rather than a saved
test. Run `pitstop repro <id>` to turn any replayable finding into a failing
test, then watch it flip to RESOLVED on the next `pen` run.

## The test pyramid — unit, integration and e2e

`pitstop test [path] [--unit] [--integration] [--e2e]` discovers and runs all
three layers of the test pyramid:

| Layer | Discovered via | Reported |
|---|---|---|
| unit | `test` / `test:unit` / `unit` scripts; vitest, jest, mocha, pytest fallbacks | pass/fail counts |
| integration | `test:integration` / `test:it` / `integration` scripts; vitest/jest/pytest on `tests/integration` dirs | pass/fail counts |
| e2e | `test:e2e` / `e2e` / `test:playwright` / `test:cypress` scripts; playwright/cypress configs | pass/fail counts + failing test names |

Every layer that cannot be found is reported `skipped — no suite discovered`
rather than silently ignored, counts are parsed from the runner's own output
(never invented), failing tests are listed by name so the fix list is
actionable, and the command exits 1 the moment any layer fails — CI can trust
it. Tests run on your machine, against your repo, with no external calls.

## Honesty contract

- Every static finding is `[indicated]` and carries a `fix` — the report is a
  worklist, never a verdict.
- Dependency audits (`npm audit`, `osv-scanner`, `pip-audit`) that fail are
  reported as `skipped` with a repair hint — deps that were never scanned are
  never reported as clean.
- The static pass is fully offline: it never sends your code anywhere.
  See [PRIVACY.md](../PRIVACY.md).
