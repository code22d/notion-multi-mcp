// -----------------------------------------------------------------------------
// AST → Notion view request body.
//
//   emitViewBody(directives, ctx) → EmittedViewBody
//     Produces { filter?, sorts?, configuration? } suitable for POST /v1/views
//     (CreateViewRequest) or PATCH /v1/views/{id} (UpdateViewRequest).
//
// `ctx.viewType` tells the emitter which configuration-request variant to
// build (table, board, calendar, timeline, gallery, list, map, form, chart,
// or dashboard). For PATCH the handler may need to fetch the view first to
// discover its type — that's the handler's job, not the emitter's.
//
// Validation we do eagerly:
//   - directive kinds that require specific view types (e.g. CALENDAR BY
//     requires a calendar view) — reported when view type is known
//   - chart aggregator / form permission / cover type constraints
//   - duplicate directives (one FILTER, one CHART, etc.) — some directives
//     like FORM can repeat to set different subfields.
//
// View types excluded:
//   - dashboard: Notion's public REST API doesn't expose
//     DashboardViewConfigRequest, so we emit a clear error if CHART/FORM/etc.
//     target this type. The handler can still create a bare dashboard view
//     (name + type) as long as the DSL is empty or only contains FILTER/SORT.
// -----------------------------------------------------------------------------

import type {
  DirectiveAst,
  FilterAst,
  PropertyFilterAst,
  TimestampFilterAst,
  CompoundFilterAst,
  FilterOperator,
  FilterPropertyType,
  FilterValue,
  SortAst,
  ChartAst,
  FormAst,
  CoverAst,
  GroupByPropertyType,
} from "./ast";

export class EmitError extends Error {
  constructor(message: string) {
    super(`View DSL emit error: ${message}`);
  }
}

/** The ten view types Notion's API accepts. */
export type ViewType =
  | "table" | "board" | "list" | "calendar" | "timeline" | "gallery"
  | "form" | "chart" | "map" | "dashboard";

export interface EmitContext {
  /** The view type — required for CREATE, and for UPDATE the handler fetches
   *  the view first to discover its type. If omitted, the emitter only
   *  produces filter/sorts; a configuration-setting directive will error. */
  viewType?: ViewType;
  /** If true, this is for an UpdateViewRequest — skips some request-only
   *  defaults. Today the shapes overlap enough that we don't distinguish;
   *  kept as a flag for forward-compat. */
  forUpdate?: boolean;
}

/** Emitted body — a subset of CreateViewRequest / UpdateViewRequest fields. */
export interface EmittedViewBody {
  filter?: EmittedFilter;
  sorts?: Array<EmittedSort>;
  configuration?: EmittedConfiguration;
}

export type EmittedFilter = Record<string, unknown>;
export type EmittedSort = Record<string, unknown>;
export type EmittedConfiguration = Record<string, unknown> & { type: ViewType };

// -----------------------------------------------------------------------------
// Public entry
// -----------------------------------------------------------------------------

