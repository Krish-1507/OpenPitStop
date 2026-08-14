import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandExists, detectLanguage, safeExecAsync } from "./util.js";
import type { ScanIssue, SecurityResult } from "./types.js";

/** How long an npm-audit result is reused before re-fetching from the registry. */
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;

export async function analyzeSecurity(repo: string): Promise<SecurityResult> {
  const lang = detectLanguage(repo);
  const issues: ScanIssue[] = [];
  let depNote: string | undefined;

  if (lang === "js") {
    // npm audit exits 1 when vulnerabilities exist but still prints the full
    // JSON — capture stdout and persist it for parsing either way. The result
    // is cached keyed on the lockfile hash: an unchanged lockfile (the common
    // case inside one fix loop) makes the audit network call disappear.
    const stdout = await npmAudit(repo);
    if (stdout) {
      const auditFile = path.join(repo, ".pitstop", "npm-audit.json");
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.writeFileSync(auditFile, stdout);
      issues.push(...parseNpmAudit(stdout));
    }
  } else if (lang === "python") {
    if (commandExists("pip-audit")) {
      const r = await safeExecAsync("pip-audit", ["-f", "json"], repo, 120000);
      if (r.stdout) issues.push(...parsePipAudit(r.stdout));
    } else {
      // pip-audit missing — OSV understands pyproject.toml / poetry.lock etc.
      issues.push(...(await osvScan(repo)));
    }
  } else if (lang !== "unknown") {
    if (commandExists("osv-scanner")) {
      issues.push(...(await osvScan(repo)));
    } else {
      depNote = `install osv-scanner (go install github.com/google/osv-scanner/cmd/osv-scanner@latest) to scan ${lang} dependencies`;
    }
  }

  if (commandExists("gitleaks")) {
    const tmp = path.join(repo, ".pitstop", `gitleaks-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    const r = await safeExecAsync(
      "gitleaks",
      ["detect", "--no-git", "--report-format", "json", "--report-path", tmp, "-v"],
      repo,
      120000,
    );
    if (fs.existsSync(tmp)) {
      try {
        issues.push(...parseGitleaks(fs.readFileSync(tmp, "utf8")));
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  if (commandExists("semgrep")) {
    const r = await safeExecAsync("semgrep", ["--config", "auto", "--json"], repo, 180000);
    if (r.stdout) issues.push(...parseSemgrep(r.stdout));
  }

  if (issues.length === 0 && lang === "unknown") {
    return {
      status: "skipped",
      note: "unsupported language / no security tooling",
      issues: [],
    };
  }
  if (issues.length === 0 && depNote) {
    return { status: "skipped", note: depNote, issues: [] };
  }

  return { status: "ok", issues };
}

async function npmAudit(repo: string): Promise<string | null> {
  const lockCandidate = ["package-lock.json", "npm-shrinkwrap.json", "package.json"].find(
    (f) => fs.existsSync(path.join(repo, f)),
  );
  if (!lockCandidate) return null;
  const hash = crypto
    .createHash("sha1")
    .update(fs.readFileSync(path.join(repo, lockCandidate)))
    .digest("hex")
    .slice(0, 12);

  const cacheDir = path.join(repo, ".pitstop", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `npm-audit-${hash}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
        at?: string;
        stdout?: string;
      };
      if (
        cached &&
        typeof cached.stdout === "string" &&
        typeof cached.at === "string" &&
        Date.now() - Date.parse(cached.at) < AUDIT_TTL_MS
      ) {
        return cached.stdout;
      }
    } catch {
      /* stale or corrupt — re-fetch */
    }
  }

  const r = await safeExecAsync("npm", ["audit", "--json"], repo, 120000);
  if (r.stdout) {
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ at: new Date().toISOString(), stdout: r.stdout }),
      );
    } catch {
      /* cache write is best-effort */
    }
  }
  return r.stdout || null;
}

/** Root-level manifests/lockfiles OSV understands (nested ones are scanned too). */
const OSV_ROOT_LOCKFILES = [
  "go.mod",
  "go.sum",
  "Cargo.lock",
  "Cargo.toml",
  "pubspec.lock",
  "pubspec.yaml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "packages.lock.json",
  "requirements.txt",
  "pyproject.toml",
  "poetry.lock",
];

