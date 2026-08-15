import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSecurityStatic, STATIC_SECURITY_RULES } from "../src/analyzers/securityStatic.js";
import { analyzeSecurity } from "../src/analyzers/security.js";
import type { ScanIssue } from "../src/analyzers/types.js";

function tmpRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-sec-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return dir;
}

function cats(issues: ScanIssue[]): string[] {
  return issues.map((i) => i.category).filter((c): c is string => Boolean(c));
}

interface Case {
  name: string;
  category: string;
  /** Vulnerable fixture → must produce at least one finding of `category`. */
  vulnerable: Record<string, string>;
  /** Same app after the fix → must produce ZERO findings of `category`. */
  fixed: Record<string, string>;
}

const CASES: Case[] = [
  {
    name: "sql-injection: string concatenation into db.query",
    category: "sql-injection",
    vulnerable: {
      "index.js": `
const db = require("pg");
app.get("/users/:id", (req, res) => {
  db.query("SELECT * FROM users WHERE id = " + req.params.id, (err, rows) => {
    res.json(rows);
  });
});
`,
    },
    fixed: {
      "index.js": `
const db = require("pg");
app.get("/users/:id", (req, res) => {
  db.query("SELECT * FROM users WHERE id = $1", [req.params.id], (err, rows) => {
    res.json(rows);
  });
});
`,
    },
  },
  {
    name: "sql-injection: template literal into ORM raw",
    category: "sql-injection",
    vulnerable: {
      "model.js": `
const users = db.collection("users");
users.find({ $where: "this.role === '" + req.query.role + "'" });
`,
    },
    fixed: {
      "model.js": `
const users = db.collection("users");
users.find({ role: req.query.role });
`,
    },
  },
  {
    name: "sql-injection: python f-string execute",
    category: "sql-injection",
    vulnerable: {
      "app.py": `
cursor = conn.cursor()
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
`,
    },
    fixed: {
      "app.py": `
cursor = conn.cursor()
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
`,
    },
  },
  {
    name: "command-injection: exec with interpolation",
    category: "command-injection",
    vulnerable: {
      "git.js": `
const { exec } = require("child_process");
exec("git log " + req.query.commit, (err, out) => console.log(out));
`,
    },
    fixed: {
      "git.js": `
const { execFile } = require("child_process");
execFile("git", ["log", req.query.commit], (err, out) => console.log(out));
`,
    },
  },
  {
    name: "path-traversal: user file read",
    category: "path-traversal",
    vulnerable: {
      "files.js": `
fs.readFileSync(path.join("uploads", req.params.file));
`,
    },
    fixed: {
      "files.js": `
const root = path.resolve("uploads");
const safe = path.resolve(root, path.basename(req.params.file));
if (!safe.startsWith(root + path.sep)) throw new Error("bad path");
fs.readFileSync(safe);
`,
    },
  },
  {
    name: "ssrf: user-supplied URL fetched",
    category: "ssrf",
    vulnerable: {
      "proxy.js": `
const res = await fetch(req.body.targetUrl);
return res.json();
`,
    },
    fixed: {
      "proxy.js": `
const ALLOWED = new Set(["https://api.example.com"]);
const url = new URL(req.body.targetUrl);
if (url.protocol !== "https:" || !ALLOWED.has(url.origin)) return 400;
const res = await fetch(url);
return res.json();
`,
    },
  },
  {
    name: "xss: innerHTML with user data",
    category: "xss",
    vulnerable: {
      "chat.js": `
function render(message) {
  document.getElementById("chat").innerHTML = message.content;
}
`,
    },
    fixed: {
      "chat.js": `
function render(message) {
  const el = document.getElementById("chat");
  el.textContent = message.content;
}
`,
    },
  },
  {
    name: "secret: OpenAI-style key hardcoded",
    category: "secret",
    vulnerable: {
      "ai.js": `
const openai = require("openai");
const client = new openai({ apiKey: "sk-1234567890abcdefghijklmnop" });
`,
    },
    fixed: {
      "ai.js": `
const openai = require("openai");
const client = new openai({ apiKey: process.env.OPENAI_API_KEY });
`,
    },
  },
  {
    name: "secret: .env not gitignored",
    category: "secret",
    vulnerable: {
      ".env": `DATABASE_URL=postgres://x:y@db
STRIPE_KEY=sk_live_1234567890abcdefghij`,
    },
    fixed: {
      ".env": `DATABASE_URL=postgres://x:y@db
STRIPE_KEY=sk_live_1234567890abcdefghij`,
      ".gitignore": `.env
.env.*
`,
    },
  },
  {
    name: "authentication: plaintext password compare",
    category: "authentication",
    vulnerable: {
      "auth.js": `
if (req.body.password === user.password) {
  req.session.user = user;
}
`,
    },
    fixed: {
      "auth.js": `
if (await bcrypt.compare(req.body.password, user.hash)) {
  req.session.user = user;
}
`,
    },
  },
  {
    name: "authentication: Math.random token",
    category: "authentication",
    vulnerable: {
      "token.js": `
const resetCode = Math.random().toString(36).slice(2, 8);
`,
    },
    fixed: {
      "token.js": `
const resetCode = crypto.randomBytes(6).toString("hex");
`,
    },
  },
  {
    name: "authentication: inline JWT secret",
    category: "authentication",
    vulnerable: {
      "jwt.js": `
const token = jwt.sign({ userId }, "hunter2");
`,
    },
    fixed: {
      "jwt.js": `
const token = jwt.sign({ userId }, process.env.JWT_SECRET);
`,
    },
  },
  {
    name: "authorization: protected route with no guard",
    category: "authorization",
    vulnerable: {
      "server.js": `
const app = express();
app.get("/api/account", (req, res) => {
  const account = db.getAccount(req.query.id);
  res.json(account);
});
`,
    },
    fixed: {
      "server.js": `
const app = express();
app.get("/api/account", requireAuth, (req, res) => {
  const account = db.getAccount(req.user.id);
  res.json(account);
});
`,
    },
  },
  {
    name: "authorization: admin route without role check",
    category: "authorization",
    vulnerable: {
      "server.js": `
const app = express();
app.get("/admin/users", (req, res) => {
  res.json(db.getAllUsers());
});
`,
    },
    fixed: {
      "server.js": `
const app = express();
app.get("/admin/users", requireAuth, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).end();
  res.json(db.getAllUsers());
});
`,
    },
  },
  {
    name: "input-validation: unrestricted multer upload",
    category: "input-validation",
    vulnerable: {
      "upload.js": `
const upload = multer();
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ ok: true });
});
`,
    },
    fixed: {
      "upload.js": `
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_TYPES.has(file.mimetype)),
});
app.post("/upload", upload.single("file"), (req, res) => {
  res.json({ ok: true });
});
`,
    },
  },
  {
    name: "input-validation: unvalidated money field",
    category: "input-validation",
    vulnerable: {
      "pay.js": `
const amount = req.body.amount;
const charge = gateway.charge(amount);
`,
    },
    fixed: {
      "pay.js": `
const amount = Number(req.body.amount);
if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).end();
const charge = gateway.charge(amount);
`,
    },
  },
  {
    name: "input-validation: eval",
    category: "input-validation",
    vulnerable: {
      "calc.js": `
const result = eval(req.body.expression);
`,
    },
    fixed: {
      "calc.js": `
const result = safeParseMath(req.body.expression);
`,
    },
  },
  {
    name: "cors: wildcard origin with credentials",
    category: "cors",
    vulnerable: {
      "server.js": `
const app = express();
app.use(cors({ origin: "*", credentials: true }));
`,
    },
    fixed: {
      "server.js": `
const app = express();
app.use(cors({ origin: ["https://app.example.com"], credentials: true }));
`,
    },
  },
  {
    name: "transport: cleartext http call",
    category: "transport",
    vulnerable: {
      "client.js": `
const res = await fetch("http://api.example.com/v1/charge", { method: "POST", body: JSON.stringify(card) });
`,
    },
    fixed: {
      "client.js": `
const res = await fetch("https://api.example.com/v1/charge", { method: "POST", body: JSON.stringify(card) });
`,
    },
  },
  {
    name: "logging: password in console.log",
    category: "logging",
    vulnerable: {
      "auth.js": `
console.log("login attempt", req.body.password);
`,
    },
    fixed: {
      "auth.js": `
console.log("login attempt", { user: req.body.email });
`,
    },
  },
  {
    name: "prototype-pollution: Object.assign with req.body",
    category: "prototype-pollution",
    vulnerable: {
      "route.js": `
const user = Object.assign({}, defaultUser, req.body);
`,
    },
    fixed: {
      "route.js": `
const user = { ...defaultUser, name: req.body.name, email: req.body.email };
`,
    },
  },
  {
    name: "repo-level: password flow with no hashing",
    category: "authentication",
    vulnerable: {
      "server.js": `
app.post("/login", (req, res) => {
  const user = db.findUser(req.body.email);
  if (req.body.password === user.password) {
    res.json({ session: sessionId });
  }
});
`,
    },
    fixed: {
      "server.js": `
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const loginLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });
app.post("/login", loginLimiter, async (req, res) => {
  const user = db.findUser(req.body.email);
  if (await bcrypt.compare(req.body.password, user.hash)) {
    res.json({ session: sessionId });
  }
});
`,
    },
  },
];

