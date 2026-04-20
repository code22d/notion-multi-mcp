// -----------------------------------------------------------------------------
// AST types for the DDL parser. Kept in its own module so the parser, emitter,
// and tests can all import them without circular dependencies.
// -----------------------------------------------------------------------------

// NOTE: the @notionhq/client package exports types only through a narrow
// whitelist in its top-level index.d.ts. SelectColor, RollupFunction, and
// PropertyConfigurationRequest aren't on that list, so we mirror them locally
// from the SDK's source of truth (build/src/api-endpoints/common.d.ts).

/** Matches SelectColor in @notionhq/client (common.d.ts). */
export type DdlColor =
  | "default" | "gray" | "brown" | "orange" | "yellow"
  | "green" | "blue" | "purple" | "pink" | "red";

/** Matches RollupFunction in @notionhq/client (common.d.ts). */
export type DdlRollupFunction =
  | "count" | "count_values" | "empty" | "not_empty" | "unique" | "show_unique"
  | "percent_empty" | "percent_not_empty" | "sum" | "average" | "median"
  | "min" | "max" | "range" | "earliest_date" | "latest_date" | "date_range"
  | "checked" | "unchecked" | "percent_checked" | "percent_unchecked"
  | "count_per_group" | "percent_per_group" | "show_original";

/** One parsed column definition from CREATE TABLE (or a fresh ADD / ALTER SET). */
export interface ColumnDef {
  name: string;
  type: PropertyTypeAst;
}

/** The discriminated union of parsed property types. */
export type PropertyTypeAst =
  | { kind: "title" }
  | { kind: "rich_text" }
  | { kind: "number"; format?: string }
  | { kind: "select"; options: SelectOption[] }
  | { kind: "multi_select"; options: SelectOption[] }
  | { kind: "status"; options: StatusOption[] }
  | { kind: "date" }
  | { kind: "people" }
  | { kind: "checkbox" }
  | { kind: "url" }
  | { kind: "email" }
  | { kind: "phone_number" }
  | { kind: "files" }
  | { kind: "created_time" }
  | { kind: "created_by" }
  | { kind: "last_edited_time" }
  | { kind: "last_edited_by" }
  | { kind: "relation"; dataSourceId: string; dual: boolean }
  | {
      kind: "rollup";
      relationPropertyName: string;
      rollupPropertyName: string;
      function: string;
    }
  | { kind: "formula"; expression: string }
  | { kind: "unique_id"; prefix?: string };

export interface SelectOption {
  name: string;
  color?: DdlColor;
}

/** STATUS options get a middle "group" token which we parse for completeness
 *  but ignore when emitting (Notion's API doesn't accept groups on request). */
export interface StatusOption {
  name: string;
  group?: string;
  color?: DdlColor;
}

// -----------------------------------------------------------------------------
// Top-level statements
// -----------------------------------------------------------------------------

export interface CreateTableAst {
  kind: "create_table";
  columns: ColumnDef[];
}

export type AlterOp =
  | { kind: "add"; column: ColumnDef }
  | { kind: "drop"; name: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "alter_set"; name: string; type: PropertyTypeAst };
