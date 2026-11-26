import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeScanIssue } from "../src/findings/schema.js";
import { stampFindings } from "../src/repro/ids.js";
import {
  addSuppression,
  applySuppressions,
  filterSuppressedIssues,
  listSuppressions,
  loadSuppressions,
  removeSuppression,
} from "../src/findings/suppressions.js";
import {
  buildInstallPlan,
  applyInstallPlan,
  purgeManifestPaths,
  rollbackLastInstall,
  removeManagedTargets,
} from "../src/installer/transaction.js";
import {
  isManagedContent,
  renderContent,
  targetsForAgents,
  type InstallTarget,
} from "../src/installer/targets.js";
import { detectAgents, detectGit, detectProject } from "../src/onboarding/detect.js";
import {
  LANGUAGE_ADAPTERS,
  extensionsFor,
  languageDisplayName,
} from "../src/languages/adapters.js";
import { detectLanguage } from "../src/analyzers/util.js";
import { loadOnboardingState, saveOnboardingState, isOnboardingComplete } from "../src/onboarding/state.js";
import { buildCheckReport, renderCheck, collectCheckFindings } from "../src/checks/report.js";
import { runCheck } from "../src/checks/run.js";
import { buildSarif } from "../src/report/sarif.js";
import type { ReportModel } from "../src/report/format.js";
import type { ScanIssue, ScanResult } from "../src/analyzers/types.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(repo: string, file: string, content: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function scanFixture(repo: string, overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    timestamp: new Date().toISOString(),
    repo,
    language: "js",
    dependencyGraph: { status: "ok", files: 1, circular: [], mostDependedOn: [], orphans: [] },
    security: { status: "ok", issues: [] },
    duplication: { status: "ok", cloneCount: 0, clones: [] },
    tests: { status: "skipped", note: "quick scan", total: 0, passed: 0, failed: 0, durationMs: 0 },
    perf: { status: "skipped", note: "quick scan" },
    accessibility: { status: "ok", issues: [] },
    reliability: { status: "skipped", note: "quick scan", runs: 0, durationMs: 0, flakyTests: [], raceSmells: [] },
    devex: { status: "ok", unusedExports: [], duplicateFunctions: [] },
    clusters: [],
    ...overrides,
  };
}

