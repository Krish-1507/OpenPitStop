import fs from "node:fs";
import path from "node:path";
import { lineOf } from "./util.js";
import type { ScanIssue } from "./types.js";

/**
 * Deterministic, fully-offline static security scan.
 *
 * Every finding here is labeled `[indicated]`: static analysis can point at
 * the line and the class of bug, but it cannot *prove* an exploit — the
 * dynamic phases (`pen`, `ledger`) exist for that. What it CAN do is never
 * miss a known pattern, and every finding carries a concrete `fix`, so the
 * report is an identify-and-solve checklist, not a scare.
 *
 * Covered (see docs/security.md):
 *   - SQL injection (JS + Python)
 *   - Command injection, path traversal, SSRF, XSS
 *   - Secret management: known credential formats, generic secret
 *     assignments, committed `.env` files
 *   - Authentication: weak password compare, plaintext storage, missing
 *     hashing, predictable tokens, inline JWT secrets, missing rate limits
 *   - Authorization: routes without authn/authz checks, admin routes
 *     without role checks
 *   - Input validation: file uploads without limits, unvalidated money
 *     fields, eval/Function sinks, prototype pollution
 *   - Rate limiting: missing limiters on state-changing endpoints, limits
 *     set so high they are decorations, disabled limiters
 *   - Database lockdown: privileged accounts in committed connection
 *     strings, GRANT ALL/SUPERUSER, TLS-free connections, hardcoded DB
 *     passwords, missing row-level security
 *   - Data exposure: credentials/PII in API responses, full DB rows sent
 *     to the client, PII in logs, SELECT *
 *   - Hidden vulnerabilities: disabled TLS verification, alg:none JWTs,
 *     eval-atob deobfuscation, security TODOs, lint/type bypasses on
 *     sensitive code, tokens in localStorage, committed minified bundles,
 *     backup/editor files and .htpasswd in the tree
 *   - Config & transport: CORS+credentials, missing security headers,
 *     cleartext HTTP, insecure cookies, CSRF exposure, stack leaks,
 *     sensitive logging, weak hashing
 */

const MAX_FILES = 600;
const MAX_BYTES_PER_FILE = 512 * 1024;
const MAX_FINDINGS = 40;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".pitstop",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "vendor",
  "target",
  "out",
  "demo-repo",
  "templates",
]);

const CODE_EXTS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".php",
  ".java",
  ".cs",
  ".html",
  ".vue",
  ".svelte",
  ".sql",
]);

/** Paths that a sane app treats as needing protection. */
const PROTECTED_PATH =
  "(?:admin|account|profile|settings|dashboard|orders?|checkout|payment|charge|billing|subscription|private|internal|api(?:/|)|users?|sessions?|transactions?|transfer|refund)";

/** Unambiguous user-controlled data sources (no bare `body`/`input`/`data`). */
const USERISH =
  "req\\.(?:query|params|body|headers|cookies|files)|userInput|userUrl|targetUrl|webhookUrl|callbackUrl|redirectUrl|uploadedFile|fileName|filePath|pathVar|target";

export interface StaticRule {
  category: string;
  severity: string;
  /** Optional path filter: only flag routes/paths matching this. */
  pathFilter?: RegExp;
  /** Optional guard words: when any appears inside the match window, the route is NOT flagged. */
  guard?: RegExp;
  /** Optional: when the match span contains this, the fix is already applied — skip. */
  skipWhenInMatch?: RegExp;
  /** Optional: extra predicate — false means the match is a false positive. */
  accept?: (m: RegExpExecArray, content: string) => boolean;
  re: RegExp;
  describe: (m: RegExpExecArray) => string;
  fix: string;
}

/**
 * Rules are tried per file, in order. Match offsets are mapped to line
 * numbers; matches are deduped by (category, file, line) so overlapping
 * patterns never double-report the same line.
 */
