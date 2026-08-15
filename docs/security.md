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

## Honesty contract

- Every static finding is `[indicated]` and carries a `fix` — the report is a
  worklist, never a verdict.
- Dependency audits (`npm audit`, `osv-scanner`, `pip-audit`) that fail are
  reported as `skipped` with a repair hint — deps that were never scanned are
  never reported as clean.
- The static pass is fully offline: it never sends your code anywhere.
  See [PRIVACY.md](../PRIVACY.md).
