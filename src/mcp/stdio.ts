import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * Stdio transport for the MCP server. stdout carries only JSON-RPC responses
 * (one per line); the in-process tool functions return values instead of
 * logging, so nothing else reaches the protocol channel. Diagnostics belong
 * on stderr. Input and output are injectable so tests drive the loop without
 * patching globals.
 */
export async function serveStdio(
  handle: (line: string) => Promise<string | null>,
  input: Readable = process.stdin,
  output: { write(chunk: string): unknown } = process.stdout,
): Promise<void> {
  const rl: Interface = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const response = await handle(trimmed);
    if (response) output.write(response + "\n");
  }
}
