import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seal } from "../src/evidence.js";
import { snapshotRepo, scanInputs, checkScanReuse, SCAN_CACHE_MAX_AGE_MS } from "../src/scanCache.js";
import { readyCheck } from "../src/commands/readyCheck.js";
import { reuseScan } from "../src/commands/scan.js";

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-cache-"));
  fs.writeFileSync(path.join(repo, "source.js"), "original");
  fs.mkdirSync(path.join(repo, ".github"));
  fs.writeFileSync(path.join(repo, ".github", "CODEOWNERS"), "* @owner");
  return repo;
}
function save(repo: string, overrides: Record<string, unknown> = {}) {
  const scan = { repo, timestamp: new Date().toISOString(), mode: "full", cache: { schema: 1, inputs: scanInputs(), snapshot: snapshotRepo(repo) }, ...overrides };
  fs.mkdirSync(path.join(repo, ".pitstop"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".pitstop", "scan-latest.json"), JSON.stringify(seal(scan, "cache fixture")));
}

test("unchanged content can be reused; touching the timestamp does not invalidate it", () => {
  const repo = fixture();
  try {
    save(repo);
    fs.utimesSync(path.join(repo, "source.js"), new Date(), new Date());
    assert.ok(reuseScan(repo));
    assert.equal(readyCheck(repo).ready, true);
    fs.writeFileSync(path.join(repo, ".pitstop", "report.json"), "generated");
    assert.ok(reuseScan(repo));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test("deletions, additions, dot-directory changes and backdated edits invalidate reuse", () => {
  for (const mutation of ["delete", "add", "dot", "backdate"]) {
    const repo = fixture();
    try {
      save(repo);
      const file = path.join(repo, "source.js");
      if (mutation === "delete") fs.unlinkSync(file);
      if (mutation === "add") fs.writeFileSync(path.join(repo, "added.js"), "new");
      if (mutation === "dot") fs.appendFileSync(path.join(repo, ".github", "CODEOWNERS"), "\n/auth @security");
      if (mutation === "backdate") { fs.writeFileSync(file, "changed!"); fs.utimesSync(file, 1, 1); }
      assert.equal(reuseScan(repo), null, mutation);
      assert.equal(readyCheck(repo).ready, false, mutation);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  }
});

test("tampered, quick, expired, ledger and differently configured scans are never reused", () => {
  const repo = fixture();
  try {
    for (const overrides of [{ mode: "try" }, { cache: undefined }, { timestamp: new Date(Date.now() - SCAN_CACHE_MAX_AGE_MS - 1000).toISOString() }]) {
      save(repo, overrides);
      assert.equal(reuseScan(repo), null);
    }
    save(repo);
    assert.equal(reuseScan(repo, { reliabilityRuns: 1 }), null);
    assert.equal(reuseScan(repo, { ledger: true }), null);
    const file = path.join(repo, ".pitstop", "scan-latest.json");
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    document.timestamp = new Date(Date.now() + 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(document));
    assert.match(checkScanReuse(repo).reason!, /evidence/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
