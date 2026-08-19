import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { commandExists, detectLanguage, safeExecAsync } from "./util.js";
import { analyzeSecurityStatic } from "./securityStatic.js";
import type { ScanIssue, SecurityResult } from "./types.js";

/** How long an npm-audit result is reused before re-fetching from the registry. */
const AUDIT_TTL_MS = 24 * 60 * 60 * 1000;

export async function analyzeSecurity(repo: string): Promise<SecurityResult> {
  const lang = detectLanguage(repo);
  // The offline static pass runs for EVERY language (even "unknown"): it is
  // deterministic, needs no tooling, and covers the vulnerability classes
  // that AI-generated code ships most often (SQL injection, secrets, XSS,
  // authz gaps, money inputs). Its findings are labeled [indicated].
  const issues: ScanIssue[] = [...analyzeSecurityStatic(repo)];
  let depNote: string | undefined;

  if (lang === "js") {
    // npm audit exits 1 when vulnerabilities exist but still prints the full
    // JSON — capture stdout and persist it for parsing either way. The result
    // is cached keyed on the lockfile hash: an unchanged lockfile (the common
    // case inside one fix loop) makes the audit network call disappear.
    const audit = await npmAudit(repo);
    if (audit.error) {
      // Honesty over numbers: a broken lockfile means dependencies are NOT
      // scanned — that is never reported as "clean".
      depNote = audit.error;
    } else if (audit.stdout) {
      const auditFile = path.join(repo, ".pitstop", "npm-audit.json");
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.writeFileSync(auditFile, audit.stdout);
      issues.push(...parseNpmAudit(audit.stdout));
    }
  } else if (lang === "python") {
    if (commandExists("pip-audit")) {
      const r = await safeExecAsync("pip-audit", ["-f", "json"], repo, 120000);
      if (r.stdout && (r.code === 0 || looksLikeJson(r.stdout))) {
        issues.push(...parsePipAudit(r.stdout));
      } else {
        depNote = `pip-audit failed (${firstLine(r.stderr || r.stdout)}) — deps not scanned`;
      }
    } else {
      // pip-audit missing — OSV understands pyproject.toml / poetry.lock etc.
      const osv = await osvScan(repo);
      if (osv.error) depNote = osv.error;
      else issues.push(...osv.issues);
    }
  } else if (lang !== "unknown") {
    if (commandExists("osv-scanner")) {
      const osv = await osvScan(repo);
      if (osv.error) depNote = osv.error;
      else issues.push(...osv.issues);
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

  const semgrep = await analyzeSecuritySemgrep(repo);
  if (semgrep.error) depNote = depNote ? `${depNote}; ${semgrep.error}` : semgrep.error;
  else issues.push(...semgrep.issues);

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

/** The lockfile exists but npm refuses to read it — a real finding on its own. */
function lockfileHint(): string {
  return "run `npm i --package-lock-only` to repair the lockfile, then re-scan";
}

function looksLikeJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

function firstLine(s: string): string {
  return (s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "unknown error";
}

async function npmAudit(repo: string): Promise<{ stdout: string | null; error: string | null }> {
  const lockCandidate = ["package-lock.json", "npm-shrinkwrap.json", "package.json"].find(
    (f) => fs.existsSync(path.join(repo, f)),
  );
  if (!lockCandidate) return { stdout: null, error: null };
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
        Date.now() - Date.parse(cached.at) < AUDIT_TTL_MS &&
        // Never trust a cached failure: only a parseable audit report is a
        // valid cache hit (older versions cached stdout even when audit errored).
        looksLikeJson(cached.stdout) &&
        typeof JSON.parse(cached.stdout)?.vulnerabilities === "object"
      ) {
        return { stdout: cached.stdout, error: null };
      }
    } catch {
      /* stale or corrupt — re-fetch */
    }
  }

  const r = await safeExecAsync("npm", ["audit", "--json"], repo, 120000);
  // Success means a real audit report: JSON that carries a `vulnerabilities`
  // object. npm exits 0 on a clean audit and 1 when vulnerabilities exist —
  // but it ALSO exits 1 and prints a JSON `error` payload when the audit
  // itself fails (e.g. ENOLOCK). Anything without `vulnerabilities` is a
  // failed audit, and reporting that as "clean" would be lying.
  let auditJson: any = null;
  try {
    auditJson = JSON.parse(r.stdout || "");
  } catch {
    auditJson = null;
  }
  if (auditJson && typeof auditJson.vulnerabilities === "object") {
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ at: new Date().toISOString(), stdout: r.stdout }),
      );
    } catch {
      /* cache write is best-effort */
    }
    return { stdout: r.stdout, error: null };
  }
  const why =
    auditJson?.error?.message ||
    auditJson?.error?.summary ||
    firstLine(r.stderr || r.stdout) ||
    "audit failed";
  return {
    stdout: null,
    error: `npm audit failed (${why}) — deps not scanned; ${lockfileHint()}`,
  };
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
async function osvScan(repo: string): Promise<{ issues: ScanIssue[]; error: string | null }> {
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
        return { issues: parseOsvScanner(cached.stdout), error: null };
      }
    } catch {
      /* stale or corrupt — re-scan */
    }
  }

  const r = await safeExecAsync("osv-scanner", ["scan", "--format", "json", repo], repo, 180000);
  // osv-scanner exits 1 when vulnerabilities are found but still prints the
  // JSON report; any other nonzero exit with unusable output means the scan
  // failed and deps were NOT checked — say so instead of reporting clean.
  if (r.stdout && (r.code === 0 || (r.code === 1 && looksLikeJson(r.stdout)))) {
    try {
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ at: new Date().toISOString(), stdout: r.stdout }),
      );
    } catch {
      /* cache write is best-effort */
    }
    return { issues: parseOsvScanner(r.stdout), error: null };
  }
  return {
    issues: [],
    error: `osv-scanner failed (${firstLine(r.stderr || r.stdout) || "no output"}) — deps not scanned`,
  };
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

