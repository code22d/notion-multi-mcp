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
import { ACCOUNT_PARAM_SCHEMA, resolveAccount, createNotionClient } from "../accounts/resolver";
import { describeTruncation, stripDashes, type NotionViewObject } from "../notion/client";
import { parseViewDsl, ParseError } from "../notion/view-dsl/parser";
import { emitViewBody, EmitError, type EmittedViewBody, type ViewType } from "../notion/view-dsl/emit";
import type { DirectiveAst } from "../notion/view-dsl/ast";

/**
 * Filter-grammar help appended to both view tools' descriptions. Kept in one
 * place so create and update can't document different dialects of the same DSL.
 */
const FILTER_DSL_HELP =
  "FILTER grammar — single value: \"Prop\" = \"v\" | != | CONTAINS | STARTS WITH | ENDS WITH | " +
  "< > <= >= | BEFORE | AFTER | ON OR BEFORE | ON OR AFTER | IS EMPTY | IS NOT EMPTY | IS CHECKED | IS UNCHECKED. " +
  "Multi-value: \"Prop\" IN (\"a\", \"b\") matches any of them, \"Prop\" NOT IN (\"a\", \"b\") excludes all of them — " +
  "on select/status these become equals/does_not_equal with an array, on multi_select contains/does_not_contain with an array. " +
  "Relative dates on date columns (bare keywords, no quotes): TODAY, TOMORROW, YESTERDAY, ONE_WEEK_AGO, ONE_WEEK_FROM_NOW, " +
  "ONE_MONTH_AGO, ONE_MONTH_FROM_NOW — e.g. FILTER \"Due\" ON OR AFTER TODAY. Notion resolves these in the workspace's timezone. " +
  "Current user on people columns: FILTER \"Assignee\" CONTAINS ME (this connector is a public OAuth integration, so ME resolves " +
  "to the authorizing user; inside an INTERNAL integration ME matches nothing because there is no authorizing user). " +
  "Compound: (\"A\" = \"x\") AND (\"B\" >= 3), or OR. Column types are read from the data source, so you rarely need the " +
  "explicit type prefix (\"Prop\" SELECT = \"Done\").";

export function registerViewTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_view",
    description:
      "Create a new view on a Notion database (table, board, list, calendar, timeline, gallery, form, chart, map, dashboard). " +
      "The `configure` parameter is a directive DSL: FILTER \"Status\" = \"Done\"; SORT BY \"Created\" DESC; GROUP BY \"Priority\"; " +
      "CALENDAR BY \"Due Date\"; TIMELINE BY \"Start\" TO \"End\"; MAP BY \"Location\"; CHART column AGGREGATE sum OF \"Revenue\"; " +
      "FORM CLOSE | FORM ANONYMOUS true | FORM PERMISSIONS editor; SHOW \"Name\", \"Status\"; COVER \"Image\" | COVER PAGE_COVER. " +
      FILTER_DSL_HELP,
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
      "Update a view's name, filters, sorts, or display configuration. `configure` follows the same DSL as notion_create_view. " +
      FILTER_DSL_HELP,
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        view_id: { type: "string", description: "The view id (or a Notion URL containing ?v=<view id>)." },
        name: { type: "string" },
        configure: { type: "string" },
      },
      required: ["account", "view_id"],
      additionalProperties: false,
    },
    handler: updateViewHandler,
  });

  register({
    name: "notion_get_view",
    description:
      "Retrieve a single Notion view by id: its name, type, data source, filter, sorts, and layout configuration. " +
      "Use notion_list_views first if you only have a database or data source id.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        view_id: { type: "string", description: "The view id (or a Notion URL containing ?v=<view id>)." },
      },
      required: ["account", "view_id"],
      additionalProperties: false,
    },
    handler: getViewHandler,
  });

  register({
    name: "notion_delete_view",
    description:
      "Delete a Notion view. This removes the view from its database — the underlying pages/rows are NOT deleted. " +
      "A database's last remaining view usually cannot be deleted; Notion rejects that with a clear error.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        view_id: { type: "string" },
      },
      required: ["account", "view_id"],
      additionalProperties: false,
    },
    handler: deleteViewHandler,
  });

  register({
    name: "notion_list_views",
    description:
      "List the views on a Notion database or data source. Pass `database_id` for every view on the database, " +
      "or `data_source_id` for every view backed by that data source. Returns each view's id, name, and type.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        database_id: { type: "string", description: "List all views on this database." },
        data_source_id: { type: "string", description: "List all views backed by this data source." },
        start_cursor: { type: "string", description: "Pagination cursor from a prior call." },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Results per page (max 100)." },
        include_details: {
          type: "boolean",
          description:
            "Fetch each view's full object to show name and type. Costs one extra API call per view. Default true.",
        },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: listViewsHandler,
  });

  register({
    name: "notion_query_view",
    description:
      "Run a view's own filters and sorts and return the matching pages. This is how you read a board/table/calendar " +
      "exactly as a person sees it in Notion, rather than re-deriving the filter yourself. " +
      "Notion caps any query at 10,000 results; if that cap is hit the response says so explicitly rather than " +
      "returning a truncated set that looks complete.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        view_id: { type: "string" },
        max_results: {
          type: "integer",
          minimum: 1,
          description: "Stop after this many rows (default 100). Truncation is always reported.",
        },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Rows per API call (max 100)." },
      },
      required: ["account", "view_id"],
      additionalProperties: false,
    },
    handler: queryViewHandler,
  });
}

