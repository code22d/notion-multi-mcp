// -----------------------------------------------------------------------------
// Phase 3 — notion_create_database, notion_update_data_source
//
// Stubs for now. Real implementation needs a SQL DDL parser that understands
// TITLE, RICH_TEXT, SELECT('opt':color, ...), NUMBER FORMAT 'dollar',
// FORMULA(...), RELATION(..., DUAL ...), ROLLUP(...), UNIQUE_ID PREFIX, etc.
// -----------------------------------------------------------------------------

import type { ToolDef } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { notYetImplemented } from "./_stub";

export function registerDatabaseTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_database",
    description:
      "Create a new Notion database on the specified account using SQL DDL syntax. Returns the created database and its data source ID. [Phase 3 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        parent: {
          type: "object",
          description: "Parent page under which to create the database. { type: 'page_id', page_id: '...' }.",
        },
        title: { type: "string" },
        description: { type: "string" },
        schema: {
          type: "string",
          description:
            'SQL DDL CREATE TABLE statement defining the schema. Column names double-quoted, option lists single-quoted.',
        },
      },
      required: ["account", "schema", "parent"],
      additionalProperties: false,
    },
    handler: notYetImplemented(3, "Requires SQL DDL CREATE TABLE parser."),
  });

  register({
    name: "notion_update_data_source",
    description:
      "Update a Notion data source's schema, title, or attributes using SQL DDL (ADD COLUMN, DROP COLUMN, RENAME COLUMN, ALTER COLUMN). [Phase 3 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        data_source_id: { type: "string" },
        statements: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        in_trash: { type: "boolean" },
        is_inline: { type: "boolean" },
      },
      required: ["account", "data_source_id"],
      additionalProperties: false,
    },
    handler: notYetImplemented(3, "Requires ALTER statement parser."),
  });
}
