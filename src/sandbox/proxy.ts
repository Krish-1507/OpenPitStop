import http from "node:http";
import net from "node:net";
import fs from "node:fs";

/**
 * sandbox/proxy.ts — HTTP(S)_PROXY recording proxy for non-Node apps.
 *
 * The Node sandbox (preload.cjs + nock) cannot load into Go/Rust/Python/.NET
 * processes. For those stacks OpenPitStop boots the app with HTTP_PROXY /
 * HTTPS_PROXY pointed at this in-process proxy:
 *
 *   - every non-loopback outbound request is recorded (JSONL, same shape the
 *     Node sandbox writes) and NEVER forwarded anywhere real;
 *   - payment-gateway hosts are answered with a mocked success receipt and the
 *     call is written to the ledger gateway log (identical LedgerChargeCall
 *     shape, so evidence.ts is unchanged);
 *   - SSRF canary hosts are answered and recorded as outbound events;
 *   - every other host gets a 502 — nothing real ever leaves the machine.
 *
 * HONEST CAVEATS (labeled in every report that uses this proxy):
 *   - only apps whose HTTP clients honor HTTP_PROXY are intercepted (Go,
 *     Python, Rust, .NET by default; Java/Dart do not by default);
 *   - native binaries (curl subprocesses) and raw sockets bypass the proxy
 *     entirely and are NOT observed;
 *   - HTTPS is a CONNECT tunnel: without a trusted CA we cannot terminate it,
 *     so https gateway calls are blocked (502) and recorded as blocked —
 *     a double-charge over HTTPS therefore cannot be proven via this proxy.
 */

export interface ProxyOptions {
  /** JSONL outbound event stream (same shape as the Node sandbox's). */
  logPath: string;
  /** Optional control stream: writes `{event:"armed"}` and `{event:"gateway-call"}`. */
  controlPath?: string;
  /** Optional ledger gateway receipt stream (LedgerChargeCall JSONL). */
  gatewayLogPath?: string;
  /** Hosts that receive mocked gateway success responses. */
  gatewayHosts: string[];
  /** Host suffix treated as a canary (e.g. "pitstop.invalid"). */
  canarySuffix: string;
}

export interface RecordingProxy {
  port: number;
  close(): Promise<void>;
}

const CHARGE_RE =
  /(?:^|\/)(payments|charges|payment_intents|paymentintents|captures?|transactions)(\/|$|\?)/i;

function getHeader(headers: http.IncomingHttpHeaders, name: string): unknown {
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return undefined;
}

function deriveKey(method: string, path: string, headers: http.IncomingHttpHeaders, body: unknown): string | null {
  for (const name of [
    "idempotency-key",
    "x-idempotency-key",
    "idempotency",
    "x-idempotency",
    "x-razorpay-idempotency",
  ]) {
    const v = getHeader(headers, name);
    if (v != null && v !== "") return String(v);
  }
  const b = body as Record<string, unknown> | null;
  const oid = b && (b.order_id ?? b.orderId ?? b.reference_id);
  if (oid != null) return String(oid);
  const m = String(path).match(/\/(payments|charges|payment_intents|transactions)\/([^/]+)/i);
  if (m) return m[2];
  return null;
}

function isCharge(method: string, path: string): boolean {
  const u = String(method).toUpperCase();
  if (u === "GET" || u === "HEAD" || u === "OPTIONS") return false;
  return CHARGE_RE.test(String(path));
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return (prefix || "req") + "_" + Date.now().toString(36) + "_" + seq;
}

function safeBody(raw: unknown): unknown {
  if (Buffer.isBuffer(raw)) raw = raw.toString("utf8");
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  return raw;
}

