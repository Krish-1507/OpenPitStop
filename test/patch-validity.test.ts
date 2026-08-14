/**
 * patch-validity.test.ts — regression guard for the pen `--fix` patch bug:
 *
 * Hand-rolled hunks were rejected by `git apply` ("corrupt patch at line N")
 * in two ways that both shipped: a trailing blank line after the hunk, and
 * old-side context duplicated into the new side. `git apply` parses a hunk
 * where every ` ` line counts toward BOTH sides, so context must appear
 * ONCE, interleaved with `+` lines, and the patch must end with exactly one
 * newline.
 *
 * These tests are the contract: EVERY patch `insertionPatch` produces must
 * pass `git apply --check` on a real git repo — clean files, BOM'd first
 * lines, top-of-file and end-of-file insertions, multi-insertion hunks.
 * If a future refactor breaks the shape, this suite fails in CI.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { insertionPatch } from "../src/pen/fix.js";

const ORIGINAL = [
  "import x from \"x\";",
  "const app = express();",
  "line3",
  "line4",
  "line5",
];

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-patch-test-"));
  git(["init"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "core.autocrlf", "false"]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { code: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") };
  }
}

function applyCheck(patch: string): { code: number; stderr: string } {
  const p = path.join(tmp, "candidate.diff");
  fs.writeFileSync(p, patch, "utf8");
  const r = git(["apply", "--check", p]);
  return { code: r.code, stderr: r.stderr };
}

/** Write a file, commit it, apply a patch, and return the patched contents. */
function applyAndRead(name: string, original: string[], patch: string): { code: number; stderr: string; after: string[] } {
  fs.writeFileSync(path.join(tmp, name), original.join("\n") + "\n", "utf8");
  git(["add", "-A"]);
  git(["commit", "-m", "base"]);
  const p = path.join(tmp, "candidate.diff");
  fs.writeFileSync(p, patch, "utf8");
  const check = git(["apply", "--check", p]);
  if (check.code !== 0) return { code: check.code, stderr: check.stderr, after: [] };
  const apply = git(["apply", p]);
  if (apply.code !== 0) return { code: apply.code, stderr: apply.stderr, after: [] };
  const after = fs.readFileSync(path.join(tmp, name), "utf8").replace(/\r\n/g, "\n").split("\n");
  if (after[after.length - 1] === "") after.pop();
  return { code: 0, stderr: "", after };
}

test("structure: hunk math is self-consistent (regression: duplicated context + trailing blank line)", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [
    { after: 0, lines: ["import helmet from \"helmet\";"] },
    { after: 2, lines: ["app.use(helmet());", "app.disable(\"x-powered-by\");"] },
  ]);
  const lines = patch.split("\n");
  assert.equal(lines[lines.length - 1], "", "patch must end with exactly one trailing newline");
  const content = lines.slice(0, -1);
  const header = content.find((l) => l.startsWith("@@ ")) ?? "";
  const m = header.match(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
  assert.ok(m, `hunk header present: ${header}`);
  const [, , oldCount, , newCount] = m!.map(Number);
  const context = content.filter((l) => l.startsWith(" ") || l.startsWith("@@")).length - 1;
  const plus = content.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  assert.equal(context, oldCount, "every context line counts toward the old side — no duplicates");
  assert.equal(context + plus, newCount, "new side = context + insertions");
  assert.equal(content.filter((l) => l.startsWith("-") && !l.startsWith("---")).length, 0, "fixes never delete lines");
});

test("single insertion mid-file applies cleanly", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [{ after: 2, lines: ["app.use(helmet());"] }]);
  const r = applyAndRead("f.js", ORIGINAL, patch);
  assert.equal(r.code, 0, `git apply --check/apply failed: ${r.stderr}`);
  assert.deepEqual(r.after, [
    "import x from \"x\";",
    "const app = express();",
    "app.use(helmet());",
    "line3",
    "line4",
    "line5",
  ]);
});

test("multi-insertion hunks (import at top + statements mid-file) apply cleanly", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [
    { after: 0, lines: ["import helmet from \"helmet\";"] },
    { after: 2, lines: ["app.use(helmet());", "app.disable(\"x-powered-by\");"] },
  ]);
  const r = applyAndRead("f.js", ORIGINAL, patch);
  assert.equal(r.code, 0, `git apply failed: ${r.stderr}`);
  assert.deepEqual(r.after, [
    "import helmet from \"helmet\";",
    "import x from \"x\";",
    "const app = express();",
    "app.use(helmet());",
    "app.disable(\"x-powered-by\");",
    "line3",
    "line4",
    "line5",
  ]);
});

test("insertion at the very top of the file (after: 0) applies cleanly", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [{ after: 0, lines: ["// banner"] }]);
  const r = applyAndRead("f.js", ORIGINAL, patch);
  assert.equal(r.code, 0, `git apply failed: ${r.stderr}`);
  assert.deepEqual(r.after, ["// banner", ...ORIGINAL]);
});

test("insertion at the end of the file applies cleanly", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [{ after: ORIGINAL.length, lines: ["// eof"] }]);
  const r = applyAndRead("f.js", ORIGINAL, patch);
  assert.equal(r.code, 0, `git apply failed: ${r.stderr}`);
  assert.deepEqual(r.after, [...ORIGINAL, "// eof"]);
});

test("UTF-8 BOM on the first line (Windows-edited file) applies cleanly", () => {
  const original = [...ORIGINAL];
  original[0] = "\uFEFF" + original[0];
  const patch = insertionPatch("f.js", original, [
    { after: 0, lines: ["import helmet from \"helmet\";"] },
    { after: 2, lines: ["app.use(helmet());"] },
  ]);
  const r = applyAndRead("f.js", original, patch);
  assert.equal(r.code, 0, `git apply failed on BOM'd file: ${r.stderr}`);
  assert.deepEqual(r.after, [
    "import helmet from \"helmet\";",
    "\uFEFFimport x from \"x\";",
    "const app = express();",
    "app.use(helmet());",
    "line3",
    "line4",
    "line5",
  ]);
});

test("regression: no trailing blank line (the 'corrupt patch at line N' bug)", () => {
  // The bug shipped as a trailing empty line after the last hunk line.
  // git apply reads it as an unexpected empty line and aborts. The builder
  // must end the patch at the final content line + one newline, and no more.
  const patch = insertionPatch("f.js", ORIGINAL, [{ after: 2, lines: ["app.use(helmet());"] }]);
  assert.ok(patch.endsWith("line5\n"), `patch must end at the last content line, got: ${JSON.stringify(patch.slice(-16))}`);
  assert.ok(!patch.endsWith("\n\n"), "no trailing blank line");
});

test("inserts are sorted by position regardless of caller order", () => {
  const patch = insertionPatch("f.js", ORIGINAL, [
    { after: 4, lines: ["// late"] },
    { after: 0, lines: ["// early"] },
  ]);
  const plus = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  assert.deepEqual(plus, ["+// early", "+// late"]);
});