export function emitViewBody(directives: DirectiveAst[], ctx: EmitContext): EmittedViewBody {
  // Bucket directives. Most kinds are "at most once" — enforced here.
  let filterAst: FilterAst | undefined;
  let sorts: SortAst[] = [];
  let groupBy: { property: string; propertyType?: GroupByPropertyType } | undefined;
  let calendarBy: { property: string } | undefined;
  let timelineBy: { start: string; end?: string } | undefined;
  let mapBy: { property: string } | undefined;
  let chart: ChartAst | undefined;
  const form: FormAst = {};
  let showProps: string[] | undefined;
  let cover: CoverAst | undefined;

  for (const d of directives) {
    switch (d.kind) {
      case "filter":
        if (filterAst !== undefined) throw new EmitError("only one FILTER directive is allowed per view");
        filterAst = d.filter;
        break;
      case "sort":
        if (sorts.length > 0) throw new EmitError("only one SORT BY directive is allowed per view (use comma-separated terms)");
        sorts = d.sorts;
        break;
      case "group_by":
        if (groupBy !== undefined) throw new EmitError("only one GROUP BY directive is allowed per view");
        groupBy = { property: d.property, ...(d.propertyType !== undefined ? { propertyType: d.propertyType } : {}) };
        break;
      case "calendar_by":
        if (calendarBy !== undefined) throw new EmitError("only one CALENDAR BY directive is allowed per view");
        calendarBy = { property: d.property };
        break;
      case "timeline_by":
        if (timelineBy !== undefined) throw new EmitError("only one TIMELINE BY directive is allowed per view");
        timelineBy = { start: d.start, ...(d.end !== undefined ? { end: d.end } : {}) };
        break;
      case "map_by":
        if (mapBy !== undefined) throw new EmitError("only one MAP BY directive is allowed per view");
        mapBy = { property: d.property };
        break;
      case "chart":
        if (chart !== undefined) throw new EmitError("only one CHART directive is allowed per view");
        chart = d.chart;
        break;
      case "form":
        // FORM can appear multiple times (CLOSE, ANONYMOUS, PERMISSIONS).
        if (d.form.isClosed !== undefined) form.isClosed = d.form.isClosed;
        if (d.form.anonymous !== undefined) form.anonymous = d.form.anonymous;
        if (d.form.permissions !== undefined) form.permissions = d.form.permissions;
        break;
      case "show":
        if (showProps !== undefined) throw new EmitError("only one SHOW directive is allowed per view");
        showProps = d.properties;
        break;
      case "cover":
        if (cover !== undefined) throw new EmitError("only one COVER directive is allowed per view");
        cover = d.cover;
        break;
    }
  }

  const out: EmittedViewBody = {};

  if (filterAst) out.filter = emitFilter(filterAst);
  if (sorts.length > 0) out.sorts = sorts.map(emitSort);

  // Configuration is built only if any config-relevant directive is present.
  const hasConfig =
    groupBy !== undefined ||
    calendarBy !== undefined ||
    timelineBy !== undefined ||
    mapBy !== undefined ||
    chart !== undefined ||
    form.isClosed !== undefined ||
    form.anonymous !== undefined ||
    form.permissions !== undefined ||
    showProps !== undefined ||
    cover !== undefined;

  if (hasConfig) {
    if (!ctx.viewType) {
      throw new EmitError(
        "view type must be known to emit configuration directives (GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, COVER). " +
          "For UPDATE, fetch the view first; for CREATE, pass the `type` argument."
      );
    }
    out.configuration = emitConfiguration(ctx.viewType, {
      groupBy,
      calendarBy,
      timelineBy,
      mapBy,
      chart,
      form,
      showProps,
      cover,
    });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Filter emission
// -----------------------------------------------------------------------------

function emitFilter(f: FilterAst): EmittedFilter {
  if (f.kind === "compound") return emitCompoundFilter(f);
  if (f.kind === "timestamp") return emitTimestampFilter(f);
  return emitPropertyFilter(f);
}

function emitCompoundFilter(f: CompoundFilterAst): EmittedFilter {
  return { [f.op]: f.filters.map(emitFilter) };
}

function emitTimestampFilter(f: TimestampFilterAst): EmittedFilter {
  const condition = emitFilterCondition("date", f.operator, f.value);
  return {
    timestamp: f.timestamp,
    [f.timestamp]: condition,
  };
}

function emitPropertyFilter(f: PropertyFilterAst): EmittedFilter {
  const type = f.propertyType ?? inferFilterType(f.operator, f.value);
  const condition = emitFilterCondition(type, f.operator, f.value);
  return {
    property: f.property,
    [type]: condition,
  };
}

/**
 * Pick the filter-property type when the user didn't write one. Rules:
 *   - numeric literal on =/!=/<=/>=/</>    → number
 *   - boolean literal on =/!=              → checkbox
 *   - date-ish operators (before/after/on) → date
 *   - is_checked / is_unchecked            → checkbox
 *   - contains/starts_with/ends_with       → rich_text
 *   - equals/does_not_equal on string      → rich_text (safe default)
 *   - in (list)                            → multi_select (most common)
 *   - is_empty / is_not_empty with no type → rich_text (tolerated but imperfect)
 */
function inferFilterType(op: FilterOperator, v?: FilterValue): FilterPropertyType {
  if (op === "before" || op === "after" || op === "on_or_before" || op === "on_or_after") return "date";
  if (op === "is_checked" || op === "is_unchecked") return "checkbox";
  if (op === "less_than" || op === "greater_than" || op === "less_than_or_equal_to" || op === "greater_than_or_equal_to") {
    return "number";
  }
  if (op === "in") return "multi_select";
  if (v?.kind === "number") return "number";
  if (v?.kind === "boolean") return "checkbox";
  // equals/does_not_equal/contains/starts_with/ends_with/is_empty/is_not_empty
  return "rich_text";
}

/** Build the filter-condition sub-object given a type, operator, and value. */
function emitFilterCondition(
  type: FilterPropertyType | "date",
  op: FilterOperator,
  v?: FilterValue
): Record<string, unknown> {
  // Existence operators apply uniformly across property types.
  if (op === "is_empty") return { is_empty: true };
  if (op === "is_not_empty") return { is_not_empty: true };
  if (op === "is_checked") return { equals: true };
  if (op === "is_unchecked") return { equals: false };

  switch (type) {
    case "rich_text":
    case "title":
    case "url":
    case "email":
    case "phone_number":
      return textCondition(op, v);
    case "number":
      return numberCondition(op, v);
    case "select":
    case "status":
      return selectCondition(op, v);
    case "multi_select":
      return multiSelectCondition(op, v);
    case "checkbox":
      return checkboxCondition(op, v);
    case "date":
      return dateCondition(op, v);
    case "people":
    case "files":
    case "relation":
      return relationCondition(op, v);
    case "formula":
      throw new EmitError(
        "FORMULA filters need the inner result type — write the filter against the underlying property instead."
      );
    default: {
      const _exhaustive: never = type;
      throw new EmitError(`unsupported filter property type: ${String(_exhaustive)}`);
    }
  }
}

function requireString(v: FilterValue | undefined, label: string): string {
  if (!v) throw new EmitError(`${label} requires a value`);
  if (v.kind === "string") return v.value;
  if (v.kind === "number") return String(v.value);
  throw new EmitError(`${label} requires a string value, got ${v.kind}`);
}

function requireNumber(v: FilterValue | undefined, label: string): number {
  if (!v) throw new EmitError(`${label} requires a numeric value`);
  if (v.kind === "number") return v.value;
  throw new EmitError(`${label} requires a numeric value, got ${v.kind}`);
}

function requireBoolean(v: FilterValue | undefined, label: string): boolean {
  if (!v) throw new EmitError(`${label} requires a boolean value`);
  if (v.kind === "boolean") return v.value;
  throw new EmitError(`${label} requires a boolean value, got ${v.kind}`);
}

function textCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "equals":         return { equals: requireString(v, "= on text") };
    case "does_not_equal": return { does_not_equal: requireString(v, "!= on text") };
    case "contains":       return { contains: requireString(v, "CONTAINS") };
    case "does_not_contain": return { does_not_contain: requireString(v, "does not contain") };
    case "starts_with":    return { starts_with: requireString(v, "STARTS WITH") };
    case "ends_with":      return { ends_with: requireString(v, "ENDS WITH") };
    default:
      throw new EmitError(`operator "${op}" is not supported on text properties`);
  }
}

function numberCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "equals":                       return { equals: requireNumber(v, "= on number") };
    case "does_not_equal":               return { does_not_equal: requireNumber(v, "!= on number") };
    case "less_than":                    return { less_than: requireNumber(v, "<") };
    case "greater_than":                 return { greater_than: requireNumber(v, ">") };
    case "less_than_or_equal_to":        return { less_than_or_equal_to: requireNumber(v, "<=") };
    case "greater_than_or_equal_to":     return { greater_than_or_equal_to: requireNumber(v, ">=") };
    default:
      throw new EmitError(`operator "${op}" is not supported on number properties`);
  }
}

function selectCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "equals":         return { equals: requireString(v, "= on select/status") };
    case "does_not_equal": return { does_not_equal: requireString(v, "!= on select/status") };
    case "in": {
      if (!v || v.kind !== "list") throw new EmitError("IN requires a list value");
      return { equals: v.values.map(String) };
    }
    default:
      throw new EmitError(`operator "${op}" is not supported on select/status properties`);
  }
}

function multiSelectCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "contains":         return { contains: requireString(v, "CONTAINS on multi_select") };
    case "does_not_contain": return { does_not_contain: requireString(v, "does not contain on multi_select") };
    case "in": {
      if (!v || v.kind !== "list") throw new EmitError("IN requires a list value");
      // multi_select doesn't natively take an array — emit as compound OR of
      // single `contains` filters. But since filters live under a property
      // object, we can't easily wrap here. Instead, pass the array through as
      // `contains: [...]` — Notion's 2025-09-03 API accepts an array form.
      return { contains: v.values.map(String) };
    }
    default:
      throw new EmitError(`operator "${op}" is not supported on multi_select properties`);
  }
}

function checkboxCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "equals":         return { equals: requireBoolean(v, "= on checkbox") };
    case "does_not_equal": return { does_not_equal: requireBoolean(v, "!= on checkbox") };
    default:
      throw new EmitError(`operator "${op}" is not supported on checkbox properties`);
  }
}

function dateCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "equals":        return { equals: requireString(v, "= on date") };
    case "before":        return { before: requireString(v, "BEFORE") };
    case "after":         return { after: requireString(v, "AFTER") };
    case "on_or_before":  return { on_or_before: requireString(v, "ON OR BEFORE") };
    case "on_or_after":   return { on_or_after: requireString(v, "ON OR AFTER") };
    default:
      throw new EmitError(`operator "${op}" is not supported on date properties`);
  }
}

function relationCondition(op: FilterOperator, v?: FilterValue): Record<string, unknown> {
  switch (op) {
    case "contains":         return { contains: requireString(v, "CONTAINS on relation/people") };
    case "does_not_contain": return { does_not_contain: requireString(v, "does not contain") };
    default:
      throw new EmitError(`operator "${op}" is not supported on people/relation properties`);
  }
}

// -----------------------------------------------------------------------------
// Sort emission
// -----------------------------------------------------------------------------

function emitSort(s: SortAst): EmittedSort {
  if (s.kind === "timestamp") {
    return { timestamp: s.timestamp, direction: s.direction };
  }
  return { property: s.property, direction: s.direction };
}

// -----------------------------------------------------------------------------
// Configuration emission
// -----------------------------------------------------------------------------

interface ConfigInputs {
  groupBy?: { property: string; propertyType?: GroupByPropertyType };
  calendarBy?: { property: string };
  timelineBy?: { start: string; end?: string };
  mapBy?: { property: string };
  chart?: ChartAst;
  form: FormAst;
  showProps?: string[];
  cover?: CoverAst;
}

function emitConfiguration(viewType: ViewType, inputs: ConfigInputs): EmittedConfiguration {
  const cfg: EmittedConfiguration = { type: viewType };
  switch (viewType) {
    case "table": {
      applyPropertiesList(cfg, inputs.showProps);
      if (inputs.groupBy) cfg.group_by = emitGroupBy(inputs.groupBy.property, inputs.groupBy.propertyType);
      forbidIrrelevant(viewType, inputs, ["calendarBy", "timelineBy", "mapBy", "chart", "form", "cover"]);
      break;
    }
    case "board": {
      if (!inputs.groupBy) {
        throw new EmitError("board view requires a GROUP BY directive");
      }
      cfg.group_by = emitGroupBy(inputs.groupBy.property, inputs.groupBy.propertyType);
      if (inputs.cover) applyCover(cfg, inputs.cover);
      applyPropertiesList(cfg, inputs.showProps);
      forbidIrrelevant(viewType, inputs, ["calendarBy", "timelineBy", "mapBy", "chart", "form"]);
      break;
    }
    case "list": {
      applyPropertiesList(cfg, inputs.showProps);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "timelineBy", "mapBy", "chart", "form", "cover"]);
      break;
    }
    case "calendar": {
      if (!inputs.calendarBy) {
        throw new EmitError("calendar view requires a CALENDAR BY directive");
      }
      cfg.date_property_id = inputs.calendarBy.property;
      applyPropertiesList(cfg, inputs.showProps);
      forbidIrrelevant(viewType, inputs, ["groupBy", "timelineBy", "mapBy", "chart", "form", "cover"]);
      break;
    }
    case "timeline": {
      if (!inputs.timelineBy) {
        throw new EmitError("timeline view requires a TIMELINE BY directive");
      }
      cfg.date_property_id = inputs.timelineBy.start;
      if (inputs.timelineBy.end !== undefined) cfg.end_date_property_id = inputs.timelineBy.end;
      applyPropertiesList(cfg, inputs.showProps);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "mapBy", "chart", "form", "cover"]);
      break;
    }
    case "gallery": {
      applyPropertiesList(cfg, inputs.showProps);
      if (inputs.cover) applyCover(cfg, inputs.cover);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "timelineBy", "mapBy", "chart", "form"]);
      break;
    }
    case "map": {
      if (!inputs.mapBy) {
        throw new EmitError("map view requires a MAP BY directive");
      }
      cfg.map_by = inputs.mapBy.property;
      applyPropertiesList(cfg, inputs.showProps);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "timelineBy", "chart", "form", "cover"]);
      break;
    }
    case "form": {
      applyForm(cfg, inputs.form);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "timelineBy", "mapBy", "chart", "showProps", "cover"]);
      break;
    }
    case "chart": {
      if (!inputs.chart) {
        throw new EmitError("chart view requires a CHART directive");
      }
      applyChart(cfg, inputs.chart);
      forbidIrrelevant(viewType, inputs, ["groupBy", "calendarBy", "timelineBy", "mapBy", "form", "cover", "showProps"]);
      break;
    }
    case "dashboard":
      throw new EmitError(
        "dashboard views are not configurable via Notion's public REST API yet — " +
          "create a bare dashboard (name + type) and configure it in the Notion UI."
      );
    default: {
      const _exhaustive: never = viewType;
      throw new EmitError(`unsupported view type: ${String(_exhaustive)}`);
    }
  }
  return cfg;
}

