// -----------------------------------------------------------------------------
// notion_search — workspace-wide search on the specified account.
// Wraps POST /v1/search with filter/sort/pagination.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { NotionClient, type NotionPageObject, type NotionDatabaseObject } from "../notion/client";
import { richTextToPlain } from "../notion/markdown/rich-text";

export function registerSearchTool(register: (def: ToolDef) => void): void {
  register({
    name: "notion_search",
    description:
      "Search pages and databases in the specified Notion account's workspace. Notion's native search only indexes titles — for content search, fetch individual pages.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        query: { type: "string", description: "Search query. Empty string returns everything." },
        filter: {
          type: "string",
          enum: ["any", "page", "database"],
          description: "Restrict results to only pages or only databases. Default: any.",
        },
        sort: {
          type: "string",
          enum: ["last_edited_desc", "last_edited_asc"],
          description: "Sort order by last edited time. Default: last_edited_desc.",
        },
        page_size: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max results (default 25).",
        },
        start_cursor: { type: "string", description: "Pagination cursor from a prior call." },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: searchHandler,
  });
}

async function searchHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const query = typeof args.query === "string" ? args.query : "";
  const pageSize = typeof args.page_size === "number" ? args.page_size : 25;
  const filter = (args.filter as string | undefined) ?? "any";
  const sortKey = (args.sort as string | undefined) ?? "last_edited_desc";

  const body: Parameters<typeof client.search>[0] = {
    query,
    page_size: pageSize,
    sort: {
      direction: sortKey === "last_edited_asc" ? "ascending" : "descending",
      timestamp: "last_edited_time",
    },
  };
  if (filter === "page") body.filter = { value: "page", property: "object" };
  if (filter === "database") body.filter = { value: "database", property: "object" };
  if (typeof args.start_cursor === "string") body.start_cursor = args.start_cursor;

  const res = await client.search(body);

  const lines: string[] = [`# Search results (${res.results.length}${res.has_more ? ", more available" : ""})`, ""];
  for (const item of res.results) {
    lines.push(formatSearchResult(item));
  }
  if (res.has_more && res.next_cursor) {
    lines.push("", `_More results available. Pass \`start_cursor: "${res.next_cursor}"\` to continue._`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function formatSearchResult(item: NotionPageObject | NotionDatabaseObject): string {
  if (item.object === "page") {
    const title = extractPageTitle(item.properties);
    return `- [page] **${title || "(untitled)"}** — ${item.url}\n  id: ${item.id} · last edited: ${item.last_edited_time}`;
  }
  // database
  const title = richTextToPlain(item.title);
  const sources = item.data_sources?.map((d) => `collection://${d.id}`).join(", ") ?? "";
  return `- [database] **${title || "(untitled)"}** — ${item.url}\n  id: ${item.id}${
    sources ? ` · sources: ${sources}` : ""
  }`;
}

function extractPageTitle(properties: Record<string, unknown>): string {
  for (const key of Object.keys(properties)) {
    const p = properties[key] as { type?: string; title?: unknown[] } | undefined;
    if (p?.type === "title" && Array.isArray(p.title)) {
      return richTextToPlain(p.title as import("../notion/client").NotionRichText[]);
    }
  }
  return "";
}
