// -----------------------------------------------------------------------------
// Schema-aware coercion of scalar property values into Notion property values.
//
// Why this exists
// ---------------
// Both the create path (notion_create_pages) and the update path
// (notion_update_page → update_properties) accept "shorthand" scalars:
//
//     { "Status": "Done", "Priority": 3, "Owner": "…user-id…" }
//
// Historically both paths guessed the target shape from the *value's* JS type
// and the *key's* name — a string became `rich_text` unless the key happened to
// be called "title"/"Name". That guess is right only when the column really is
// rich_text. For every other string-shaped column Notion rejects the write:
//
//     "Status is expected to be status"
//     "database property select does not match filter text"
//
// This is the same class of bug the View DSL hit before it started resolving
// property types from the data source (see views.ts / view-dsl/emit.ts). The
// cure is the same: ask the schema what the column actually is, then serialize
// to match.
//
// Design notes
// ------------
//  - Pure functions here; no NotionClient import. Schema fetching takes a
//    minimal structural interface so this module stays trivially testable.
//  - Fail-soft everywhere. If the schema can't be fetched, or the column isn't
//    in it, we fall back to the historical heuristic rather than erroring — a
//    write that used to work must keep working.
//  - Object values always pass through untouched (the documented escape hatch
//    for callers who want to hand-build a native Notion property value).
// -----------------------------------------------------------------------------

/** Resolve a property name to its Notion type (e.g. "status"), or undefined
 *  when unknown. Unknown ⇒ caller falls back to the legacy heuristic. */
export type PropertyTypeResolver = (name: string) => string | undefined;

/** Always-unknown resolver — the fail-soft default. */
export const UNKNOWN_TYPES: PropertyTypeResolver = () => undefined;

/** Build a name → type resolver from a data source's `properties` map.
 *  Mirrors makeTypeResolverFromProperties() in tools/views.ts. */
export function makePropertyTypeResolver(
  properties: Record<string, unknown> | undefined | null
): PropertyTypeResolver {
  const map: Record<string, string> = {};
  for (const [name, v] of Object.entries(properties ?? {})) {
    if (v && typeof v === "object") {
      const vv = v as { type?: unknown };
      if (typeof vv.type === "string") map[name] = vv.type;
    }
  }
  return (name: string) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined;
}

// -----------------------------------------------------------------------------
// Schema fetching
// -----------------------------------------------------------------------------

/** The slice of NotionClient this module needs. Structural on purpose. */
export interface SchemaSource {
  getPage(pageId: string): Promise<unknown>;
  getDatabase(databaseId: string): Promise<unknown>;
  getDataSource(dataSourceId: string): Promise<unknown>;
}

type ParentLike = {
  type?: unknown;
  data_source_id?: unknown;
  database_id?: unknown;
};

function readParent(obj: unknown): ParentLike | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const p = (obj as { parent?: unknown }).parent;
  if (!p || typeof p !== "object") return undefined;
  return p as ParentLike;
}

function readProperties(obj: unknown): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const props = (obj as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return undefined;
  return props as Record<string, unknown>;
}

/** First data source id on a database object (API 2025-09-03 shape). */
function firstDataSourceId(db: unknown): string | undefined {
  if (!db || typeof db !== "object") return undefined;
  const list = (db as { data_sources?: unknown }).data_sources;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const first = list[0] as { id?: unknown };
  return typeof first?.id === "string" ? first.id : undefined;
}

/** Resolve property types for an existing page by walking page → parent →
 *  data source. Returns UNKNOWN_TYPES for page/workspace parents (no schema)
 *  and on any failure. */
export async function resolveTypesForPage(
  client: SchemaSource,
  pageId: string
): Promise<PropertyTypeResolver> {
  try {
    const page = await client.getPage(pageId);
    const parent = readParent(page);
    if (!parent) return UNKNOWN_TYPES;

    if (typeof parent.data_source_id === "string" && parent.data_source_id) {
      const ds = await client.getDataSource(parent.data_source_id);
      return makePropertyTypeResolver(readProperties(ds));
    }
    // Legacy parent shape — resolve the database's first data source.
    if (typeof parent.database_id === "string" && parent.database_id) {
      return resolveTypesForDatabase(client, parent.database_id);
    }
    // page_id / workspace parents have no column schema.
    return UNKNOWN_TYPES;
  } catch {
    return UNKNOWN_TYPES;
  }
}

/** Resolve property types for a database id (via its first data source). */
export async function resolveTypesForDatabase(
  client: SchemaSource,
  databaseId: string
): Promise<PropertyTypeResolver> {
  try {
    const db = await client.getDatabase(databaseId);
    const dsId = firstDataSourceId(db);
    if (!dsId) return UNKNOWN_TYPES;
    const ds = await client.getDataSource(dsId);
    return makePropertyTypeResolver(readProperties(ds));
  } catch {
    return UNKNOWN_TYPES;
  }
}

/** Resolve property types for a create-page parent, which the caller already
 *  told us about — no page fetch needed. */
