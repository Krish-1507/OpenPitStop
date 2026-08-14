/**
 * pen/store.ts — persistence for pen results (sealed evidence, like every
 * other OpenPitStop artifact) and lookup helpers for `pitstop repro` / inspect.
 */

import fs from "node:fs";
import path from "node:path";
import { seal } from "../evidence.js";
import type { PenFinding, PenResult } from "./types.js";

export function persistPen(repo: string, result: PenResult): { file: string } {
  const sealed = seal(result, `pitstop pen result for ${repo}`);
  const outDir = path.join(repo, ".pitstop");
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `pen-${ts}.json`);
  const json = JSON.stringify(sealed, null, 2);
  fs.writeFileSync(file, json);
  fs.writeFileSync(path.join(outDir, "pen-latest.json"), json);
  return { file };
}

export function loadPenLatest(repo: string): PenResult | null {
  const p = path.join(repo, ".pitstop", "pen-latest.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as PenResult;
  } catch {
    return null;
  }
}

export function enumeratePenFindings(r: PenResult): PenFinding[] {
  return r.findings ?? [];
}

export function resolvePenFinding(r: PenResult, id: string): PenFinding | null {
  return enumeratePenFindings(r).find((f) => f.id === id) ?? null;
}
