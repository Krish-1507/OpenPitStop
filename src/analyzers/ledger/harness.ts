import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { detectLanguage } from "../util.js";
import { startRecordingProxy, type RecordingProxy } from "../../sandbox/proxy.js";
import {
  isNodeCommand,
  resolveNativeStart,
  resolveNodeStart,
  type StartCommand,
} from "../../sandbox/startCmd.js";
import type { Harness, HarnessResult } from "./types.js";

const STARTUP_TIMEOUT_MS = 25_000;

/** Absolute path of the nock sandbox preload that ships with the package. */
function preloadPath(): string {
  return fileURLToPath(
    new URL("../../../templates/ledger/preload.cjs", import.meta.url),
  );
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

async function waitForServer(
  baseUrl: string,
  exited: () => boolean,
  controlPath: string,
  timeoutMs: number,
): Promise<{ up: boolean; aborted: boolean }> {
  const deadline = Date.now() + timeoutMs;
  const armed = async () => {
    if (!fs.existsSync(controlPath)) return false;
    try {
      return fs
        .readFileSync(controlPath, "utf8")
        .split(/\r?\n/)
        .some((l) => l.includes('"event":"armed"'));
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline) {
    const aborted = controlAborted(controlPath);
    if (aborted) return { up: false, aborted: true };
    if (exited()) {
      return { up: false, aborted: controlAborted(controlPath) };
    }
    if ((await armed()) && baseUrl) {
      try {
        const res = await fetch(`${baseUrl}/__pitstop_ledger_probe__`);
        if (res) return { up: true, aborted: false };
      } catch {
        /* not up yet */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { up: false, aborted: controlAborted(controlPath) };
}

function controlAborted(controlPath: string): boolean {
  if (!fs.existsSync(controlPath)) return false;
  try {
    return fs
      .readFileSync(controlPath, "utf8")
      .split(/\r?\n/)
      .some((l) => l.includes('"event":"abort"'));
  } catch {
    return false;
  }
}

export async function startHarness(
  repo: string,
  gatewayHosts: string[],
): Promise<HarnessResult> {
  const lang = detectLanguage(repo);
  const nodeMode = lang === "js";

  // Java/Dart clients do not honor HTTP_PROXY by default — a proxy sandbox
  // there cannot claim to intercept gateway traffic, so refuse honestly.
  if (lang === "unknown") {
    return {
      harness: null,
      aborted: true,
      abortReason: "could not identify the repo language — refusing to run ledger mode",
    };
  }
  if (!nodeMode && (lang === "java" || lang === "dart")) {
    return {
      harness: null,
      aborted: true,
      abortReason:
        `--ledger cannot guarantee interception for ${lang} apps: ${lang} HTTP clients do not honor ` +
        "HTTP_PROXY by default, and the nock preload cannot load into a non-Node process. " +
        "Run ledger mode on a Node/JS, Go, Python, Rust, or .NET app.",
    };
  }

  const workDir = path.join(repo, ".pitstop", "ledger");
  fs.mkdirSync(workDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(workDir, `run-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });

  const gatewayLogPath = path.join(runDir, "gateway.log.jsonl");
  const controlPath = path.join(runDir, "control.jsonl");
  const appOut = path.join(runDir, "app.out.log");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  let start: StartCommand | null = null;
  try {
    if (nodeMode) {
      start = resolveNodeStart(repo);
      if (!isNodeCommand(start.cmd)) {
        return {
          harness: null,
          aborted: true,
          abortReason:
            `start script runs "${start.cmd}", which is not a Node-based runtime — ` +
            "outbound HTTP from it cannot be guaranteed to be intercepted; refusing to run ledger mode",
        };
      }
    } else {
      start = resolveNativeStart(repo, lang, port);
    }
  } catch (e) {
    return {
      harness: null,
      aborted: false,
      abortReason: (e as Error).message,
    };
  }
  if (!start) {
    return {
      harness: null,
      aborted: false,
      abortReason:
        `could not determine a start command for a ${lang} repo — set PITSTOP_START ` +
        `(e.g. "PITSTOP_START=uvicorn app.main:app") and re-run`,
    };
  }

  // Non-Node sandbox: HTTP(S)_PROXY recording proxy that mocks the gateway
  // hosts and writes receipts to the same gateway.log.jsonl contract.
  let proxy: RecordingProxy | null = null;
  if (!nodeMode) {
    try {
      proxy = await startRecordingProxy({
        logPath: path.join(runDir, "outbound.jsonl"),
        controlPath,
        gatewayLogPath,
        gatewayHosts,
        canarySuffix: "pitstop.invalid",
      });
    } catch (e) {
      return {
        harness: null,
        aborted: true,
        abortReason: `could not start the recording proxy: ${(e as Error).message}`,
      };
    }
  } else if (!fs.existsSync(preloadPath())) {
    return {
      harness: null,
      aborted: true,
      abortReason: `ledger preload missing at ${preloadPath()}; cannot guarantee interception`,
    };
  }

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PITSTOP_LEDGER_CONTROL: controlPath,
    PITSTOP_LEDGER_GATEWAY_LOG: gatewayLogPath,
    PITSTOP_LEDGER_GATEWAY_HOSTS: gatewayHosts.join(","),
    // Fake credentials — requests are intercepted before they reach a real gateway.
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

  // execa's subprocess is a promise (never rejects with `reject: false`);
  // track completion so the poll loop can detect an early exit.
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

  const { up, aborted } = await waitForServer(
    baseUrl,
    () => exited,
    controlPath,
    STARTUP_TIMEOUT_MS,
  );

  if (!up) {
    const reason =
      (controlAborted(controlPath) ? readAbortReason(controlPath) : null) ??
      `app did not come up within ${STARTUP_TIMEOUT_MS / 1000}s (start: "${start.cmd} ${start.args.join(" ")}")`;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    if (proxy) proxy.close().catch(() => {});
    return { harness: null, aborted, abortReason: reason };
  }

  const harness: Harness = {
    port,
    baseUrl,
    gatewayLogPath,
    controlPath,
    close: () =>
      new Promise<void>((resolve) => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        fs.closeSync(outFd);
        if (proxy) proxy.close().catch(() => {});
        resolve();
      }),
  };
  return { harness, aborted: false };
}

export function newEvidencePath(repo: string, ts: string): string {
  return path.join(repo, ".pitstop", `ledger-evidence-${ts}.json`);
}

export function readAbortReason(controlPath: string): string | null {
  try {
    for (const line of fs.readFileSync(controlPath, "utf8").split(/\r?\n/)) {
      try {
        const e = JSON.parse(line);
        if (e.event === "abort" && e.reason) return e.reason;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}