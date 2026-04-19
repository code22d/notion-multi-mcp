// -----------------------------------------------------------------------------
// notion_duplicate_page — actually works via the public API by creating a new
// page whose parent duplicates the source. (Full block copy requires Phase 2's
// block walker, so this Phase 1 version returns a not-supported note that
// describes the path forward.)
//
// notion_move_pages — supported by Notion's PATCH /pages endpoint.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { NotionClient } from "../notion/client";

export function registerDuplicateAndMoveTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_duplicate_page",
    description:
      "Duplicate a Notion page on the specified account. Full recursive block copy arrives with Phase 2. [Phase 4 — pending full implementation]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string" },
      },
      required: ["account", "page_id"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      await resolveAccount(args, ctx);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              "notion_duplicate_page requires the block walker (Phase 2) for a faithful copy. Use Notion's UI or re-run this tool after Phase 2 ships.",
          },
        ],
      };
    },
  });

  register({
    name: "notion_move_pages",
    description: "Move one or more Notion pages/databases to a new parent on the specified account.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_or_database_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        new_parent: {
          type: "object",
          description: "New parent: { type: 'page_id' | 'database_id' | 'data_source_id' | 'workspace', ... }",
        },
      },
      required: ["account", "page_or_database_ids", "new_parent"],
      additionalProperties: false,
    },
    handler: moveHandler,
  });
}

async function moveHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const ids = Array.isArray(args.page_or_database_ids) ? (args.page_or_database_ids as string[]) : [];
  const parent = args.new_parent as Record<string, unknown> | undefined;
  if (ids.length === 0) return { isError: true, content: [{ type: "text", text: "`page_or_database_ids` must have at least one id." }] };
  if (!parent || !parent.type) return { isError: true, content: [{ type: "text", text: "`new_parent` is required and must have a `type`." }] };

  const results: string[] = [];
  for (const id of ids) {
    try {
      // PATCH /pages/:id supports `parent` updates for moves within the same workspace.
      const updated = await client.updatePage(id, { parent });
      results.push(`✅ Moved ${id} → parent ${JSON.stringify(parent)} (now at ${updated.url})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`❌ ${id}: ${msg}`);
    }
  }
  return { content: [{ type: "text", text: results.join("\n") }] };
}
