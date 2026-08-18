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

// FAILS: no security headers, X-Powered-By leaked.
it("responses carry security headers", async () => {
  const r = await req("/");
  expect(r.headers["content-security-policy"]).toBeDefined();
  expect(r.headers["x-powered-by"]).toBeUndefined();
});

// FAILS: /api/account returns the user's password.
it("account endpoint does not leak the password", async () => {
  const r = await req("/api/account");
  expect(r.body).not.toContain('"password"');
});

// FAILS: reflected XSS — input echoed into the HTML response.
it("greet is not reflectively XSS-able", async () => {
  const r = await req("/greet?name=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  expect(r.body).not.toContain("<script>");
});

// FAILS: SQL injection — payload reaches the query text.
it("search is not SQL-injectable", async () => {
  const r = await req("/search?q=%27%20OR%20%271%27%3D%271");
  expect(r.body).not.toContain("OR '1'='1");
});

// FAILS: command injection — hostile host executes a shell command.
// %26 is an encoded "&" so the payload splits the shell command on both
// Windows (cmd) and Unix (/bin/sh).
it("ping does not allow command injection", async () => {
  const r = await req("/api/ping?host=127.0.0.1%26echo%20PWNED");
  expect(r.body).not.toContain("PWNED");
});
