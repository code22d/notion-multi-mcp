// -----------------------------------------------------------------------------
// Shared types used across the MCP server.
// -----------------------------------------------------------------------------

export interface Env {
  NOTION_MCP_KV: KVNamespace;

  // Secrets (set via `wrangler secret put`)
  MCP_AUTH_TOKEN: string;
  NOTION_OAUTH_CLIENT_ID: string;
  NOTION_OAUTH_CLIENT_SECRET: string;

  // Vars
  PUBLIC_BASE_URL?: string;
}

export interface ToolContext {
  env: Env;
  request: Request;
  /** Base URL the worker is being called on (used to build OAuth redirects). */
  baseUrl: string;
}

/** JSON-RPC types per MCP spec. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A registered MCP tool. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool's input. */
  inputSchema: Record<string, unknown>;
  /** Handler — returns the `result.content` array MCP tools return. */
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Stored per account. */
export interface NotionAccount {
  /** Internal UUID we generate when the account is added. */
  id: string;
  /** Human-friendly name Rene picks. Lowercased form is also indexed for fast lookup. */
  name: string;
  /** Notion OAuth access token. */
  accessToken: string;
  /** Returned by Notion on OAuth exchange. Unique per bot-per-workspace. */
  botId: string;
  /** Notion workspace identifier. */
  workspaceId: string;
  /** Workspace display name from Notion. */
  workspaceName: string;
  /** Workspace icon URL (if any). */
  workspaceIcon?: string;
  /** Owner info Notion returned. */
  owner?: unknown;
  /** Unix ms. */
  createdAt: number;
}

/** Lightweight view of an account used in `notion_account_list`. */
export interface AccountSummary {
  id: string;
  name: string;
  workspaceName: string;
  createdAt: number;
}
