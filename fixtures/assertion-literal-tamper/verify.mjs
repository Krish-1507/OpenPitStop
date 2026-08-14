// Verify the assertionLiteralTamper detector end to end:
//
//   scenario 1 (cheat)  — a diff that ONLY changes expected literals in test
//                         files (8.08 -> 8.07, the half-cent bug) must yield
//                         verdict CONFIRMED_CHEAT / exit 2, with the finding
//                         marked confirmed.
//   scenario 2 (honest) — the same literal change accompanied by a real logic
//                         change in src/ must NOT be flagged (verdict CLEAN).
//
// Run:  node fixtures/assertion-literal-tamper/verify.mjs   (after npm run build)
// The fixture repos are created under os.tmpdir(), which on this Windows box
// is an 8.3 short path (C:\Users\KRISH_~1\...) — exercising path handling too.
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, "../../dist/cli.js");
if (!fs.existsSync(cli)) {
  console.error("dist/cli.js missing — run `npm run build` first");
  process.exit(1);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function mkRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pitstop-alit-${name}-`));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "fixture@pitstop.local"]);
  git(dir, ["config", "user.name", "OpenPitStop Fixture"]);
  git(dir, ["config", "core.autocrlf", "true"]);
  return dir;
}

function commitBaseline(dir) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "baseline"]);
}

function applyChange(dir, srcDir) {
  fs.cpSync(path.join(here, srcDir), dir, { recursive: true });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "change"]);
}

function integrityResult(dir) {
  let exit = 0;
  try {
    execFileSync(process.execPath, [cli, "integrity", "--from", "HEAD~1", "--to", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    exit = e.status ?? -1;
  }
  const reportsDir = path.join(dir, ".pitstop");
  let report = null;
  if (fs.existsSync(reportsDir)) {
    const files = fs
      .readdirSync(reportsDir)
      .filter((f) => f.startsWith("integrity-") && f.endsWith(".json"))
      .sort();
    if (files.length) {
      report = JSON.parse(fs.readFileSync(path.join(reportsDir, files[files.length - 1]), "utf8"));
    }
  }
  return { exit, report };
}

let failed = 0;
const check = (name, cond, extra) => {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.error(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

// ---- Scenario 1: pure expected-literal swap in test files (the cheat) ----
const cheat = mkRepo("cheat");
fs.cpSync(path.join(here, "baseline"), cheat, { recursive: true });
commitBaseline(cheat);
applyChange(cheat, "cheat");
const c1 = integrityResult(cheat);
const litFindings = (c1.report?.findings ?? []).filter(
  (f) => f.detector === "assertionLiteralTamper",
);
check(
  "cheat: verdict is CONFIRMED_CHEAT (exit 2)",
  c1.exit === 2 && c1.report?.verdict === "CONFIRMED_CHEAT",
  `exit=${c1.exit} verdict=${c1.report?.verdict}`,
);
check(
  "cheat: detector fired with confirmed confidence",
  litFindings.length === 2 &&
    litFindings.every((f) => f.confidence === "confirmed") &&
    litFindings.every((f) => f.pattern === "assertion-expected-value-changed"),
  `findings=${JSON.stringify(litFindings.map((f) => [f.file, f.confidence]))}`,
);
check(
  "cheat: both JS and Python files flagged with the swap details",
  litFindings.some((f) => f.file === "test/money.test.js" && f.evidence.includes("8.08 to 8.07")) &&
    litFindings.some((f) => f.file === "test/test_money.py" && f.evidence.includes("8.08 to 8.07")),
  JSON.stringify(litFindings.map((f) => f.evidence)),
);

// ---- Scenario 2: literal change WITH a real logic change (honest spec) ----
const honest = mkRepo("honest");
fs.cpSync(path.join(here, "baseline"), honest, { recursive: true });
commitBaseline(honest);
applyChange(honest, "honest");
const c2 = integrityResult(honest);
check(
  "honest: verdict is CLEAN (exit 0) — logic change elsewhere suppresses the flag",
  c2.exit === 0 && c2.report?.verdict === "CLEAN" && (c2.report?.findings ?? []).length === 0,
  `exit=${c2.exit} verdict=${c2.report?.verdict} findings=${c2.report?.findings?.length ?? 0}`,
);

console.log("");
if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All assertion-literal-tamper checks passed.");
