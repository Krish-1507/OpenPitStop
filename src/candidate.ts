import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hashSuiteFiles } from "./verify/holdout.js";
import { snapshotRepo } from "./scanCache.js";

export interface CandidateBinding {
  schema: 1;
  repo: string;
  digest: string;
  head: string | null;
  clean: boolean;
  engine: string;
  policy: string;
}
const context = new AsyncLocalStorage<CandidateBinding | null>();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const policies = ["architecture.json", "plan-latest.json", "acceptance-pin.json"];

function engineIdentity(): string {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const files: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|js|json|cjs)$/.test(entry.name)) files.push([path.relative(root, p), hash(fs.readFileSync(p).toString("base64"))]);
    }
  };
  walk(root);
  walk(path.join(root, "../templates"));
  return hash([files, fs.readFileSync(path.join(root, "../package.json"), "utf8"), process.version, process.platform]);
}

/** No source or secret contents are stored in evidence, only content digests. */
export function captureCandidate(repo: string): CandidateBinding | null {
  try {
    repo = fs.realpathSync(repo);
    const snapshot = snapshotRepo(repo);
    if (!snapshot) return null;
    const policy = policies.map(name => {
      const p = path.join(repo, ".pitstop", name);
      if (!fs.existsSync(p)) return [name, null];
      if (fs.lstatSync(p).isSymbolicLink()) throw new Error("policy symlink");
      return [name, hash(fs.readFileSync(p).toString("base64"))];
    });
    let clean = false;
    if (snapshot.head) {
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).pitstop", ":(exclude)PITSTOP_*.md", ":(exclude)PITSTOP_*.html", ":(exclude)PITSTOP_*.svg"],
        { cwd: repo, encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      clean = !status.trim();
    }
    const env = Object.entries(process.env).filter(([k]) => k.startsWith("PITSTOP_") || ["NODE_OPTIONS", "NODE_ENV"].includes(k)).sort();
    return { schema: 1, repo, digest: snapshot.digest, head: snapshot.head, clean, engine: engineIdentity(), policy: hash([policy, env]) };
  } catch { return null; }
}

export function activeCandidate(): CandidateBinding | null | undefined { return context.getStore(); }

/** Capture BEFORE execution, including async work and early-return evidence. */
export async function candidateRun<T extends object>(repo: string, run: () => Promise<T>): Promise<T & { candidateBinding: CandidateBinding | null }> {
  const binding = captureCandidate(repo);
  return context.run(binding, async () => ({ ...await run(), candidateBinding: binding }));
}
export function candidateRunSync<T extends object>(repo: string, run: () => T): T & { candidateBinding: CandidateBinding | null } {
  const binding = captureCandidate(repo);
  return context.run(binding, () => ({ ...run(), candidateBinding: binding }));
}

export function candidateMismatch(repo: string, doc: any, current = captureCandidate(repo)): string | null {
  const binding = doc?.candidateBinding;
  if (!binding || binding.schema !== 1) return "evidence has no candidate binding; rerun this check";
  if (!current) return "current candidate cannot be fingerprinted safely";
  if (JSON.stringify(binding) !== JSON.stringify(current)) return "repository, Git state, policy or verification engine changed; rerun this check";
  try {
    if (doc.contract?.path && createHash("sha256").update(fs.readFileSync(doc.contract.path, "utf8")).digest("hex") !== doc.contract.hash) return "acceptance contract changed; rerun acceptance verification";
    if (doc.suite?.dir && hashSuiteFiles(doc.suite.dir).hash !== doc.suite.hash) return "holdout suite changed; rerun holdout verification";
  } catch { return "external verification input is unavailable"; }
  const sha = doc?.candidate?.commitSha ?? doc?.candidate?.sha ?? doc?.candidateSha;
  if (sha && (sha !== current.head || !current.clean)) return "check ran on a commit that does not represent the current clean candidate";
  return null;
}
