'use strict';

/**
 * OpenPitStop `scan --ledger` HTTP sandbox (CommonJS preload).
 *
 * Loaded into the app-under-test via `NODE_OPTIONS=--require=<this file>`, i.e.
 * BEFORE the app's own modules, so every outbound HTTP request is intercepted by
 * nock before a single byte can reach a real payment gateway.
 *
 * SAFETY CONTRACT (this file is the enforcement point):
 *   1. `nock.disableNetConnect()` — any http/https request to a host that is not
 *      explicitly mocked below throws `NetConnectNotAllowedError` and the
 *      connection never happens. Nothing reaches the real network.
 *   2. Any request to an unmocked host, any child-process spawn, any raw socket
 *      (net/tls), any UDP send, or any global `fetch` to a non-local host is a
 *      signal that the app does something we cannot guarantee to intercept.
 *      In every such case we write an `abort` event to the control stream and
 *      exit the process (code 77) — ledger mode is never allowed to keep going
 *      when interception is not airtight.
 *
 * Everything recorded here is written as JSONL to
 * `PITSTOP_LEDGER_GATEWAY_LOG` (the "mocked gateway's" receipt ledger) and to
 * `PITSTOP_LEDGER_CONTROL` (the harness's control/abort stream).
 */

const fs = require('fs');

