// -----------------------------------------------------------------------------
// Phase 4 — notion_create_view, notion_update_view
//
// Parses the View DSL (see src/notion/view-dsl/) and POSTs/PATCHes the Notion
// public REST API. Tool names, descriptions, and input schemas match the
// native Notion MCP for parity — swap-in handlers, schemas unchanged.
//
// Public-API caveats we surface as clean tool errors:
//   - dashboard view configuration isn't exposed via the public API; creating
//     a bare dashboard (name + type, no config) still works.
//   - FORMULA filters need the inner result type — we reject them and ask the
//     caller to filter against the underlying property.
//   - Anything else Notion rejects is passed through as the API error body.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount } from "../accounts/resolver";
import { NotionClient, stripDashes, type NotionViewObject } from "../notion/client";
import { parseViewDsl, ParseError } from "../notion/view-dsl/parser";
import { emitViewBody, EmitError, type EmittedViewBody, type ViewType } from "../notion/view-dsl/emit";

export function registerViewTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_view",
    description:
      "Create a new view on a Notion database (table, board, list, calendar, timeline, gallery, form, chart, map, dashboard). " +
      "The `configure` parameter is a directive DSL: FILTER \"Status\" = \"Done\"; SORT BY \"Created\" DESC; GROUP BY \"Priority\"; " +
      "CALENDAR BY \"Due Date\"; TIMELINE BY \"Start\" TO \"End\"; MAP BY \"Location\"; CHART column AGGREGATE sum OF \"Revenue\"; " +
      "FORM CLOSE | FORM ANONYMOUS true | FORM PERMISSIONS editor; SHOW \"Name\", \"Status\"; COVER \"Image\" | COVER PAGE_COVER.",
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
    handler: createViewHandler,
  });

  register({
    name: "notion_update_view",
    description:
      "Update a view's name, filters, sorts, or display configuration. `configure` follows the same DSL as notion_create_view.",
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
    handler: updateViewHandler,
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function createViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const databaseId = typeof args.database_id === "string" ? args.database_id.trim() : "";
  const dataSourceId = typeof args.data_source_id === "string" ? args.data_source_id.trim() : "";
  const name = typeof args.name === "string" ? args.name.trim() : "";
  const type = typeof args.type === "string" ? args.type : "";
  if (!databaseId || !dataSourceId || !name || !type) {
    return textErr("`database_id`, `data_source_id`, `name`, and `type` are all required.");
  }
  if (!isViewType(type)) {
    return textErr(`Unknown view \`type\` "${type}".`);
  }

  // Parse the DSL (if any) and emit a body.
  const configure = typeof args.configure === "string" ? args.configure : "";
  let body: EmittedViewBody;
  try {
    const directives = configure.trim() === "" ? [] : parseViewDsl(configure);
    body = emitViewBody(directives, { viewType: type });
  } catch (e) {
    return toolErrorFromDsl(e);
  }

  try {
    const payload: Record<string, unknown> = {
      database_id: stripDashes(databaseId),
      data_source_id: stripDashes(dataSourceId),
      name,
      type,
    };
    if (body.filter) payload.filter = body.filter;
    if (body.sorts) payload.sorts = body.sorts;
    if (body.configuration) payload.configuration = body.configuration;

    const view = await client.createView(payload);
    return { content: [{ type: "text", text: formatViewResult("Created", view) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_create_view failed: ${msg}`);
  }
}

async function updateViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const viewId = typeof args.view_id === "string" ? args.view_id.trim() : "";
  if (!viewId) return textErr("`view_id` is required.");

  const name = typeof args.name === "string" ? args.name : undefined;
  const configure = typeof args.configure === "string" ? args.configure : "";

  // Parse DSL early so we can fail before touching the API.
  let directives;
  try {
    directives = configure.trim() === "" ? [] : parseViewDsl(configure);
  } catch (e) {
    return toolErrorFromDsl(e);
  }

  // If any configuration-touching directive is present, we need the view type —
  // fetch the view to discover it.
  const needsViewType = directives.some(
    (d) => d.kind !== "filter" && d.kind !== "sort"
  );

  let viewType: ViewType | undefined;
  if (needsViewType) {
    try {
      const existing = await client.getView(viewId);
      viewType = existing.type;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return textErr(`notion_update_view could not read the existing view to determine its type: ${msg}`);
    }
  }

  let body: EmittedViewBody;
  try {
    body = emitViewBody(directives, { viewType, forUpdate: true });
  } catch (e) {
    return toolErrorFromDsl(e);
  }

  try {
    const payload: Record<string, unknown> = {};
    if (name !== undefined) payload.name = name;
    if (body.filter !== undefined) payload.filter = body.filter;
    if (body.sorts !== undefined) payload.sorts = body.sorts;
    if (body.configuration !== undefined) payload.configuration = body.configuration;

    if (Object.keys(payload).length === 0) {
      return textErr("Nothing to update — pass `name` and/or a non-empty `configure` DSL.");
    }

    const view = await client.updateView(viewId, payload);
    return { content: [{ type: "text", text: formatViewResult("Updated", view) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_update_view failed: ${msg}`);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isViewType(s: string): s is ViewType {
  return (
    s === "table" || s === "board" || s === "list" || s === "calendar" ||
    s === "timeline" || s === "gallery" || s === "form" || s === "chart" ||
    s === "map" || s === "dashboard"
  );
}

function toolErrorFromDsl(e: unknown): ToolResult {
  if (e instanceof ParseError || e instanceof EmitError) {
    return textErr(e.message);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return textErr(msg);
}

function formatViewResult(verb: string, view: NotionViewObject): string {
  const url = view.url ?? "";
  return `✅ ${verb} view: **${view.name}** (${view.type})\nid: ${view.id}${url ? `\n${url}` : ""}`;
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
