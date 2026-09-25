import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";

export const SANDBOX_IMAGE = "node:22-bookworm-slim";
const OMIT = new Set([".git", ".pitstop", ".ssh", ".aws", ".azure", ".gcloud", ".npmrc", ".pypirc", ".netrc", ".docker", "__pycache__", ".pytest_cache"]);
export function sandboxExcluded(name: string): boolean {
  return OMIT.has(name) || /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || /^(credentials|id_rsa|id_ed25519)$/i.test(name);
}

/** Stage only files available to the app. The real repository and host home are
 * NEVER mounted. Symlinks may only resolve inside the source tree. */
export function stageSandboxTree(source: string, dest: string): void {
  source = fs.realpathSync(source);
  let bytes = 0, count = 0;
  const copy = (from: string, to: string, ancestors: Set<string>) => {
    const real = fs.realpathSync(from);
    const rel = path.relative(source, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("sandbox input contains an external symlink");
    if (rel.split(path.sep).some(sandboxExcluded)) return;
    const st = fs.statSync(real);
    if (st.isDirectory()) {
      if (ancestors.has(real)) throw new Error("sandbox input contains a symlink cycle");
      fs.mkdirSync(to, { recursive: true });
      fs.chmodSync(to, 0o755);
      const next = new Set(ancestors).add(real);
      for (const name of fs.readdirSync(real)) if (!sandboxExcluded(name)) copy(path.join(real, name), path.join(to, name), next);
    } else {
      if (!st.isFile() || ++count > 150000 || (bytes += st.size) > 512 * 1024 * 1024) throw new Error("sandbox input exceeds file/type/512 MiB limits");
      fs.copyFileSync(real, to);
      fs.chmodSync(to, st.mode & 0o111 ? 0o755 : 0o644);
    }
  };
  copy(source, dest, new Set());
}

export function containerArgs(stage: string, name: string, image = SANDBOX_IMAGE): string[] {
  if (stage.includes(",") || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(image)) throw new Error("invalid sandbox mount or image");
  return ["run", "--rm", "--pull=never", "--name", name,
    "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
    "--user=1000:1000", "--pids-limit=128", "--memory=1g", "--memory-swap=1g", "--cpus=2",
    "--tmpfs", "/work:rw,nosuid,nodev,size=768m,mode=1777", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--mount", `type=bind,source=${stage},target=/input,readonly`,
    "--env", "HOME=/tmp", "--env", "NODE_ENV=test", "--workdir=/work", "--entrypoint=node",
    image, "/input/tool/dist/sandbox/worker.js"];
}

/** Only constrained evidence basenames can be returned to the host. */
export function safeEvidenceName(name: string): boolean {
  return /^(?:ledger|pen)-[a-zA-Z0-9_.-]+\.(?:json|jsonl)$/.test(name) && !name.includes("..");
}

export async function runIsolated<T>(repo: string, kind: "pen" | "ledger" | "repro", routes?: unknown): Promise<T> {
  const image = process.env.PITSTOP_SANDBOX_IMAGE || SANDBOX_IMAGE;
  const name = `pitstop-${randomUUID()}`;
  let stage: string | undefined;
  try {
    const info = await execa("docker", ["info", "--format", "{{.OSType}}"], { timeout: 10000, windowsHide: true });
    if (info.stdout.trim() !== "linux") throw new Error("a Linux Docker engine is required");
    await execa("docker", ["image", "inspect", image], { timeout: 10000, windowsHide: true });
    stage = fs.mkdtempSync(path.join(os.tmpdir(), "pitstop-isolation-"));
    fs.chmodSync(stage, 0o755);
    stageSandboxTree(repo, path.join(stage, "repo"));
    const pkg = fileURLToPath(new URL("../../", import.meta.url));
    const tool = path.join(stage, "tool");
    fs.mkdirSync(tool);
    for (const entry of ["dist", "templates", "node_modules"]) stageSandboxTree(path.join(pkg, entry), path.join(tool, entry));
    fs.copyFileSync(path.join(pkg, "package.json"), path.join(tool, "package.json"));
    fs.writeFileSync(path.join(stage, "request.json"), JSON.stringify({ kind, routes, start: process.env.PITSTOP_START }));
    const outcome = await execa("docker", containerArgs(stage, name, image), {
      timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    const payload = JSON.parse(outcome.stdout);
    if (!payload || payload.schema !== 1 || !payload.result || !Array.isArray(payload.artifacts)) throw new Error("invalid sandbox evidence envelope");
    const remap = (value: any): any => typeof value === "string" ? value.replaceAll("/work/repo", path.resolve(repo))
      : Array.isArray(value) ? value.map(remap) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)])) : value;
    // Each run gets its own directory, preventing a container from overwriting
    // an earlier run's evidence. Never follow a repo-controlled output symlink.
    const pitstop = path.join(repo, ".pitstop");
    if (fs.existsSync(pitstop) && fs.lstatSync(pitstop).isSymbolicLink()) throw new Error("evidence directory is a symlink");
    fs.mkdirSync(pitstop, { recursive: true });
    const output = fs.mkdtempSync(path.join(pitstop, "isolated-"));
    const paths = new Map<string, string>();
    for (const artifact of payload.artifacts) {
      if (typeof artifact?.name !== "string" || !safeEvidenceName(artifact.name) || typeof artifact.content !== "string" || artifact.content.length > 4 * 1024 * 1024)
        throw new Error("unsafe sandbox artifact");
      const target = path.join(output, artifact.name);
      if (typeof artifact.source !== "string" || !/^\/work\/repo\/\.pitstop\/(pen|ledger)[a-zA-Z0-9_./-]*$/.test(artifact.source) || artifact.source.includes("..")) throw new Error("unsafe artifact source");
      paths.set(remap(artifact.source).replaceAll("\\", "/"), target);
    }
    const fixPaths = (v: any): any => typeof v === "string" ? paths.get(v.replaceAll("\\", "/")) ?? v
      : Array.isArray(v) ? v.map(fixPaths) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fixPaths(x)])) : v;
    for (const artifact of payload.artifacts) {
      // Keep receipt references usable after the disposable container is gone.
      const rewrite = (line: string) => {
        try { return JSON.stringify(fixPaths(remap(JSON.parse(line)))); }
        catch { return line; }
      };
      const content = artifact.name.endsWith(".jsonl")
        ? artifact.content.split(/\r?\n/).map(rewrite).join("\n") : rewrite(artifact.content);
      fs.writeFileSync(path.join(output, artifact.name), content, { flag: "wx" });
    }
    return fixPaths(remap(payload.result)) as T;
  } catch (error: any) {
    throw new Error(`OS-isolated ${kind} testing unavailable: ${error.shortMessage ?? error.message}. Install/start Docker with Linux containers and run: docker pull ${image}. No host app was launched.`);
  } finally {
    await execa("docker", ["rm", "--force", name], { timeout: 10000, reject: false, windowsHide: true }).catch(() => {});
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
  }
}
