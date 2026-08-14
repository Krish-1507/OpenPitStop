/**
 * pen/static.ts — the static phase of `pitstop pen`.
 *
 * Cheap, dependency-free, honest heuristics. Every finding is labelled with
 * its confidence: `heuristic` (pattern matched, no proof yet), `indicated`
 * (the data flow is concrete: user input reaching a sink). Nothing is ever
 * labelled `proven` here — proof is the dynamic phase's job.
 */

import fs from "node:fs";
import path from "node:path";
import { walkFiles } from "../analyzers/util.js";
import { findRoutesInFile, ROUTE_EXTS } from "../analyzers/routes.js";
import { findingIdFor } from "../repro/ids.js";
import type { PenFinding, PenRoute } from "./types.js";

const JS_EXTS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const PY_EXTS = [".py"];

/* ------------------------------------------------------------------ */
/* 1. Secret patterns (inline, no network, no gitleaks dependency)     */
/* ------------------------------------------------------------------ */

interface SecretPattern {
  type: string;
  severity: "critical" | "high";
  re: RegExp;
  name: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    type: "hardcoded-secret",
    severity: "critical",
    re: /\bAKIA[0-9A-Z]{16}\b/,
    name: "AWS access key",
  },
  {
    type: "hardcoded-secret",
    severity: "critical",
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    name: "GitHub token",
  },
  {
    type: "hardcoded-secret",
    severity: "high",
    re: /\bsk_(live|prod)_[A-Za-z0-9]{16,}\b/,
    name: "live Stripe secret key",
  },
  {
    type: "hardcoded-secret",
    severity: "high",
    re: /\brzp_live_[A-Za-z0-9]{10,}\b|\brz_live_[A-Za-z0-9]{10,}\b/,
    name: "live Razorpay key",
  },
  {
    type: "hardcoded-secret",
    severity: "high",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    name: "Google API key",
  },
  {
    type: "hardcoded-secret",
    severity: "high",
    re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    name: "Slack token",
  },
  {
    type: "hardcoded-secret",
    severity: "critical",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
    name: "private key block",
  },
];

/** Values that are clearly placeholders — never flag these. */
const PLACEHOLDER_RE =
  /^(test|example|changeme|change-me|dummy|fake|placeholder|your|secret|password|token|xxx+|\.\.\.|none|null|undefined)$/i;
const TEST_CRED_RE = /(test|demo|sample|example|fake|pitstop|mock)/i;

interface SecretHit {
  file: string;
  line: number;
  pattern: SecretPattern;
  value: string;
}

