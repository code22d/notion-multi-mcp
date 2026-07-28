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
import {
  describeTruncation,
  stripDashes,
  type NotionDatabaseObject,
  type NotionDataSourceObject,
} from "../notion/client";
import { parseCreateTable, parseAlterStatements, ParseError } from "../notion/ddl/parser";
import { emitCreateProperties, emitAlterPatch, plainTextToRichText, EmitError } from "../notion/ddl/emit";
// notion_query_data_source reuses the View DSL for filters/sorts — the shapes
// are identical, so a second dialect would only be a way for them to diverge.
import { parseViewDsl, ParseError as ViewParseError } from "../notion/view-dsl/parser";
import { emitViewBody, EmitError as ViewEmitError } from "../notion/view-dsl/emit";

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
        is_locked: {
          type: "boolean",
          description:
            "Lock / unlock the parent DATABASE against edits in the Notion UI. Applied to the database object, not the data source.",
        },
      },
      required: ["account", "data_source_id"],
      additionalProperties: false,
    },
    handler: updateDataSourceHandler,
  });

  register({
    name: "notion_query_data_source",
    description:
      "Query the rows of a Notion data source (a database's table of pages), with optional filters and sorts. " +
      "`filter` uses the same FILTER / SORT BY directive grammar as notion_create_view — Notion's data-source query and " +
      "view filter shapes are identical, so one dialect covers both. Example: " +
      'FILTER "Status" IN ("To-do", "In progress"); SORT BY "Due" ASC. ' +
      "Set `is_archived: true` to query ARCHIVED rows instead of live ones (Notion 2026-07-15). " +
      "Notion caps any query at 10,000 results; if that cap is hit the response says so explicitly rather than " +
      "quietly returning a truncated set.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        data_source_id: { type: "string", description: "The data source id (or a collection:// URI)." },
        filter: {
          type: "string",
          description:
            'FILTER / SORT BY directives, e.g. FILTER "Status" = "Done"; SORT BY "Created" DESC. ' +
            "Supports multi-value IN / NOT IN, relative dates (TODAY, ONE_WEEK_AGO, …), and ME on people columns.",
        },
        is_archived: {
          type: "boolean",
          description: "Return ARCHIVED rows instead of live ones. Default false.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          description: "Stop after this many rows (default 100). Truncation is always reported.",
        },
      },
      required: ["account", "data_source_id"],
      additionalProperties: false,
    },
    handler: queryDataSourceHandler,
  });
}

// -----------------------------------------------------------------------------
// notion_query_data_source
// -----------------------------------------------------------------------------