function applyPropertiesList(cfg: EmittedConfiguration, showProps: string[] | undefined): void {
  if (!showProps || showProps.length === 0) return;
  cfg.properties = showProps.map((name) => ({ property_id: name, visible: true }));
}

function applyCover(cfg: EmittedConfiguration, cover: CoverAst): void {
  switch (cover.kind) {
    case "page_cover":   cfg.cover = { type: "page_cover" }; break;
    case "page_content": cfg.cover = { type: "page_content" }; break;
    case "property":     cfg.cover = { type: "property", property_id: cover.property }; break;
  }
}

function applyForm(cfg: EmittedConfiguration, form: FormAst): void {
  if (form.isClosed !== undefined) cfg.is_form_closed = form.isClosed;
  if (form.anonymous !== undefined) cfg.anonymous_submissions = form.anonymous;
  if (form.permissions !== undefined) cfg.submission_permissions = form.permissions;
}

function applyChart(cfg: EmittedConfiguration, chart: ChartAst): void {
  cfg.chart_type = chart.chartType;
  if (chart.aggregator !== undefined) {
    const value: Record<string, unknown> = { aggregator: chart.aggregator };
    if (chart.aggregatorProperty !== undefined) value.property_id = chart.aggregatorProperty;
    cfg.value = value;
    cfg.y_axis = value;
  }
  if (chart.xAxisProperty !== undefined) {
    cfg.x_axis_property_id = chart.xAxisProperty;
  }
  if (chart.height !== undefined) {
    cfg.height = chart.height;
  }
}

function emitGroupBy(property: string, propertyType: GroupByPropertyType | undefined): Record<string, unknown> {
  const type: GroupByPropertyType = propertyType ?? "select";
  const base: Record<string, unknown> = {
    type,
    property_id: property,
    sort: { type: "manual" },
  };
  // Type-specific required sub-group_by keys.
  if (type === "date" || type === "created_time" || type === "last_edited_time") {
    base.group_by = "month";
  } else if (type === "text" || type === "title" || type === "url" || type === "email" || type === "phone_number") {
    base.group_by = "exact";
  } else if (type === "status") {
    base.group_by = "group";
  }
  return base;
}

function forbidIrrelevant(
  viewType: ViewType,
  inputs: ConfigInputs,
  disallowed: Array<keyof ConfigInputs>
): void {
  for (const key of disallowed) {
    const v = inputs[key as keyof ConfigInputs];
    const present =
      key === "form" ? formHasAny(inputs.form) :
      key === "showProps" ? Array.isArray(v) && v.length > 0 :
      v !== undefined;
    if (present) {
      throw new EmitError(
        `${directiveLabel(key)} is not supported on ${viewType} views`
      );
    }
  }
}

function formHasAny(f: FormAst): boolean {
  return f.isClosed !== undefined || f.anonymous !== undefined || f.permissions !== undefined;
}

function directiveLabel(k: keyof ConfigInputs): string {
  switch (k) {
    case "groupBy":    return "GROUP BY";
    case "calendarBy": return "CALENDAR BY";
    case "timelineBy": return "TIMELINE BY";
    case "mapBy":      return "MAP BY";
    case "chart":      return "CHART";
    case "form":       return "FORM";
    case "showProps":  return "SHOW";
    case "cover":      return "COVER";
  }
}