const CONTROL = process.env.PITSTOP_LEDGER_CONTROL || null;
const GATEWAY_LOG = process.env.PITSTOP_LEDGER_GATEWAY_LOG || null;
const HOSTS = (process.env.PITSTOP_LEDGER_GATEWAY_HOSTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CHARGE_RE = new RegExp(
  process.env.PITSTOP_LEDGER_CHARGE_RE ||
    '(?:^|/)(payments|charges|payment_intents|paymentintents|captures?|transactions)(/|$|\\?)',
  'i',
);

let aborted = false;

function writeJsonl(file, obj) {
  if (!file) return;
  try {
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (_) {
    /* best-effort: if we cannot even log, do not risk continuing */
  }
}

function emit(event) {
  writeJsonl(CONTROL, Object.assign({ at: new Date().toISOString() }, event));
}

/** Unrecoverable safety trip: record it, scream, and die. Never continue. */
function abort(reason) {
  if (aborted) return;
  aborted = true;
  emit({ event: 'abort', reason });
  console.error('[pitstop-ledger] ABORT: ' + reason);
  setTimeout(() => process.exit(77), 0);
}

/* ------------------------------------------------------------------ */
/* nock: the only sanctioned way out of the process is a mocked reply  */
/* ------------------------------------------------------------------ */

let nock;
try {
  nock = require('nock');
} catch (_) {
  abort(
    'nock is not resolvable from the ledger preload — outbound HTTP cannot be ' +
      'guaranteed to be intercepted; refusing to run ledger mode',
  );
}

nock.disableNetConnect();

nock.emitter.on('no match', (req) => {
  const host = (req && (req.hostname || req.host)) || 'unknown';
  abort(
    'outbound request to host ' +
      host +
      ' has no mock — it would require real network access; aborting ledger mode',
  );
});

function safeBody(b) {
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (_) {
      return { raw: b };
    }
  }
  return b;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

function deriveKey(req, body) {
  const h = req.headers || {};
  for (const name of [
    'idempotency-key',
    'x-idempotency-key',
    'idempotency',
    'x-idempotency',
    'x-razorpay-idempotency',
  ]) {
    const v = getHeader(h, name);
    if (v != null && v !== '') return String(v);
  }
  const oid = body && (body.order_id || body.orderId || body.reference_id);
  if (oid != null) return String(oid);
  const m = String(req.path || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .match(/\/(payments|charges|payment_intents|transactions)\/([^/]+)/i);
  if (m) return m[2];
  return null;
}

function isCharge(req) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const p = String(req.path || req.url || '');
  return CHARGE_RE.test(p);
}

let seq = 0;
function nextId(prefix) {
  seq += 1;
  return (prefix || 'req') + '_' + Date.now().toString(36) + '_' + seq;
}

/** Build a plausible gateway success response for the host being called. */
function gatewaySuccess(host, req, body, record) {
  const amount = body && body.amount != null ? body.amount : 1000;
  const currency = (body && body.currency) || 'INR';
  const h = String(host).toLowerCase();

  if (h.includes('razorpay')) {
    return {
      id: 'pay_' + record.requestId,
      entity: 'payment',
      amount,
      currency,
      status: /capture|settle/i.test(record.path) ? 'captured' : 'authorized',
      order_id: (body && body.order_id) || null,
      method: 'card',
      vpa: null,
      created_at: Date.now() / 1000,
    };
  }
  if (h.includes('stripe')) {
    return {
      id: 'ch_' + record.requestId,
      object: 'charge',
      amount,
      currency: currency.toLowerCase(),
      status: 'succeeded',
      paid: true,
      captured: true,
      requestId: record.requestId,
      created: Date.now() / 1000,
    };
  }
  if (h.includes('braintree')) {
    return {
      id: record.requestId,
      object: 'transaction',
      status: 'settled',
      amount: String((Number(amount) || 0) / 100),
      currencyIsoCode: currency,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: record.requestId,
    object: 'payment',
    status: 'succeeded',
    amount,
    currency,
  };
}

function arm(host) {
  const scope = nock(host).persist();
  const methodArmed = {};
  const armMethod = (method) => {
    if (methodArmed[method]) return;
    methodArmed[method] = true;
    scope[method.toLowerCase()](/.*/).reply(function (uri, requestBody) {
        const req = this.req;
        if (req && !req.headers) {
          try {
            req.headers = req.getHeaders();
          } catch (_) {
            req.headers = {};
          }
        }
        const body = safeBody(requestBody);
        const record = {
          at: new Date().toISOString(),
          host,
          method: String((req && req.method) || method).toUpperCase(),
          path: uri,
          key: deriveKey(req, body),
          orderId:
            (body && (body.order_id || body.orderId || body.reference_id)) || null,
          requestId: nextId('req'),
          requestHeaders: (req && req.headers) || {},
          requestBody: body,
        };
        record.charge = isCharge(req);
        const respBody = gatewaySuccess(host, req, body, record);
        record.responseStatus = 200;
        record.responseBody = respBody;
        writeJsonl(GATEWAY_LOG, record);
        emit({ event: 'gateway-call', charge: record.charge, key: record.key, host });
        return [200, respBody];
      });
  };
  for (const m of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) armMethod(m);
}

for (const host of HOSTS) {
  if (!host) continue;
  try {
    arm(host);
  } catch (e) {
    abort('failed to arm mock for ' + host + ': ' + (e && e.message));
  }
}

/* ------------------------------------------------------------------ */
/* Out-of-band channels nock cannot see — each one aborts ledger mode   */
/* ------------------------------------------------------------------ */

// Native binaries (curl, wget, gh, ...) would bypass nock entirely.
const cp = require('child_process');
for (const m of ['exec', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  if (typeof cp[m] === 'function') {
    const name = m;
    cp[m] = function (...args) {
      abort(
        'ledger sandbox blocks child_process.' +
          name +
          '(' +
          String(args[0] || '') +
          ') — native tools cannot be intercepted; aborting ledger mode',
      );
      const err = new Error('[pitstop-ledger] blocked external process spawn');
      err.code = 'PITSTOP_LEDGER_BLOCKED_SPAWN';
      throw err;
    };
  }
}

// Raw sockets (net/tls) bypass nock.
const net = require('net');
const tls = require('tls');
const block = (what) => {
  abort(
    'ledger sandbox blocks a raw ' +
      what +
      ' — such a connection cannot be intercepted by nock; aborting ledger mode',
  );
  const err = new Error('[pitstop-ledger] blocked raw ' + what);
  err.code = 'PITSTOP_LEDGER_BLOCKED_SOCKET';
  throw err;
};
net.connect = function () {
  return block('net.connect');
};
net.createConnection = function () {
  return block('net.createConnection');
};
net.Socket.prototype.connect = function () {
  return block('net.Socket.connect');
};
tls.connect = function () {
  return block('tls.connect');
};

// Undici / global fetch bypasses nock's ClientRequest interception.
if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async function (input, init) {
    let u = null;
    try {
      u = new URL(typeof input === 'string' ? input : (input && input.url) || 'http://localhost/');
    } catch (_) {
      u = null;
    }
    if (u && !(u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '::1')) {
      abort(
        'global fetch to external host ' + u.href + ' cannot be intercepted by nock; aborting ledger mode',
      );
      throw new Error('[pitstop-ledger] blocked external fetch');
    }
    return realFetch.call(globalThis, input, init);
  };
}

// UDP sends bypass nock.
try {
  const dgram = require('dgram');
  dgram.Socket.prototype.send = function () {
    return block('dgram.Socket.send');
  };
} catch (_) {
  /* dgram absent — nothing to block */
}

emit({
  event: 'armed',
  hosts: HOSTS,
  gatewayLog: GATEWAY_LOG,
});
console.error(
  '[pitstop-ledger] sandbox armed; mocked hosts: ' + (HOSTS.join(', ') || '(none)'),
);
