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
import type { DirectiveAst } from "../notion/view-dsl/ast";

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
    // If any directive references a property by name in a slot that Notion
    // wants a property_id for (GROUP BY / CALENDAR BY / TIMELINE BY / MAP BY /
    // CHART / SHOW / COVER-by-property), fetch the data source and build a
    // name → id resolver. Filter/sort-only DSLs skip the fetch.
    let resolvePropertyId: ((name: string) => string) | undefined;
    if (directivesNeedIdResolution(directives)) {
      const ds = await client.getDataSource(dataSourceId);
      resolvePropertyId = makeResolverFromProperties(ds.properties);
    }
    body = emitViewBody(directives, {
      viewType: type,
      ...(resolvePropertyId !== undefined ? { resolvePropertyId } : {}),
    });
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
  // fetch the view to discover it. We'll also use the fetched view's
  // data_source_id to look up property ids when the DSL references properties
  // by name.
  const needsViewType = directives.some(
    (d) => d.kind !== "filter" && d.kind !== "sort"
  );
  const needsIdResolution = directivesNeedIdResolution(directives);

  let viewType: ViewType | undefined;
  let resolvePropertyId: ((name: string) => string) | undefined;
  if (needsViewType || needsIdResolution) {
    try {
      const existing = await client.getView(viewId);
      viewType = existing.type;
      if (needsIdResolution) {
        const dsId = existing.data_source_id;
        if (!dsId) {
          return textErr(
            `notion_update_view: the fetched view has no data_source_id, so property names cannot be resolved to ids. Pass property ids in the DSL instead.`
          );
        }
        const ds = await client.getDataSource(dsId);
        resolvePropertyId = makeResolverFromProperties(ds.properties);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return textErr(`notion_update_view could not read the existing view: ${msg}`);
    }
  }

  let body: EmittedViewBody;
  try {
    body = emitViewBody(directives, {
      viewType,
      forUpdate: true,
      ...(resolvePropertyId !== undefined ? { resolvePropertyId } : {}),
    });
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

/** Does this directive set reference properties in slots that Notion's view
 *  API wants an id (not a name)? FILTER/SORT take names; everything else on
 *  the configuration object takes property_id. */
function directivesNeedIdResolution(directives: DirectiveAst[]): boolean {
  for (const d of directives) {
    switch (d.kind) {
      case "filter":
      case "sort":
      case "form":
        continue;
      case "group_by":
      case "calendar_by":
      case "timeline_by":
      case "map_by":
      case "chart":
      case "show":
        return true;
      case "cover":
        if (d.cover.kind === "property") return true;
        continue;
    }
  }
  return false;
}

/** Build a resolver (name → property_id) from a data source's `properties`
 *  map. Throws a helpful EmitError if a name isn't present. */
function makeResolverFromProperties(properties: Record<string, unknown>): (name: string) => string {
  const map: Record<string, string> = {};
  for (const [name, v] of Object.entries(properties ?? {})) {
    if (v && typeof v === "object") {
      const vv = v as { id?: unknown };
      if (typeof vv.id === "string" && vv.id) map[name] = vv.id;
    }
  }
  const available = Object.keys(map);
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name]!;
    // If the "name" is already an id we know about (values of the map), pass
    // through — lets callers mix ids and names in one DSL without friction.
    for (const id of Object.values(map)) {
      if (id === name) return name;
    }
    throw new EmitError(
      `property "${name}" not found on the view's data source. ` +
        `Available property names: ${available.map((n) => `"${n}"`).join(", ") || "(none)"}.`
    );
  };
}