test("the 5 mandated vulnerability classes + extras: detection", () => {
  for (const c of CASES) {
    const dir = tmpRepo(c.vulnerable);
    const issues = analyzeSecurityStatic(dir);
    const found = issues.filter((i) => i.category === c.category);
    assert.ok(
      found.length > 0,
      `case "${c.name}": expected a ${c.category} finding, got: ${JSON.stringify(cats(issues))}`,
    );
    for (const f of found) {
      assert.ok(
        typeof f.fix === "string" && f.fix.length > 0,
        `case "${c.name}": every finding must carry a fix`,
      );
      // Repo-level findings (rate limiting, hashing, headers) are repo-scoped
      // by design; file-scoped findings must always carry file:line evidence.
      if (f.file) {
        assert.ok(typeof f.line === "number", `case "${c.name}": file-scoped findings carry file:line`);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("applying the fix clears the finding (identify-and-solve is real)", () => {
  for (const c of CASES) {
    const dir = tmpRepo(c.fixed);
    const issues = analyzeSecurityStatic(dir);
    const still = issues.filter((i) => i.category === c.category);
    assert.deepEqual(
      still,
      [],
      `case "${c.name}": fixed repo still reports ${c.category}: ${JSON.stringify(still.map((i) => i.description))}`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rule registry is internally consistent", () => {
  assert.ok(STATIC_SECURITY_RULES.length >= 20, "covers the 5 mandated classes + extras");
  const cats = new Set(STATIC_SECURITY_RULES.map((r) => r.category));
  for (const required of [
    "sql-injection",
    "authentication",
    "authorization",
    "input-validation",
    "secret",
  ]) {
    assert.ok(cats.has(required), `mandated class ${required} has rules`);
  }
  for (const r of STATIC_SECURITY_RULES) {
    assert.ok(r.fix.length > 0, `rule ${r.category} has a fix`);
    assert.equal(typeof r.describe({ 0: "match", 1: "group1" } as any), "string", `rule ${r.category} describes`);
  }
});

test("scan integrates static findings into the Security category (offline)", async () => {
  const dir = tmpRepo({
    "index.js": `
const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
app.get("/api/account", (req, res) => {
  db.query("SELECT * FROM orders WHERE id = " + req.params.id, (e, rows) => res.json(rows));
});
`,
  });
  // No package.json → no lockfile → npm audit is never invoked (offline);
  // gitleaks/semgrep absent on most machines and optional anyway.
  const sec = await analyzeSecurity(dir);
  assert.equal(sec.status, "ok");
  assert.ok(sec.issues.length >= 2, "static findings merged into the Security category");
  assert.ok(
    sec.issues.every((i) => i.fix),
    "every static finding carries its fix through to the scan result",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
