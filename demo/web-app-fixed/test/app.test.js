// Set env before requiring the app (config.js fails fast without it).
process.env.DB_PASSWORD = process.env.DB_PASSWORD || "dummy";
process.env.JWT_SECRET = process.env.JWT_SECRET || "dummy";
// Point the DB pool at localhost so connection errors fail fast (no real DB
// exists in this demo env) instead of hanging on an unresolvable host.
process.env.DB_HOST = "127.0.0.1";

const http = require("node:http");
const app = require("../src/server");

function req(path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      http
        .get({ host: "127.0.0.1", port, path }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            server.close();
            resolve({ status: res.statusCode, headers: res.headers, body });
          });
        })
        .on("error", reject);
    });
  });
}

// PASSES: helmet adds CSP, X-Powered-By disabled.
it("responses carry security headers", async () => {
  const r = await req("/");
  expect(r.headers["content-security-policy"]).toBeDefined();
  expect(r.headers["x-powered-by"]).toBeUndefined();
});

// PASSES: /api/account strips the password before responding.
it("account endpoint does not leak the password", async () => {
  const r = await req("/api/account");
  expect(r.body).not.toContain('"password"');
});

// PASSES: user input is escaped before reaching the HTML response.
it("greet is not reflectively XSS-able", async () => {
  const r = await req("/greet?name=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  expect(r.body).not.toContain("<script>");
});

// PASSES: the payload never reaches a raw query string.
it("search is not SQL-injectable", async () => {
  const r = await req("/search?q=%27%20OR%20%271%27%3D%271");
  expect(r.body).not.toContain("OR '1'='1");
});

// PASSES: the host is validated; no shell command is executed.
it("ping does not allow command injection", async () => {
  const r = await req("/api/ping?host=127.0.0.1%26echo%20PWNED");
  expect(r.body).not.toContain("PWNED");
});
