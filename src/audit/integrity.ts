/**
 * audit/integrity.ts — report content digest.
 *
 * The shared evidence seal deliberately excludes every key named "evidence"
 * so a document's own evidence block is not part of its digest. Audit findings
 * and risks also carry evidence, so the top-level seal alone cannot detect an
 * edit to a finding excerpt. This digest covers those nested evidence fields
 * (and the rest of the report) while excluding only the root evidence block,
 * the digest itself and the candidate binding added by seal().
 */

import { createHash } from "node:crypto";

const ROOT_EXCLUDED = new Set(["evidence", "contentDigest", "candidateBinding"]);

function canonical(value: unknown, depth: number): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map((entry) => canonical(entry, depth + 1)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    if (depth === 0 && ROOT_EXCLUDED.has(key)) continue;
    if (obj[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonical(obj[key], depth + 1));
  }
  return "{" + parts.join(",") + "}";
}

export function contentDigestOf(value: object): string {
  return createHash("sha256").update(canonical(value, 0), "utf8").digest("hex");
}

export function contentDigestValid(value: object & { contentDigest?: unknown }): boolean {
  return typeof value.contentDigest === "string" && value.contentDigest === contentDigestOf(value);
}
