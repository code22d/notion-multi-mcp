// -----------------------------------------------------------------------------
// notion_get_users / notion_get_teams
//
// `get_users` wraps GET /v1/users with optional user_id lookup (including "self").
// `get_teams` — Notion's public API doesn't expose teamspaces directly; we return
// an explanatory note. (The native MCP has special API access for this.) When
// the public API gains teamspace endpoints we'll swap this implementation.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA, createNotionClient } from "../accounts/resolver";

export function registerUserTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_get_users",
    description:
      "Get users (workspace members + bots) from the specified Notion account. Supports pagination and filtering by name/email (client-side since Notion's API has no server-side search).",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        query: {
          type: "string",
          description: "Optional substring filter over name/email (case-insensitive, applied client-side).",
        },
        user_id: {
          type: "string",
          description: "Fetch a single user by ID. Pass \"self\" for the bot user the integration runs as.",
        },
        start_cursor: { type: "string" },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: getUsersHandler,
  });

  register({
    name: "notion_get_teams",
    description:
      "List teamspaces in the specified Notion account's workspace. Note: Notion's public REST API does not expose teamspace listing directly; this tool returns an explanatory message for now. Teamspace-aware search can be done via notion_search with a teamspace-scoped query.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        query: { type: "string" },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: getTeamsHandler,
  });
}

async function getUsersHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  // Single-user lookup
  if (typeof args.user_id === "string" && args.user_id.trim()) {
    const raw = args.user_id.trim();
    const user = raw === "self" ? await client.getMe() : await client.getUser(raw);
    return {
      content: [
        {
          type: "text",
          text: [
            `# User`,
            `- **Name**: ${user.name ?? "(no name)"}`,
            `- **ID**: ${user.id}`,
            `- **Type**: ${user.type ?? "unknown"}`,
            user.person?.email ? `- **Email**: ${user.person.email}` : "",
            "",
            "## Raw JSON",
            "```json",
            JSON.stringify(user, null, 2),
            "```",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }

  const pageSize = typeof args.page_size === "number" ? args.page_size : 100;
  const listOpts: { startCursor?: string; pageSize?: number } = { pageSize };
  if (typeof args.start_cursor === "string") listOpts.startCursor = args.start_cursor;
  const res = await client.listUsers(listOpts);

  const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const filtered = q
    ? res.results.filter(
        (u) => (u.name ?? "").toLowerCase().includes(q) || (u.person?.email ?? "").toLowerCase().includes(q)
      )
    : res.results;

  const lines: string[] = [`# Users (${filtered.length}${res.has_more ? ", more available" : ""})`, ""];
  for (const u of filtered) {
    const email = u.person?.email ? ` · ${u.person.email}` : "";
    lines.push(`- **${u.name ?? "(no name)"}** (${u.type ?? "?"})${email} · id: ${u.id}`);
  }
  if (res.has_more && res.next_cursor) {
    lines.push("", `_More users available. Pass \`start_cursor: "${res.next_cursor}"\` to continue._`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

async function getTeamsHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  await resolveAccount(args, ctx); // validate account exists
  return {
    content: [
      {
        type: "text",
        text: [
          "Notion's public REST API does not currently expose teamspace listing.",
          "Workarounds:",
          "  • Use notion_search with a query; results include teamspace paths in URLs.",
          "  • Teamspace-scoped filtering will be added if/when Notion exposes the endpoint.",
        ].join("\n"),
      },
    ],
  };
}