function issue(partial: Partial<ScanIssue> = {}): ScanIssue {
  return {
    type: "code",
    category: "xss",
    severity: "high",
    description: "[indicated] user data reaches an HTML sink",
    file: "src/app.js",
    line: 1,
    fix: "use textContent",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Standardized finding schema
// ---------------------------------------------------------------------------

test("finding schema: enrichment is complete, stable and content-bound", () => {
  const repo = tempDir("pitstop-schema-");
  try {
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    const first = normalizeScanIssue(repo, issue(), "security", "security-abc123");
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.id, "security-abc123");
    assert.equal(first.confidence, "indicated");
    assert.equal(first.sourceTool, "static-security");
    assert.equal(first.reachability, "unknown");
    assert.ok(first.impact!.length > 0);
    assert.ok(first.reproduction!.includes("pitstop inspect security-abc123"));
    assert.ok(first.verification!.includes("pitstop scan"));
    assert.equal(first.fix, "use textContent");
    assert.match(first.fingerprint!, /^[0-9a-f]{64}$/);

    const same = normalizeScanIssue(repo, issue(), "security", "security-abc123");
    assert.equal(same.fingerprint, first.fingerprint, "same code line → same fingerprint");

    write(repo, "src/app.js", "el.textContent = req.body.name;\n");
    const changed = normalizeScanIssue(repo, issue(), "security", "security-abc123");
    assert.notEqual(changed.fingerprint, first.fingerprint, "changed code line → new fingerprint");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("stampFindings enriches every persisted issue with the common contract", () => {
  const repo = tempDir("pitstop-stamp-");
  try {
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    const scan = scanFixture(repo, {
      security: { status: "ok", issues: [issue()] },
      accessibility: { status: "ok", issues: [issue({ category: "a11y", type: "a11y", severity: "medium" })] },
      reliability: {
        status: "ok", runs: 1, durationMs: 1, flakyTests: [],
        raceSmells: [issue({ category: "race-condition", type: "code", severity: "medium" })],
      },
      devex: {
        status: "ok", duplicateFunctions: [],
        unusedExports: [issue({ category: "unused-export", type: "unused-export", severity: "low" })],
      },
    });
    stampFindings(scan);
    const all = [
      ...scan.security.issues,
      ...scan.accessibility.issues,
      ...scan.reliability.raceSmells,
      ...scan.devex.unusedExports,
    ];
    for (const finding of all) {
      assert.equal(finding.schemaVersion, 1);
      assert.match(finding.id!, /^[a-z0-9]+-[0-9a-f]{8}$/);
      assert.match(finding.fingerprint!, /^[0-9a-f]{64}$/);
      assert.ok(finding.title && finding.impact && finding.suggestedFix && finding.verification);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// False-positive management
// ---------------------------------------------------------------------------

test("suppressions: finding-specific dismissal, code-change invalidation, removal", () => {
  const repo = tempDir("pitstop-suppress-");
  try {
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    const scan = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(scan);
    const target = scan.security.issues[0];
    addSuppression(repo, {
      findingId: target.id,
      fingerprint: target.fingerprint,
      kind: "false-positive",
      reason: "the value is sanitized by an upstream allowlist",
    });

    applySuppressions(repo, scan);
    assert.equal(scan.security.issues.length, 0);
    assert.equal(scan.dismissed?.length, 1);
    assert.equal(scan.dismissed?.[0].suppression.reason, "the value is sanitized by an upstream allowlist");
    assert.equal(scan.dismissed?.[0].severity, "high");

    // The same code still matches on the next scan.
    const repeat = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(repeat);
    applySuppressions(repo, repeat);
    assert.equal(repeat.security.issues.length, 0, "unchanged code keeps the scoped dismissal");

    // Changing the finding's code invalidates the old dismissal.
    write(repo, "src/app.js", "el.textContent = req.body.name;\n");
    const changed = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(changed);
    applySuppressions(repo, changed);
    assert.equal(changed.security.issues.length, 1, "changed code is reconsidered");
    assert.equal(changed.dismissed?.length, 0);

    const [entry] = listSuppressions(repo);
    removeSuppression(repo, entry.id);
    const restored = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(restored);
    applySuppressions(repo, restored);
    assert.equal(restored.security.issues.length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("suppressions: rule/path scope, expiry, validation and verify-count filtering", () => {
  const repo = tempDir("pitstop-suppress-scope-");
  try {
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    addSuppression(repo, {
      rule: "xss",
      path: "src/**",
      kind: "accepted-risk",
      reason: "legacy component scheduled for removal",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const expired = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(expired);
    applySuppressions(repo, expired);
    assert.equal(expired.security.issues.length, 1, "expired dismissal no longer applies");
    assert.equal(listSuppressions(repo)[0].state, "expired");

    removeSuppression(repo, listSuppressions(repo)[0].id);
    addSuppression(repo, {
      rule: "xss",
      path: "src/**",
      kind: "suppressed",
      reason: "reviewed and constrained for this path",
    });
    const active = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(active);
    applySuppressions(repo, active);
    assert.equal(active.security.issues.length, 0, "rule + path dismissal applies");

    const outside = scanFixture(repo, { security: { status: "ok", issues: [issue({ file: "tests/app.js" })] } });
    stampFindings(outside);
    applySuppressions(repo, outside);
    assert.equal(outside.security.issues.length, 1, "path scope is respected");

    assert.throws(() => addSuppression(repo, { findingId: "security-x", kind: "suppressed", reason: " " }), /reason/);

    const counted = filterSuppressedIssues(repo, [issue({ file: "tests/app.js" })], "security");
    assert.equal(counted.length, 1, "suppression in another path does not hide this issue");
    write(repo, "src/other.js", "const ok = true;\n");
    const inScope = filterSuppressedIssues(repo, [issue({ file: "src/other.js" })], "security");
    assert.equal(inScope.length, 0, "verify/gate counts exclude dismissed findings");

    fs.writeFileSync(path.join(repo, ".pitstop", "suppressions.json"), "{ bad json");
    assert.throws(() => loadSuppressions(repo), /invalid suppression file/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Installer transaction, preview, preservation and rollback
// ---------------------------------------------------------------------------

test("installer: selective plan, managed marker, unchanged detection and rollback", () => {
  const repo = tempDir("pitstop-install-repo-");
  const home = tempDir("pitstop-install-home-");
  try {
    const targets = targetsForAgents(repo, ["claude-code", "cursor"], home);
    const plan = buildInstallPlan(targets, { overwrite: "managed" });
    assert.ok(plan.counts.create > 0, "empty project creates files");
    assert.equal(plan.counts.skip, 0);
    for (const entry of plan.entries) {
      assert.ok(isManagedContent(entry.content), `${entry.path} carries the managed marker`);
    }

    const applied = applyInstallPlan(repo, plan);
    assert.ok(applied.changed.length >= 3);
    assert.ok(fs.existsSync(path.join(repo, ".claude", "commands", "pitstop.md")));
    assert.ok(fs.existsSync(path.join(repo, ".claude", "skills", "pitstop", "SKILL.md")));
    assert.ok(fs.existsSync(path.join(repo, ".cursor", "commands", "pitstop.md")));
    assert.ok(fs.existsSync(path.join(home, ".claude", "commands", "pitstop.md")), "home target written to injected home");
    assert.ok(fs.existsSync(path.join(repo, ".pitstop", "install-manifest.json")));

    const again = buildInstallPlan(targets, { overwrite: "managed" });
    assert.equal(again.counts.create, 0);
    assert.equal(again.counts.update, 0);
    assert.equal(again.counts.unchanged, plan.entries.length);

    const rolledBack = rollbackLastInstall(repo);
    assert.equal(rolledBack.conflicts.length, 0);
    assert.ok(!fs.existsSync(path.join(repo, ".claude", "commands", "pitstop.md")));
    assert.ok(!fs.existsSync(path.join(home, ".claude", "commands", "pitstop.md")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installer: user-authored files are never overwritten without explicit force", () => {
  const repo = tempDir("pitstop-install-conflict-");
  const home = tempDir("pitstop-install-conflict-home-");
  try {
    const custom = "# my own cursor command\n";
    write(repo, ".cursor/commands/pitstop.md", custom);
    const targets = targetsForAgents(repo, ["cursor"], home);
    const managed = buildInstallPlan(targets, { overwrite: "managed" });
    const conflict = managed.entries.find((entry) => entry.path.endsWith("pitstop.md"))!;
    assert.equal(conflict.action, "skip");
    assert.match(conflict.reason!, /not managed by OpenPitStop/);

    applyInstallPlan(repo, managed);
    assert.equal(fs.readFileSync(path.join(repo, ".cursor", "commands", "pitstop.md"), "utf8"), custom);

    const forced = buildInstallPlan(targets, { overwrite: "all" });
    const forcedEntry = forced.entries.find((entry) => entry.path.endsWith("pitstop.md"))!;
    assert.equal(forcedEntry.action, "update");
    const forcedApply = applyInstallPlan(repo, forced);
    assert.equal(forcedApply.changed.length, 1);
    assert.notEqual(fs.readFileSync(path.join(repo, ".cursor", "commands", "pitstop.md"), "utf8"), custom);
    assert.ok(forcedApply.transaction.entries[0].backup);

    const rollback = rollbackLastInstall(repo);
    assert.equal(rollback.conflicts.length, 0);
    assert.equal(fs.readFileSync(path.join(repo, ".cursor", "commands", "pitstop.md"), "utf8"), custom, "force overwrite is reversible");

    // A file edited after installation is kept unless rollback is forced.
    const forcedPlan = buildInstallPlan(targets, { overwrite: "all" });
    applyInstallPlan(repo, forcedPlan);
    write(repo, ".cursor/commands/pitstop.md", "edited after install\n");
    const guarded = rollbackLastInstall(repo);
    assert.equal(guarded.conflicts.length, 1);
    assert.equal(fs.readFileSync(path.join(repo, ".cursor", "commands", "pitstop.md"), "utf8"), "edited after install\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installer: uninstall removes managed files only and purges their manifest records", () => {
  const repo = tempDir("pitstop-uninstall-");
  const home = tempDir("pitstop-uninstall-home-");
  try {
    const targets = targetsForAgents(repo, ["cursor"], home);
    applyInstallPlan(repo, buildInstallPlan(targets, { overwrite: "managed" }));
    assert.ok(fs.existsSync(path.join(repo, ".cursor", "commands", "pitstop.md")));
    assert.ok(fs.existsSync(path.join(repo, ".pitstop", "install-manifest.json")));

    const user = path.join(repo, ".cursor", "commands", "other.md");
    fs.writeFileSync(user, "# user file\n");
    const result = removeManagedTargets(targets);
    assert.ok(result.removed.some((file) => file.endsWith("pitstop.md")));
    assert.ok(fs.existsSync(user));
    assert.ok(!fs.existsSync(path.join(repo, ".cursor", "commands", "pitstop.md")));

    purgeManifestPaths(repo, result.removed);
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, ".pitstop", "install-manifest.json"), "utf8"));
    assert.equal(manifest.transactions.length, 0, "uninstalled files are not left as rollback targets");
    assert.equal(rollbackLastInstall(repo).transactionId, null);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("installer: a write failure reverts earlier writes in the same transaction", () => {
  const repo = tempDir("pitstop-install-atomic-");
  try {
    const blocker = path.join(repo, "blocker");
    fs.writeFileSync(blocker, "not a directory\n");
    const first: InstallTarget = { path: path.join(repo, "ok", "pitstop.md"), tool: "A", level: "project" };
    const second: InstallTarget = { path: path.join(blocker, "child", "pitstop.md"), tool: "B", level: "project" };
    const plan = buildInstallPlan([first, second], { overwrite: "managed" });
    assert.equal(plan.entries[0].action, "create");
    assert.equal(plan.entries[1].action, "create");
    assert.throws(() => applyInstallPlan(repo, plan), /earlier writes were reverted/);
    assert.ok(!fs.existsSync(first.path), "the successful first write was rolled back");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("installer: renderContent preserves frontmatter and marks workflow/gemini/skill variants", () => {
  const template = "---\ndescription: \"OpenPitStop test\"\n---\n\n# /pitstop\n";
  for (const transform of ["skill", "workflow", "gemini"] as const) {
    const rendered = renderContent({ path: "x", tool: "t", level: "project", transform }, template);
    assert.ok(isManagedContent(rendered), transform);
    if (transform === "gemini") assert.match(rendered, /^# openpitstop:managed\n/);
    else assert.match(rendered, /^---\n/);
  }
});

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

test("detection: project type, scripts, entry points and package manager", () => {
  const repo = tempDir("pitstop-detect-");
  try {
    write(repo, "package.json", JSON.stringify({
      name: "checkout-service",
      scripts: { test: "node --test", build: "tsc", lint: "eslint ." },
      devDependencies: { typescript: "^5", express: "^4" },
    }));
    write(repo, "package-lock.json", "{}");
    write(repo, "tsconfig.json", "{}");
    write(repo, "src/index.ts", "export const app = 1;\n");
    const project = detectProject(repo);
    assert.equal(project.name, "checkout-service");
    assert.equal(project.type, "Node.js / TypeScript");
    assert.equal(project.packageManager, "npm");
    assert.ok(project.languages.includes("TypeScript"));
    assert.ok(project.frameworks.includes("Express"));
    assert.ok(project.entryPoints.includes("src/index.ts"));
    assert.equal(project.verificationCommands.test, "npm run test");
    assert.equal(project.verificationCommands.build, "npm run build");
    assert.equal(project.verificationCommands.lint, "npm run lint");
    assert.equal(detectGit(repo).isRepo, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("detection: agents come from real paths and report configured state", () => {
  const repo = tempDir("pitstop-agent-repo-");
  const home = tempDir("pitstop-agent-home-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "agent-fixture" }));
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".cursor"), { recursive: true });
    write(repo, ".claude/commands/pitstop.md", "<!-- openpitstop:managed -->\n# /pitstop\n");
    const agents = detectAgents(repo, home);
    const claude = agents.find((agent) => agent.id === "claude-code")!;
    const cursor = agents.find((agent) => agent.id === "cursor")!;
    assert.equal(claude.installed, true);
    assert.equal(claude.configured, true);
    assert.ok(claude.evidence.some((entry) => entry.includes("~/.claude")));
    assert.equal(cursor.installed, true);
    assert.ok(cursor.evidence.includes(".cursor/ in this project"));
    assert.equal(cursor.configured, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("language adapters: detection is marker-driven and shared", () => {
  const js = tempDir("pitstop-lang-js-");
  const py = tempDir("pitstop-lang-py-");
  const dotnet = tempDir("pitstop-lang-dotnet-");
  try {
    fs.writeFileSync(path.join(js, "package.json"), JSON.stringify({ name: "x" }));
    fs.writeFileSync(path.join(py, "pyproject.toml"), "[project]\nname = 'x'\n");
    fs.mkdirSync(path.join(dotnet, "src"), { recursive: true });
    fs.writeFileSync(path.join(dotnet, "src", "App.csproj"), "<Project />\n");

    assert.equal(detectLanguage(js), "js");
    assert.equal(detectLanguage(py), "python");
    assert.equal(detectLanguage(dotnet), "dotnet");
    assert.equal(languageDisplayName("dotnet"), "C#");
    assert.deepEqual(extensionsFor("go"), [".go"]);
    assert.equal(new Set(LANGUAGE_ADAPTERS.map((adapter) => adapter.id)).size, LANGUAGE_ADAPTERS.length);
  } finally {
    for (const repo of [js, py, dotnet]) fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("onboarding state: first run, completion and persistence", () => {
  const repo = tempDir("pitstop-onboarding-");
  try {
    assert.equal(isOnboardingComplete(repo), false);
    assert.equal(loadOnboardingState(repo).schemaVersion, 1);
    saveOnboardingState(repo, {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      lastCheckMode: "quick",
      configuredAgents: ["claude-code"],
      skippedAgentSetup: false,
      skippedCheck: false,
    });
    assert.equal(isOnboardingComplete(repo), true);
    assert.equal(loadOnboardingState(repo).lastCheckMode, "quick");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Check report and skipped-check visibility
// ---------------------------------------------------------------------------

test("check report: groups findings, keeps skipped checks visible, and recommends inspect", () => {
  const repo = tempDir("pitstop-check-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "check-fixture", scripts: { test: "node --test" } }));
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    const scan = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(scan);
    const project = detectProject(repo);
    const report = buildCheckReport({ mode: "quick", repo, project, scan });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.mode, "quick");
    assert.equal(report.findings.total, 1);
    assert.equal(report.findings.groups[0].key, "security");
    assert.equal(report.findings.groups[0].count, 1);
    assert.equal(report.findings.top[0].id, scan.security.issues[0].id);
    assert.equal(report.findings.top[0].addressable, true);
    assert.ok(report.findings.top[0].impact.length > 0);
    assert.ok(report.score.value > 0);
    assert.ok(report.skipped.some((entry) => entry.area === "Tests"));
    assert.ok(report.skipped.some((entry) => entry.area === "Build / performance"));
    assert.ok(report.nextSteps.some((step) => step.command === `pitstop inspect ${scan.security.issues[0].id}`));
    const rendered = renderCheck(report);
    assert.match(rendered, /Skipped checks/);
    assert.match(rendered, /Why it matters/);
    assert.match(rendered, /Next steps/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check command: an unsupported directory fails honestly without writing evidence", async () => {
  const repo = tempDir("pitstop-check-unknown-");
  try {
    await assert.rejects(
      () => runCheck(repo, "quick", { persist: false }),
      /no supported project detected/,
    );
    assert.equal(fs.existsSync(path.join(repo, ".pitstop")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check report: aggregate findings are counted but never given a broken inspect command", () => {
  const repo = tempDir("pitstop-check-aggregate-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "aggregate-fixture" }));
    write(repo, "src/a.js", "export const a = 1;\n");
    const scan = scanFixture(repo, {
      duplication: { status: "ok", cloneCount: 1, clones: [{ files: ["src/a.js", "src/b.js"], lines: 12 }] },
    });
    stampFindings(scan);
    const project = detectProject(repo);
    const findings = collectCheckFindings(repo, scan);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].addressable, false);
    const report = buildCheckReport({ mode: "quick", repo, project, scan });
    assert.ok(report.nextSteps.every((step) => !step.command.startsWith("pitstop inspect")));
    assert.match(renderCheck(report), /no single reproduction id/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("check report: ship records the strict gate verdict and reasons", () => {
  const repo = tempDir("pitstop-check-ship-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "ship-fixture" }));
    const scan = scanFixture(repo);
    stampFindings(scan);
    const project = detectProject(repo);
    const report = buildCheckReport({
      mode: "ship",
      repo,
      project,
      scan,
      gate: {
        verdict: "UNPROVEN",
        exitCode: 1,
        layers: [],
        reasons: ["insufficient deep evidence for VERIFIED"],
        summary: { layers: 1, passed: 0, failed: 0, unproven: 1, notConfigured: 0, tampered: 0 },
      },
    });
    assert.equal(report.gate?.verdict, "UNPROVEN");
    assert.equal(report.gate?.strict, true);
    assert.equal(report.nextSteps[0].command, "pitstop gate --strict --score 60");
    assert.match(renderCheck(report), /Release gate/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SARIF
// ---------------------------------------------------------------------------

test("SARIF: stable fingerprints, confidence, rules and scoped suppressions", () => {
  const repo = tempDir("pitstop-sarif-");
  try {
    write(repo, "src/app.js", "el.innerHTML = req.body.name;\n");
    const scan = scanFixture(repo, { security: { status: "ok", issues: [issue()] } });
    stampFindings(scan);
    const active = scan.security.issues[0];
    scan.dismissed = [{
      id: active.id!,
      source: "security",
      type: active.type,
      category: active.category!,
      description: active.description,
      severity: active.severity,
      file: active.file,
      line: active.line,
      fingerprint: active.fingerprint,
      confidence: active.confidence,
      sourceTool: active.sourceTool,
      impact: active.impact,
      suppression: {
        id: "sup-test",
        findingId: active.id,
        fingerprint: active.fingerprint,
        kind: "accepted-risk",
        reason: "reviewed, scheduled for removal",
        createdAt: new Date().toISOString(),
      },
    }];
    scan.security.issues = [];
    const model = { repo, latestScan: scan } as ReportModel;

    const sarif = buildSarif(repo, model);
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "OpenPitStop");
    assert.ok(sarif.runs[0].tool.driver.rules.length >= 1);
    assert.ok(sarif.runs[0].originalUriBaseIds?.["%SRCROOT%"].uri.startsWith("file:"));
    const result = sarif.runs[0].results[0] as any;
    assert.equal(result.level, "none");
    assert.equal(result.partialFingerprints["openpitstopFindingId/v1"], active.id);
    assert.match(result.partialFingerprints["openpitstopContentHash/v1"], /^[0-9a-f]{64}$/);
    assert.equal(result.properties.confidence, "indicated");
    assert.equal(result.properties.sourceTool, "static-security");
    assert.equal(result.properties.suppressed, true);
    assert.match(result.suppressions[0].justification, /accepted-risk: reviewed, scheduled for removal/);
    assert.equal(result.locations[0].physicalLocation.artifactLocation.uri, "src/app.js");
    assert.ok((result.properties["security-severity"] as number) > 0);

    const withoutSuppressed = buildSarif(repo, model, { includeSuppressed: false });
    assert.equal(withoutSuppressed.runs[0].results.length, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
