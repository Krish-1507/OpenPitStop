const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const fs = require("fs");
const config = require("./config");
const auth = require("./auth");
const users = require("./users");
const db = require("./db");

const app = express();
app.use(express.json());
// BUG: CORS allows any origin with credentials.
app.use(cors({ origin: "*", credentials: true }));
// BUG: X-Powered-By left on, no security headers (no helmet).

// In-memory "users" — enough to demonstrate data exposure.
const accounts = [
  { id: 1, name: "alice", email: "alice@minishop.dev", password: "alice123", isAdmin: false },
  { id: 2, name: "bob", email: "bob@minishop.dev", password: "bob123", isAdmin: true },
];

// BUG: command injection — host flows from query string into a shell.
app.get("/api/ping", (req, res) => {
  exec(`ping -c 1 ${req.query.host || "localhost"}`, (err, out) => {
    res.send(out);
  });
});

// BUG: SQL injection — query string concatenated into a real query call (SELECT *).
app.get("/search", (req, res) => {
  const q = req.query.q || "";
  const sql = `SELECT * FROM products WHERE name LIKE '%${q}%'`;
  db.pool.query(sql, () => {}); // real query call — flagged by the SQLi analyzer
  res.send(sql); // echoes the constructed SQL so the flaw is observable
});

// BUG: SQL injection via path param into a real query call.
app.get("/user/:id", (req, res) => {
  const sql = "SELECT * FROM users WHERE id = " + req.params.id;
  db.pool.query(sql, () => {});
  res.send(sql);
});

// BUG: reflected XSS — user input echoed straight into an HTML response.
app.get("/greet", (req, res) => {
  res.send(`<h1>Hello ${req.query.name}</h1>`);
});

// BUG: path traversal — untrusted filename read from disk.
app.get("/file", (req, res) => {
  fs.readFile(req.query.name, "utf8", (e, data) => {
    if (e) return res.send(e.stack); // BUG: stack trace leaked to client
    res.send(data);
  });
});

// BUG: eval — RCE sink on user-controlled input.
app.post("/calc", (req, res) => {
  res.send(String(eval(req.body.expr)));
});

// BUG: no authn/authz — returns the full account object (password included).
app.get("/api/account", (req, res) => {
  // @ts-ignore password is fine to return for now
  res.json(accounts[0]);
});

// BUG: admin route with no role check.
app.get("/admin", (req, res) => {
  res.json(accounts);
});

// BUG: login with no rate limit, cleartext password compare, insecure cookie.
app.post("/login", (req, res) => {
  const user = accounts.find((a) => a.name === req.body.username);
  // TODO: secure this auth before launch
  if (user && auth.checkPassword(req.body.password, user.password)) {
    const token = auth.issueToken(user);
    auth.setSessionCookie(res, token);
    // BUG: PII + secret logged
    console.log({ user: user.email, password: user.password, token });
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

// BUG: client reads token from localStorage (XSS-exfiltratable).
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/../views/index.html");
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`minishop listening on ${port}`));
}

module.exports = app;
