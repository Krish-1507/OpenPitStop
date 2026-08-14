import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { startRecordingProxy } from "../src/sandbox/proxy.js";

interface TestDir {
  dir: string;
  outbound: string;
  control: string;
  gateway: string;
}

function makeDir(): TestDir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-proxy-test-"));
  return {
    dir,
    outbound: path.join(dir, "outbound.jsonl"),
    control: path.join(dir, "control.jsonl"),
    gateway: path.join(dir, "gateway.jsonl"),
  };
}

function readLines(file: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no file yet */
  }
  return out;
}

function request(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers ?? {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test("proxy: canary hosts get the canary response and are recorded", async () => {
  const t = makeDir();
  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    controlPath: t.control,
    gatewayHosts: ["api.razorpay.com"],
    canarySuffix: "pitstop.invalid",
  });
  try {
    const res = await request(proxy.port, "http://ssrf.pitstop.invalid/admin", {});
    assert.equal(res.status, 200);
    assert.equal(res.text, "pitstop-canary-hit");
    const events = readLines(t.outbound);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "http");
    assert.equal(events[0].host, "ssrf.pitstop.invalid");
  } finally {
    await proxy.close();
  }
});

test("proxy: unmocked hosts are blocked with 502 and recorded, never forwarded", async () => {
  const t = makeDir();
  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    gatewayHosts: [],
    canarySuffix: "pitstop.invalid",
  });
  try {
    const res = await request(proxy.port, "http://example.com/anything", {});
    assert.equal(res.status, 502);
    const events = readLines(t.outbound);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "blocked");
    assert.equal(events[0].host, "example.com");
  } finally {
    await proxy.close();
  }
});

test("proxy: gateway hosts get a mocked success receipt and a ledger gateway log entry", async () => {
  const t = makeDir();
  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    controlPath: t.control,
    gatewayLogPath: t.gateway,
    gatewayHosts: ["https://api.razorpay.com"],
    canarySuffix: "pitstop.invalid",
  });
  try {
    const res = await request(proxy.port, "http://api.razorpay.com/v1/payments", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "key-abc" },
      body: JSON.stringify({ amount: 500, currency: "INR", order_id: "order_1" }),
    });
    assert.equal(res.status, 200);
    const receipt = JSON.parse(res.text);
    assert.match(receipt.id, /^pay_/);
    assert.equal(receipt.amount, 500);
    assert.equal(receipt.order_id, "order_1");

    const records = readLines(t.gateway);
    assert.equal(records.length, 1);
    assert.equal(records[0].charge, true);
    assert.equal(records[0].key, "key-abc");
    assert.equal(records[0].host, "api.razorpay.com");
    assert.equal((records[0].responseBody as { status: string }).status, "authorized");

    const control = readLines(t.control);
    assert.equal(control[0].event, "armed");
    assert.equal(control[1].event, "gateway-call");
    assert.equal(control[1].charge, true);
  } finally {
    await proxy.close();
  }
});

test("proxy: non-charge gateway paths are recorded with charge=false", async () => {
  const t = makeDir();
  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    gatewayLogPath: t.gateway,
    gatewayHosts: ["api.stripe.com"],
    canarySuffix: "pitstop.invalid",
  });
  try {
    await request(proxy.port, "http://api.stripe.com/v1/customers", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.c" }),
    });
    const records = readLines(t.gateway);
    assert.equal(records.length, 1);
    assert.equal(records[0].charge, false);
    assert.equal(records[0].key, null);
  } finally {
    await proxy.close();
  }
});

test("proxy: loopback requests are forwarded to the on-machine upstream", async () => {
  const t = makeDir();
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;

  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    gatewayHosts: [],
    canarySuffix: "pitstop.invalid",
  });
  try {
    const res = await request(proxy.port, `http://127.0.0.1:${upstreamPort}/health`, {});
    assert.equal(res.status, 200);
    assert.equal(res.text, "upstream-ok");
  } finally {
    await proxy.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  }
});

test("proxy: HTTPS CONNECT is refused with 502 and recorded as blocked", async () => {
  const t = makeDir();
  const proxy = await startRecordingProxy({
    logPath: t.outbound,
    gatewayHosts: [],
    canarySuffix: "pitstop.invalid",
  });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxy.port, "127.0.0.1", () => {
        sock.write("CONNECT api.stripe.com:443 HTTP/1.1\r\nHost: api.stripe.com:443\r\n\r\n");
      });
      sock.on("data", (d) => {
        sock.destroy();
        resolve(d.toString("utf8"));
      });
      sock.on("error", reject);
    });
    assert.match(reply, /^HTTP\/1\.1 502/);
    const events = readLines(t.outbound);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "blocked");
    assert.equal(events[0].method, "CONNECT");
  } finally {
    await proxy.close();
  }
});
