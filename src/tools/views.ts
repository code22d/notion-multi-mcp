// -----------------------------------------------------------------------------
// Phase 4 — notion_create_view, notion_update_view
//
// Stubs. Real implementation needs a View DSL parser understanding FILTER,
// SORT BY, GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, etc.
// -----------------------------------------------------------------------------

import type { ToolDef } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { notYetImplemented } from "./_stub";

export function registerViewTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_view",
    description:
      "Create a new view on a Notion database (table, board, list, calendar, timeline, gallery, form, chart, map, dashboard). [Phase 4 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        database_id: { type: "string" },
        data_source_id: { type: "string" },
        name: { type: "string" },
        type: {
          type: "string",
          enum: ["table", "board", "list", "calendar", "timeline", "gallery", "form", "chart", "map", "dashboard"],
        },
        configure: { type: "string" },
      },
      required: ["account", "database_id", "data_source_id", "name", "type"],
      additionalProperties: false,
    },
    handler: notYetImplemented(4, "Requires View DSL parser."),
  });

  register({
    name: "notion_update_view",
    description: "Update a view's name, filters, sorts, or display configuration. [Phase 4 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        view_id: { type: "string" },
        name: { type: "string" },
        configure: { type: "string" },
      },
      required: ["account", "view_id"],
      additionalProperties: false,
    },
    handler: notYetImplemented(4, "Requires View DSL parser."),
  });
}
