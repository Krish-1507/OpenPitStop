/**
 * pen/dynamic.ts — the dynamic phase of `pitstop pen`.
 *
 * Boots the app-under-test under the pen sandbox (`templates/pen/preload.cjs`
 * for Node/JS) and fires a battery of live attacks at the discovered routes.
 * Every attack is recorded (method, path, payload, status, response snippet)
 * and its outcome is checked against BOTH the response and the sandbox
 * evidence stream.
 *
 * Non-Node stacks (Go/Rust/Python/.NET/Java/Dart) are sandboxed with an
 * HTTP(S)_PROXY recording proxy instead of the nock preload: outbound calls
 * from apps honoring the proxy are recorded and never forwarded anywhere real.
 * That proxy cannot observe subprocess spawns, so for those stacks
 * command-injection is capped at "indicated" (response-echo), never "proven".
 *
 * Honesty rules:
 *   - Attack requests may legitimately crash bits of the app (a 500 is a
 *     finding too: `crash-on-input`). The app is this user's own repo, started
 *     by the user, on a local port, with all external network traffic
 *     intercepted and logged.
 *   - "proven" is reserved for findings where the sandbox recorded a canary —
 *     e.g. a spawn containing our marker (command injection) or an outbound
 *     HTTP call to our canary host (SSRF). Everything else is "indicated".
 */

import { execa } from "execa";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectLanguage } from "../analyzers/util.js";
import { startRecordingProxy, type RecordingProxy } from "../sandbox/proxy.js";
import {
  resolveNativeStart,
  resolveNodeStart,
  type StartCommand,
} from "../sandbox/startCmd.js";
import { findingIdFor } from "../repro/ids.js";
import type { PenFinding, PenRoute } from "./types.js";

const STARTUP_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_ROUTES_PROBED = 40;
const RATE_LIMIT_HAMMER = 30;