function gatewaySuccess(host: string, method: string, path: string, body: unknown, requestId: string): Record<string, unknown> {
  const b = body as Record<string, unknown> | null;
  const amount = b && b.amount != null ? b.amount : 1000;
  const currency = (b && b.currency) || "INR";
  const h = String(host).toLowerCase();

  if (h.includes("razorpay")) {
    return {
      id: "pay_" + requestId,
      entity: "payment",
      amount,
      currency,
      status: /capture|settle/i.test(path) ? "captured" : "authorized",
      order_id: (b && b.order_id) || null,
      method: "card",
      vpa: null,
      created_at: Date.now() / 1000,
    };
  }
  if (h.includes("stripe")) {
    return {
      id: "ch_" + requestId,
      object: "charge",
      amount,
      currency: String(currency).toLowerCase(),
      status: "succeeded",
      paid: true,
      captured: true,
      requestId,
      created: Date.now() / 1000,
    };
  }
  if (h.includes("braintree")) {
    return {
      id: requestId,
      object: "transaction",
      status: "settled",
      amount: String((Number(amount) || 0) / 100),
      currencyIsoCode: currency,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: requestId,
    object: "payment",
    status: "succeeded",
    amount,
    currency,
  };
}

export function startRecordingProxy(opts: ProxyOptions): Promise<RecordingProxy> {
  let seqOut = 0;
  const append = (file: string, obj: unknown): void => {
    try {
      fs.appendFileSync(file, JSON.stringify(obj) + "\n");
    } catch {
      /* best-effort */
    }
  };
  const logEvent = (kind: string, extra: Record<string, unknown>): void => {
    seqOut += 1;
    append(opts.logPath, {
      kind,
      n: seqOut,
      at: new Date().toISOString(),
      ...extra,
    });
  };
  const control = (event: Record<string, unknown>): void => {
    if (opts.controlPath) append(opts.controlPath, { at: new Date().toISOString(), ...event });
  };

  const isGateway = (host: string): boolean =>
    opts.gatewayHosts.some((g) => {
      const gh = g.replace(/^https?:\/\//i, "").toLowerCase();
      const h = host.toLowerCase();
      return h === gh || h.endsWith("." + gh);
    });
  const isCanary = (host: string): boolean => host.toLowerCase().endsWith(opts.canarySuffix.toLowerCase());
  const isLoopback = (host: string): boolean =>
    /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0)$/i.test(host);

  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "/", "http://localhost");
    } catch {
      res.writeHead(400);
      res.end("pitstop-proxy: unparseable request");
      return;
    }
    const host = target.hostname || String(req.headers.host ?? "").split(":")[0] || "unknown";
    const path = target.pathname + target.search;
    const method = String(req.method ?? "GET").toUpperCase();

    // Loopback targets (e.g. clients ignoring NO_PROXY): forward on-machine.
    if (isLoopback(host)) {
      const proxy = http.request(
        {
          host: target.hostname,
          port: target.port || (target.protocol === "https:" ? 443 : 80),
          method,
          path: target.pathname + target.search,
          headers: { ...req.headers, host: target.host },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.writeHead(502);
        res.end("pitstop-proxy: loopback forward failed");
      });
      req.pipe(proxy);
      return;
    }

    if (isCanary(host)) {
      logEvent("http", { host, method, path });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pitstop-canary-hit");
      return;
    }

    if (isGateway(host)) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = safeBody(Buffer.concat(chunks).toString("utf8"));
        const requestId = nextId("req");
        const record = {
          at: new Date().toISOString(),
          host,
          method,
          path,
          key: deriveKey(method, path, req.headers, body),
          orderId: (body as Record<string, unknown> | null)?.order_id ?? null,
          requestId,
          requestHeaders: { ...req.headers },
          requestBody: body,
          charge: isCharge(method, path),
          responseStatus: 200,
          responseBody: gatewaySuccess(host, method, path, body, requestId),
        };
        if (opts.gatewayLogPath) append(opts.gatewayLogPath, record);
        control({ event: "gateway-call", charge: record.charge, key: record.key, host });
        logEvent("http", { host, method, path });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(record.responseBody));
      });
      return;
    }

    // Unmocked host: blocked. No byte is forwarded anywhere real.
    logEvent("blocked", { host, method, path });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ pitstop: "blocked-unmocked-host", host }));
  });

  // HTTPS goes through CONNECT; without a trusted CA we cannot terminate the
  // tunnel, so every CONNECT is recorded and refused.
  server.on("connect", (req, socket) => {
    const host = String(req.url ?? "").split(":")[0] || "unknown";
    logEvent("blocked", { host, method: "CONNECT", path: req.url ?? "" });
    socket.write("HTTP/1.1 502 OpenPitStop Proxy Cannot Terminate TLS\r\n\r\n");
    socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      control({ event: "armed", mode: "proxy", port });
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
            setTimeout(() => r(), 1000);
          }),
      });
    });
  });
}
