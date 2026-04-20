// -----------------------------------------------------------------------------
// AST → Notion request body.
//
//   emitCreateProperties(ast) → Record<string, PropertyConfigurationRequest>
//     Goes under `initial_data_source.properties` on POST /v1/databases.
//
//   emitAlterPatch(ops) → Record<string, PropertyConfigurationRequest | {name} | null>
//     Goes under `properties` on PATCH /v1/data_sources/{id}. Each ALTER op
//     maps to one key/value pair:
//       ADD        → key = new column name,   value = property config
//       DROP       → key = old name,           value = null
//       RENAME     → key = old name,           value = { name: "new" }
//       ALTER SET  → key = current name,       value = property config
//
// Validation we do eagerly:
//   - exactly one TITLE in CREATE (ALTER is unchecked — server decides)
//   - known SelectColor for SELECT/MULTI_SELECT/STATUS options (parser already
//     guarantees this, but we re-validate as defence in depth)
//   - known RollupFunction for ROLLUP
//   - unique property names inside one statement
//
// Anything else (NUMBER format strings, RELATION data_source_id format, etc.)
// is passed through — Notion is the source of truth for those.
// -----------------------------------------------------------------------------

import type { CreateTableAst, AlterOp, ColumnDef, PropertyTypeAst, DdlRollupFunction } from "./ast";

/**
 * The shape we emit for each property — a JSON object the Notion API accepts
 * as a PropertyConfigurationRequest. We type it loosely here (matches the
 * convention used for BlockRequest in Phase 2) so TS doesn't force us to
 * narrow against the SDK's massive discriminated union every time.
 */
export type EmittedPropertyConfig = Record<string, unknown> & { type?: string };

// A property value in the PATCH body can be a full config, a rename, or null.
export type AlterPropertyValue =
  | EmittedPropertyConfig
  | { name: string }
  | null;

export class EmitError extends Error {
  constructor(message: string) {
    super(`DDL emit error: ${message}`);
  }
}

// Mirror of @notionhq/client's RollupFunction enum. Validated at emit time so
// callers get a fast, clear error instead of a Notion 400.
const ROLLUP_FUNCTIONS: ReadonlySet<DdlRollupFunction> = new Set<DdlRollupFunction>([
  "count", "count_values", "empty", "not_empty", "unique", "show_unique",
  "percent_empty", "percent_not_empty", "sum", "average", "median", "min", "max",
  "range", "earliest_date", "latest_date", "date_range", "checked", "unchecked",
  "percent_checked", "percent_unchecked", "count_per_group", "percent_per_group",
  "show_original",
]);

// -----------------------------------------------------------------------------
// CREATE → properties map
// -----------------------------------------------------------------------------

export function emitCreateProperties(
  ast: CreateTableAst
): Record<string, EmittedPropertyConfig> {
  const props: Record<string, EmittedPropertyConfig> = {};
  let titleCount = 0;
  for (const col of ast.columns) {
    if (col.type.kind === "title") titleCount++;
    if (Object.prototype.hasOwnProperty.call(props, col.name)) {
      throw new EmitError(`duplicate column name "${col.name}" in CREATE TABLE`);
    }
    props[col.name] = emitPropertyConfig(col);
  }
  if (titleCount === 0) {
    throw new EmitError("CREATE TABLE must declare exactly one TITLE column");
  }
  if (titleCount > 1) {
    throw new EmitError(`CREATE TABLE declared ${titleCount} TITLE columns — exactly one is required`);
  }
  return props;
}

// -----------------------------------------------------------------------------
// ALTER → properties map
// -----------------------------------------------------------------------------

export function emitAlterPatch(ops: AlterOp[]): Record<string, AlterPropertyValue> {
  const out: Record<string, AlterPropertyValue> = {};
  // If the user touches the same column twice in one call we keep only the
  // last write — but warn loudly by throwing. That's almost always a bug.
  const touched = new Map<string, AlterOp["kind"]>();
  for (const op of ops) {
    const key = alterKey(op);
    if (touched.has(key)) {
      throw new EmitError(
        `column "${key}" appears in multiple ALTER operations in the same statement ` +
          `(first as ${touched.get(key)}, now as ${op.kind}). Split them into separate calls.`
      );
    }
    touched.set(key, op.kind);
    out[key] = emitAlterValue(op);
  }
  return out;
}

