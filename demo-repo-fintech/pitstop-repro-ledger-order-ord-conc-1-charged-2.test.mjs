// ==============================================================================
// OpenPitStop permanent repro test — finding ledger-18f7bcc7
// Linked from .pitstop/scan-latest.json (issue / cluster finding id ledger-18f7bcc7).
//
// Scenario: concurrent-double-submit on /api/orders/:id/charge
//   order ord_conc_1 · idempotency key idem_conc_1
//   Gateway contract: exactly ONE charge for key "pay_idem_conc_1"
//   (observed now: 2 charges — the bug this test exists to guard).
//
// Run via: npx openpitstop repro ledger-18f7bcc7
// The app is booted under OpenPitStop's nock sandbox, so no request can ever reach
// a real payment gateway; the "gateway" is a local mock that records every call.
// This test MUST FAIL on the buggy code and MUST PASS only after the fix.
// ==============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

const REPO = process.cwd();
const PRELOAD = process.env.PITSTOP_LEDGER_PRELOAD;
const GATEWAY_HOST = "https://api.razorpay.com";
const ENDPOINT = "/api/orders/:id/charge";
const SCENARIO = "concurrent-double-submit";
const ORDER_ID = "ord_conc_1";
const IDEM_KEY = "idem_conc_1";
const EXPECTED_KEY = "pay_idem_conc_1";
const AMOUNT = 1000;
const CURRENCY = "INR";
const NODE_BASED = new Set(["node","node.exe","nodejs","npm","npm.cmd","npx","npx.cmd","yarn","yarn.cmd","pnpm","pnpm.cmd","tsx","ts-node","babel-node","ojs","vitest","jest"]);

import { spawn } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveStart() {
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
  const start = (pkg.scripts && pkg.scripts.start) || "";
  if (!start) throw new Error("no start script in package.json");
  const tokens = start.trim().split(/\s+/);
  if (!NODE_BASED.has(tokens[0])) {
    throw new Error("start script runs " + tokens[0] + ", which is not Node-based — refusing");
  }
  return { cmd: tokens[0], args: tokens.slice(1) };
}

function resolvePath(route, orderId) {
  return route
    .replace(/:([A-Za-z_][\w-]*)/g, (_, name) => (/id|order/i.test(name) ? orderId : name))
    .replace(/\{([A-Za-z_][\w-]*)\}/g, (_, name) => (/id|order/i.test(name) ? orderId : name));
}

async function post(baseUrl, p, body, headers) {
  try {
    const res = await fetch(baseUrl + p, { method: "POST", headers, body: JSON.stringify(body) });
    await res.text().catch(() => "");
    return res.status;
  } catch {
    return 0;
  }
}

function controlHas(controlPath, needle) {
  if (!existsSync(controlPath)) return false;
  try {
    return readFileSync(controlPath, "utf8").split(/\r?\n/).some((l) => l.includes(needle));
  } catch {
    return false;
  }
}

function countCharges(gatewayLogPath) {
  if (!existsSync(gatewayLogPath)) return [];
  const out = [];
  for (const line of readFileSync(gatewayLogPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e.charge && e.key === EXPECTED_KEY) out.push(e);
    } catch {}
  }
  return out;
}

test("pitstop repro ledger-18f7bcc7: exactly one gateway charge for key '" + EXPECTED_KEY + "'", async () => {
  assert.ok(PRELOAD, "PITSTOP_LEDGER_PRELOAD not set — run this via `npx openpitstop repro ledger-18f7bcc7`");

  const start = resolveStart();
  const runDir = path.join(REPO, ".pitstop", "repro", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(runDir, { recursive: true });
  const controlPath = path.join(runDir, "control.jsonl");
  const gatewayLogPath = path.join(runDir, "gateway.log.jsonl");
  const port = await freePort();
  const baseUrl = "http://127.0.0.1:" + port;

  const env = {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--require=" + PRELOAD].filter(Boolean).join(" "),
    PORT: String(port),
    PITSTOP_LEDGER_CONTROL: controlPath,
    PITSTOP_LEDGER_GATEWAY_LOG: gatewayLogPath,
    PITSTOP_LEDGER_GATEWAY_HOSTS: GATEWAY_HOST,
    RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID || "rzp_test_pitstop000000",
    RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET || "pitstop_fake_secret",
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || "sk_test_pitstop_fake",
    NODE_ENV: process.env.NODE_ENV || "test",
  };
  const child = spawn(start.cmd, start.args, { cwd: REPO, env, stdio: ["ignore", "ignore", "inherit"] });
  try {
    const deadline = Date.now() + 25000;
    let up = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (controlHas(controlPath, '"event":"armed"')) {
        try {
          await fetch(baseUrl + "/__pitstop_ledger_probe__");
          up = true;
          break;
        } catch {}
      }
      await sleep(150);
    }
    assert.ok(up, "app did not come up under the sandbox within 25s (" + start.cmd + " " + start.args.join(" ") + ")");
    assert.ok(!controlHas(controlPath, '"event":"abort"'), "sandbox aborted during startup");

    if (SCENARIO === "concurrent-double-submit" || SCENARIO === "delayed-retry") {
      const reqBody = { amount: AMOUNT, currency: CURRENCY };
      const headers = { "Content-Type": "application/json", ...(IDEM_KEY ? { "Idempotency-Key": IDEM_KEY } : {}) };
      const p = resolvePath(ENDPOINT, ORDER_ID);
      if (SCENARIO === "concurrent-double-submit") {
        await Promise.all([post(baseUrl, p, reqBody, headers), post(baseUrl, p, reqBody, headers)]);
      } else {
        await post(baseUrl, p, reqBody, headers);
        await sleep(2000);
        await post(baseUrl, p, reqBody, headers);
      }
    } else {
      const payload = {
        event: "payment.captured",
        id: ORDER_ID + "_evt",
        payload: { payment: { entity: { id: EXPECTED_KEY, amount: AMOUNT, currency: CURRENCY, order_id: ORDER_ID } } },
      };
      const headers = { "Content-Type": "application/json" };
      await post(baseUrl, ENDPOINT, payload, headers);
      await sleep(300);
      await post(baseUrl, ENDPOINT, payload, headers);
    }

    await sleep(400);
    assert.ok(!controlHas(controlPath, '"event":"abort"'), "sandbox aborted during the attack");
    const charges = countCharges(gatewayLogPath);
    assert.equal(
      charges.length,
      1,
      "expected exactly 1 gateway charge for key '" + EXPECTED_KEY + "', saw " + charges.length +
      ". This repro proves the idempotency bug: it FAILS on the buggy code and must PASS only after the fix.",
    );
  } finally {
    try { child.kill(); } catch {}
  }
});