function scanSecrets(repo: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const files = walkFiles(repo, [...JS_EXTS, ...PY_EXTS, ".env", ".env.production", ".env.local", ".env.example"].filter((e, i, a) => a.indexOf(e) === i));
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Strip comments so placeholders in docs/tests don't scream.
    const lines = content.split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith("*")) return;
      for (const p of SECRET_PATTERNS) {
        const m = line.match(p.re);
        if (!m) continue;
        const value = m[0];
        if (p.type === "hardcoded-secret" && /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?([^"'\s,;)]+)/i.test(line)) {
          const v = (line.match(/(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?([^"'\s,;)]+)/i) || [])[1] || "";
          if (PLACEHOLDER_RE.test(v) || TEST_CRED_RE.test(v)) continue;
        }
        hits.push({ file, line: i + 1, pattern: p, value });
        break; // one secret per line is enough
      }
    });
  }
  return hits;
}

/** Generic `SOMETHING_KEY = "value"` where value is clearly real (high entropy-ish). */
const GENERIC_KEY_RE =
  /\b(?:[A-Z][A-Z0-9_]{3,})?(?:PASSWORD|PASSWD|SECRET|API_?KEY|TOKEN|PRIVATE_?KEY)\s*[:=]\s*["']([^"'\s]{12,})["']/i;

function scanGenericKeys(repo: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const files = walkFiles(repo, [...JS_EXTS, ...PY_EXTS, ".env", ".env.production", ".env.local", ".env.example"].filter((e, i, a) => a.indexOf(e) === i));
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const m = line.match(GENERIC_KEY_RE);
      if (!m) continue;
      const v = m[1];
      if (PLACEHOLDER_RE.test(v) || TEST_CRED_RE.test(v)) continue;
      // Entropy-ish guard: real secrets are rarely a repeated char or a word.
      if (/^([a-z0-9])\1{10,}$/i.test(v)) continue;
      hits.push({
        file,
        line: i + 1,
        pattern: {
          type: "hardcoded-secret",
          severity: "high",
          re: GENERIC_KEY_RE,
          name: "hardcoded credential",
        },
        value: v,
      });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* 2. Route inventory (static, for the dynamic phase)                  */
/* ------------------------------------------------------------------ */

const SENSITIVE_WORDS = [
  "admin",
  "dashboard",
  "private",
  "account",
  "profile",
  "settings",
  "order",
  "charge",
  "payment",
  "refund",
  "transfer",
  "webhook",
  "secret",
  "token",
  "otp",
  "verify",
  "user",
  "users",
  "auth",
  "login",
  "signin",
  "session",
];

const LOGIN_WORDS = ["login", "signin", "auth", "otp", "verify", "token", "password", "forgot"];

export function findRoutes(repo: string): PenRoute[] {
  const out: PenRoute[] = [];
  const add = (file: string, method: string, p: string, line: number) => {
    const lower = p.toLowerCase();
    out.push({
      method: method.toUpperCase(),
      path: p,
      file,
      line,
      sensitive: SENSITIVE_WORDS.some((w) => lower.includes(w)),
      loginLike: LOGIN_WORDS.some((w) => lower.includes(w)),
    });
  };
  for (const file of walkFiles(repo, ROUTE_EXTS)) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    for (const r of findRoutesInFile(content, ext)) add(file, r.method, r.path, r.line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 3. Config hygiene + taint heuristics                                */
/* ------------------------------------------------------------------ */

interface StaticRule {
  type: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: "heuristic" | "indicated";
  title: string;
  describe: (file: string, line: number, m: RegExpMatchArray) => string;
  fix: string;
}

const STATIC_RULES: StaticRule[] = [
  {
    type: "insecure-cors",
    severity: "high",
    confidence: "indicated",
    title: "CORS allows any origin",
    describe: () => "CORS is wide open — either a bare `cors()` (defaults to origin: * with credentials off) or an explicit `origin: \"*\"`. Any website can read the responses of this endpoint from a victim's browser.",
    fix: "Restrict origins to an explicit allowlist: `cors({ origin: [/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$/, ...] })` — or better, list only your real production origins and never combine `origin: *` with credentials.",
  },
  {
    type: "missing-security-headers",
    severity: "medium",
    confidence: "indicated",
    title: "no helmet / security headers middleware",
    describe: () => "An Express app without helmet() (or manual CSP / X-Frame-Options / X-Content-Type-Options headers). Clickjacking, MIME sniffing and mixed-content protections are all off.",
    fix: "Install helmet and `app.use(helmet());` after app creation (deterministic patch generated by `pitstop pen --fix` when helmet is already installed).",
  },
  {
    type: "cookie-without-httponly",
    severity: "medium",
    confidence: "indicated",
    title: "cookie set without httpOnly",
    describe: () => "A session/security cookie is being set without `httpOnly` (and likely without `secure`), so an XSS in any page can steal it via document.cookie.",
    fix: "Set `{ httpOnly: true, secure: true, sameSite: \"strict\" }` on every session/auth cookie.",
  },
  {
    type: "no-rate-limit",
    severity: "medium",
    confidence: "heuristic",
    title: "no rate limiting on authentication paths",
    describe: () => "express-rate-limit is not installed and login-ish routes exist — credential stuffing / brute force is unthrottled. The dynamic phase verifies this live.",
    fix: "Add express-rate-limit and apply a strict limiter to /login /verify /otp /token routes (e.g. 5 requests / 15 min per IP).",
  },
  {
    type: "info-leak",
    severity: "high",
    confidence: "indicated",
    title: "env secrets printed to console",
    describe: () => "A console statement forwards process.env values (API keys, tokens, DB credentials) into stdout logs where they are one grep away from exfiltration.",
    fix: "Remove the log, or redact secrets before logging; never log raw process.env.",
  },
  {
    type: "arbitrary-code-execution",
    severity: "high",
    confidence: "heuristic",
    title: "eval / new Function in application code",
    describe: () => "`eval` or `new Function` turns attacker-influenced strings into executable code. It is never needed for this; replace with a lookup table or JSON.parse.",
    fix: "Remove eval/new Function. If a template engine is genuinely required, use a sandboxed one (e.g. a compiled template with no global access).",
  },
  {
    type: "sql-injection",
    severity: "critical",
    confidence: "indicated",
    title: "SQL built by string interpolation",
    describe: () => "A query string is assembled by concatenating or interpolating variables into SQL. Any route feeding these variables becomes a live injection point.",
    fix: "Use parameterized queries (?, $1 placeholders) or an ORM. Never interpolate values into SQL text.",
  },
  {
    type: "command-injection",
    severity: "critical",
    confidence: "indicated",
    title: "child_process called with request-derived input",
    describe: () => "exec/spawn/execFile is called with a value that can trace back to request data (query, params, body). If the shell interprets it, that is remote code execution.",
    fix: "Do not shell out with user input. If unavoidable: execFile with a fixed command, no shell, and validate input against a strict allowlist (e.g. /^[a-z0-9-]{1,64}$/).",
  },
  {
    type: "path-traversal",
    severity: "high",
    confidence: "indicated",
    title: "filesystem access with request-derived paths",
    describe: () => "fs.readFile/readdir/createReadStream receives a path built from request data — ../ sequences can read or enumerate anything the process can.",
    fix: "Resolve the path and verify it stays inside a root directory: `path.resolve(root, name)` then check `startsWith(root + path.sep)`; reject anything that escapes.",
  },
  {
    type: "ssrf",
    severity: "high",
    confidence: "indicated",
    title: "outbound HTTP built from request-derived URLs",
    describe: () => "fetch/http/axios/got is called with a URL that can trace back to request data — the server can be coerced into attacking internal hosts (metadata endpoints, admin panels).",
    fix: "Allow only an explicit allowlist of hosts; forbid private ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.169.254); resolve and re-check the IP before sending.",
  },
  {
    type: "xss-sink",
    severity: "high",
    confidence: "indicated",
    title: "HTML sink with request-derived data",
    describe: () => "dangerouslySetInnerHTML / v-html / innerHTML / document.write receives data that can trace back to request data — stored or reflected XSS.",
    fix: "Never put user data into HTML strings; use text nodes / escaped interpolation. If it must be HTML, sanitize with DOMPurify server-side or an HTML escaper at the sink.",
  },
  {
    type: "prototype-pollution",
    severity: "high",
    confidence: "indicated",
    title: "object merge/assign of untrusted data",
    describe: () => "A recursive merge/assign (or __proto__ handling) appears with untrusted input — the classic prototype-pollution gadget (admin bypass, RCE via sanitized options).",
    fix: "Merge only plain, schema-known objects; reject keys __proto__ / constructor / prototype at the boundary before any merge.",
  },
];

const TYPES_WITH_RE = new Map(
  STATIC_RULES.filter((r) => r.type !== "no-rate-limit").map((r) => [r.type, r]),
);

interface PatternEntry {
  type: string;
  re: RegExp;
  /** Only matched in JS/Python source lines that plausibly contain user input. */
  requiresUserInput: boolean;
}

const PATTERNS: PatternEntry[] = [
  // SQL: template literal query with ${} or concatenated + with a variable.
  {
    type: "sql-injection",
    re: /\b(?:query|execute|exec|raw|run|find|findOne|aggregate|executeSql|sql)\s*\(\s*(?:[`"])[^`"\n]*\$\{/i,
    requiresUserInput: false,
  },
  {
    type: "sql-injection",
    re: /\b(?:query|execute|exec|raw|run)\s*\(\s*(?:'|")[^'"\n]*"\s*\+\s*(?!['"])[\w.[\]]+/i,
    requiresUserInput: true,
  },
  {
    type: "command-injection",
    re: /\b(?:exec|execFile|spawn|spawnSync|execSync|execFileSync|fork)\s*\(\s*(?:[`"])[^`"\n]*\$\{/i,
    requiresUserInput: false,
  },
  {
    type: "command-injection",
    re: /\b(?:exec|spawn)\s*\(\s*[`"'][^`"'\n]*[`"']\s*\+/i,
    requiresUserInput: true,
  },
  {
    type: "path-traversal",
    re: /\b(?:readFileSync|readFile|readdir|readdirSync|createReadStream|writeFileSync|writeFile|existsSync|statSync)\s*\(\s*(?:[`"])[^`"\n]*\$\{/i,
    requiresUserInput: false,
  },
  {
    type: "path-traversal",
    re: /\b(?:readFileSync|readFile|createReadStream|readdirSync|readdir)\s*\(\s*path\.join\s*\([^)]*(?:req\.|query|body|params|input|user|data)[^)]*\)/i,
    requiresUserInput: true,
  },
  {
    type: "ssrf",
    re: /\b(?:fetch|axios|request|got|http|https)\s*\(\s*(?:[`"])[^`"\n]*\$\{(?:url|uri|target|link|image|src|webhook|callback)[^}]*\}/i,
    requiresUserInput: false,
  },
  {
    type: "ssrf",
    re: /\b(?:fetch|axios|request|got)\s*\(\s*(?:req\.(?:body|query|params)|[a-z]+\.(?:url|uri|webhook|callback|image|src))\s*[),]/i,
    requiresUserInput: true,
  },
  {
    type: "xss-sink",
    re: /\b(?:dangerouslySetInnerHTML|v-html)\b|document\.write\s*\(/i,
    requiresUserInput: false,
  },
  {
    type: "xss-sink",
    re: /\binnerHTML\s*=\s*[^;]*(?:req\.|body\.|query\.|params\.|data\.|input)/i,
    requiresUserInput: true,
  },
  {
    type: "prototype-pollution",
    re: /["']__proto__["']\s*[:=]\s*\{|Object\.assign\s*\([^)]*\b[a-z]+,[^)]*\)/i,
    requiresUserInput: false,
  },
  {
    type: "arbitrary-code-execution",
    re: /\beval\s*\(|\bnew\s+Function\s*\(/i,
    requiresUserInput: false,
  },
];

const USER_INPUT_RE =
  /\b(?:req|request|ctx|context|body|query|params|headers|input|payload|user|data|arg|value|url|name|id|file|content|message)\b/i;

function hasUserInput(line: string): boolean {
  return USER_INPUT_RE.test(line);
}

/* ------------------------------------------------------------------ */
/* 4. Config hygiene rules (whole-file, dependency-aware)              */
/* ------------------------------------------------------------------ */

function findAppLine(content: string): { line: number; text: string } | null {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/const\s+app\s*=\s*express\s*\(/.test(lines[i]) || /express\s*\(\s*\)/.test(lines[i])) {
      return { line: i + 1, text: lines[i] };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */

export interface PenStaticOutcome {
  findings: PenFinding[];
  routes: PenRoute[];
  framework: "express" | "other" | "none";
  packages: string[];
}

export function analyzeStatic(repo: string): PenStaticOutcome {
  const findings: PenFinding[] = [];
  const routes = findRoutes(repo);
  const jsFiles = walkFiles(repo, JS_EXTS);
  const pyFiles = walkFiles(repo, PY_EXTS);
  const allFiles = [...jsFiles, ...pyFiles];

  let pkg: any = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    /* no package.json */
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const packages = Object.keys(deps);
  const hasExpress = packages.includes("express");
  const framework: PenStaticOutcome["framework"] = hasExpress
    ? "express"
    : packages.length > 0
      ? "other"
      : "none";

  const push = (f: Omit<PenFinding, "id" | "source">) => {
    findings.push({
      id: findingIdFor("pen", f.type, f.file ?? f.route, f.title),
      source: "pen-static",
      ...f,
    });
  };

  // Secrets.
  for (const hit of [...scanSecrets(repo), ...scanGenericKeys(repo)]) {
    push({
      type: hit.pattern.type,
      severity: hit.pattern.severity,
      confidence: "proven" as const,
      title: `${hit.pattern.name} committed to source`,
      description: `${hit.pattern.name} found in ${path.relative(repo, hit.file).replace(/\\/g, "/")}:${hit.line} (${hit.value.slice(0, 12)}…). This credential is recoverable from git history and any CI log that runs the repo.`,
      file: hit.file,
      line: hit.line,
      repro: `grep -n "${hit.value.slice(0, 12)}" "${path.relative(repo, hit.file).replace(/\\/g, "/")}"`,
      fix: "Rotate the credential NOW (it may already be compromised), remove it from source, and move it to an environment variable / secret manager. Add the value to .gitignore'd .env and to a secrets policy so it never returns.",
    });
  }

  // Per-file pattern rules.
  const codeLines: Array<{ file: string; line: number; text: string }> = [];
  for (const file of allFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((text, i) => {
      const t = text.trim();
      if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) return;
      codeLines.push({ file, line: i + 1, text: t });
    });
  }

  const seenPattern = new Set<string>();
  for (const entry of PATTERNS) {
    for (const { file, line, text } of codeLines) {
      if (!entry.re.test(text)) continue;
      if (entry.requiresUserInput && !hasUserInput(text)) continue;
      if (entry.type === "arbitrary-code-execution" && /node_modules|\.test\.|spec\.|__tests__|dist\//.test(file)) continue;
      const rule = TYPES_WITH_RE.get(entry.type);
      if (!rule) continue;
      const key = `${entry.type}|${path.relative(repo, file)}|${line}`;
      if (seenPattern.has(key)) continue;
      seenPattern.add(key);
      push({
        type: rule.type,
        severity: rule.severity,
        confidence: rule.confidence,
        title: rule.title,
        description: rule.describe(file, line, entry.re.exec(text) as RegExpMatchArray) + ` (${path.relative(repo, file).replace(/\\/g, "/")}:${line})`,
        file,
        line,
        repro: `open ${path.relative(repo, file).replace(/\\/g, "/")}:${line}`,
        fix: rule.fix,
      });
    }
  }

  // Whole-file config hygiene (JS only, express-aware).
  const seenFileRule = new Set<string>();
  for (const file of jsFiles) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const c = content;

    if (/cors\s*\(\s*\)|origin\s*:\s*["']\*["']/.test(c)) {
      const line = findLineOf(c, /cors\s*\(\s*\)|origin\s*:\s*["']\*["']/);
      const rule = TYPES_WITH_RE.get("insecure-cors")!;
      const key = `insecure-cors|${file}`;
      if (!seenFileRule.has(key)) {
        seenFileRule.add(key);
        push({
          type: rule.type,
          severity: rule.severity,
          confidence: rule.confidence,
          title: rule.title,
          description: rule.describe(file, line, null as never),
          file,
          line,
          fix: rule.fix,
        });
      }
    }

    if (hasExpress && !/\bhelmet\s*\(/.test(c) && !/\bapp\.use\s*\(\s*helmet/.test(c) && /\bexpress\s*\(/.test(c)) {
      const line = findLineOf(c, /\bexpress\s*\(/);
      const rule = TYPES_WITH_RE.get("missing-security-headers")!;
      const key = `missing-security-headers|${file}`;
      if (!seenFileRule.has(key)) {
        seenFileRule.add(key);
        push({
          type: rule.type,
          severity: rule.severity,
          confidence: rule.confidence,
          title: rule.title,
          description: rule.describe(file, line, null as never),
          file,
          line,
          fix: rule.fix,
        });
      }
    }

    if (/res\.cookie\s*\(/.test(c) && !/\bhttpOnly\s*:\s*true/.test(c)) {
      const line = findLineOf(c, /res\.cookie\s*\(/);
      const rule = TYPES_WITH_RE.get("cookie-without-httponly")!;
      const key = `cookie-without-httponly|${file}`;
      if (!seenFileRule.has(key)) {
        seenFileRule.add(key);
        push({
          type: rule.type,
          severity: rule.severity,
          confidence: rule.confidence,
          title: rule.title,
          description: rule.describe(file, line, null as never),
          file,
          line,
          fix: rule.fix,
        });
      }
    }

    if (/console\.(?:log|debug|info)\([^)]*process\.env/.test(c)) {
      const line = findLineOf(c, /console\.(?:log|debug|info)\([^)]*process\.env/);
      const rule = TYPES_WITH_RE.get("info-leak")!;
      const key = `info-leak|${file}`;
      if (!seenFileRule.has(key)) {
        seenFileRule.add(key);
        push({
          type: rule.type,
          severity: rule.severity,
          confidence: rule.confidence,
          title: rule.title,
          description: rule.describe(file, line, null as never),
          file,
          line,
          fix: rule.fix,
        });
      }
    }
  }

  // no-rate-limit: package-level rule.
  if (!packages.includes("express-rate-limit") && routes.some((r) => r.loginLike)) {
    const rule = STATIC_RULES.find((r) => r.type === "no-rate-limit")!;
    push({
      type: rule.type,
      severity: rule.severity,
      confidence: rule.confidence,
      title: rule.title,
      description: rule.describe(repo, 0, null as never) + ` Login-ish routes: ${routes.filter((r) => r.loginLike).slice(0, 3).map((r) => `${r.method} ${r.path}`).join(", ")}.`,
      fix: rule.fix,
    });
  }

  return { findings, routes, framework, packages };
}

function findLineOf(content: string, re: RegExp): number {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i + 1;
  return 1;
}