function alterKey(op: AlterOp): string {
  switch (op.kind) {
    case "add":       return op.column.name;
    case "drop":      return op.name;
    case "rename":    return op.from;
    case "alter_set": return op.name;
  }
}

function emitAlterValue(op: AlterOp): AlterPropertyValue {
  switch (op.kind) {
    case "add":       return emitPropertyConfig(op.column);
    case "drop":      return null;
    case "rename":    return { name: op.to };
    case "alter_set": return emitPropertyConfig({ name: op.name, type: op.type });
  }
}

// -----------------------------------------------------------------------------
// Single property config — used by both CREATE and ALTER
// -----------------------------------------------------------------------------

function emitPropertyConfig(col: ColumnDef): EmittedPropertyConfig {
  const t = col.type;
  switch (t.kind) {
    case "title":
      return { type: "title", title: {} };
    case "rich_text":
      return { type: "rich_text", rich_text: {} };
    case "date":
      return { type: "date", date: {} };
    case "people":
      return { type: "people", people: {} };
    case "checkbox":
      return { type: "checkbox", checkbox: {} };
    case "url":
      return { type: "url", url: {} };
    case "email":
      return { type: "email", email: {} };
    case "phone_number":
      return { type: "phone_number", phone_number: {} };
    case "files":
      return { type: "files", files: {} };
    case "created_time":
      return { type: "created_time", created_time: {} };
    case "created_by":
      return { type: "created_by", created_by: {} };
    case "last_edited_time":
      return { type: "last_edited_time", last_edited_time: {} };
    case "last_edited_by":
      return { type: "last_edited_by", last_edited_by: {} };

    case "number":
      return {
        type: "number",
        number: t.format !== undefined ? { format: t.format } : {},
      };

    case "select":
      return {
        type: "select",
        select: {
          options: t.options.map((o) => ({
            name: o.name,
            ...(o.color !== undefined ? { color: o.color } : {}),
          })),
        },
      };

    case "multi_select":
      return {
        type: "multi_select",
        multi_select: {
          options: t.options.map((o) => ({
            name: o.name,
            ...(o.color !== undefined ? { color: o.color } : {}),
          })),
        },
      };

    case "status":
      // Note: Notion's request API doesn't accept a `groups` field — groups
      // are assigned server-side. We drop StatusOption.group during emit.
      return {
        type: "status",
        status: {
          options: t.options.map((o) => ({
            name: o.name,
            ...(o.color !== undefined ? { color: o.color } : {}),
          })),
        },
      };

    case "relation": {
      if (t.dual) {
        return {
          type: "relation",
          relation: {
            data_source_id: t.dataSourceId,
            type: "dual_property",
            dual_property: {},
          },
        };
      }
      return {
        type: "relation",
        relation: {
          data_source_id: t.dataSourceId,
          type: "single_property",
          single_property: {},
        },
      };
    }

    case "rollup": {
      if (!ROLLUP_FUNCTIONS.has(t.function as DdlRollupFunction)) {
        throw new EmitError(
          `unknown ROLLUP function "${t.function}" — must be one of ${[...ROLLUP_FUNCTIONS].join(", ")}`
        );
      }
      return {
        type: "rollup",
        rollup: {
          function: t.function as DdlRollupFunction,
          relation_property_name: t.relationPropertyName,
          rollup_property_name: t.rollupPropertyName,
        },
      };
    }

    case "formula":
      return {
        type: "formula",
        formula: { expression: t.expression },
      };

    case "unique_id":
      return {
        type: "unique_id",
        unique_id: t.prefix !== undefined ? { prefix: t.prefix } : {},
      };

    default: {
      // exhaustiveness check
      const _exhaustive: never = t;
      throw new EmitError(`unsupported property type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Convenience: build a Notion `title` / `description` rich_text array from a
// plain string. Callers use this when the user supplies a string to the
// tool's `title` / `description` fields.
// -----------------------------------------------------------------------------

export function plainTextToRichText(text: string): Array<{ type: "text"; text: { content: string } }> {
  if (!text) return [];
  return [{ type: "text", text: { content: text } }];
}

/** Re-exported kind guard for tests. */
export function propertyKind(t: PropertyTypeAst): PropertyTypeAst["kind"] {
  return t.kind;
}
