import { runReproLocal } from "../repro/run.js";
// Internal container entrypoint. The host never invokes the local attack engines.
import fs from "node:fs";
import path from "node:path";
import { safeEvidenceName } from "./container.js";
import { runDynamicLocal } from "../pen/dynamic.js";
import { runLedgerLocal } from "../analyzers/ledger/index.js";

// A deadline inside PID 1 also kills the container if the host CLI disconnects.
const watchdog = setTimeout(() => process.exit(124), 180000);
watchdog.unref();
const request = JSON.parse(fs.readFileSync("/input/request.json", "utf8"));
fs.cpSync("/input/repo", "/work/repo", { recursive: true });
process.chdir("/work/repo");
process.env.PITSTOP_OS_SANDBOX = "docker";
if (request.start) process.env.PITSTOP_START = request.start;
const result = request.kind === "pen" ? await runDynamicLocal("/work/repo", request.routes)
  : request.kind === "ledger" ? await runLedgerLocal("/work/repo")
  : request.kind === "repro" ? await runReproLocal("/work/repo", request.routes.file) : null;
const dir = "/work/repo/.pitstop";
const artifacts: { name: string; source: string; content: string }[] = [];
const collect = (folder: string) => {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const p = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { if (folder !== dir || ["pen", "ledger"].includes(entry.name)) collect(p); continue; }
    const name = path.relative(dir, p).replaceAll("/", "-");
    if (!safeEvidenceName(name) || !entry.isFile() || fs.statSync(p).size > 4 * 1024 * 1024) continue;
    artifacts.push({ name, source: p, content: fs.readFileSync(p, "utf8") });
  }
};
if (fs.existsSync(dir)) collect(dir);
process.stdout.write(JSON.stringify({ schema: 1, result, artifacts }));
