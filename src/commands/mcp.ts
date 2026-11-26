import { Command } from "commander";
import fs from "node:fs";
import { createMcpHandler } from "../mcp/protocol.js";
import { mcpTools } from "../mcp/tools.js";
import { serveStdio } from "../mcp/stdio.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * `pitstop mcp` — OpenPitStop as a Model Context Protocol stdio server.
 *
 * Coding agents get tools to inspect the repo and read verification evidence,
 * but the release gate still reasons over sealed evidence: an agent cannot
 * declare its own work verified by calling a tool. stdout is the protocol
 * channel; diagnostics go to stderr only.
 */
export const mcp = new Command("mcp")
  .description(
    "Run OpenPitStop as an MCP stdio server: expose understand/map/scan/release-gate/reproduce/bench " +
      "tools to any MCP-capable coding agent. Point the agent's MCP client at `pitstop mcp`.",
  )
  .action(async () => {
    const handle = createMcpHandler({
      serverInfo: { name: "openpitstop", version: readVersion() },
      tools: mcpTools(process.cwd()),
    });
    await serveStdio(handle);
  });

export default mcp;