/**
 * Universal dependency scan via google/osv-scanner (`scan --format json <dir>`
 * walks the tree for supported manifests: go.mod, Cargo.lock, pubspec.lock,
 * pom.xml, build.gradle, *.csproj, ...). Result is cached like npm-audit,
 * keyed on root lockfile names + sizes.
 */
async function osvScan(repo: string): Promise<ScanIssue[]> {
  const lockKey = OSV_ROOT_LOCKFILES.filter((f) => fs.existsSync(path.join(repo, f)))
    .map((f) => {
      try {
        return `${f}:${fs.statSync(path.join(repo, f)).size}`;
      } catch {
        return f;
      }
    })
    .join("|");
  const hash = crypto.createHash("sha1").update(lockKey || "dir").digest("hex").slice(0, 12);

  const cacheDir = path.join(repo, ".pitstop", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `osv-${hash}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as {
        at?: string;
        stdout?: string;
      };
      if (
        cached &&
        typeof cached.stdout === "string" &&
        typeof cached.at === "string" &&
        Date.now() - Date.parse(cached.at) < AUDIT_TTL_MS
      ) {
        return parseOsvScanner(cached.stdout);
      }
    } catch {
      /* stale or corrupt — re-scan */
    }
  }

  const r = await safeExecAsync("osv-scanner", ["scan", "--format", "json", repo], repo, 180000);
  if (r.stdout) {
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ at: new Date().toISOString(), stdout: r.stdout }),
      );
    } catch {
      /* cache write is best-effort */
    }
    return parseOsvScanner(r.stdout);
  }
  return [];
}

function parseOsvScanner(stdout: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return issues;
  }
  for (const res of json?.results ?? []) {
    for (const pkg of res?.packages ?? []) {
      const name: string = pkg?.package?.name ?? "unknown";
      const version: string = pkg?.package?.version ?? "";
      for (const v of pkg?.vulnerabilities ?? []) {
        // OSV advisories carry CVSS scores; map to the 4-level severity scale
        // the rest of the report uses.
        const sev = v?.severity?.[0];
        let severity = "medium";
        if (typeof sev?.score === "string" || typeof sev?.score === "number") {
          const score = parseFloat(String(sev.score));
          if (!Number.isNaN(score)) {
            severity =
              score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
          }
        }
        const summary = (v?.summary ?? "").trim();
        const desc = `${name}${version ? `@${version}` : ""} ${v?.id ?? ""}`.trim();
        issues.push({
          type: "dependency",
          severity,
          description: summary ? `${desc} — ${summary}` : desc,
        });
      }
    }
  }
  return issues;
}

function parseNpmAudit(stdout: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return issues;
  }
  const vuls = json?.vulnerabilities ?? {};
  for (const [name, v] of Object.entries<any>(vuls)) {
    let desc = name;
    const via = v?.via;
    if (Array.isArray(via)) {
      const firstObj = via.find((x: any) => typeof x === "object" && x.title);
      if (firstObj?.title) desc = `${name}: ${firstObj.title}`;
      else if (typeof via[0] === "string") desc = `${name} (via ${via[0]})`;
    }
    issues.push({
      type: "dependency",
      severity: v?.severity ?? "unknown",
      description: desc,
    });
  }
  return issues;
}

function parsePipAudit(stdout: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let arr: any[];
  try {
    arr = JSON.parse(stdout);
  } catch {
    return issues;
  }
  for (const v of arr) {
    issues.push({
      type: "dependency",
      severity: v.severity ?? "unknown",
      description: `${v.name} ${v.id ?? ""}`.trim(),
    });
  }
  return issues;
}

function parseGitleaks(stdout: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let arr: any[];
  try {
    arr = JSON.parse(stdout);
  } catch {
    return issues;
  }
  for (const f of arr) {
    issues.push({
      type: "secret",
      severity: f.Severity ?? "high",
      file: f.File,
      line: f.StartLine,
      description: f.Description ?? f.RuleID ?? "secret detected",
    });
  }
  return issues;
}

function parseSemgrep(stdout: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return issues;
  }
  for (const r of json?.results ?? []) {
    issues.push({
      type: "code",
      severity: r.extra?.severity ?? "medium",
      file: r.path,
      line: r.start?.line,
      description: r.extra?.message ?? r.check_id ?? "finding",
    });
  }
  return issues;
}
