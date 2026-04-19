// -----------------------------------------------------------------------------
// Phase 2 — notion_create_pages, notion_update_page
//
// Currently stubs. The full implementation requires a Notion-flavored Markdown
// converter (markdown ↔ blocks) to match the native MCP's `content` parameter
// exactly. That converter is substantial and will be added in Phase 2.
//
// For now these tools register with full parity schemas so Claude sees the
// same tool surface, and emit a clear "not yet implemented" error.
// -----------------------------------------------------------------------------

import type { ToolDef } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { notYetImplemented } from "./_stub";

export function registerPageTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_pages",
    description:
      "Create one or more Notion pages in the specified account, with properties and content. Same surface as the native Notion MCP (Markdown content, parent page/database/data-source, templates). [Phase 2 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        pages: {
          type: "array",
          description: "Pages to create (up to 100). Each item has content, properties, icon, cover, template_id.",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              properties: { type: "object" },
              icon: { type: "string" },
              cover: { type: "string" },
              template_id: { type: "string" },
            },
          },
        },
        parent: {
          type: "object",
          description: "Parent under which the pages are created (page_id, database_id, or data_source_id).",
        },
      },
      required: ["account", "pages", "parent"],
      additionalProperties: false,
    },
    handler: notYetImplemented(2, "Requires Notion-flavored Markdown → blocks converter."),
  });

  register({
    name: "notion_update_page",
    description:
      "Update a Notion page on the specified account — properties, content, cover, icon, template application, or verification status. [Phase 2 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string" },
        command: {
          type: "string",
          enum: ["update_properties", "update_content", "replace_content", "apply_template", "update_verification"],
        },
        properties: { type: "object" },
        content_updates: { type: "array" },
        new_str: { type: "string" },
        template_id: { type: "string" },
        cover: { type: "string" },
        icon: { type: "string" },
        verification_status: { type: "string", enum: ["verified", "unverified"] },
        verification_expiry_days: { type: "integer" },
        allow_deleting_content: { type: "boolean" },
      },
      required: ["account", "page_id", "command"],
      additionalProperties: false,
    },
    handler: notYetImplemented(2, "Requires Markdown diff/replace engine to match native search-and-replace semantics."),
  });
}