async function queryDataSourceHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const raw = typeof args.data_source_id === "string" ? args.data_source_id.trim() : "";
  if (!raw) return textErr("`data_source_id` is required.");
  const dsId = stripDashes(raw.startsWith("collection://") ? raw.slice("collection://".length) : raw);

  const body: Record<string, unknown> = {};

  // Reuse the View DSL for filters and sorts. The two shapes really are the
  // same — a view's `filter`/`sorts` and a data-source query's are the same
  // JSON — so maintaining a second dialect here would only create a way for
  // them to disagree.
  const dsl = typeof args.filter === "string" ? args.filter.trim() : "";
  if (dsl) {
    try {
      const directives = parseViewDsl(dsl);
      const unsupported = directives.find((d) => d.kind !== "filter" && d.kind !== "sort");
      if (unsupported) {
        return textErr(
          `notion_query_data_source only accepts FILTER and SORT BY directives — ` +
            `layout directives like ${unsupported.kind.toUpperCase().replace("_", " ")} belong on a view. ` +
            `Use notion_create_view / notion_update_view for those.`
        );
      }
      // Resolve column types from the schema so a FILTER on a select/status
      // column emits the right condition shape. Same fail-soft contract as the
      // view tools: an unknown name falls back to operator/value inference.
      let resolvePropertyType: ((name: string) => string | undefined) | undefined;
      try {
        const ds = await client.getDataSource(dsId);
        const map: Record<string, string> = {};
        for (const [name, v] of Object.entries(ds.properties ?? {})) {
          if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") {
            map[name] = (v as { type: string }).type;
          }
        }
        resolvePropertyType = (name: string) =>
          Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
      } catch {
        /* schema fetch failed — fall back to inference, as elsewhere */
      }

      const emitted = emitViewBody(directives, {
        ...(resolvePropertyType !== undefined ? { resolvePropertyType } : {}),
      });
      if (emitted.filter) body.filter = emitted.filter;
      if (emitted.sorts) body.sorts = emitted.sorts;
    } catch (e) {
      if (e instanceof ViewParseError || e instanceof ViewEmitError) return textErr(e.message);
      return textErr(e instanceof Error ? e.message : String(e));
    }
  }

  // `is_archived` (2026-07-15) — query archived rows instead of live ones.
  const isArchived = args.is_archived === true;
  if (isArchived) body.is_archived = true;

  const maxResults = typeof args.max_results === "number" ? args.max_results : 100;

  try {
    const collected = await client.queryDataSourceAll(dsId, body, { maxResults });

    const lines: string[] = [
      `# Rows in ${dsId}${isArchived ? " (archived)" : ""} — ${collected.results.length}`,
      "",
    ];
    // Truncation banner first — see describeTruncation's doc comment.
    const warning = describeTruncation(collected);
    if (warning) lines.push(warning, "");

    if (collected.results.length === 0) {
      lines.push("_(no rows matched)_");
    } else {
      for (const row of collected.results) {
        lines.push(`- **${extractRowTitle(row.properties) || "(untitled)"}**\n  id: ${row.id} · ${row.url ?? ""}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return textErr(`notion_query_data_source failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Pull the title cell out of a row's property bag for a readable listing. */
function extractRowTitle(properties: Record<string, unknown> | undefined): string {
  for (const v of Object.values(properties ?? {})) {
    const p = v as { type?: string; title?: Array<{ plain_text?: string }> } | undefined;
    if (p?.type === "title" && Array.isArray(p.title)) {
      return p.title.map((t) => t?.plain_text ?? "").join("").trim();
    }
  }
  return "";
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
  // `is_locked` is on the DATABASE's PATCH body whitelist, not the data
  // source's — so it rides along with is_inline/description on the second
  // PATCH below rather than the data-source PATCH above.
  const maybeIsLocked = typeof args.is_locked === "boolean" ? args.is_locked : undefined;
  const maybeDescription = typeof args.description === "string" && args.description.length > 0
    ? args.description
    : undefined;

  if (
    Object.keys(body).length === 0 &&
    maybeIsInline === undefined &&
    maybeIsLocked === undefined &&
    maybeDescription === undefined
  ) {
    return textErr(
      "No changes specified. Pass at least one of: statements, title, description, in_trash, is_inline, is_locked."
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
  if (maybeIsInline !== undefined || maybeDescription !== undefined || maybeIsLocked !== undefined) {
    const dsForParent = ds ?? (await client.getDataSource(dsId));
    const parentDbId = dsForParent?.database_parent?.database_id;
    if (!parentDbId) {
      // Soft error — the data-source change (if any) went through, but we
      // couldn't find a parent database to apply is_inline/description/is_locked to.
      const lines = ["# Updated data source (partial)"];
      lines.push(`- data_source_id: ${dsId}`);
      lines.push(`- warning: could not locate parent database to apply is_inline/description/is_locked.`);
      return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
    }
    const dbBody: Record<string, unknown> = {};
    if (maybeIsInline !== undefined) dbBody.is_inline = maybeIsInline;
    if (maybeIsLocked !== undefined) dbBody.is_locked = maybeIsLocked;
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
  if (maybeIsLocked !== undefined) lines.push(`- is_locked: ${maybeIsLocked}`);
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
