// -----------------------------------------------------------------------------
// AST types for the View DSL parser.
//
// The DSL is a directive-per-line config grammar that the native Notion MCP
// accepts on `notion_create_view` and `notion_update_view`. Example:
//
//   FILTER "Status" = "Done"
//   SORT BY "Created" DESC
//   GROUP BY "Priority"
//   CALENDAR BY "Due Date"
//   TIMELINE BY "Start" TO "End"
//   MAP BY "Location"
//   CHART column AGGREGATE sum OF "Revenue" HEIGHT large
//   FORM CLOSE
//   FORM ANONYMOUS true
//   FORM PERMISSIONS editor
//   SHOW "Name", "Status", "Owner"
//   COVER "Hero Image"
//   COVER PAGE_COVER
//
// Multiple directives may appear in one DSL string (newline- or
// semicolon-separated). Directive order doesn't matter — the emitter buckets
// them by kind.
//
// Filter sub-grammar (atoms + and/or, up to 2 levels nesting):
//
//   "Prop" = "value"           text equals (default)
//   "Prop" != 5                number not-equal
//   "Prop" CONTAINS "x"        text contains
//   "Prop" STARTS WITH "x"     text starts_with
//   "Prop" ENDS WITH "x"       text ends_with
//   "Prop" < 5                 number less_than
//   "Prop" > 5
//   "Prop" <= 5
//   "Prop" >= 5
//   "Prop" BEFORE "2026-01-01"
//   "Prop" AFTER "..."
//   "Prop" ON OR BEFORE "..."
//   "Prop" ON OR AFTER "..."
//   "Prop" IS EMPTY
//   "Prop" IS NOT EMPTY
//   "Prop" IS CHECKED
//   "Prop" IS UNCHECKED
//   "Prop" IN ("v1", "v2")     multi_select / select equality
//   TIMESTAMP "created_time" BEFORE "2026-01-01"
//
// Type prefix override (when default inference is wrong):
//
//   "Prop" SELECT = "Done"
//   "Prop" MULTI_SELECT CONTAINS "urgent"
//   "Prop" STATUS = "In Progress"
//   "Prop" CHECKBOX = true
//   "Prop" PEOPLE CONTAINS "user-id"
//
// Compound:
//
//   ("Status" = "Done") AND ("Priority" >= 3)
//   ("A" = "x") OR ("B" = "y") OR ("C" IS EMPTY)
// -----------------------------------------------------------------------------

/**
 * The whole parsed DSL is a flat list of directives. Directives of the same
 * kind that appear more than once are an error (caught in emit), with one
 * exception: SORT BY may carry multiple sort terms in one directive — they're
 * all flattened into the directive's `sorts` array.
 */
export type DirectiveAst =
  | { kind: "filter"; filter: FilterAst }
  | { kind: "sort"; sorts: SortAst[] }
  | { kind: "group_by"; property: string; propertyType?: GroupByPropertyType }
  | { kind: "calendar_by"; property: string }
  | { kind: "timeline_by"; start: string; end?: string }
  | { kind: "map_by"; property: string }
  | { kind: "chart"; chart: ChartAst }
  | { kind: "form"; form: FormAst }
  | { kind: "show"; properties: string[] }
  | { kind: "cover"; cover: CoverAst };

// -----------------------------------------------------------------------------
// Filters
// -----------------------------------------------------------------------------

export type FilterAst =
  | PropertyFilterAst
  | TimestampFilterAst
  | CompoundFilterAst;

export interface PropertyFilterAst {
  kind: "property";
  property: string;
  /** Optional explicit type override — when omitted, emitter infers from operator + value. */
  propertyType?: FilterPropertyType;
  operator: FilterOperator;
  /** undefined for IS EMPTY / IS NOT EMPTY / IS CHECKED / IS UNCHECKED. */
  value?: FilterValue;
}

export interface TimestampFilterAst {
  kind: "timestamp";
  timestamp: "created_time" | "last_edited_time";
  operator: FilterOperator;
  value?: FilterValue;
}

export interface CompoundFilterAst {
  kind: "compound";
  op: "and" | "or";
  filters: FilterAst[];
}

export type FilterValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "list"; values: Array<string | number> };

/** Operator atoms recognised by the parser. */
export type FilterOperator =
  | "equals"
  | "does_not_equal"
  | "contains"
  | "does_not_contain"
  | "starts_with"
  | "ends_with"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal_to"
  | "less_than_or_equal_to"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after"
  | "is_empty"
  | "is_not_empty"
  | "is_checked"
  | "is_unchecked"
  | "in";

/**
 * Filter-property types we accept as an explicit override. Matches the keys
 * Notion's filter API expects on a property filter. When omitted, the emitter
 * picks based on operator+value (see emit.ts).
 */
export type FilterPropertyType =
  | "rich_text"
  | "title"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone_number"
  | "people"
  | "files"
  | "relation"
  | "formula";

// -----------------------------------------------------------------------------
// Sorts
// -----------------------------------------------------------------------------

export type SortAst =
  | { kind: "property"; property: string; direction: "ascending" | "descending" }
  | { kind: "timestamp"; timestamp: "created_time" | "last_edited_time"; direction: "ascending" | "descending" };

// -----------------------------------------------------------------------------
// Group-by
// -----------------------------------------------------------------------------

/** Property-type hints for GROUP BY. Notion's API requires picking a
 *  GroupByConfigRequest variant by type — our emitter defaults to "select"
 *  when the user doesn't specify. */
export type GroupByPropertyType =
  | "select"
  | "multi_select"
  | "status"
  | "person"
  | "relation"
  | "date"
  | "created_time"
  | "last_edited_time"
  | "text"
  | "title"
  | "url"
  | "email"
  | "phone_number"
  | "number"
  | "checkbox";

// -----------------------------------------------------------------------------
// Chart
// -----------------------------------------------------------------------------

export interface ChartAst {
  chartType: "column" | "bar" | "line" | "donut" | "number";
  /** AGGREGATE <fn> — defaults to "count" if omitted. */
  aggregator?: ChartAggregator;
  /** OF "prop" — required for non-count aggregators. */
  aggregatorProperty?: string;
  /** X "prop" — for column/bar/line/donut. */
  xAxisProperty?: string;
  /** HEIGHT small|medium|large|extra_large. */
  height?: "small" | "medium" | "large" | "extra_large";
}

export type ChartAggregator =
  | "count" | "count_values" | "sum" | "average" | "median"
  | "min" | "max" | "range" | "unique" | "empty" | "not_empty"
  | "percent_empty" | "percent_not_empty" | "checked" | "unchecked"
  | "percent_checked" | "percent_unchecked" | "earliest_date"
  | "latest_date" | "date_range";

// -----------------------------------------------------------------------------
// Form
// -----------------------------------------------------------------------------

export interface FormAst {
  isClosed?: boolean;
  anonymous?: boolean;
  permissions?: "none" | "comment_only" | "reader" | "read_and_write" | "editor";
}

// -----------------------------------------------------------------------------
// Cover
// -----------------------------------------------------------------------------

export type CoverAst =
  | { kind: "property"; property: string }
  | { kind: "page_cover" }
  | { kind: "page_content" };