/**
 * Pull a view id out of whatever the caller passed.
 *
 * Notion's own MCP accepts `view://<id>`, a Notion URL carrying `?v=<id>`, or
 * a bare UUID, and callers reliably paste URLs, so accepting all three costs
 * little and removes a common failure.
 */
export function parseViewId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("view://")) return stripDashes(trimmed.slice("view://".length));
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const v = new URL(trimmed).searchParams.get("v");
      if (v) return stripDashes(v);
    } catch {
      /* fall through to the bare-id path */
    }
  }
  return stripDashes(trimmed);
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function createViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

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
    let resolvePropertyType: ((name: string) => string | undefined) | undefined;
    // Fetch the data source when we need id resolution for config directives
    // OR type resolution for FILTER emission. One fetch, two resolvers.
    const needsIds = directivesNeedIdResolution(directives);
    const needsTypes = directivesNeedTypeResolution(directives);
    if (needsIds || needsTypes) {
      const ds = await client.getDataSource(dataSourceId);
      if (needsIds) resolvePropertyId = makeResolverFromProperties(ds.properties);
      if (needsTypes) resolvePropertyType = makeTypeResolverFromProperties(ds.properties);
    }
    body = emitViewBody(directives, {
      viewType: type,
      ...(resolvePropertyId !== undefined ? { resolvePropertyId } : {}),
      ...(resolvePropertyType !== undefined ? { resolvePropertyType } : {}),
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
  const client = createNotionClient(account, ctx);

  const rawViewId = typeof args.view_id === "string" ? args.view_id.trim() : "";
  if (!rawViewId) return textErr("`view_id` is required.");
  // Same acceptance as notion_get_view / _delete_view / _query_view. Without
  // this, pasting a Notion URL worked in one tool and 400'd in this one, which
  // reads as "update is broken" rather than "wrong id format".
  const viewId = parseViewId(rawViewId);

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
  const needsTypeResolution = directivesNeedTypeResolution(directives);

  let viewType: ViewType | undefined;
  let resolvePropertyId: ((name: string) => string) | undefined;
  let resolvePropertyType: ((name: string) => string | undefined) | undefined;
  if (needsViewType || needsIdResolution || needsTypeResolution) {
    try {
      const existing = await client.getView(viewId);
      viewType = existing.type;
      if (needsIdResolution || needsTypeResolution) {
        const dsId = existing.data_source_id;
        if (!dsId) {
          return textErr(
            `notion_update_view: the fetched view has no data_source_id, so property names cannot be resolved to ids. Pass property ids in the DSL instead.`
          );
        }
        const ds = await client.getDataSource(dsId);
        if (needsIdResolution) resolvePropertyId = makeResolverFromProperties(ds.properties);
        if (needsTypeResolution) resolvePropertyType = makeTypeResolverFromProperties(ds.properties);
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
      ...(resolvePropertyType !== undefined ? { resolvePropertyType } : {}),
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

async function getViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const raw = typeof args.view_id === "string" ? args.view_id.trim() : "";
  if (!raw) return textErr("`view_id` is required.");

  try {
    const view = await client.getView(parseViewId(raw));
    return { content: [{ type: "text", text: formatViewDetail(view) }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_get_view failed: ${msg}`);
  }
}

async function deleteViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const raw = typeof args.view_id === "string" ? args.view_id.trim() : "";
  if (!raw) return textErr("`view_id` is required.");
  const viewId = parseViewId(raw);

  // Read the view first so the confirmation can name what was removed. DELETE
  // returns only identity fields, so without this the user gets back a bare
  // uuid and no way to tell whether they deleted the right thing.
  let label = viewId;
  try {
    const existing = await client.getView(viewId);
    label = `**${existing.name}** (${existing.type})`;
  } catch {
    /* fail soft — a delete that works shouldn't fail on a cosmetic pre-read */
  }

  try {
    await client.deleteView(viewId);
    return { content: [{ type: "text", text: `✅ Deleted view ${label}\nid: ${viewId}` }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_delete_view failed: ${msg}`);
  }
}

async function listViewsHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const databaseId = typeof args.database_id === "string" ? args.database_id.trim() : "";
  const dataSourceId = typeof args.data_source_id === "string" ? args.data_source_id.trim() : "";
  if (!databaseId && !dataSourceId) {
    return textErr("Pass either `database_id` or `data_source_id`.");
  }
  const includeDetails = args.include_details !== false;

  try {
    const page = await client.listViews({
      ...(databaseId ? { databaseId } : {}),
      ...(dataSourceId ? { dataSourceId } : {}),
      ...(typeof args.start_cursor === "string" ? { startCursor: args.start_cursor } : {}),
      ...(typeof args.page_size === "number" ? { pageSize: args.page_size } : {}),
    });

    const scope = databaseId ? `database ${databaseId}` : `data source ${dataSourceId}`;
    const lines: string[] = [`# Views on ${scope} (${page.results.length})`, ""];

    if (page.results.length === 0) {
      lines.push("_(none)_");
    } else if (!includeDetails) {
      // GET /v1/views returns MINIMAL references — id only. Say so rather than
      // rendering a list of bare uuids that looks like a bug.
      for (const v of page.results) lines.push(`- id: ${v.id}`);
      lines.push("", "_Ids only — pass `include_details: true` (the default) for names and types._");
    } else {
      for (const ref of page.results) {
        try {
          const full = await client.getView(ref.id);
          lines.push(`- **${full.name}** (${full.type}) — id: ${full.id}${full.url ? `\n  ${full.url}` : ""}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          lines.push(`- id: ${ref.id} — _(could not load details: ${msg})_`);
        }
      }
    }

    if (page.has_more && page.next_cursor) {
      lines.push("", `_More views available. Pass \`start_cursor: "${page.next_cursor}"\` to continue._`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_list_views failed: ${msg}`);
  }
}

async function queryViewHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const raw = typeof args.view_id === "string" ? args.view_id.trim() : "";
  if (!raw) return textErr("`view_id` is required.");
  const viewId = parseViewId(raw);

  const maxResults = typeof args.max_results === "number" ? args.max_results : 100;
  const pageSize = typeof args.page_size === "number" ? args.page_size : undefined;

  try {
    const collected = await client.queryViewAll(viewId, {
      maxResults,
      ...(pageSize !== undefined ? { pageSize } : {}),
    });

    const lines: string[] = [];
    const total = typeof collected.totalCount === "number" ? ` of ${collected.totalCount}` : "";
    lines.push(`# View query results (${collected.results.length}${total})`, "");

    // The truncation banner goes FIRST, not in a footnote. A caller that reads
    // only the head of a long tool result must still see that the set is
    // partial — that is the whole point of the 2026-04-20 request_status field.
    const warning = describeTruncation(collected);
    if (warning) lines.push(warning, "");

    if (collected.results.length === 0) {
      lines.push("_(no rows matched this view's filters)_");
    } else {
      for (const row of collected.results) {
        lines.push(`- page: ${row.id}`);
      }
      lines.push(
        "",
        "_The view query endpoint returns page REFERENCES (ids only). Use notion_fetch on an id for its content._"
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_query_view failed: ${msg}`);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function formatViewDetail(view: NotionViewObject): string {
  const lines: string[] = [
    `# View: ${view.name}`,
    `Type: ${view.type}`,
    `ID: ${view.id}`,
  ];
  if (view.url) lines.push(`URL: ${view.url}`);
  if (view.data_source_id) lines.push(`Data source: collection://${view.data_source_id}`);
  if (view.parent?.database_id) lines.push(`Database: ${view.parent.database_id}`);
  lines.push(
    "",
    "## Filter",
    view.filter ? "```json\n" + JSON.stringify(view.filter, null, 2) + "\n```" : "_(none)_",
    "",
    "## Sorts",
    view.sorts && view.sorts.length > 0
      ? "```json\n" + JSON.stringify(view.sorts, null, 2) + "\n```"
      : "_(none)_",
    "",
    "## Configuration",
    view.configuration ? "```json\n" + JSON.stringify(view.configuration, null, 2) + "\n```" : "_(none)_"
  );
  return lines.join("\n");
}

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

/** Does this directive set include a FILTER that would benefit from column-
 *  type resolution? Today every FILTER does — an explicit-type override in
 *  the DSL simply shadows the resolver — so we trigger a data-source fetch
 *  whenever a FILTER directive is present. */
function directivesNeedTypeResolution(directives: DirectiveAst[]): boolean {
  for (const d of directives) {
    if (d.kind === "filter") return true;
  }
  return false;
}

/** Build a resolver (name → Notion column type, e.g. "select", "status") from
 *  a data source's `properties` map. Returns undefined for names not present
 *  so the emitter can fall back to inference; the emitter also accepts an id
 *  in place of a name (unknown strings → undefined → inference). */
function makeTypeResolverFromProperties(properties: Record<string, unknown>): (name: string) => string | undefined {
  const map: Record<string, string> = {};
  for (const [name, v] of Object.entries(properties ?? {})) {
    if (v && typeof v === "object") {
      const vv = v as { type?: unknown };
      if (typeof vv.type === "string") map[name] = vv.type;
    }
  }
  return (name: string) => {
    if (Object.prototype.hasOwnProperty.call(map, name)) return map[name];
    return undefined;
  };
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
