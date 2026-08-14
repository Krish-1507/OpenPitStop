import fs from "node:fs";
import path from "node:path";
import { commandExists, safeExec } from "./util.js";
import type { DuplicationResult } from "./types.js";

export function analyzeDuplication(repo: string): DuplicationResult {
  if (!commandExists("jscpd")) {
    return {
      status: "skipped",
      note: "jscpd not found",
      cloneCount: 0,
      clones: [],
    };
  }

  const outDir = path.join(repo, ".pitstop", "jscpd");
  fs.mkdirSync(outDir, { recursive: true });
  const r = safeExec(
    "jscpd",
    ["--silent", "--output", outDir, "--format", "json", repo],
    repo,
    180000,
  );
  const reportPath = path.join(outDir, "jscpd-report.json");
  if (!fs.existsSync(reportPath)) {
    return {
      status: "error",
      note: "jscpd produced no report",
      cloneCount: 0,
      clones: [],
    };
  }
  try {
    const json = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const duplicates: any[] = json.duplicates ?? [];
    const clones = duplicates.slice(0, 5).map((d: any) => ({
      files: (d.files ?? []).map((f: any) => f.path ?? f),
      lines: d.lines ?? 0,
    }));
    return {
      status: "ok",
      cloneCount: duplicates.length,
      clones,
    };
  } catch {
    return {
      status: "error",
      note: "could not parse jscpd report",
      cloneCount: 0,
      clones: [],
    };
  }
}
