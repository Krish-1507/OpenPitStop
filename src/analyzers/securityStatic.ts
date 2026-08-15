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
    accept: (m) => {
      const s = m[0];
      if (/\b(?:bcrypt|compare|hash|argon2|scrypt)\b/.test(s)) return false;
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
        if (e.name === ".gitignore" || e.name.startsWith(".env") || CODE_EXTS.has(path.extname(e.name))) out.push(p);
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
    if (/^(?:\/\/|\/\*|\*|#|<!--|"""|''')/.test(lineText)) return;
    if (/\b(?:fix:|describe:|title:|re:)/.test(lineText) || /\(\?:/.test(lineText)) return;
    // Multi-line metadata strings: the marker sits on the previous line
    // ("describe: () =>" then the quoted text on the next line).
    const prevStart = content.lastIndexOf("\n", lineStart - 2) + 1;
    const prevLine = content.slice(prevStart, lineStart - 1).trim();
    if (/\b(?:describe|fix)\s*:\s*\(?\s*\)?\s*=>/.test(prevLine)) return;
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

  for (const file of walkTextFiles(repo)) {
    const content = readText(file);
    if (!content) continue;
    // .env files are where secrets belong — the dedicated .env check below
    // (gitignore protection) is the rule that governs them, not the
    // hardcoded-secret patterns.
    if (path.basename(file).startsWith(".env")) continue;

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
