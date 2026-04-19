// -----------------------------------------------------------------------------
// Account management MCP tools:
//   notion_account_add     — kicks off OAuth by returning an authorize URL
//   notion_account_list    — lists all connected accounts
//   notion_account_remove  — removes an account (revokes local access, not Notion-side)
//   notion_account_rename  — renames an account
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { AccountStore } from "./store";
import { createAuthorizeUrl } from "../oauth/flow";

export function registerAccountTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_account_add",
    description:
      "Start adding a new Notion account. Returns an OAuth authorization URL to open in a browser. After the user approves in Notion, the account is saved to KV with the given friendly name. Use notion_account_list afterward to confirm.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Friendly name for this account (e.g. 'VirtualLatinos', 'Acme Corp'). Must be unique across accounts. Case-insensitive. This is what you reference in other tools as the `account` parameter.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: addHandler,
  });

  register({
    name: "notion_account_list",
    description:
      "List all connected Notion accounts. Returns each account's id, name, and workspace name so you can pick which one to use in subsequent tool calls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: listHandler,
  });

  register({
    name: "notion_account_remove",
    description:
      "Remove a connected Notion account. Accepts either the account's name or id. This only deletes the stored token from KV — it does not revoke the integration in Notion. Returns the removed account's details.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Name or id of the account to remove.",
        },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: removeHandler,
  });

  register({
    name: "notion_account_rename",
    description: "Rename a connected Notion account. The new name must be unique (case-insensitive).",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Current name or id of the account." },
        new_name: { type: "string", description: "New friendly name." },
      },
      required: ["account", "new_name"],
      additionalProperties: false,
    },
    handler: renameHandler,
  });
}

// -----------------------------------------------------------------------------

async function addHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = String(args.name ?? "").trim();
  if (!name) return textError("`name` is required.");

  const { url } = await createAuthorizeUrl(ctx.env, ctx.baseUrl, name);
  const text = [
    `To connect the "${name}" account, open this URL in a browser:`,
    "",
    url,
    "",
    "After you approve the integration in Notion, you'll see a success page and the account will be available immediately. Run notion_account_list to confirm.",
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

async function listHandler(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const store = new AccountStore(ctx.env.NOTION_MCP_KV);
  const accounts = await store.list();
  if (accounts.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "No Notion accounts connected yet. Use notion_account_add to connect one.",
        },
      ],
    };
  }
  const lines = [
    `Connected Notion accounts (${accounts.length}):`,
    "",
    ...accounts.map(
      (a) => `• ${a.name}  —  workspace: ${a.workspaceName}  —  id: ${a.id}`
    ),
    "",
    "Reference an account in Notion tools by passing its name (or id) as the `account` parameter.",
  ];
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function removeHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const nameOrId = String(args.account ?? "").trim();
  if (!nameOrId) return textError("`account` is required.");
  const store = new AccountStore(ctx.env.NOTION_MCP_KV);
  const existing = await store.resolve(nameOrId);
  if (!existing) return textError(`No account found matching "${nameOrId}".`);
  await store.remove(existing.id);
  return {
    content: [
      {
        type: "text",
        text: `Removed account "${existing.name}" (workspace: ${existing.workspaceName}, id: ${existing.id}). Note: the Notion-side integration still exists — you can fully revoke access from https://www.notion.so/profile/integrations.`,
      },
    ],
  };
}

async function renameHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const nameOrId = String(args.account ?? "").trim();
  const newName = String(args.new_name ?? "").trim();
  if (!nameOrId || !newName) return textError("Both `account` and `new_name` are required.");
  const store = new AccountStore(ctx.env.NOTION_MCP_KV);
  const existing = await store.resolve(nameOrId);
  if (!existing) return textError(`No account found matching "${nameOrId}".`);
  const updated = await store.rename(existing.id, newName);
  return {
    content: [
      {
        type: "text",
        text: `Renamed account ${existing.id} from "${existing.name}" to "${updated.name}".`,
      },
    ],
  };
}

function textError(msg: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}