function preloadPath(): string {
  return fileURLToPath(new URL("../../templates/pen/preload.cjs", import.meta.url));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function controlHas(controlPath: string, needle: string): boolean {
  if (!fs.existsSync(controlPath)) return false;
  try {
    return fs
      .readFileSync(controlPath, "utf8")
      .split(/\r?\n/)
      .some((l) => l.includes(needle));
  } catch {
    return false;
  }
}

function waitForServer(
  baseUrl: string,
  exited: () => boolean,
  controlPath: string,
  timeoutMs: number,
): Promise<{ up: boolean; aborted: boolean }> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (controlHas(controlPath, '"event":"abort"')) return { up: false, aborted: true };
      if (exited()) return { up: false, aborted: controlHas(controlPath, '"event":"abort"') };
      if (controlHas(controlPath, '"event":"armed"')) {
        try {
          const res = await fetch(`${baseUrl}/__pitstop_pen_probe__`, { signal: AbortSignal.timeout(2500) });
          if (res) return { up: true, aborted: false };
        } catch {
          /* not up yet */
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    return { up: false, aborted: controlHas(controlPath, '"event":"abort"') };
  })();
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                        */
/* ------------------------------------------------------------------ */

function sanitize(s: string): string {
  return s
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

interface Hit {
  status: number;
  snippet: string;
  headers: Record<string, string>;
  text: string;
}

async function hit(baseUrl: string, method: string, p: string, body?: unknown): Promise<Hit> {
  const effort: RequestInit = {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  try {
    const res = await fetch(baseUrl + p, effort);
    const text = await res.text().catch(() => "");
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, snippet: sanitize(text), headers, text };
  } catch (e: any) {
    return { status: 0, snippet: "", headers: {}, text: "" };
  }
}

const idish = (name: string) => /id|key|slug|code|order/i.test(name);

const pathTraversalFix =
  "Resolve the path and verify it stays inside a ROOT directory (path.resolve(root, name)), " +
  "then reject any result that escapes via startsWith(root + path.sep); use a safelist of allowed filenames.";

function substitute(rawPath: string): string {
  return rawPath
    .replace(/:([A-Za-z_][\w-]*)/g, (_, name) => (idish(name) ? "1" : "abc"))
    .replace(/\{([A-Za-z_][\w-]*)\}/g, (_, name) => (idish(name) ? "1" : "abc"));
}

/* ------------------------------------------------------------------ */
/* Attack battery                                                      */
/* ------------------------------------------------------------------ */

interface AttackDef {
  tag: string;
  method: string;
  origin: string;
  qs: [string, string][];
  body?: (marker: string, canary: string) => Record<string, unknown>;
}

function buildAttacks(marker: string, canary: string): AttackDef[] {
  const xss = `<script>${marker}</script>`;
  const sql = `' OR '1'='1' -- ${marker}`;
  const nosql = { $gt: "" };
  const trav = "../../../../etc/passwd";
  const cmd = `;echo ${marker};`;
  const q = (v: string): [string, string][] => [
    ["q", v],
    ["name", v],
    ["search", v],
    ["input", v],
  ];
  return [
    { tag: "xss", method: "GET", origin: "query arguments", qs: q(xss) },
    { tag: "sql", method: "GET", origin: "query arguments", qs: q(sql) },
    {
      tag: "traversal",
      method: "GET",
      origin: "query arguments",
      qs: [["file", trav], ["path", trav], ["filename", trav]],
    },
    {
      tag: "cmd",
      method: "GET",
      origin: "query arguments",
      qs: [["cmd", cmd], ["command", cmd], ["execute", cmd]],
    },
    {
      tag: "ssrf",
      method: "GET",
      origin: "query arguments",
      qs: [["url", canary], ["uri", canary], ["link", canary], ["target", canary], ["remote", canary], ["redirect", canary], ["callback", canary], ["webhook", canary], ["image", canary], ["src", canary], ["host", canary], ["api", canary]],
    },
    {
      tag: "xss",
      method: "POST",
      origin: "request body",
      qs: [],
      body: (m) => ({ q: `<script>${m}</script>`, name: `<script>${m}</script>`, search: `<script>${m}</script>`, input: `<script>${m}</script>`, message: `<script>${m}</script>` }),
    },
    {
      tag: "sql",
      method: "POST",
      origin: "request body",
      qs: [],
      body: (m) => ({ q: `' OR '1'='1' -- ${m}`, name: `' OR '1'='1' -- ${m}`, search: `' OR '1'='1' -- ${m}`, input: `' OR '1'='1' -- ${m}` }),
    },
    {
      tag: "nosql",
      method: "POST",
      origin: "request body",
      qs: [],
      body: () => ({ q: { $gt: "" }, name: { $gt: "" }, id: { $gt: "" } }),
    },
    {
      tag: "traversal",
      method: "POST",
      origin: "request body",
      qs: [],
      body: () => ({ file: "../../../../etc/passwd", path: "../../../../etc/passwd", filename: "..\\..\\..\\..\\windows\\win.ini" }),
    },
    {
      tag: "cmd",
      method: "POST",
      origin: "request body",
      qs: [],
      body: (m) => ({ cmd: `;echo ${m};`, command: `;echo ${m};`, execute: `;echo ${m};` }),
    },
    {
      tag: "ssrf",
      method: "POST",
      origin: "request body",
      qs: [],
      body: (_m, c) => ({ url: c, target: c, remote: c, image: c, src: c, webhook: c, callback: c, redirect: c, uri: c, link: c, host: c, api: c }),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Outbound evidence                                                    */
/* ------------------------------------------------------------------ */

interface OutboundEvent {
  kind: string;
  n?: number;
  host?: string;
  method?: string;
  cmd?: string;
  via?: string;
}

function readOutbound(outboundPath: string): OutboundEvent[] {
  if (!fs.existsSync(outboundPath)) return [];
  try {
    return fs
      .readFileSync(outboundPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as OutboundEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is OutboundEvent => !!e);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */

export interface PenDynamicOutcome {
  status: "ok" | "aborted";
  note?: string;
  routesProbed: number;
  attacks: number;
  bootMs: number;
  durationMs: number;
  outboundEvents: number;
  findings: PenFinding[];
}

export async function runDynamic(repo: string, routes: PenRoute[]): Promise<PenDynamicOutcome> {
  const t0 = Date.now();
  const abortWith = (note: string): PenDynamicOutcome => ({
    status: "aborted",
    note,
    routesProbed: 0,
    attacks: 0,
    bootMs: 0,
    durationMs: Date.now() - t0,
    outboundEvents: 0,
    findings: [],
  });

  const lang = detectLanguage(repo);
  const nodeMode = lang === "js";
  if (lang === "unknown") {
    return abortWith(
      "could not identify the repo language — dynamic pen cannot choose a sandbox; " +
        "static pen still ran — see its findings below.",
    );
  }

  const workDir = path.join(repo, ".pitstop", "pen");
  fs.mkdirSync(workDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workDir, `run-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });

  const controlPath = path.join(runDir, "control.jsonl");
  const outboundPath = path.join(runDir, "outbound.jsonl");
  const appOut = path.join(runDir, "app.out.log");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let start: StartCommand | null = null;
  try {
    start = nodeMode ? resolveNodeStart(repo) : resolveNativeStart(repo, lang, port);
  } catch (e) {
    return abortWith((e as Error).message);
  }
  if (!start) {
    return abortWith(
      `could not determine a start command for a ${lang} repo — set PITSTOP_START ` +
        `(e.g. "PITSTOP_START=uvicorn app.main:app") and re-run. Static pen still ran — see its findings below.`,
    );
  }

  // Non-Node sandbox: HTTP(S)_PROXY recording proxy. Java/Dart clients do not
  // honor the proxy by default — outbound evidence there simply never fires,
  // while response-side findings stay valid.
  let proxy: RecordingProxy | null = null;
  if (!nodeMode) {
    try {
      proxy = await startRecordingProxy({
        logPath: outboundPath,
        controlPath,
        gatewayHosts: [],
        canarySuffix: "pitstop.invalid",
      });
    } catch (e) {
      return abortWith(`could not start the recording proxy: ${(e as Error).message}`);
    }
  }

  const bootStart = Date.now();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PITSTOP_PEN_CONTROL: controlPath,
    PITSTOP_PEN_OUTBOUND: outboundPath,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || "rzp_test_pitstop000000",
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || "pitstop_fake_secret",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_pitstop_fake",
    NODE_ENV: process.env.NODE_ENV || "test",
  };
  const env: NodeJS.ProcessEnv = nodeMode
    ? {
        ...baseEnv,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath()}`]
          .filter(Boolean)
          .join(" "),
      }
    : {
        ...baseEnv,
        HTTP_PROXY: `http://127.0.0.1:${proxy!.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy!.port}`,
        http_proxy: `http://127.0.0.1:${proxy!.port}`,
        https_proxy: `http://127.0.0.1:${proxy!.port}`,
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
      };

  const child = execa(start.cmd, start.args, {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    reject: false,
    maxBuffer: 50 * 1024 * 1024,
  });

  let exited = false;
  child
    .then(() => {
      exited = true;
    })
    .catch(() => {
      exited = true;
    });

  const outFd = fs.openSync(appOut, "a");
  const pump = (chunk: Buffer | string) =>
    fs.writeSync(outFd, typeof chunk === "string" ? chunk : chunk.toString());
  child.stdout?.on("data", pump);
  child.stderr?.on("data", pump);

  const { up, aborted } = await waitForServer(baseUrl, () => exited, controlPath, STARTUP_TIMEOUT_MS);

  const close = () => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      fs.closeSync(outFd);
    } catch {
      /* ignore */
    }
    if (proxy) {
      proxy.close().catch(() => {
        /* ignore */
      });
    }
  };

  if (!up) {
    close();
    const note = aborted
      ? "the sandbox aborted during startup (a raw socket / uninterceptable channel fired before we were ready) — see the run dir for control.jsonl"
      : `app did not come up within ${STARTUP_TIMEOUT_MS / 1000}s (start: "${start.cmd} ${start.args.join(" ")}")`;
    return {
      status: "aborted",
      note,
      routesProbed: 0,
      attacks: 0,
      bootMs: Date.now() - bootStart,
      durationMs: Date.now() - t0,
      outboundEvents: readOutbound(outboundPath).length,
      findings: [],
    };
  }
  const bootMs = Date.now() - bootStart;

  const findings: PenFinding[] = [];
  let attacks = 0;
  let routesProbed = 0;

  try {
    const probed = routes.slice(0, MAX_ROUTES_PROBED);
    routesProbed = probed.length;
    const marker = `gpn${Math.floor(Math.random() * 1e8)}`;
    const canaryHost = `ssrf-canary-${marker}.pitstop.invalid`;
    const canaryUrl = `http://${canaryHost}/pen`;

    const seen = new Set<string>();
    const pushFinding = (f: Omit<PenFinding, "id" | "source">) => {
      const key = `${f.type}|${f.route ?? f.file ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        id: findingIdFor("pen", f.type, f.route ?? f.file, f.title),
        source: "pen-dynamic",
        ...f,
      });
    };

    for (const route of probed) {
      const urlPath = substitute(route.path);
      const base = await hit(baseUrl, route.method, urlPath, route.method === "GET" ? undefined : {});
      attacks++;
      const headers = base.headers;
      const routeLabel = `${route.method} ${route.path}`;

      /* ---- headers: framework disclosure + missing security headers ---- */
      if (headers["x-powered-by"]) {
        pushFinding({
          type: "info-leak-header",
          severity: "low",
          confidence: "indicated",
          title: "framework version leaked via X-Powered-By",
          description: `${routeLabel} responds with X-Powered-By: ${headers["x-powered-by"]} — fingerprints framework/version for attackers.`,
          route: route.path,
          method: route.method,
          response: { status: base.status, headers },
          repro: `curl -sI /${urlPath} | grep -i x-powered-by`,
          fix: 'Disable it: `app.disable("x-powered-by");` (deterministic patch via `pitstop pen --fix`).',
        });
      }
      const secHeaders = ["x-frame-options", "content-security-policy", "x-content-type-options", "strict-transport-security"];
      const missingSec = secHeaders.filter((h) => !headers[h]);
      if (missingSec.length >= 2) {
        pushFinding({
          type: "missing-security-headers",
          severity: "medium",
          confidence: "indicated",
          title: `security headers absent on ${routeLabel}`,
          description: `Missing: ${missingSec.join(", ")}. Responses are clickjackable and MIME-sniffable.`,
          route: route.path,
          method: route.method,
          response: { status: base.status, headers },
          fix: 'Ship `helmet()` (or manually set X-Frame-Options: DENY, X-Content-Type-Options: nosniff, a CSP, and HSTS).',
        });
      }

      /* ---- auth check on sensitive routes ---- */
      if (route.sensitive && base.status >= 200 && base.status < 300) {
        pushFinding({
          type: "missing-auth",
          severity: "high",
          confidence: "indicated",
          title: "sensitive route answers unauthenticated",
          description: `${routeLabel} returns ${base.status} with NO Authorization header / session cookie. Response: ${base.snippet}`,
          route: route.path,
          method: route.method,
          attack: { method: route.method, path: urlPath },
          response: { status: base.status, snippet: base.snippet },
          repro: `curl -s -o /dev/null -w '%{http_code}' /${urlPath}`,
          fix: "Require authentication (session/JWT) BEFORE the handler; 401 on missing credentials.",
        });
      }

      /* ---- injection battery ---- */
      for (const atk of buildAttacks(marker, canaryUrl)) {
        const qs = atk.qs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
        const p = qs ? `${urlPath}${urlPath.includes("?") ? "&" : "?"}${qs}` : urlPath;
        const pre = readOutbound(outboundPath);
        const nextN = pre.length ? Math.max(...pre.map((o) => (o.n ?? 0))) : 0;
        const res = await hit(baseUrl, atk.method, p, atk.body ? atk.body(marker, canaryUrl) : undefined);
        attacks++;

        // canary-linked proof: only evidence recorded DURING this attack (n > nextN).
        const inWindow = readOutbound(outboundPath).filter((o) => (o.n ?? 0) > nextN);
        const cmdProof = inWindow.filter((o) => o.kind === "spawn" && o.cmd && o.cmd.includes(marker));
        const ssrfProof = inWindow.filter((o) => o.kind === "http" && o.host && o.host.includes("ssrf-canary"));

        if (ssrfProof.length > 0) {
          pushFinding({
            type: "ssrf",
            severity: "high",
            confidence: "proven",
            title: `server-side request forgery via ${routeLabel}`,
            description: `A ${atk.origin} "url/webhook/callback"-style field made the SERVER open a connection to ${canaryHost} (recorded by ${nodeMode ? "the sandbox" : "the recording proxy"} — no real byte left the machine). Response: HTTP ${res.status}.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body ? atk.body(marker, canaryUrl) : undefined },
            response: { status: res.status, snippet: res.snippet },
            outbound: ssrfProof.slice(0, 3).map((e) => `${e.kind} → ${e.host}${e.method ? " " + e.method : ""}`),
            repro: `POST ${urlPath} with a "url"/"webhook"/"callback" field set to ${canaryUrl} — the app opens a connection to it.`,
            fix: "Only allow an explicit allowlist of hosts; block private/metadata ranges (169.254.169.254 etc.) after DNS resolution; never accept attacker-controlled URLs for server-side fetches.",
          });
        }

        if (cmdProof.length > 0) {
          pushFinding({
            type: "command-injection",
            severity: "critical",
            confidence: "proven",
            title: `command injection on ${routeLabel}`,
            description: `The sandbox recorded a child_process spawn containing the marker after sending a "cmd"-style payload (executed cmd: ${cmdProof[0].cmd}). This is remote code execution with the server's privileges.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body ? atk.body(marker, canaryUrl) : undefined },
            response: { status: res.status, snippet: res.snippet },
            outbound: cmdProof.slice(0, 2).map((e) => `spawn: ${e.cmd}`),
            repro: `GET/POST with e.g. ?cmd=;echo ${marker}; — the server spawns the command.`,
            fix: "Never shell out with request data. Use execFile with a fixed command and no shell; validate input against a strict allowlist.",
          });
        } else if (
          !nodeMode &&
          atk.tag === "cmd" &&
          res.status < 300 &&
          res.text.includes(marker)
        ) {
          // The recording proxy cannot observe subprocess spawns, so an echoed
          // marker is the strongest evidence it can give: indicated, never proven.
          pushFinding({
            type: "command-injection",
            severity: "critical",
            confidence: "indicated",
            title: `command payload echoed on ${routeLabel}`,
            description: `A "cmd"-style payload's marker (${marker}) came back in the HTTP ${res.status} response. The value reached a shell/exec path — but the HTTP proxy cannot observe spawns, so this is indicated, not proven (a pure echo endpoint could also reflect it).`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body ? atk.body(marker, canaryUrl) : undefined },
            response: { status: res.status, snippet: res.snippet },
            repro: `GET/POST with e.g. ?cmd=;echo ${marker}; — the marker appears in the response body.`,
            fix: "Never shell out with request data. Use execFile with a fixed command and no shell; validate input against a strict allowlist.",
          });
        }

        // Injection-style observations (indicated): response reflects or crashes.
        if (res.status >= 500) {
          pushFinding({
            type: "crash-on-input",
            severity: "medium",
            confidence: "indicated",
            title: `server error on crafted input (${routeLabel})`,
            description: `${atk.tag} payload (${atk.origin}) produced HTTP ${res.status}. Unhandled exceptions are a DoS vector and usually a red flag for injection.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body ? atk.body(marker, canaryUrl) : undefined },
            response: { status: res.status, snippet: res.snippet },
            fix: "Validate/normalize input at the boundary; never let malformed request data reach a raw handler; add a global error handler that returns 400.",
          });
        }
        if (atk.tag === "xss" && res.status < 300 && res.text.includes(marker)) {
          pushFinding({
            type: "reflected-xss",
            severity: "high",
            confidence: "proven",
            title: `reflected XSS on ${routeLabel}`,
            description: `The exact payload ${marker} appeared UNESCAPED in the HTTP ${res.status} response to ${atk.method} ${p.slice(0, 120)}. A browser visiting the URL executes attacker script.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body && atk.body(marker, canaryUrl) },
            response: { status: res.status, snippet: res.snippet },
            repro: `GET "${baseUrl}${p}" and grep for ${marker} in the body.`,
            fix: "Never interpolate request data into HTML. Escape at the output (or use text nodes); apply a strict CSP and set X-Content-Type-Options: nosniff.",
          });
        }
        if (atk.tag === "traversal" && res.status < 300 && (res.text.includes("root:x:0:0") || res.text.includes("[extensions]") || res.text.includes("; for 16-bit app support"))) {
          pushFinding({
            type: "path-traversal",
            severity: "critical",
            confidence: "proven",
            title: `path traversal reads files on ${routeLabel}`,
            description: `A ../../.. path payload made the server return the host's ${res.text.includes("root:x:0:0") ? "/etc/passwd" : "windows config"} inside HTTP ${res.status}. That is arbitrary file read.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body && atk.body(marker, canaryUrl) },
            response: { status: res.status, snippet: res.snippet },
            repro: "Hit the route with `..%2f..%2f..%2fetc%2fpasswd` in a file/path parameter.",
            fix: pathTraversalFix,
          });
        }
        if ((atk.tag === "sql" || atk.tag === "nosql") && res.status < 300 && res.text.includes("error") && /syntax|unterminated|parse|invalid|mongo|sqlite|sql|sequelize|knex|cannot read/i.test(res.snippet)) {
          pushFinding({
            type: `${atk.tag === "sql" ? "sql-injection" : "nosql-injection"}`,
            severity: "critical",
            confidence: "indicated",
            title: `injection probing surfaced parse errors on ${routeLabel}`,
            description: `${atk.tag} payload produced a DB-ish error surface in the ${res.status} response (${res.snippet}). Strong evidence the value lands in a query.`,
            route: route.path,
            method: route.method,
            attack: { method: atk.method, path: p, payload: atk.body && atk.body(marker, canaryUrl) },
            response: { status: res.status, snippet: res.snippet },
            fix: "Parameterize all queries; disable verbose error output in production.",
          });
        }
      }

      /* ---- rate-limit battery on login-like routes ---- */
      if (route.loginLike) {
        let seen429 = 0;
        let after429Status = "";
        for (let i = 0; i < RATE_LIMIT_HAMMER; i++) {
          const r = await hit(baseUrl, "POST", urlPath, { username: "admin", password: `x-${i}-${Math.random()}` });
          attacks++;
          if (r.status === 429) {
            seen429++;
            if (!after429Status) after429Status = `${r.status} (${r.snippet})`;
          }
        }
        if (seen429 === 0) {
          pushFinding({
            type: "no-rate-limit",
            severity: "medium",
            confidence: "indicated",
            title: `no rate limiting on ${routeLabel}`,
            description: `${RATE_LIMIT_HAMMER} rapid guesses were all accepted (hit ${base.status} after the first request) — no 429 anywhere. Credential stuffing / OTP brute force is unthrottled.`,
            route: route.path,
            method: route.method,
            attack: { method: "POST", path: urlPath, payload: `{ username, password } × ${RATE_LIMIT_HAMMER} rapid requests` },
            repro: `for i in $(seq 1 ${RATE_LIMIT_HAMMER}); do curl -s -o /dev/null -w '%{http_code}\\n' -X POST /${urlPath} -d '{"username":"admin","password":"x"}'; done | sort | uniq -c`,
            fix: "Add express-rate-limit on this route (e.g. 5 / 15min per IP) and consider lockout / captcha after failures.",
          });
        }
      }
    }

    close();
    return {
      status: "ok",
      note: nodeMode
        ? undefined
        : `HTTP(S)_PROXY recording sandbox (${lang}) — only apps whose HTTP clients honor the proxy are intercepted; ` +
          "native binaries/raw sockets are not; command-injection is capped at 'indicated'; https outbound is blocked (502).",
      routesProbed,
      attacks,
      bootMs,
      durationMs: Date.now() - t0,
      outboundEvents: readOutbound(outboundPath).length,
      findings,
    };
  } catch (e: any) {
    close();
    return {
      status: "aborted",
      note: `dynamic phase crashed: ${(e as Error).message}`,
      routesProbed,
      attacks,
      bootMs,
      durationMs: Date.now() - t0,
      outboundEvents: readOutbound(outboundPath).length,
      findings,
    };
  }
}