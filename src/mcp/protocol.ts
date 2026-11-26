/**
 * Minimal Model Context Protocol (stdio) server core.
 *
 * Implements the JSON-RPC 2.0 surface an MCP client needs: `initialize`,
 * `ping`, `tools/list`, `tools/call` (plus harmless empty `resources/list` and
 * `prompts/list` so clients that probe them get a defined answer). OpenPitStop
 * exposes tools only; it never exposes a prompt that could talk the host agent
 * out of a verdict.
 *
 * The handler is transport-agnostic and fully testable: `createMcpHandler`
 * maps one inbound JSON-RPC line to at most one outbound line (`null` for
 * notifications, which get no response).
 *
 * Protocol versions are negotiated, not echoed blindly: a version this server
 * implements is echoed back, and anything else — newer, older or invented —
 * gets the newest version this server actually speaks, as the MCP specification
 * requires. A client therefore cannot believe it is talking a dialect we do not
 * implement.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

/** MCP revisions this server implements, oldest first. */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

const ErrorCode = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function respond(id: unknown, result: unknown, error: { code: number; message: string } | null): string {
  if (error) {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message } });
  }
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMcpHandler(options: {
  serverInfo: { name: string; version: string };
  instructions?: string;
  tools: McpTool[];
}): (line: string) => Promise<string | null> {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));

  async function dispatch(
    id: unknown,
    method: string,
    params: unknown,
    isNotification: boolean,
  ): Promise<string | null> {
    // A notification is never answered, and never triggers a tool: a client that
    // omits the id is not waiting for a result, so running a scan on its behalf
    // would surprise it.
    if (isNotification) return null;

    switch (method) {
      case "initialize": {
        const requested = isRecord(params) ? params.protocolVersion : undefined;
        return respond(
          id,
          {
            protocolVersion: negotiateProtocolVersion(requested),
            capabilities: { tools: { listChanged: false } },
            serverInfo: options.serverInfo,
            instructions:
              options.instructions ??
              "OpenPitStop tools inspect the repository and read sealed verification evidence. " +
                "They never accept a verdict from the calling agent: an agent that claims a fix " +
                "works must still call pitstop_release_gate, which reasons over OpenPitStop's own evidence.",
          },
          null,
        );
      }

      case "ping":
        return respond(id, {}, null);

      case "tools/list":
        return respond(
          id,
          {
            tools: [...tools.values()].map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          },
          null,
        );

      case "tools/call": {
        if (!isRecord(params)) {
          return respond(id, null, {
            code: ErrorCode.invalidParams,
            message: "Invalid params: expected an object with a tool name and optional arguments",
          });
        }
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name) {
          return respond(id, null, { code: ErrorCode.invalidParams, message: "Invalid params: missing tool name" });
        }
        const tool = tools.get(name);
        if (!tool) {
          return respond(id, null, { code: ErrorCode.invalidParams, message: `Unknown tool: ${name}` });
        }
        const callArgs = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        try {
          const value = await tool.handler(callArgs);
          return respond(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }, null);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return respond(
            id,
            { content: [{ type: "text", text: `OpenPitStop tool error: ${detail}` }], isError: true },
            null,
          );
        }
      }

      case "resources/list":
        return respond(id, { resources: [] }, null);

      case "prompts/list":
        return respond(id, { prompts: [] }, null);

      default:
        return respond(id, null, { code: ErrorCode.methodNotFound, message: `Method not found: ${method}` });
    }
  }

  return async function handle(line: string): Promise<string | null> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return respond(null, null, { code: ErrorCode.parse, message: "Parse error: input was not valid JSON" });
    }
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = isRecord(message) && "id" in message ? message.id : null;
      return respond(id, null, { code: ErrorCode.invalidRequest, message: "Invalid Request: not a JSON-RPC 2.0 message" });
    }

    const { id, method, params } = message as { id?: unknown; method: string; params?: unknown };
    // JSON-RPC 2.0: a notification is a request *without* an id member.
    // `"id": null` is a discouraged but legal request id, and still gets an answer.
    const isNotification = !("id" in message);

    try {
      return await dispatch(id, method, params, isNotification);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return isNotification
        ? null
        : respond(id, null, { code: ErrorCode.internal, message: `Internal error: ${detail}` });
    }
  };
}