export async function resolveTypesForParent(
  client: SchemaSource,
  parent: { type: string; data_source_id?: string; database_id?: string }
): Promise<PropertyTypeResolver> {
  try {
    if (parent.type === "data_source_id" && parent.data_source_id) {
      const ds = await client.getDataSource(parent.data_source_id);
      return makePropertyTypeResolver(readProperties(ds));
    }
    if (parent.type === "database_id" && parent.database_id) {
      return resolveTypesForDatabase(client, parent.database_id);
    }
    return UNKNOWN_TYPES;
  } catch {
    return UNKNOWN_TYPES;
  }
}

// -----------------------------------------------------------------------------
// Coercion
// -----------------------------------------------------------------------------

/** Sentinels the flat property format uses for booleans. */
const YES = "__YES__";
const NO = "__NO__";

/** Keys historically treated as the title column when no schema is available. */
export function isLegacyTitleKey(key: string): boolean {
  return key.toLowerCase() === "title" || key === "Title" || key === "Name";
}

function richText(content: string): unknown {
  return { rich_text: [{ type: "text", text: { content } }] };
}

function titleText(content: string): unknown {
  return { title: [{ type: "text", text: { content } }] };
}

/** True when a raw value is a scalar we'd have to guess about — i.e. a string
 *  that isn't a boolean sentinel. Used to decide whether a schema fetch is
 *  worth the round trip. Objects (escape hatch), numbers, booleans and arrays
 *  are all unambiguous already. */
export function isAmbiguousScalar(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === YES || value === NO) return false;
  if (isLegacyTitleKey(key)) return false;
  return true;
}

/** Does this property bag contain at least one value whose target shape we
 *  can't determine without the schema? */
export function needsTypeResolution(values: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(values)) {
    if (isAmbiguousScalar(key, value)) return true;
  }
  return false;
}

/**
 * Coerce a scalar shorthand value into a Notion property value, using the
 * column's real type when known.
 *
 * `type` is the Notion property type from the data source schema, or undefined
 * when unknown — in which case we reproduce the historical behaviour exactly.
 */
export function coerceScalarToPropertyValue(
  key: string,
  value: string | number | boolean,
  type: string | undefined
): unknown {
  // Booleans and numbers are unambiguous in every schema we care about, but
  // still respect an explicit schema type when it disagrees.
  if (typeof value === "boolean") {
    if (type === "checkbox" || type === undefined) return { checkbox: value };
    // e.g. a boolean written into a select column — stringify and continue.
    return coerceScalarToPropertyValue(key, value ? "true" : "false", type);
  }

  if (typeof value === "number") {
    switch (type) {
      case undefined:
      case "number":
        return { number: value };
      case "rich_text":
        return richText(String(value));
      case "title":
        return titleText(String(value));
      case "select":
        return { select: { name: String(value) } };
      case "status":
        return { status: { name: String(value) } };
      case "checkbox":
        return { checkbox: value !== 0 };
      default:
        return { number: value };
    }
  }

  // ---- strings ----
  if (value === YES) return { checkbox: true };
  if (value === NO) return { checkbox: false };

  // No schema → legacy heuristic, unchanged.
  if (type === undefined) {
    return isLegacyTitleKey(key) ? titleText(value) : richText(value);
  }

  const s = value;
  const empty = s === "";

  switch (type) {
    case "title":
      return titleText(s);

    case "rich_text":
      return richText(s);

    // Single-choice columns: empty string clears the value.
    case "select":
      return { select: empty ? null : { name: s } };
    case "status":
      return { status: empty ? null : { name: s } };

    // A bare string for a multi-select becomes a one-item selection. Commas are
    // NOT split — Notion allows commas inside option names, so splitting would
    // silently corrupt them. Callers wanting several options pass an array.
    case "multi_select":
      return { multi_select: empty ? [] : [{ name: s }] };

    case "url":
      return { url: empty ? null : s };
    case "email":
      return { email: empty ? null : s };
    case "phone_number":
      return { phone_number: empty ? null : s };

    case "number": {
      if (empty) return { number: null };
      const n = Number(s);
      return { number: Number.isFinite(n) ? n : null };
    }

    case "checkbox":
      return { checkbox: /^(true|yes|1|__yes__)$/i.test(s) };

    case "date":
      return { date: empty ? null : { start: s } };

    case "people":
      return { people: empty ? [] : [{ object: "user", id: s }] };

    case "relation":
      return { relation: empty ? [] : [{ id: s }] };

    case "files":
      return {
        files: empty
          ? []
          : [{ type: "external", name: s.split("/").pop() || s, external: { url: s } }],
      };

    // Read-only / computed columns — Notion rejects writes to these outright.
    // Pass through as rich_text so the API surfaces its own clear error rather
    // than us inventing a shape it never accepts.
    case "formula":
    case "rollup":
    case "created_time":
    case "created_by":
    case "last_edited_time":
    case "last_edited_by":
    case "unique_id":
      return richText(s);

    default:
      // Unrecognised (or newly added) type — legacy behaviour.
      return isLegacyTitleKey(key) ? titleText(s) : richText(s);
  }
}
