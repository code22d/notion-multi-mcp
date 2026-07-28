// -----------------------------------------------------------------------------
// Phase 3 — notion_create_database, notion_update_data_source.
//
// Both tools accept SQL DDL syntax that matches the native Notion MCP:
//
//   CREATE TABLE (
//     "Name" TITLE,
//     "Status" SELECT('To Do':red, 'Done':green),
//     "Due" DATE
//   )
//
//   ADD COLUMN "Priority" SELECT('High':red, 'Low':green)
//   DROP COLUMN "Old"
//   RENAME COLUMN "Status" TO "Project Status"
//   ALTER COLUMN "Status" SET SELECT('Open':yellow, 'Done':green)
//
// Implementation lives under src/notion/ddl/ (lexer → parser → emit).
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount, createNotionClient } from "../accounts/resolver";
import { stripDashes, type NotionDatabaseObject, type NotionDataSourceObject } from "../notion/client";
import { parseCreateTable, parseAlterStatements, ParseError } from "../notion/ddl/parser";
import { emitCreateProperties, emitAlterPatch, plainTextToRichText, EmitError } from "../notion/ddl/emit";

export function registerDatabaseTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_database",
    description:
      "Create a new Notion database on the specified account using SQL DDL syntax. Returns the created database and its data source ID. " +
      'Schema example: CREATE TABLE ("Name" TITLE, "Status" SELECT(\'To Do\':red, \'Done\':green), "Due" DATE). ' +
      "Supported property types: TITLE, RICH_TEXT, NUMBER [FORMAT 'fmt'], SELECT, MULTI_SELECT, STATUS, DATE, PEOPLE, CHECKBOX, URL, EMAIL, PHONE_NUMBER, FILES, RELATION('ds_id' [, DUAL]), ROLLUP('rel','target','fn'), FORMULA('expr'), UNIQUE_ID [PREFIX 'X'], CREATED_TIME, CREATED_BY, LAST_EDITED_TIME, LAST_EDITED_BY. " +
      "Colors: default, gray, brown, orange, yellow, green, blue, purple, pink, red.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        parent: {
          type: "object",
          description:
            "Parent under which to create the database. Exactly one of: { page_id: '…' }, { workspace: true }.",
        },
        title: { type: "string", description: "Plain-text database title." },
        description: { type: "string", description: "Optional plain-text database description." },
        schema: {
          type: "string",
          description:
            "SQL DDL CREATE TABLE statement. Column names double-quoted, option lists single-quoted. The leading CREATE TABLE prefix is optional.",
        },
      },
      required: ["account", "schema", "parent"],
      additionalProperties: false,
    },
    handler: createDatabaseHandler,
  });

  register({
    name: "notion_update_data_source",
    description:
      "Update a Notion data source's schema, title, or attributes. Schema changes use SQL-style statements (semicolon- or newline-separated): " +
      "ADD COLUMN \"Name\" <type>, DROP COLUMN \"Name\", RENAME COLUMN \"Old\" TO \"New\", ALTER COLUMN \"Name\" SET <type>. " +
      "Same property-type vocabulary as notion_create_database.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        data_source_id: { type: "string", description: "The data source id to update." },
        statements: {
          type: "string",
          description:
            "One or more ALTER statements separated by ';' or newlines. Optional — omit if you only want to change title/in_trash/is_inline.",
        },
        title: { type: "string", description: "New plain-text title for the data source." },
        description: {
          type: "string",
          description: "New plain-text description (forwarded to the underlying database object).",
        },
        in_trash: { type: "boolean", description: "Move the data source to / out of the trash." },
        is_inline: { type: "boolean", description: "Toggle inline rendering on the parent database." },
      },
      required: ["account", "data_source_id"],
      additionalProperties: false,
    },
    handler: updateDataSourceHandler,
  });
}

// -----------------------------------------------------------------------------
// notion_create_database
// -----------------------------------------------------------------------------

