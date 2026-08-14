'use strict';

/**
 * OpenPitStop `pen` HTTP sandbox (CommonJS preload).
 *
 * Loaded into the app-under-test via `NODE_OPTIONS=--require=<this file>`,
 * BEFORE the app's own modules, so the "penetration test" can fire attack
 * traffic at the app while being certain of two things:
 *
 *   1. NOTHING reaches the real network. Every outbound HTTP/HTTPS request is
 *      intercepted (nock catch-all + fetch wrapper) and recorded into
 *      `PITSTOP_PEN_OUTBOUND`; raw sockets and UDP are blocked outright.
 *      An SSRF is therefore not an exfiltration — it is a recorded log line.
 *   2. Everything the app tries to reach out to is evidence: outbound HTTP is
 *      logged as `{kind:"http", host, method, path}`, child-process spawns as
 *      `{kind:"spawn", cmd}`. A `pitstop` canary marker inside a logged line
 *      is PROOF of command injection / SSRF without a single real byte leaving
 *      the machine.
 *
 * SAFETY NOTES (documented honestly, unlike a magic "pen"):
 *   - child_process calls are RECORDED but not blocked: apps legitimately spawn
 *     (dev servers, migrators), and this is the user's own start script.
 *     The attacker payload canary still shows up in the spawn log, which is the
 *     proof we need. A truly hostile repo is no more dangerous than running
 *     `npm start` yourself — which is exactly what `pitstop pen` asks you to do.
 *   - raw sockets (net/tls) and UDP are BLOCKED: those bypass interception
 *     entirely, so the "nothing reaches the real network" guarantee cannot be
 *     kept with them enabled.
 *
 * Control stream (`PITSTOP_PEN_CONTROL`): JSONL events `armed` / `probe`,
 * plus every `outbound` / `spawn` / `blocked` line mirrored for the harness.
 */

const fs = require('fs');

const CONTROL = process.env.PITSTOP_PEN_CONTROL || null;
const OUTBOUND = process.env.PITSTOP_PEN_OUTBOUND || null;

let seq = 0;

function writeJsonl(file, obj) {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (_) {
    /* best-effort */
  }
}

function emit(event) {
  const line = Object.assign({ at: new Date().toISOString(), n: ++seq }, event);
  writeJsonl(CONTROL, line);
  if (line.kind === 'http' || line.kind === 'spawn' || line.kind === 'blocked') {
    writeJsonl(OUTBOUND, line);
  }
}

function trunc(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + '…' : str;
}

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch (_) {
    return trunc(u, 160);
  }
}

const isLocal = (hostname) =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

/* ------------------------------------------------------------------ */
/* nock: every outbound HTTP/HTTPS request is intercepted + recorded   */
/* ------------------------------------------------------------------ */

let nock;
try {
  nock = require('nock');
} catch (_) {
  emit({ event: 'abort', reason: 'nock is not resolvable from the pen preload' });
  setTimeout(() => process.exit(77), 0);
}

nock.disableNetConnect();

// Catch-all: ANY host the app calls is intercepted (recorded, fake reply).
const scope = nock(/(.*)/).persist();
const armMethod = (method) => {
  if (!scope[method.toLowerCase()]) return;
  scope[method.toLowerCase()](/.*/).reply(function (uri) {
    const req = this.req;
    const host =
      (req && (req.hostname || req.host || (req.headers && req.headers.host) || (req.options && req.options.hostname))) || 'unknown';
    emit({
      kind: 'http',
      host,
      method: String((req && req.method) || method).toUpperCase(),
      path: trunc(uri, 300),
    });
    // A bland 200 JSON reply: the app keeps working, we keep the receipt.
    return [
      200,
      { ok: true, intercepted: true, note: 'pitstop pen sandbox — this call never reached the real network' },
    ];
  });
};
for (const m of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) armMethod(m);

// undici / global fetch bypasses nock's ClientRequest interception.
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    let u = null;
    try {
      u = new URL(typeof input === 'string' ? input : (input && input.url) || 'http://localhost/');
    } catch (_) {
      u = null;
    }
    if (u && !isLocal(u.hostname)) {
      emit({
        kind: 'http',
        host: u.host,
        method: String((init && init.method) || 'GET').toUpperCase(),
        path: trunc(u.pathname + u.search, 300),
        via: 'fetch',
      });
      return new Response(
        JSON.stringify({ ok: true, intercepted: true, note: 'pitstop pen sandbox' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return realFetch.call(globalThis, input, init);
  };
}

/* ------------------------------------------------------------------ */
/* child_process: RECORD (do not block) — the canary is the proof      */
/* ------------------------------------------------------------------ */

const cp = require('child_process');
for (const m of ['exec', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[m] === 'function') {
    const name = m;
    const real = cp[m];
    cp[m] = function (...args) {
      const target = args[0];
      const rest = Array.isArray(args[1]) ? args[1] : [];
      const cmd = String(typeof target === 'string' ? target : (target && target.command) || '');
      emit({
        kind: 'spawn',
        via: 'child_process.' + name,
        cmd: trunc([cmd].concat(rest.map(String)).join(' '), 600),
      });
      return real.apply(cp, args);
    };
  }
}

/* ------------------------------------------------------------------ */
/* raw sockets / UDP: BLOCK + record — interception would not hold     */
/* ------------------------------------------------------------------ */

const net = require('net');
const tls = require('tls');
const block = (what, detail) => {
  emit({ kind: 'blocked', what, detail: trunc(detail || '', 200) });
  const err = new Error('[pitstop-pen] blocked raw ' + what + ' — it would bypass interception');
  err.code = 'PITSTOP_PEN_BLOCKED_CONNECT';
  throw err;
};
net.connect = function (...a) {
  return block('net.connect', hostOf(typeof a[0] === 'object' && a[0] ? (a[0].host || a[0].port) : a[0]));
};
net.createConnection = function (...a) {
  return block('net.createConnection', hostOf(typeof a[0] === 'object' && a[0] ? (a[0].host || a[0].port) : a[0]));
};
net.Socket.prototype.connect = function (...a) {
  return block('net.Socket.connect', hostOf(typeof a[0] === 'object' && a[0] ? (a[0].host || a[0].port) : a[0]));
};
tls.connect = function (...a) {
  return block('tls.connect', hostOf(typeof a[0] === 'object' && a[0] ? (a[0].host || a[0].port) : a[0]));
};

try {
  const dgram = require('dgram');
  dgram.Socket.prototype.send = function (...a) {
    return block('dgram.Socket.send', String(a[1] || ''));
  };
} catch (_) {
  /* dgram absent */
}

emit({ event: 'armed', note: 'pitstop pen sandbox armed — outbound HTTP intercepted, raw sockets blocked' });
console.error('[pitstop-pen] sandbox armed — all outbound HTTP is intercepted and recorded; raw sockets are blocked');