export const STATIC_SECURITY_RULES: StaticRule[] = [
  /* ----------------------- SQL injection ----------------------- */
  {
    category: "sql-injection",
    severity: "high",
    re: /\b(?:db|client|pool|connection|mysql|pg|sqlite|sqlite3)\.(?:query|execute|exec|run|all|get)\s*\([`"']?[\s\S]{0,140}?(?:\$\{[\s\S]{0,40}?\}|["'`]\s*\+)/g,
    describe: () =>
      "SQL built by string concatenation or interpolation — user input reaches the query text",
    fix: 'use parameterized queries, never string-built SQL: db.query("SELECT * FROM users WHERE id = $1", [id])',
  },
  {
    category: "sql-injection",
    severity: "high",
    re: /\b(?:whereRaw|orderByRaw|groupByRaw|joinRaw|havingRaw|fromRaw|raw|literal)\s*\(\s*[`"']?[\s\S]{0,140}?(?:\$\{[\s\S]{0,40}?\}|["'`]\s*\+)/g,
    describe: () =>
      "raw SQL builder receives interpolated/concatenated input — injection into an ORM raw call",
    fix: 'raw SQL builders must never receive user input: use the ORM\'s parameterized API: .where("id", id) instead of .whereRaw(`id = ${id}`)',
  },
  {
    category: "sql-injection",
    severity: "high",
    re: /\$\s*where\s*:/g,
    describe: () =>
      "Mongoose $where query — runs JS on the DB server with injected conditions",
    fix: "never use $where: it evaluates strings server-side. Use $eq/$in with validated values: { _id: { $eq: id } }",
  },
  {
    category: "sql-injection",
    severity: "high",
    re: /\bqueryRawUnsafe\s*\(/g,
    describe: () =>
      "Prisma $queryRawUnsafe — explicitly marked unsafe by Prisma, intended for constant SQL only",
    fix: "use Prisma's parameterized queryRaw with $1 placeholders, or better the typed findUnique/findMany API",
  },
  {
    category: "sql-injection",
    severity: "high",
    re: /\b(?:cursor|conn|db)\.(?:execute|executemany)\s*\(\s*f["']|\.execute\s*\(\s*["'][^"'\n]{0,120}["']\s*%\s*[\(\[]/g,
    describe: () =>
      "SQL built with f-strings or %-formatting — Python driver-level injection",
    fix: 'always pass parameters separately: cursor.execute("SELECT * FROM users WHERE id = ?", (id,)) — never f-strings',
  },

  /* --------------------- Command injection --------------------- */
  {
    category: "command-injection",
    severity: "high",
    re: /\b(?:exec|execSync|execFileSync)\s*\(\s*[`"']?[\s\S]{0,160}?(?:\$\{[\s\S]{0,40}?\}|["'`]\s*\+)/g,
    describe: () =>
      "shell command built with interpolation/concatenation — user input executes as code",
    fix: 'never put user input in shell strings: execFile("git", ["log", commit]) with an args array and shell:false',
  },
  {
    category: "command-injection",
    severity: "high",
    re: /\bos\.system\s*\(\s*f["']|subprocess\.(?:run|Popen|call|check_output)\s*\([\s\S]{0,200}?shell\s*=\s*True/g,
    describe: () =>
      "Python shell=True with a formatted command — RCE via user input",
    fix: 'drop shell=True and pass an argv list: subprocess.run(["git", "log", commit]) — never a formatted string',
  },
  {
    category: "command-injection",
    severity: "medium",
    re: /\bshell\s*:\s*true[\s\S]{0,60}?(?:req\.|userInput|payload|commit|targetUrl|filename|filePath)/g,
    describe: () =>
      "spawn/exec with shell:true near user-controlled data — quoting mistakes become RCE",
    fix: "shell:true disables argument safety. Pass argv arrays without a shell unless you control every byte",
  },

  /* --------------------- Path traversal ------------------------ */
  {
    category: "path-traversal",
    severity: "medium",
    re: /\b(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|sendFile|unlink|unlinkSync|rmSync|realpath|access)\w*\s*\(\s*[`"']?[\s\S]{0,120}?(?:req\.(?:query|params|body|files)|userInput|uploadedFile|pathVar)[\s\S]{0,60}?\)/g,
    describe: () =>
      "user-controlled path reaches the filesystem — ../ escapes read arbitrary files",
    fix: 'confine user paths: const root = path.resolve("uploads"); const safe = path.resolve(root, name); if (!safe.startsWith(root + path.sep)) throw new Error("bad path")',
    skipWhenInMatch: /path\.basename\s*\(/,
  },
  {
    category: "path-traversal",
    severity: "medium",
    re: /\bpath\.(?:join|resolve)\s*\(\s*[`"']?[\s\S]{0,100}?(?:req\.(?:query|params|body)|userInput|uploadedFile|pathVar)[\s\S]{0,40}?\)/g,
    describe: () =>
      "user input joined into a path — ../ traversal unless confined to a root",
    fix: "basename the user part and verify the result stays inside an allowed root: path.basename(name) + prefix check",
    skipWhenInMatch: /path\.basename\s*\(/,
  },
  /* -------------------------- SSRF ----------------------------- */
  {
    category: "ssrf",
    severity: "medium",
    re: /\b(?:fetch|axios\.(?:get|post|put|patch|request)|got|request|superagent|http\.(?:get|post)|https\.(?:get|post))\s*\(\s*[`"']?[\s\S]{0,140}?(?:req\.(?:query|params|body|headers)|userInput|targetUrl|webhookUrl|callbackUrl|redirectUrl|userUrl|target)[\s\S]{0,40}?\)/g,
    describe: () =>
      "user-supplied URL reaches an HTTP client — SSRF lets attackers hit internal services (169.254.169.254)",
    fix: "allowlist destinations: only https + your domain, or an explicit allowlist; never fetch a user-supplied URL",
    accept: (_m, content) => {
      // A loopback/localhost guard immediately before the call is a real
      // (partial) mitigation for internal-probe scenarios — skip it.
      const before = content.slice(Math.max(0, _m.index - 200), _m.index);
      return !/\b(?:isLoopback|isLocalhost|isPrivate)\s*\(/.test(before);
    },
  },

  /* --------------------------- XSS ----------------------------- */
  {
    category: "xss",
    severity: "high",
    re: /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\s*[:=]\s*[`"'(\s]*[\s\S]{0,100}?(?:req\.(?:query|params|body)|userInput|username|userTitle|userContent|userMessage|userComment|userSearch|userUrl|payload)|\bdangerouslySetInnerHTML\s*=|\bv-html\s*=/g,
    describe: () =>
      "user data flows into an HTML sink — script injection runs in every visitor's browser",
    fix: 'never write user data into HTML sinks: use textContent / {expression} / v-text, or escape HTML on every path in',
  },
  {
    category: "xss",
    severity: "medium",
    re: /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\s*[:=]\s*(?![`"'])([A-Za-z_$][\w$.]*|\$\{)/g,
    describe: (m) =>
      `dynamic value (${m[1].slice(0, 40)}) written into an HTML sink — if it can be user-derived, this is stored/reflected XSS`,
    fix: "write text with textContent; if you must write HTML, escape every interpolated value first",
  },

  /* --------------------- Secret management --------------------- */
  {
    category: "secret",
    severity: "high",
    re: /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|ghp_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{20,}|xox[baprs]-[0-9A-Za-z\-]{10,}|sk_live_[0-9A-Za-z]{16,}|sk-ant-[0-9A-Za-z\-_]{20,}|sk-[A-Za-z0-9]{20,})/g,
    describe: () =>
      "known credential format committed in source — anyone with repo access has a live key",
    fix: "rotate the leaked key NOW, then move it to .env (gitignored): process.env.API_KEY — never in source",
  },
  {
    category: "secret",
    severity: "medium",
    re: /\b(?:api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|jwt[_-]?secret|session[_-]?secret|password|passwd|pwd)\s*[:=]\s*["']([^"']{4,})["']/g,
    describe: (m) =>
      `secret-looking value "${m[1].slice(0, 12)}…" assigned inline instead of read from the environment`,
    fix: "secrets live in .env (gitignored) + process.env.NAME — never as string literals in source",
  },
  {
    category: "secret",
    severity: "medium",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    describe: () =>
      "a signed JWT committed in source (leaked token or test fixture — either way it must not be here)",
    fix: "remove committed JWTs; issue tokens at runtime and keep the signing secret in the environment",
  },

  /* ---------------------- Authentication ----------------------- */
  {
    category: "authentication",
    severity: "high",
    re: /\b(?:password|passwd|pwd)\b[^;\n]{0,80}?(?:===|!==|==|!=)[^;\n]{0,80}/g,
    describe: () =>
      "password value compared directly with ==/=== — no key-derivation function in sight; cleartext compares are trivially leaked",
    fix: "compare only salted hashes: await bcrypt.compare(input, user.hash) — never plaintext ===",
    accept: (m, content) => {
      const s = m[0];
      if (/\b(?:bcrypt|compare|hash|argon2|scrypt)\b/.test(s)) return false;
      // Object-equality methods (dataclass __eq__ / getattr pulls) compare two
      // in-memory objects — a shape check, not a credential check.
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const lineEnd = content.indexOf("\n", m.index);
      const line = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (/\bgetattr\s*\(|__eq__\s*\(|\.equals\s*\(/.test(line)) return false;
      const reqRefs = (s.match(/req\./g) ?? []).length;
      // password === confirmPassword (both from the request) is a shape check, not a leak.
      return reqRefs < 2;
    },
  },
  {
    category: "authentication",
    severity: "medium",
    re: /\b(?:INSERT|insert|UPDATE|update|create|save|set)\s*\([^)]{0,120}\bpassword\b[^)]{0,60}\)/g,
    describe: () =>
      "password written straight into a store with no hash call nearby",
    fix: "store only salted hashes: await bcrypt.hash(password, 12), keep the hash, discard the plaintext",
  },
  {
    category: "authentication",
    severity: "high",
    re: /\b(?:token|otp|code|nonce|sessionId|session_id|verificationCode|resetCode|authCode|csrf|secret)\w*\s*[:=]\s*[^;\n]{0,40}?\bMath\.random\(\)/g,
    describe: () =>
      "Math.random() for a token/OTP/session id — predictable output, one guess away from account takeover",
    fix: 'use crypto.randomBytes(32).toString("hex") — Math.random is not cryptographic',
  },
  {
    category: "authentication",
    severity: "medium",
    re: /\bjwt\.(?:sign|verify)\s*\([\s\S]{0,140}?["'][A-Za-z0-9!@#$%^&*\-_=+]{1,16}["']\s*\)/g,
    describe: () =>
      "JWT signed/verified with a short inline literal secret — brute-forceable, and it lives in source",
    fix: "jwt.sign(payload, process.env.JWT_SECRET) with a long random env secret — never an inline literal",
  },

  /* ---------------------- Authorization ------------------------ */
  {
    category: "authorization",
    severity: "medium",
    pathFilter: new RegExp(PROTECTED_PATH),
    guard:
      /\b(?:req\.(?:user|session|auth|headers\.authorization)|verifyToken|requireAuth|isAuthenticated|jwt\.verify|authMiddleware|passport\.authenticate|apiKey|middleware)/,
    re: /\b(?:app|router)\.(?:get|post|put|delete|patch|use)\s*\(\s*["']([^"']+)["'],\s*[\s\S]{0,700}/g,
    describe: (m) =>
      `route ${m[1]} handles data with no authn/authz check visible (no req.user/req.session/JWT verify) — who is allowed in?`,
    fix: 'every protected route needs a guard: router.get("/api/account", requireAuth, handler) — the guard must verify the token/session server-side, per request',
  },
  {
    category: "authorization",
    severity: "medium",
    pathFilter: /(?:admin|moderator|manager|staff|dashboard)/,
    guard: /\b(?:role|roles|permission|isAdmin|isStaff|requireRole|can\b|scopes?|acl|rbac)/,
    re: /\b(?:app|router)\.(?:get|post|put|delete|patch|use)\s*\(\s*["']([^"']+)["'],\s*[\s\S]{0,700}/g,
    describe: (m) =>
      `privileged route ${m[1]} never references role/permission/isAdmin — broken access control: any logged-in user can reach it`,
    fix: 'enforce roles server-side on every privileged route and every page: if (req.user.role !== "admin") return 403 — never rely on hiding UI',
  },

  /* ---------------------- Input validation --------------------- */
  {
    category: "input-validation",
    severity: "medium",
    re: /\bmulter\s*\(\s*\)|\.single\s*\(\s*["'][^"']+["']\s*\)|\.array\s*\(|\.fields\s*\(|express\.fileupload\s*\(\s*\)/g,
    describe: () =>
      "file upload with no size limit and no type filter — attacker uploads a 10 GB exe or an executable .js served by the static host",
    fix: 'const upload = multer({ storage, limits: { fileSize: 1 * 1024 * 1024 }, fileFilter: (_, f, cb) => cb(null, ALLOWED_TYPES.has(f.mimetype)) })',
    accept: (_m, content) => !/(?:limits\s*:\s*\{[^}]{0,120}fileSize|fileFilter)/.test(content),
  },
  {
    category: "input-validation",
    severity: "medium",
    re: /\b(?:req\.(?:body|query|params)|payload)\.(?:amount|price|total|quantity|fee|qty|subtotal|priceCents)\b/g,
    describe: () =>
      "money field read straight off the request without a Number/NaN/finite/range check — strings and negatives reach arithmetic and the ledger",
    fix: 'validate money as integers of the smallest unit: const v = Number(req.body.amount); if (!Number.isSafeInteger(v) || v <= 0) return 400',
    accept: (m, content) => {
      // Already wrapped in a sanitizer (Number/parseInt/parseFloat)? The fix
      // is applied — don't re-flag the same field.
      const before = content.slice(Math.max(0, m.index - 40), m.index);
      if (/\b(?:Number|parseFloat|parseInt)\s*\($/.test(before)) return false;
      const lineStart = content.lastIndexOf("\n", m.index);
      const after = content.slice(m.index, content.indexOf("\n", m.index) === -1 ? content.length : content.indexOf("\n", m.index));
      if (/\b(?:isSafeInteger|isFinite|isNaN)\b/.test(after) || /(?:\|\||&&)\s*[^;]{0,40}\b(?:return|throw)/.test(after)) return false;
      return true;
    },
  },

  /* ---------------------- Code injection ----------------------- */
  {
    category: "input-validation",
    severity: "high",
    re: /\beval\s*\([^)]{0,120}\$\{|new\s+Function\s*\([^)]{0,100}(?:\$\{|["'`]\s*\+)/g,
    describe: () =>
      "eval or dynamic Function construction with interpolated content — arbitrary code execution if any part is user-controlled",
    fix: "never eval: JSON.parse for data, and precompiled functions for logic — eval(anything) is RCE by default",
  },
  {
    category: "input-validation",
    severity: "medium",
    re: /\beval\s*\(/g,
    describe: () =>
      "eval() call — review that its argument can never be user-controlled; even then it is a code smell",
    fix: "replace eval with JSON.parse / precompiled functions; if you truly must eval, allowlist the exact inputs",
  },

  /* -------------------- Prototype pollution -------------------- */
  {
    category: "prototype-pollution",
    severity: "medium",
    re: /\bObject\.assign\s*\(\s*[^)]{0,80}(?:req\.body|req\.query|req\.params|userInput|payload)[^)]{0,40}\)|\.\.\.\s*(?:req\.body|req\.query|req\.params|userInput|payload)[^)\n]{0,40}/g,
    describe: () =>
      "user input merged into objects — a crafted __proto__ key rewrites Object.prototype and breaks auth checks app-wide",
    fix: 'never merge/spread raw request bodies: pick only whitelisted keys, or JSON.parse(body, (k, v) => (k === "__proto__" ? undefined : v))',
  },

  /* ----------------------- Config & transport ------------------ */
  {
    category: "cors",
    severity: "high",
    re: /[\s\S]{0,160}?\borigin\s*:\s*["']\*["'][\s\S]{0,160}?\bcredentials\s*:\s*true[\s\S]{0,160}?\)|Access-Control-Allow-Origin\s*:\s*\*[\s\S]{0,120}?Access-Control-Allow-Credentials\s*:\s*true/g,
    describe: () =>
      "Access-Control-Allow-Origin: * combined with credentials — any website can make authenticated requests from a victim's browser",
    fix: 'allowlist the exact frontend origin(s): cors({ origin: ["https://app.example.com"], credentials: true }) — never * with cookies',
  },
  {
    category: "transport",
    severity: "medium",
    re: /\b(?:fetch|axios\.(?:get|post|put|patch)|got|request|http\.(?:get|post|request))\s*\(\s*["']http:\/\//g,
    describe: () =>
      "outbound call uses cleartext http:// — credentials and data travel unencrypted, MITM-able",
    fix: "use https:// for every outbound call — http only for localhost dev sandboxes",
  },
  {
    category: "transport",
    severity: "medium",
    re: /\bres\.cookie\s*\([^)]{0,160}?\bsecure\s*:\s*false/g,
    describe: () =>
      "session cookie sent without the secure flag — leaked in cleartext on any http page",
    fix: 'res.cookie("session", token, { httpOnly: true, secure: true, sameSite: "lax" })',
  },
  {
    category: "transport",
    severity: "low",
    re: /\bws:\/\//g,
    describe: () => "plain ws:// websocket — unencrypted traffic",
    fix: "use wss:// (TLS) for websockets in production",
  },
  {
    category: "transport",
    severity: "low",
    re: /\bres\.redirect\s*\(\s*["']http:\/\//g,
    describe: () => "redirect target is hardcoded to cleartext http",
    fix: "redirect to https:// URLs",
  },
  {
    category: "logging",
    severity: "medium",
    re: /\bconsole\.(?:log|info|debug|warn)\s*\([\s\S]{0,120}?(?:password|passwd|pwd|api[_-]?key|secret|token|authorization)[\s\S]{0,40}?\)/g,
    describe: () =>
      "credentials reach the console/log pipeline — they end up in CI logs and support tickets",
    fix: 'never log credentials: log identifiers only, or pass values through a redact({ password: "***" }) helper',
  },
  {
    category: "logging",
    severity: "medium",
    re: /\b(?:res|response)\.(?:send|json|write|end)\s*\(\s*[\s\S]{0,80}?\berr\b[\s\S]{0,60}?\bstack\b|\bstack\b[\s\S]{0,40}?\b(?:send|json)\s*\(/g,
    describe: () =>
      "error.stack is shipped to the client — file paths, library versions and internals leak to attackers",
    fix: 'log the stack server-side; respond with { error: "internal", id } and keep a correlation id',
  },

  /* ---------------------- Rate limiting ----------------------- */
  {
    category: "rate-limiting",
    severity: "medium",
    re: /\b(?:rateLimit|rate-limit|limiter)\w*\s*\(\s*\{[^}]{0,300}?\bmax\s*:\s*(\d{3,})\b/g,
    describe: (m) =>
      `rate limiter allows ${m[1]} requests per window — that's a decoration, not a defense: brute-force and abuse still fit through`,
    fix: "tighten to 5–10 per window per IP+account on auth and state-changing routes (express-rate-limit: windowMs: 60_000, max: 5)",
  },
  {
    category: "rate-limiting",
    severity: "low",
    re: /\bwindowMs\s*:\s*0\b|\bmax\s*:\s*0\b/g,
    describe: () =>
      "rate limiter configured with a zero window or zero max — effectively disabled middleware",
    fix: "give the limiter a real window and max (5–10 per minute), or delete it until you can",
  },

  /* --------------------- Database lockdown -------------------- */
  {
    category: "database",
    severity: "high",
    re: /\b(?:DATABASE_URL|DB_URL|CONNECTION_STRING|connectionString|connection_?string|dsn|db_?uri|mongo(?:db)?_?uri|jdbc_?url|MYSQL_URL|PG_URL)\s*[:=]\s*["'][a-z0-9+]+:\/\/\s*(postgres|root|sa|admin|superuser):([^@\s/]{0,40})@/gi,
    describe: (m) =>
      `connection string uses the privileged account ${m[1]} with a committed password — every database in the fleet shares one superuser credential`,
    fix: 'create a scoped role with only the privileges the app needs (SELECT/INSERT/UPDATE/DELETE, no DDL), a strong generated password in .env, and connect as it: postgres://app_user:${process.env.DB_PASSWORD}@db.internal:5432/app',
    accept: (m) => Boolean(m[2]),
  },
  {
    category: "database",
    severity: "high",
    re: /\bGRANT\s+ALL\s+PRIVILEGES\b|(?:ALTER|CREATE)\s+(?:USER|ROLE)\b[^;\n]{0,80}\b(?:SUPERUSER|SYSADMIN|DBA)\b/gi,
    describe: () =>
      "database grants hand out ALL PRIVILEGES / SUPERUSER — any compromise of this app is now a compromise of every database",
    fix: "grant only what the app needs: GRANT SELECT, INSERT, UPDATE, DELETE ON <tables> TO app_user; run migrations with a separate CI-only credential",
  },
  {
    category: "database",
    severity: "medium",
    re: /\bsslmode\s*[:=]\s*["']?(?:disable|allow)["']?|\bssl\s*:\s*false\b|\buseSSL\s*:\s*false\b|\bencrypt\s*:\s*false\b|\btls\s*:\s*false\b/gi,
    describe: () =>
      "database connection without enforced TLS — queries, rows and credentials travel cleartext",
    fix: 'require TLS on every connection: sslmode=require (or ssl: { rejectUnauthorized: true }); disable only for a localhost dev sandbox',
    accept: (_m, content) => {
      const before = content.slice(Math.max(0, _m.index - 300), _m.index);
      return !/(?:localhost|127\.0\.0\.1|192\.168\.)/.test(before);
    },
  },
  {
    category: "database",
    severity: "high",
    re: /\b(?:db[_-]?password|database[_-]?password|pg[_-]?password|mysql[_-]?password|mongo(?:db)?[_-]?password|redis[_-]?password|jdbc[^;"]{0,30}password)\s*[:=]\s*["']([^"']{3,})["']/gi,
    describe: (m) =>
      `database password hardcoded in config (${m[1].length} chars) — every clone of the repo holds the key to the database`,
    fix: "rotate it now, then read from the environment: password: process.env.DB_PASSWORD with DB_PASSWORD in .env (gitignored) and the CI secret store",
  },

  /* ---------------------- Data exposure ----------------------- */
  {
    category: "data-exposure",
    severity: "high",
    re: /\b(?:res|response)\.(?:json|send)\s*\(\s*\{[^{}]{0,200}\b(?:password|passwd|hash|apiKey|api_key|client_secret|secret|cardNumber|card_number|ssn|cvv|iban)\b[^{}]{0,40}\}/g,
    describe: () =>
      "credentials or PII in the API response body — the client never needed them, and now every log, XSS and third-party script can read them",
    fix: 'return only what the UI needs: res.json({ id: user.id, name: user.name }) — never password/hash/apiKey; or a toJSON() that strips secrets',
  },
  {
    category: "data-exposure",
    severity: "medium",
    re: /\b(?:res|response)\.(?:json|send)\s*\(\s*(user|users|account|accounts|profile|customer|order|orders)\b[\s\S]{0,120}/g,
    describe: (m) =>
      `full ${m[1]} object(s) returned to the client — if that's a DB row, password/hash/internal fields ride along`,
    fix: "strip before sending: const { password, hash, ...safe } = user; res.json(safe) — or map explicit fields",
    accept: (m) => !/\b(?:toJSON|pick|omit|select|strip|safeUser|sanitize)\b/.test(m[0]),
  },
  {
    category: "data-exposure",
    severity: "medium",
    re: /\bconsole\.(?:log|info|debug|warn)\s*\([\s\S]{0,120}?(?:cardNumber|card_number|ssn|nationalId|bankAccount|iban|cvv|creditCard|passportNumber|dateOfBirth)\b[\s\S]{0,40}?\)/g,
    describe: () =>
      "PII (card/SSN/IBAN…) reaches the log pipeline — a data breach becomes searchable in log storage",
    fix: "log a masked token, never the value: console.log({ cardLast4: card.slice(-4) })",
    accept: (m) =>
      !/\b(?:last4|last_?4|mask|redact|slice\(\s*-4\s*\)|\*{3})/i.test(m[0]),
  },
  {
    category: "data-exposure",
    severity: "medium",
    re: /\bSELECT\s+\*\s+FROM\b/gi,
    describe: () =>
      "SELECT * — every column (password, hash, internal flags) ships to every caller; one careless response leaks the whole row",
    fix: "name the columns you need: SELECT id, email, name FROM users — narrower columns, narrower blast radius",
  },

  /* ------------------ Hidden vulnerabilities ------------------ */
  {
    category: "hidden-vulnerabilities",
    severity: "high",
    re: /\brejectUnauthorized\s*:\s*false\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0["']?\b|\bcurl\s+[^;\n]{0,60}-[kK]\b|\bwget\s+[^;\n]{0,60}--no-check-certificate\b/g,
    describe: () =>
      "TLS verification silently disabled — every 'secure' connection is MITM-able and nothing will ever complain",
    fix: "remove the override: rejectUnauthorized: true (default), drop NODE_TLS_REJECT_UNAUTHORIZED, never curl -k in scripts — pin the CA if it's a private cert",
    accept: (_m, content) => {
      const before = content.slice(Math.max(0, _m.index - 300), _m.index);
      return !/(?:localhost|127\.0\.0\.1|192\.168\.)/.test(before);
    },
  },
  {
    category: "hidden-vulnerabilities",
    severity: "high",
    re: /\b(?:algorithms?|alg)\s*[:=]\s*\[?\s*["']none["']\s*\]?/gi,
    describe: () =>
      "JWT accepts alg:none — a forged unsigned token validates as a real session",
    fix: "verify with an explicit allowlist: jwt.verify(token, secret, { algorithms: ['HS256'] }) — 'none' is never an option",
  },
  {
    category: "hidden-vulnerabilities",
    severity: "medium",
    re: /\beval\s*\(\s*(?:atob|Buffer\.from|btoa|decodeURIComponent|unescape)/g,
    describe: () =>
      "encoded payload decoded straight into eval — obfuscation exists to hide the logic from review",
    fix: "delete the decoder-eval chain and replace the payload with the actual logic, plainly; if it's an external artifact, pin and hash it",
  },
  {
    category: "hidden-vulnerabilities",
    severity: "medium",
    re: /\/\/\s*(?:TODO|FIXME|HACK|XXX|BUG)\b[^\n]{0,120}?(?:secur|auth|password|token|bypass|insecure|vuln|backdoor|ssl|encrypt|key|secret|csrf)/gi,
    describe: () =>
      "a comment acknowledges an unfinished security gap (TODO/FIXME/HACK) — 'we'll fix it later' is how breaches ship",
    fix: "resolve it now or track it as a blocking ticket with an owner; security TODOs never make a release",
  },
  {
    category: "hidden-vulnerabilities",
    severity: "medium",
    re: /\b(?:eslint-disable(?:-next-line|-line)?|@ts-ignore|@ts-nocheck|@ts-expect-error)\b[^\n]{0,80}?(?:password|token|secret|auth|sql|eval|innerHTML|key|cookie)\b/gi,
    describe: () =>
      "lint/type checks bypassed on security-sensitive code — the guardrail was switched off right where it mattered",
    fix: "fix the underlying issue instead of suppressing it; a suppression comment hides the danger, it doesn't remove it",
  },
  {
    category: "hidden-vulnerabilities",
    severity: "medium",
    re: /\blocalStorage\.(?:setItem|getItem)\s*\(\s*["'][^"']{0,40}(?:token|jwt|auth|session|refresh|access)[^"']{0,20}["']/gi,
    describe: () =>
      "session/access token kept in localStorage — readable by any XSS, exfiltrated by the next compromised script tag",
    fix: "httpOnly + secure + SameSite cookie for the session; never localStorage for credentials",
  },

  /* --------------------- Cryptographic weakness ----------------- */
  {
    category: "crypto-weakness",
    severity: "high",
    re: /\bcrypto\.createHash\s*\(\s*["'](?:md5|sha1)["']\s*\)|\bhashlib\.(?:md5|sha1)\s*\(/g,
    describe: () =>
      "weak hash (md5/sha1) used for integrity or password-adjacent data — collisions are trivial and brute-force is instant",
    fix: "use SHA-256+ for integrity; for passwords use bcrypt/argon2/scrypt. Never md5/sha1 for anything security-relevant",
  },
  {
    category: "crypto-weakness",
    severity: "high",
    re: /\bcrypto\.create(?:Cipher|Decipher)\s*\(/g,
    describe: () =>
      "crypto.createCipher/createDecipher — deprecated: derives the key from the password with no IV and a weak KDF",
    fix: "use crypto.createCipheriv/createDecipheriv with an explicit random IV and a strong key (scrypt/argon2-derived)",
  },
  {
    category: "crypto-weakness",
    severity: "medium",
    re: /\baes-?256-?ecb\b|\baes-?128-?ecb\b|\bAES\.MODE_ECB\b|\baes_ecb\b/gi,
    describe: () =>
      "ECB cipher mode — identical plaintext blocks produce identical ciphertext, leaking structure (images, PDFs, tokens)",
    fix: "use an authenticated mode: AES-256-GCM, or AES-256-CBC with a random IV + HMAC",
  },
  {
    category: "crypto-weakness",
    severity: "medium",
    re: /\b(?:iv|salt|nonce|seed)\s*[:=][^;\n]{0,40}\bMath\.random\s*\(\)|\bpseudoRandomBytes\s*\(/g,
    describe: () =>
      "IV/salt/nonce (or crypto.pseudoRandomBytes) seeded from Math.random — predictable, breaking the crypto guarantee",
    fix: 'derive IV/salt/nonce from crypto.randomBytes / WebCrypto getRandomValues — never Math.random or pseudoRandomBytes',
  },

  /* ------------------- Insecure deserialization ---------------- */
  {
    category: "insecure-deserialization",
    severity: "high",
    re: /\bpickle\.loads?\s*\(|\bcPickle\.load|\byaml\.load\s*\(/g,
    describe: () =>
      "pickle/cPickle/yaml.load on untrusted data — deserializing attacker-controlled bytes executes arbitrary code",
    fix: "use json.loads for data; for YAML use yaml.safe_load (never yaml.load without an explicit SafeLoader)",
  },
  {
    category: "insecure-deserialization",
    severity: "high",
    re: /\bunserialize\s*\(|require\s*\(\s*["']node-serialize["']\s*\)/g,
    describe: () =>
      "PHP-style unserialize() or node-serialize — reconstructing objects from untrusted input is RCE",
    fix: "parse with JSON.parse and validate against a schema; never unserialize untrusted payloads",
  },

  /* ----------------------- Open redirect ----------------------- */
  {
    category: "open-redirect",
    severity: "medium",
    re: /\bres\.redirect\s*\([^;]{0,120}(?:req\.(?:query|body|params)\.[A-Za-z0-9_]+)/g,
    describe: () =>
      "redirect target taken from user input — open redirect to phishing, and a step toward SSRF/SSO token theft",
    fix: "allowlist redirect destinations (constant allowlist or same-origin check) before calling res.redirect",
  },
  {
    category: "open-redirect",
    severity: "medium",
    re: /\bredirect\s*\([^;]{0,120}request\.(?:args|form|values)\.get/g,
    describe: () =>
      "Flask redirect() fed by request data — open redirect to external/phishing destinations",
    fix: "validate the target against an allowlist or same-origin host before redirect()",
  },

  /* ---------------------- Mass assignment ---------------------- */
  {
    category: "mass-assignment",
    severity: "high",
    re: /\b(?:findByIdAndUpdate|findOneAndUpdate|updateOne|updateMany|update|replaceOne|findOneAndReplace)\s*\([^)]{0,80}?req\.(?:body|query)/g,
    describe: () =>
      "ORM/Mongo update called with the raw request body — attackers set arbitrary fields (role=admin, isVerified=true)",
    fix: "never pass req.body to an update: build a whitelisted DTO (const dto = { name, email }; Model.update(id, dto))",
  },

  /* ------------------- NoSQL / template injection ------------- */
  {
    category: "nosql-injection",
    severity: "high",
    re: /\.(?:find|findOne|findOneAndRemove|findOneAndUpdate|findOneAndReplace|aggregate)\s*\(\s*(?:req\.(?:body|query|params)|userInput|payload)\b/g,
    describe: () =>
      "entire request object passed into a Mongo query — operator injection ($gt, $regex, $ne) bypasses filters and auth",
    fix: "pass only validated scalars: Model.find({ _id: req.body._id }) — never the whole req.body/req.query",
  },
  {
    category: "ssti",
    severity: "high",
    re: /\brender_template_string\s*\([^)]{0,120}request|\bjinja2?\.Template\s*\([^)]{0,120}request|\bTemplate\s*\([^)]{0,120}(?:request|req\.)/g,
    describe: () =>
      "template rendered from user-controlled string (render_template_string/Template with request data) — SSTI = RCE",
    fix: "render fixed template files with data passed as variables; never build template source from user input",
  },

  /* -------------------- XML external entity -------------------- */
  {
    category: "xxe",
    severity: "high",
    re: /\bresolve_entities\s*=\s*True\b|\bXMLParser\s*\([^)]*resolve_entities\s*=\s*True/g,
    describe: () =>
      "XML parser resolves external entities (XXE) — reads local files or reaches internal network from parsed XML",
    fix: "disable external entity resolution: lxml etree.XMLParser(resolve_entities=False); or use defusedxml",
  },

  /* ----------------------- CORS reflection --------------------- */
  {
    category: "cors",
    severity: "medium",
    re: /\borigin\s*:\s*req\.headers\.origin|\borigin\s*:\s*function\s*\([^)]*\)\s*\{[^}]{0,160}?req\.headers\.origin/g,
    describe: () =>
      "CORS origin reflected from the request — any site can make credentialed cross-origin requests on behalf of victims",
    fix: "allowlist exact trusted origins: cors({ origin: ['https://app.example.com'] }) — never echo req.headers.origin",
  },

  /* ----------------------- Debug mode -------------------------- */
  {
    category: "debug-mode",
    severity: "medium",
    re: /\bDEBUG\s*=\s*True\b|\bapp\.debug\s*=\s*True|\.run\s*\([^)]{0,80}debug\s*=\s*True/g,
    describe: () =>
      "debug mode enabled (DEBUG=True / app.debug=True / debug=True) — exposes the interactive debugger, stack traces and env",
    fix: "DEBUG=False in production; serve via a real WSGI/ASGI server and gate debug behind an env flag off in prod",
  },

  /* --------------------- CSRF disabled ------------------------- */
  {
    category: "csrf",
    severity: "medium",
    re: /\bcsrf_exempt\b/g,
    describe: () =>
      "CSRF protection explicitly disabled (@csrf_exempt) on a view — reachable cross-site from a victim's browser",
    fix: "remove @csrf_exempt and use the framework CSRF token; if an API truly needs it, require an auth header + same-site cookie",
  },

  /* ------------------- Extended secret formats ----------------- */
  {
    category: "secret",
    severity: "high",
    re: /\bya29\.[A-Za-z0-9_-]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    describe: () =>
      "Google OAuth (ya29) or GitLab PAT (glpat-) token committed in source — a live credential leak",
    fix: "revoke the token now, then read it from the environment (process.env / os.environ), never from source",
  },
];

/**
 * Repo-level findings that only make sense over the whole tree (e.g. "no
 * rate limiter anywhere"). Cheap to compute, always honest about being
 * indicated.
 */
export function analyzeSecurityRepoLevel(repo: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const text: string[] = [];
  for (const f of walkTextFiles(repo)) {
    const content = readText(f);
    if (content) text.push(content);
  }
  const all = text.join("\n");

  const hasAuthFlow =
    /\b(?:login|signup|register|signin|sign_in|createAccount|forgotPassword|resetPassword|otp)\b/i.test(all);
  const hasPasswordFlow = /\b(?:password|passwd|pwd)\b/i.test(all);

  if (
    hasAuthFlow &&
    hasPasswordFlow &&
    !/\b(?:bcrypt|argon2|scrypt|pbkdf2|hashSync|\.hash\s*\()/i.test(all)
  ) {
    issues.push({
      type: "code",
      category: "authentication",
      severity: "medium",
      description:
        "[indicated] auth + password flow present, but no bcrypt/argon2/scrypt/pbkdf2 anywhere — passwords are handled without a key-derivation function",
      fix: "hash on write, compare on read: bcrypt.hash(password, 12) / bcrypt.compare(input, stored)",
    });
  }

  if (
    hasAuthFlow &&
    !/\b(?:rateLimit|rate-limit|express-rate-limit|limiter|throttle)\b/i.test(all)
  ) {
    issues.push({
      type: "code",
      category: "authentication",
      severity: "low",
      description:
        "[indicated] auth endpoints present but no rate limiter appears anywhere — credential stuffing and OTP brute-force are wide open",
      fix: "express-rate-limit on every auth endpoint: 5 req/min per IP+user on /login, /otp, /reset",
    });
  }

  const hasCookieSession =
    /express-session|express\.session|cookie[_-]?session|cookieSession/i.test(all);
  const hasStateChanging = /\b(?:app|router)\.(?:post|put|delete|patch)\s*\(/g.test(all);
  if (hasCookieSession && hasStateChanging && !/\b(?:csrf|xsrf|csrfToken|csrf-sync|csurf)\b/i.test(all)) {
    issues.push({
      type: "code",
      category: "csrf",
      severity: "medium",
      description:
        "[indicated] cookie-based sessions with state-changing routes and no CSRF token anywhere — a victim's browser can be tricked into POSTing",
      fix: "add a CSRF token to every state-changing request: csrf-sync middleware, token in a form header, verify on POST/PUT/DELETE",
    });
  }

  if (
    /\bexpress\s*\(\s*\)|\bfastify\s*\(\s*\)/g.test(all) &&
    !/\bhelmet\b/i.test(all)
  ) {
    issues.push({
      type: "code",
      category: "headers",
      severity: "low",
      description:
        "[indicated] web framework present but helmet (CSP, HSTS, X-Content-Type-Options, frameguard) is never applied",
      fix: "app.use(helmet()) — one line for CSP, HSTS, X-Frame-Options, X-Content-Type-Options and more",
    });
  }

  if (hasStateChanging && !/\b(?:rateLimit|rate-limit|express-rate-limit|limiter|throttle)\b/i.test(all)) {
    issues.push({
      type: "code",
      category: "rate-limiting",
      severity: "medium",
      description:
        "[indicated] state-changing endpoints exist but no rate limiter appears anywhere — scripted abuse, brute-force and spam are wide open",
      fix: "express-rate-limit on auth and every state-changing route: 5–10 req/min per IP+account; tune the window for legit bursts",
    });
  }

  const hasSqlLayer =
    /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|SELECT\s+\w+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|\.findMany\s*\(|\.findAll\s*\(|queryRaw|\.query\s*\()/i.test(all);
  const hasRoutes = /\b(?:app|router)\.(?:get|post|put|delete|patch)\s*\(/g.test(all);
  if (
    hasSqlLayer &&
    hasRoutes &&
    !/\b(?:ROW\s+LEVEL\s+SECURITY|ENABLE\s+ROW|CREATE\s+POLICY|FORCE\s+ROW\s+LEVEL|security_invoker)\b/i.test(all)
  ) {
    issues.push({
      type: "code",
      category: "database",
      severity: "medium",
      description:
        "[indicated] backend with direct DB access but no row-level security — tenant isolation is one missing WHERE clause away from leaking everyone's data",
      fix: 'enable RLS on every table and add policies: ALTER TABLE orders ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation ON orders USING (tenant_id = current_setting("app.tenant_id")); set app.tenant_id once per request',
    });
  }

  return issues;
}

function walkTextFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(p);
      } else if (e.isFile()) {
        if (
          e.name === ".gitignore" ||
          e.name.startsWith(".env") ||
          CODE_EXTS.has(path.extname(e.name)) ||
          /(?:\.(?:bak|old|orig|swp)$|~$|^\.htpasswd$)/.test(e.name)
        )
          out.push(p);
      }
    }
  }
  return out.sort();
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_BYTES_PER_FILE) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function fileGitignoresEnv(root: string): boolean {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(path.join(dir, e.name));
      } else if (e.isFile() && e.name === ".gitignore") {
        const gi = readText(path.join(dir, e.name)) ?? "";
        if (/(?:^|\n)\s*\.env(?:\$|(?:\.|\s|$))/m.test(gi)) return true;
      }
    }
  }
  return false;
}

/**
 * Scan a repo for the static vulnerability classes. Deterministic: files are
 * walked in sorted order, findings are ordered by (severity, file, line),
 * deduped by (category, file, line), capped. All findings are labeled
 * `[indicated]` — static analysis points, it does not prove.
 */
export function analyzeSecurityStatic(repo: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  const seen = new Set<string>();

  const push = (
    file: string,
    content: string,
    m: RegExpExecArray,
    rule: StaticRule,
  ) => {
    // De-noise: never flag documentation or rule metadata. Lines that are
    // comments, quote a fix ("fix: …"), describe a rule ("describe: …"), or
    // contain regex-alternation syntax ("(?:") are how scanners and docs talk
    // ABOUT these bugs — not app code containing them.
    const lineStart = content.lastIndexOf("\n", m.index) + 1;
    const lineEnd = content.indexOf("\n", m.index);
    const lineText = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
    // Comment lines are skipped EXCEPT for the hidden-vulnerabilities rules —
    // a "TODO: fix insecure auth" comment IS the finding there.
    if (
      /^(?:\/\/|\/\*|\*|#|<!--|"""|''')/.test(lineText) &&
      rule.category !== "hidden-vulnerabilities"
    )
      return;
    if (/\b(?:fix:|describe:|title:|re:)/.test(lineText) || /\(\?:/.test(lineText)) return;
    // Multi-line metadata strings: the marker sits on the previous line
    // ("describe: () =>" then the quoted text on the next line).
    const prevStart = content.lastIndexOf("\n", lineStart - 2) + 1;
    const prevLine = content.slice(prevStart, lineStart - 1).trim();
    if (/\b(?:describe|fix|title|re)\s*:/.test(prevLine)) return;
    // Same-line adjacency false positive: `something.exec(fn) + \`…${…}\`` —
    // a closing paren BEFORE the interpolated/concatenated part means the
    // danger isn't the SQL/shell call on this line.
    if (/\)[\s\S]{0,200}?(?:\$\{|["'`]\s*\+)/.test(m[0])) return;

    const rel = path.relative(repo, file);
    const line = lineOf(content, m.index);
    const key = `${rule.category}|${rel}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({
      type: "code",
      category: rule.category,
      severity: rule.severity,
      file: rel,
      line,
      description: `[indicated] ${rule.describe(m)}`,
      fix: rule.fix,
    });
  };

  const pushNamed = (
    file: string,
    category: string,
    severity: string,
    description: string,
    fix: string,
  ) => {
    const rel = path.relative(repo, file);
    const key = `${category}|${rel}|1`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push({ type: "code", category, severity, file: rel, line: 1, description, fix });
  };

  for (const file of walkTextFiles(repo)) {
    const content = readText(file);
    if (!content) continue;
    // .env files are where secrets belong — the dedicated .env check below
    // (gitignore protection) is the rule that governs them, not the
    // hardcoded-secret patterns.
    if (path.basename(file).startsWith(".env")) continue;

    const name = path.basename(file);
    if (/\.min\.js$/.test(name)) {
      pushNamed(
        file,
        "hidden-vulnerabilities",
        "low",
        "[indicated] minified bundle committed — logic hidden from review; it can silently carry secrets or backdoor payloads",
        "commit the source and build the bundle at release time; if a bundle must ship, keep its sourcemap and sign it",
      );
    }
    if (/(?:\.(?:bak|old|orig|swp)$|~$)/.test(name)) {
      pushNamed(
        file,
        "hidden-vulnerabilities",
        "medium",
        "[indicated] backup/editor file committed — old snapshots commonly contain earlier (secret-bearing) versions of the code",
        "delete it and add *.bak, *.old, *.orig, *.swp, *~ to .gitignore",
      );
    }
    if (name === ".htpasswd") {
      pushNamed(
        file,
        "hidden-vulnerabilities",
        "medium",
        "[indicated] .htpasswd credential file committed — a password store living in the repository",
        "rotate the passwords, move auth to the app layer or a secret manager, and delete the file",
      );
    }

    for (const rule of STATIC_SECURITY_RULES) {
      rule.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      let count = 0;
      while ((m = rule.re.exec(content)) !== null && count < 3) {
        if (rule.skipWhenInMatch && rule.skipWhenInMatch.test(m[0])) {
          count++;
          continue;
        }
        if (rule.accept && !rule.accept(m, content)) {
          count++;
          continue;
        }
        if (rule.pathFilter) {
          const pathMatch = /\(\s*["']([^"']+)["']/.exec(m[0]);
          if (!pathMatch || !rule.pathFilter.test(pathMatch[1])) {
            count++;
            continue;
          }
          if (rule.guard && rule.guard.test(m[0])) {
            count++;
            continue;
          }
        }
        push(file, content, m, rule);
        count++;
        if (m[0].length === 0) rule.re.lastIndex++;
      }
    }
  }

  // .env committed risk (only when a .env file actually exists).
  for (const file of walkTextFiles(repo)) {
    if (!/^\.env(\.[\w-]+)?$/.test(path.basename(file))) continue;
    if (!fileGitignoresEnv(repo)) {
      issues.push({
        type: "code",
        category: "secret",
        severity: "medium",
        file: path.relative(repo, file),
        line: 1,
        description:
          "[indicated] .env exists but nothing in .gitignore protects it — one careless commit publishes every secret",
        fix: 'add ".env" and ".env.*" (keep ".env.example") to .gitignore, then confirm with git status',
      });
    }
    break;
  }

  issues.push(...analyzeSecurityRepoLevel(repo));

  const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
  return issues
    .sort(
      (a, b) =>
        (order[a.severity] ?? 3) - (order[b.severity] ?? 3) ||
        (a.file ?? "").localeCompare(b.file ?? "") ||
        (a.line ?? 0) - (b.line ?? 0),
    )
    .slice(0, MAX_FINDINGS);
}