async function createDatabaseHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const parent = normalizeCreateParent(args.parent);
  if (!parent) {
    return textErr(
      "`parent` must be an object with exactly one of: page_id, workspace: true. Example: { \"page_id\": \"abc123…\" }."
    );
  }

  const schema = typeof args.schema === "string" ? args.schema : "";
  if (!schema.trim()) return textErr("`schema` is required — pass a CREATE TABLE DDL string.");

  // Parse → emit.
  let properties: Record<string, unknown>;
  try {
    const ast = parseCreateTable(schema);
    properties = emitCreateProperties(ast);
  } catch (e) {
    return textErr(formatDdlError(e));
  }

  // Build the POST /v1/databases body. In the 2025-09-03 API version properties
  // live under `initial_data_source`, not top-level.
  const body: Record<string, unknown> = {
    parent,
    initial_data_source: { properties },
  };
  if (typeof args.title === "string" && args.title.length > 0) {
    body.title = plainTextToRichText(args.title);
  }
  if (typeof args.description === "string" && args.description.length > 0) {
    body.description = plainTextToRichText(args.description);
  }

  let db: NotionDatabaseObject;
  try {
    db = await client.createDatabase(body);
  } catch (e) {
    return textErr(`Notion API rejected the CREATE request: ${e instanceof Error ? e.message : String(e)}`);
  }

  const dataSourceIds = (db.data_sources ?? []).map((s) => s.id);
  const firstDsId = dataSourceIds[0];

  const lines: string[] = [];
  lines.push(`# Created database`);
  lines.push(`- id: ${db.id}`);
  if (db.url) lines.push(`- url: ${db.url}`);
  if (firstDsId) lines.push(`- data_source_id: ${firstDsId}`);
  if (dataSourceIds.length > 1) {
    lines.push(`- additional data sources: ${dataSourceIds.slice(1).join(", ")}`);
  }
  lines.push("");
  lines.push(`Pass the data_source_id above into notion_update_data_source to ALTER the schema further.`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// -----------------------------------------------------------------------------
// notion_update_data_source
// -----------------------------------------------------------------------------

async function updateDataSourceHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const dsIdRaw = args.data_source_id;
  if (typeof dsIdRaw !== "string" || !dsIdRaw.trim()) {
    return textErr("`data_source_id` is required.");
  }
  const dsId = stripDashes(dsIdRaw);

  const body: Record<string, unknown> = {};

  const statements = typeof args.statements === "string" ? args.statements.trim() : "";
  if (statements) {
    try {
      const ops = parseAlterStatements(statements);
      const props = emitAlterPatch(ops);
      if (Object.keys(props).length > 0) body.properties = props;
    } catch (e) {
      return textErr(formatDdlError(e));
    }
  }

  if (typeof args.title === "string" && args.title.length > 0) {
    body.title = plainTextToRichText(args.title);
  }
  if (typeof args.in_trash === "boolean") body.in_trash = args.in_trash;
  // is_inline lives on the database object in the 2025-09-03 API, not the data
  // source. If the caller passes it we apply it via a second PATCH to the
  // parent database — a small convenience.
  const maybeIsInline = typeof args.is_inline === "boolean" ? args.is_inline : undefined;
  const maybeDescription = typeof args.description === "string" && args.description.length > 0
    ? args.description
    : undefined;

  if (Object.keys(body).length === 0 && maybeIsInline === undefined && maybeDescription === undefined) {
    return textErr(
      "No changes specified. Pass at least one of: statements, title, description, in_trash, is_inline."
    );
  }

  // 1. PATCH the data source itself (if there's anything to send).
  let ds: NotionDataSourceObject | undefined;
  if (Object.keys(body).length > 0) {
    try {
      ds = await client.updateDataSource(dsId, body);
    } catch (e) {
      return textErr(`Notion API rejected the PATCH: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. If the caller passed is_inline or description, those live on the
  //    database object — push a second PATCH to the parent database.
  let dbPatched = false;
  if (maybeIsInline !== undefined || maybeDescription !== undefined) {
    const dsForParent = ds ?? (await client.getDataSource(dsId));
    const parentDbId = dsForParent?.database_parent?.database_id;
    if (!parentDbId) {
      // Soft error — the data-source change (if any) went through, but we
      // couldn't find a parent database to apply is_inline/description to.
      const lines = ["# Updated data source (partial)"];
      lines.push(`- data_source_id: ${dsId}`);
      lines.push(`- warning: could not locate parent database to apply is_inline/description.`);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
    }
    const dbBody: Record<string, unknown> = {};
    if (maybeIsInline !== undefined) dbBody.is_inline = maybeIsInline;
    if (maybeDescription !== undefined) dbBody.description = plainTextToRichText(maybeDescription);
    try {
      await client.updateDatabase(parentDbId, dbBody);
      dbPatched = true;
    } catch (e) {
      return textErr(`Notion API rejected the database PATCH: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lines: string[] = [];
  lines.push(`# Updated data source`);
  lines.push(`- data_source_id: ${dsId}`);
  if (statements) lines.push(`- applied ${countStatements(statements)} schema statement(s).`);
  if (typeof args.title === "string" && args.title) lines.push(`- title: ${args.title}`);
  if (maybeIsInline !== undefined) lines.push(`- is_inline: ${maybeIsInline}`);
  if (maybeDescription !== undefined) lines.push(`- description updated.`);
  if (typeof args.in_trash === "boolean") lines.push(`- in_trash: ${args.in_trash}`);
  if (dbPatched) lines.push(`- parent database also updated.`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface CreateParent {
  type: "page_id" | "workspace";
  page_id?: string;
  workspace?: boolean;
}

function normalizeCreateParent(raw: unknown): CreateParent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.page_id === "string" && r.page_id.trim()) {
    return { type: "page_id", page_id: stripDashes(r.page_id) };
  }
  if (r.workspace === true) {
    return { type: "workspace", workspace: true };
  }
  // Also tolerate {type: "page_id", page_id: "..."} shape, which matches the
  // SDK's explicit form.
  if (r.type === "page_id" && typeof r.page_id === "string" && r.page_id.trim()) {
    return { type: "page_id", page_id: stripDashes(r.page_id) };
  }
  if (r.type === "workspace") {
    return { type: "workspace", workspace: true };
  }
  return null;
}

function formatDdlError(e: unknown): string {
  if (e instanceof ParseError || e instanceof EmitError) {
    return `DDL error: ${e.message}`;
  }
  return `DDL error: ${e instanceof Error ? e.message : String(e)}`;
}

/** Counts top-level statements in the input — for a human-readable summary. */
function countStatements(source: string): number {
  const lines = source.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  return lines.length;
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
