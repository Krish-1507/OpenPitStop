import fs from "node:fs";
import path from "node:path";
import type { ScanIssue } from "../analyzers/types.js";

/**
 * Dependency hygiene findings that do not require network access. Actual
 * vulnerability advisories remain the job of npm audit / pip-audit / OSV;
 * these checks catch supply-chain inputs that make those audits unreliable.
 */
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];

function lineForDependency(content: string, name: string): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\s*"${escaped}"\\s*:`, "m").exec(content);
  return match ? content.slice(0, match.index).split("\n").length : 1;
}

function issue(
  file: string,
  line: number,
  category: string,
  severity: "high" | "medium" | "low",
  title: string,
  description: string,
  fix: string,
): ScanIssue {
  return {
    type: "dependency",
    category,
    severity,
    title,
    file,
    line,
    description: `[indicated] ${description}`,
    fix,
    sourceTool: "pitstop-dependencies",
    confidence: "indicated",
    reachability: "unknown",
  };
}

export function analyzeDependencyHygiene(repoInput: string): ScanIssue[] {
  const repo = path.resolve(repoInput);
  const pkgPath = path.join(repo, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let content: string;
  let pkg: any;
  try {
    content = fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, "");
    pkg = JSON.parse(content);
  } catch {
    return [];
  }
  const issues: ScanIssue[] = [];
  const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
  const dependencies = groups.flatMap((group) =>
    Object.entries(pkg?.[group] ?? {}).map(([name, spec]) => ({ name, spec: String(spec), group })),
  );

  for (const dependency of dependencies) {
    const line = lineForDependency(content, dependency.name);
    if (/^(?:\*|latest)$/i.test(dependency.spec)) {
      issues.push(issue(
        "package.json", line, "dependency-floating-version", "medium",
        "dependency uses a floating version",
        `${dependency.name} is pinned to "${dependency.spec}", so installs can silently move to an unreviewed or vulnerable version.`,
        `Pin ${dependency.name} to a reviewed range (for example ^major.minor) and update it deliberately with the lockfile.`,
      ));
    }
    if (/^(?:https?:\/\/|git\+http:\/\/)/i.test(dependency.spec)) {
      issues.push(issue(
        "package.json", line, "dependency-insecure-source", "high",
        "dependency uses an insecure HTTP source",
        `${dependency.name} is fetched over plain HTTP (${dependency.spec}), so the artifact can be modified in transit.`,
        "Use an HTTPS URL or the registry, and pin the artifact by integrity/hash.",
      ));
    } else if (/^(?:github:|git\+https:\/\/|git:\/\/)/i.test(dependency.spec) && !/#[0-9a-f]{7,40}\b/i.test(dependency.spec)) {
      issues.push(issue(
        "package.json", line, "dependency-unpinned-git", "medium",
        "git dependency is not pinned to a commit",
        `${dependency.name} points at a mutable git ref; the code installed tomorrow can differ from the code reviewed today.`,
        "Pin the dependency to a full commit SHA (or publish a versioned package with an integrity hash).",
      ));
    }
  }

  if (dependencies.length > 0 && !LOCKFILES.some((file) => fs.existsSync(path.join(repo, file)))) {
    issues.push(issue(
      "package.json", 1, "dependency-lockfile-missing", "low",
      "dependency lockfile is missing",
      "The repository declares dependencies without a lockfile, so installs and vulnerability scans are not reproducible.",
      "Commit the package manager's lockfile and use a frozen/immutable install in CI.",
    ));
  }

  return issues;
}
