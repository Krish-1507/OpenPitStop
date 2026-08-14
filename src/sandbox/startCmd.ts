import fs from "node:fs";
import path from "node:path";
import type { Language } from "../analyzers/util.js";

/**
 * sandbox/startCmd.ts — resolve the app-under-test's start command.
 *
 * JS repos use the package.json `start` script (as before). Non-JS stacks have
 * no universal convention, so in order we try:
 *   1. the PITSTOP_START env var (explicit, e.g. "uvicorn app.main:app"),
 *   2. the repo's own conventions (manage.py / app.py / main.py / server.py,
 *      `go run .`, `cargo run`, `dotnet run`, spring-boot:run / bootRun),
 *   3. null — the caller aborts honestly with a hint instead of guessing.
 */

export interface StartCommand {
  cmd: string;
  args: string[];
}

const NODE_BASED = new Set([
  "node", "node.exe", "nodejs", "npm", "npm.cmd", "npx", "npx.cmd",
  "yarn", "yarn.cmd", "pnpm", "pnpm.cmd", "tsx", "ts-node", "babel-node",
  "ojs", "vitest", "jest",
]);

export function isNodeCommand(cmd: string): boolean {
  return NODE_BASED.has(cmd);
}

/** The start command for a Node/JS repo (package.json `start` script). */
export function resolveNodeStart(repo: string): StartCommand {
  const pkgPath = path.join(repo, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error("no package.json — a start script is required");
  const start =
    JSON.parse(fs.readFileSync(pkgPath, "utf8").replace(/^\uFEFF/, ""))?.scripts?.start || "";
  if (!start) throw new Error("no `start` script in package.json — a start script is required");
  const tokens = start.trim().split(/\s+/);
  return { cmd: tokens[0] || "", args: tokens.slice(1) };
}

function gradleWrapper(repo: string): string | null {
  const name = process.platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapper = path.join(repo, name);
  return fs.existsSync(wrapper) ? wrapper : null;
}

/**
 * Best-effort start command for a non-JS repo. `port` is templated into the
 * args where the framework needs it (e.g. Django's runserver). Returns null
 * when nothing can be guessed — callers must abort with an honest hint.
 */
export function resolveNativeStart(repo: string, lang: Language, port: number): StartCommand | null {
  const fromEnv = process.env.PITSTOP_START?.trim();
  if (fromEnv) {
    const tokens = fromEnv.split(/\s+/);
    return { cmd: tokens[0] || "", args: tokens.slice(1) };
  }

  switch (lang) {
    case "python": {
      if (fs.existsSync(path.join(repo, "manage.py"))) {
        return { cmd: "python", args: ["manage.py", "runserver", "--noreload", `0.0.0.0:${port}`] };
      }
      for (const f of ["app.py", "main.py", "server.py", "wsgi.py", "asgi.py"]) {
        if (fs.existsSync(path.join(repo, f))) return { cmd: "python", args: [f] };
      }
      return null;
    }
    case "go":
      return fs.existsSync(path.join(repo, "go.mod")) ? { cmd: "go", args: ["run", "."] } : null;
    case "rust":
      return fs.existsSync(path.join(repo, "Cargo.toml"))
        ? { cmd: "cargo", args: ["run"] }
        : null;
    case "dotnet":
      return { cmd: "dotnet", args: ["run"] };
    case "java": {
      if (fs.existsSync(path.join(repo, "pom.xml"))) {
        return { cmd: "mvn", args: ["spring-boot:run"] };
      }
      const gradle = gradleWrapper(repo);
      if (gradle || fs.existsSync(path.join(repo, "build.gradle"))) {
        return { cmd: gradle ?? "gradle", args: ["bootRun"] };
      }
      return null;
    }
    default:
      return null;
  }
}
