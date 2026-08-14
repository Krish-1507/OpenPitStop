import { createHash } from "node:crypto";

/**
 * evidence.ts — OpenPitStop's tamper-evident evidence chain.
 *
 * Every scan/cluster/verify document OpenPitStop writes carries a deterministic
 * cryptographic digest of its own content. If anyone edits the JSON after the
 * fact — a score inflated, a finding deleted — the digest stops matching and
 * OpenPitStop reports the chain as broken. No key material is involved: this is
 * not "who signed this" but "not a byte changed since OpenPitStop wrote it",
 * which is the property that makes agent report honesty checkable.
 */

export interface OpenPitStopEvidence {
  scheme: "pitstop-canonical-sha256-v1";
  /** sha256 hex over the canonical JSON of the document (evidence excluded). */
  digest: string;
  /** Human description of what the digest covers. */
  of: string;
  signedAt: string;
}

/** The evidence field itself is never part of the digest it protects. */
const EXCLUDED_KEYS = new Set(["evidence"]);

/** Canonical JSON: keys sorted recursively, no whitespace, floats verbatim. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((v) => canonicalize(v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (EXCLUDED_KEYS.has(key)) continue;
    if (obj[key] === undefined) continue; // JSON.stringify drops these on write
    parts.push(JSON.stringify(key) + ":" + canonicalize(obj[key]));
  }
  return "{" + parts.join(",") + "}";
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** Attach a signed evidence block to a document (returns the document itself). */
export function seal<T extends object>(doc: T, of: string): T & { evidence: OpenPitStopEvidence } {
  const evidence: OpenPitStopEvidence = {
    scheme: "pitstop-canonical-sha256-v1",
    digest: digestOf(doc),
    of,
    signedAt: new Date().toISOString(),
  };
  return { ...doc, evidence };
}

export type EvidenceStatus = "verified" | "tampered" | "missing";

export interface EvidenceCheck {
  status: EvidenceStatus;
  digest: string;
  expected?: string;
  reason?: string;
}

/**
 * Recompute the digest over a sealed document (excluding its own evidence
 * field) and compare against the claimed signature.
 */
export function checkEvidence(value: unknown): EvidenceCheck {
  const ev = (value as { evidence?: OpenPitStopEvidence })?.evidence;
  const digest = digestOf(value);
  if (!ev || !ev.digest) {
    return {
      status: "missing",
      digest,
      reason: "document carries no OpenPitStop evidence block — written by a non-OpenPitStop tool or pre-0.6.0",
    };
  }
  if (ev.scheme !== "pitstop-canonical-sha256-v1") {
    return { status: "tampered", digest, expected: ev.digest, reason: `unrecognized scheme "${ev.scheme}"` };
  }
  if (digest !== ev.digest) {
    return {
      status: "tampered",
      digest,
      expected: ev.digest,
      reason: "digest does not match document content — evidence was edited after OpenPitStop wrote it",
    };
  }
  return { status: "verified", digest };
}