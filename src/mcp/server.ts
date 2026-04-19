// -----------------------------------------------------------------------------
// Minimal MCP server over streamable HTTP transport.
//
// Implements the JSON-RPC methods Claude uses over the wire:
//   - initialize
//   - tools/list
//   - tools/call
//   - notifications/initialized  (acknowledged, no response)
//   - ping
//
// Keeps the surface tiny so we can host on a single CF Worker fetch handler.
// -----------------------------------------------------------------------------

import type { Env, JsonRpcRequest, JsonRpcResponse, ToolContext, ToolDef, ToolResult } from "./types";
import { registerAllTools } from "./tools";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "notion-multi-mcp", version: "0.1.0" };

export async function handleMcpRequest(
  request: Request,
  env: Env,
  opts: { prevalidated: boolean } = { prevalidated: false }
): Promise<Response> {
  // If the router already validated the token via URL path, skip header check.
  // Otherwise enforce `Authorization: Bearer <MCP_AUTH_TOKEN>`.
  if (!opts.prevalidated) {
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${env.MCP_AUTH_TOKEN}`;
    if (!env.MCP_AUTH_TOKEN || auth !== expected) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  }

  if (request.method === "GET") {
    // Streamable HTTP transport optionally supports SSE on GET — we return 405 for now;
    // clients that require SSE can be added later. POST works for the entire tool protocol.
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: JsonRpcRequest | JsonRpcRequest[];
  try {
    payload = (await request.json()) as JsonRpcRequest | JsonRpcRequest[];
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const baseUrl = deriveBaseUrl(request, env);
  const ctx: ToolContext = { env, request, baseUrl };

  // Batch support
  if (Array.isArray(payload)) {
    const results = await Promise.all(payload.map((p) => dispatch(p, ctx)));
    const filtered = results.filter((r): r is JsonRpcResponse => r !== null);
    if (filtered.length === 0) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(filtered), {
      headers: { "content-type": "application/json" },
    });
  }

  const res = await dispatch(payload, ctx);
  if (res === null) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(res), { headers: { "content-type": "application/json" } });
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

async function dispatch(req: JsonRpcRequest, ctx: ToolContext): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;

  // Notifications: no response
  if (req.method === "notifications/initialized" || req.method.startsWith("notifications/")) {
    return null;
  }

  try {
    switch (req.method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });

      case "ping":
        return ok(id, {});

      case "tools/list": {
        const tools = getToolDefs().map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        }));
        return ok(id, { tools });
      }

      case "tools/call": {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const tool = getToolDefs().find((t) => t.name === params.name);
        if (!tool) return err(id, -32602, `Unknown tool: ${params.name}`);
        const result = await invokeTool(tool, params.arguments ?? {}, ctx);
        return ok(id, result);
      }

      default:
        return err(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(id, -32603, `Internal error: ${message}`);
  }
}

// -----------------------------------------------------------------------------
// Tool registry (lazy-initialized per worker instance)
// -----------------------------------------------------------------------------

let TOOLS: ToolDef[] | null = null;
function getToolDefs(): ToolDef[] {
  if (TOOLS === null) {
    TOOLS = [];
    registerAllTools((def) => TOOLS!.push(def));
  }
  return TOOLS;
}

async function invokeTool(tool: ToolDef, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await tool.handler(args, ctx);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: "text", text: `Tool error: ${message}` }],
    };
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}
function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify(err(id, code, message)), {
    headers: { "content-type": "application/json" },
  });
}

function deriveBaseUrl(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.length > 0) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
