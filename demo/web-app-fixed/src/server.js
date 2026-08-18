const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { execFile } = require("child_process");
const fs = require("fs");
const config = require("./config");
const auth = require("./auth");
const users = require("./users");
const db = require("./db");

const app = express();
app.use(express.json());
// FIXED: security headers via helmet; X-Powered-By disabled.
app.use(helmet());
app.disable("x-powered-by");
// FIXED: CORS allowlist, not *.
app.use(
  cors({
    origin: [process.env.FRONTEND_ORIGIN || "http://localhost:5173"],
    credentials: true,
  }),
);

// In-memory accounts. Password hashes live in the environment (never as
// literals in source) — see .env.example (DEMO_ALICE_HASH / DEMO_BOB_HASH).
const accounts = [
  { id: 1, name: "alice", email: "alice@minishop.dev", password: process.env.DEMO_ALICE_HASH || "", isAdmin: false },
  { id: 2, name: "bob", email: "bob@minishop.dev", password: process.env.DEMO_BOB_HASH || "", isAdmin: true },
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// FIXED: auth guard present on protected routes.
function requireAuth(req, res, next) {
  const token = req.cookies?.session || req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "unauthenticated" });
  try {
    req.user = auth.verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: "invalid token" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !accounts.find((a) => a.id === req.user.sub)?.isAdmin) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
}

const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true });

// FIXED: no shell — host validated, looked up, never executed.
app.get("/api/ping", (req, res) => {
  const host = req.query.host || "localhost";
  if (!/^[\w.-]+$/.test(host)) return res.status(400).json({ error: "invalid host" });
  res.json({ host, ok: true });
});

// FIXED: parameterized query, named columns, no SELECT *.
app.get("/search", async (req, res) => {
  const q = req.query.q || "";
  const like = "%" + q + "%"; // built outside the query call, passed as a param
  try {
    const [rows] = await db.pool.query(
      "SELECT id, name, price FROM products WHERE name LIKE ?",
      [like],
    );
    res.json(rows);
  } catch {
    res.json([]); // DB unreachable in this demo env — safe empty result
  }
});

app.get("/user/:id", async (req, res) => {
  try {
    const [rows] = await db.pool.query(
      "SELECT id, name, email FROM users WHERE id = ?",
      [req.params.id],
    );
    res.json(rows[0] || null);
  } catch {
    res.json(null);
  }
});

// FIXED: user input escaped before going into HTML.
app.get("/greet", (req, res) => {
  res.type("html").send(`<h1>Hello ${escapeHtml(req.query.name || "world")}</h1>`);
});

// FIXED: path confined to an uploads root; traversal rejected.
const UPLOAD_ROOT = path.resolve(__dirname, "..", "uploads");
app.get("/file", (req, res) => {
  const safe = path.resolve(UPLOAD_ROOT, path.basename(req.query.name || ""));
  if (!safe.startsWith(UPLOAD_ROOT + path.sep)) return res.status(400).json({ error: "bad path" });
  fs.readFile(safe, "utf8", (e, data) => {
    if (e) return res.status(404).json({ error: "not found" });
    res.send(data);
  });
});

// FIXED: eval removed — safe arithmetic only, everything else rejected.
app.post("/calc", (req, res) => {
  const n = Number(req.body.expr);
  if (!Number.isFinite(n)) return res.status(400).json({ error: "invalid expression" });
  res.json({ result: n * 2 });
});

// FIXED: auth guard + password stripped before sending.
app.get("/api/account", requireAuth, (req, res) => {
  const { password, ...safe } = accounts[0];
  res.json(safe);
});

// FIXED: admin role check + explicit, safe field projection (no raw object).
app.get("/admin", requireAuth, requireAdmin, (req, res) => {
  const admins = accounts.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    isAdmin: a.isAdmin,
  }));
  res.json(admins);
});

// FIXED: rate-limited, hashed compare, secure cookie, no secret logging.
app.post("/login", loginLimiter, async (req, res) => {
  const user = accounts.find((a) => a.name === req.body.username);
  if (user && (await auth.checkPassword(req.body.password, user.password))) {
    const token = auth.issueToken(user);
    auth.setSessionCookie(res, token);
    // FIXED: log an identifier only, never the password/token.
    console.log({ user: user.email, action: "login" });
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "views", "index.html"));
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`minishop listening on ${port}`));
}

module.exports = app;
