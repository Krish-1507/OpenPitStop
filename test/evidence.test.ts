/**
 * evidence.test.ts — regression guard for the evidence-chain bug shipped in
 * 0.8.x: `canonicalize` hashed keys whose value was `undefined`, but
 * `JSON.stringify` drops those keys when the sealed document is persisted.
 * The digest therefore never matched the file on disk, and EVERY gate
 * reported `Evidence: TAMPERED` for baselines it had just written itself
 * (caught via `scan -> gate` on a fresh repo: exitCode 1, evidence tampered).
 *
 * These tests are the contract: a sealed document must always verify after a
 * JSON round-trip (the exact write/read path), including documents carrying
 * `undefined` values, and must flip to tampered when any byte of content
 * changes or the evidence block goes missing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, digestOf, seal, checkEvidence } from "../src/evidence.js";

function roundTrip(doc: object): object {
  return JSON.parse(JSON.stringify(seal(doc, "pitstop scan result for /tmp/repo")));
}

test("seal -> JSON round-trip -> checkEvidence is verified", () => {
  const doc = {
    timestamp: "2026-08-06T00:00:00.000Z",
    repo: "/tmp/repo",
    security: { status: "ok", issues: [{ severity: "high" }] },
  };
  const persisted = roundTrip(doc);
  assert.equal(checkEvidence(persisted).status, "verified");
});

test("undefined-valued keys survive the round-trip (the 0.8.x tampered bug)", () => {
  const doc = {
    status: "ok",
    note: undefined,
    runs: 2,
    reliability: { durationMs: 9039, flakyTests: [], note: undefined, raceSmells: [] },
  };
  const persisted = roundTrip(doc);
  assert.equal(checkEvidence(persisted).status, "verified");
});

test("editing a field after sealing is detected as tampered", () => {
  const persisted = roundTrip({ score: 100, grade: "A" }) as Record<string, any>;
  persisted.grade = "F";
  const check = checkEvidence(persisted);
  assert.equal(check.status, "tampered");
  assert.equal(check.expected, (persisted as any).evidence.digest);
});

test("deleting the evidence block is reported as missing", () => {
  const persisted = roundTrip({ score: 100 }) as Record<string, any>;
  delete persisted.evidence;
  assert.equal(checkEvidence(persisted).status, "missing");
});

test("canonicalize is order-independent and matches parse-serialized content", () => {
  const a = { b: 1, a: { d: [1, 2], c: "x" } };
  const b = { a: { c: "x", d: [1, 2] }, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), canonicalize(JSON.parse(JSON.stringify(a))));
  assert.equal(digestOf(a), digestOf(b));
});