/**
 * Deeper SAST via Semgrep, wired behind the same scan/drive loop.
 *
 * Defaults to the free Semgrep Registry rules (`--config auto`) which cover a
 * broad, actively-maintained set of injection / crypto / auth / secrets / OWASP
 * checks across many languages. Override with:
 *   - PITSTOP_SEMGREP        path to the semgrep binary
 *   - PITSTOP_SEMGREP_CONFIG space/comma separated --config values (e.g.
 *                            "p/security-audit p/owasp-top-ten ./my-rules")
 *
 * Findings carry the rule's own remediation when available (extra.fix /
 * metadata.fix) so `pitstop drive` can actually solve them, and a stable
 * (check_id + message) description so they survive re-scans for verification.
 * Degrades gracefully: a missing binary or a failed run reports no findings
 * (with an honest depNote) rather than faking "clean".
 */
async function analyzeSecuritySemgrep(
  repo: string,
): Promise<{ issues: ScanIssue[]; error: string | null }> {
  const configEnv = process.env.PITSTOP_SEMGREP_CONFIG?.trim();
  // Optional, opt-in only: Semgrep is NOT a default part of the scan. It runs
  // solely when the user enables it (PITSTOP_SEMGREP_CONFIG), so it never fires
  // just because the binary happens to be on PATH — no surprise network calls or
  // slow scans for people who don't need it.
  if (!configEnv) return { issues: [], error: null };

  const bin = process.env.PITSTOP_SEMGREP?.trim() || (commandExists("semgrep") ? "semgrep" : null);
  if (!bin) {
    return {
      issues: [],
      error:
        "PITSTOP_SEMGREP_CONFIG is set but the semgrep binary was not found — run `pip install semgrep` to enable the deeper SAST engine",
    };
  }
  const configs = configEnv.split(/[\s,]+/).filter(Boolean);
  const args = [
    "scan",
    ...configs.flatMap((c) => ["--config", c]),
    "--json",
    "--quiet",
    "--metrics", "off",
    "--disable-version-check",
    "--timeout", "30",
    "--exclude", "node_modules",
    "--exclude", ".git",
    "--exclude", ".pitstop",
    "--exclude", "dist",
    "--exclude", "build",
    "--exclude", "vendor",
    "--exclude", ".next",
    "--exclude", "coverage",
    repo,
  ];

  const r = await safeExecAsync(bin, args, repo, 240000);
  if (!r.stdout) {
    const why = (r.stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return {
      issues: [],
      error: why
        ? `semgrep failed (${why}) — deep SAST skipped`
        : "semgrep produced no output — deep SAST skipped",
    };
  }
  return { issues: parseSemgrep(r.stdout, repo), error: null };
}

export function parseSemgrep(stdout: string, repo: string): ScanIssue[] {
  const issues: ScanIssue[] = [];
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return issues;
  }
  for (const r of json?.results ?? []) {
    const checkId: string = r.check_id ?? "semgrep";
    const msg: string = (r.extra?.message ?? "").toString().trim() || checkId;
    const rawPath: string = r.path ?? "";
    const rel = path.isAbsolute(rawPath) ? path.relative(repo, rawPath) : rawPath;
    if (!rel) continue;
    const sevRaw = (r.extra?.severity ?? "WARNING").toString().toUpperCase();
    const severity = sevRaw === "ERROR" ? "high" : sevRaw === "INFO" ? "low" : "medium";
    const meta = r.extra?.metadata ?? {};
    const fix: string =
      r.extra?.fix ??
      meta?.fix ??
      `Review Semgrep rule '${checkId}' and apply its documented remediation (see the rule reference for details).`;
    issues.push({
      type: "code",
      severity,
      category: checkId,
      file: rel,
      line: r.start?.line,
      description: `${checkId}: ${msg}`,
      fix,
    });
  }
  return issues;
}
