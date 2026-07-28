// -----------------------------------------------------------------------------
// View DSL parser — recursive-descent. Entry point:
//
//   parseViewDsl(source) → DirectiveAst[]
//
// Directives are separated by newlines or semicolons. Each directive is one
// of FILTER / SORT BY / GROUP BY / CALENDAR BY / TIMELINE BY / MAP BY /
// CHART / FORM / SHOW / COVER (see ast.ts for the full grammar).
//
// Error strategy: throw a ParseError with a line/col-anchored message. The
// tool handler maps these to MCP tool errors.
// -----------------------------------------------------------------------------

import type {
  DirectiveAst,
  FilterAst,
  FilterOperator,
  FilterPropertyType,
  FilterValue,
  PropertyFilterAst,
  TimestampFilterAst,
  CompoundFilterAst,
  SortAst,
  ChartAst,
  ChartAggregator,
  FormAst,
  CoverAst,
  GroupByPropertyType,
  RelativeDateValue,
} from "./ast";
import { RELATIVE_DATE_VALUES } from "./ast";
import { LexError, tokenize, type Token } from "./lexer";

export class ParseError extends Error {
  constructor(message: string, public readonly line: number, public readonly col: number) {
    super(`View DSL parse error at ${line}:${col}: ${message}`);
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export function parseViewDsl(source: string): DirectiveAst[] {
  const tokens = lex(source);
  const p = new Cursor(tokens);
  const out: DirectiveAst[] = [];
  while (true) {
    p.skipSeparators();
    if (p.peek().kind === "EOF") break;
    out.push(parseDirective(p));
  }
  return out;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function lex(source: string): Token[] {
  try {
    return tokenize(source);
  } catch (err) {
    if (err instanceof LexError) {
      throw new ParseError(err.message.replace(/^View DSL lex error at \S+: /, ""), err.line, err.col);
    }
    throw err;
  }
}

class Cursor {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.i]!;
  }

  peekAt(offset: number): Token | undefined {
    return this.tokens[this.i + offset];
  }

  advance(): Token {
    const t = this.tokens[this.i]!;
    if (t.kind !== "EOF") this.i++;
    return t;
  }

  consume(kind: Token["kind"], value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      const want = value !== undefined ? `${kind} "${value}"` : kind;
      throw new ParseError(`expected ${want}, got ${tokDesc(t)}`, t.line, t.col);
    }
    return this.advance();
  }

  accept(kind: Token["kind"], value?: string): Token | null {
    const t = this.peek();
    if (t.kind !== kind) return null;
    if (value !== undefined && t.value !== value) return null;
    this.i++;
    return t;
  }

  acceptKeyword(...values: string[]): Token | null {
    const t = this.peek();
    if (t.kind !== "KEYWORD") return null;
    if (!values.includes(t.value)) return null;
    this.i++;
    return t;
  }

  /** Directives end at newline, semicolon, or EOF. */
  atDirectiveEnd(): boolean {
    const k = this.peek().kind;
    return k === "NEWLINE" || k === "SEMICOLON" || k === "EOF";
  }

  skipSeparators(): void {
    while (this.peek().kind === "NEWLINE" || this.peek().kind === "SEMICOLON") this.i++;
  }
}

// -----------------------------------------------------------------------------
// Directives
// -----------------------------------------------------------------------------

function parseDirective(p: Cursor): DirectiveAst {
  const head = p.consume("KEYWORD");
  switch (head.value) {
    case "FILTER":   return { kind: "filter", filter: parseFilterExpr(p) };
    case "SORT":     return parseSortDirective(p);
    case "GROUP":    return parseGroupByDirective(p);
    case "CALENDAR": return parseCalendarByDirective(p);
    case "TIMELINE": return parseTimelineByDirective(p);
    case "MAP":      return parseMapByDirective(p);
    case "CHART":    return { kind: "chart", chart: parseChartDirective(p) };
    case "FORM":     return { kind: "form", form: parseFormDirective(p) };
    case "SHOW":     return parseShowDirective(p);
    case "COVER":    return { kind: "cover", cover: parseCoverDirective(p) };
    default:
      throw new ParseError(
        `expected a directive (FILTER, SORT, GROUP, CALENDAR, TIMELINE, MAP, CHART, FORM, SHOW, COVER), got ${tokDesc(head)}`,
        head.line, head.col
      );
  }
}

// -----------------------------------------------------------------------------
// FILTER
// -----------------------------------------------------------------------------

function parseFilterExpr(p: Cursor): FilterAst {
  return parseOrFilter(p);
}

function parseOrFilter(p: Cursor): FilterAst {
  const first = parseAndFilter(p);
  if (!isOrPeek(p)) return first;
  const filters: FilterAst[] = [first];
  while (isOrPeek(p)) {
    p.advance(); // OR
    filters.push(parseAndFilter(p));
  }
  return { kind: "compound", op: "or", filters };
}

function parseAndFilter(p: Cursor): FilterAst {
  const first = parseFilterAtom(p);
  if (!isAndPeek(p)) return first;
  const filters: FilterAst[] = [first];
  while (isAndPeek(p)) {
    p.advance(); // AND
    filters.push(parseFilterAtom(p));
  }
  return { kind: "compound", op: "and", filters };
}

function isAndPeek(p: Cursor): boolean {
  const t = p.peek();
  return t.kind === "KEYWORD" && t.value === "AND";
}
function isOrPeek(p: Cursor): boolean {
  const t = p.peek();
  return t.kind === "KEYWORD" && t.value === "OR";
}

function parseFilterAtom(p: Cursor): FilterAst {
  // Parenthesised group: "(" filter-expr ")"
  if (p.accept("LPAREN")) {
    const inner = parseFilterExpr(p);
    p.consume("RPAREN", ")");
    return inner;
  }
  // TIMESTAMP "created_time"|"last_edited_time" <op> <value>
  if (p.peek().kind === "KEYWORD" && p.peek().value === "TIMESTAMP") {
    return parseTimestampFilter(p);
  }
  // Property filter: "name" [TYPE] <op> [<value>]
  return parsePropertyFilter(p);
}

function parseTimestampFilter(p: Cursor): TimestampFilterAst {
  p.consume("KEYWORD", "TIMESTAMP");
  const nameTok = consumeStringLike(p, "TIMESTAMP name");
  const kind = nameTok.value;
  if (kind !== "created_time" && kind !== "last_edited_time") {
    throw new ParseError(
      `TIMESTAMP filter must be 'created_time' or 'last_edited_time', got '${kind}'`,
      nameTok.line, nameTok.col
    );
  }
  const { operator, value } = parseOperatorAndValue(p, /* propertyTypeHint */ "date");
  const out: TimestampFilterAst = { kind: "timestamp", timestamp: kind, operator };
  if (value !== undefined) out.value = value;
  return out;
}

/** Accept IDENT or STRING — both are string-shaped in the grammar. */
function consumeStringLike(p: Cursor, label: string): Token {
  const t = p.peek();
  if (t.kind === "IDENT" || t.kind === "STRING") {
    return p.advance();
  }
  throw new ParseError(`expected a string (${label}), got ${tokDesc(t)}`, t.line, t.col);
}

function parsePropertyFilter(p: Cursor): PropertyFilterAst {
  const nameTok = p.consume("IDENT");
  // Optional type override keyword (SELECT, MULTI_SELECT, etc.)
  const propertyType = maybeParseFilterPropertyType(p);
  const { operator, value } = parseOperatorAndValue(p, propertyType);
  const out: PropertyFilterAst = {
    kind: "property",
    property: nameTok.value,
    operator,
  };
  if (propertyType !== undefined) out.propertyType = propertyType;
  if (value !== undefined) out.value = value;
  return out;
}

const FILTER_PROP_TYPES: ReadonlySet<string> = new Set<string>([
  "RICH_TEXT", "TEXT", "TITLE", "NUMBER", "SELECT", "MULTI_SELECT", "STATUS",
  "DATE", "CHECKBOX", "URL", "EMAIL", "PHONE_NUMBER", "PEOPLE", "FILES",
  "RELATION", "FORMULA",
]);

function maybeParseFilterPropertyType(p: Cursor): FilterPropertyType | undefined {
  const t = p.peek();
  if (t.kind !== "KEYWORD") return undefined;
  if (!FILTER_PROP_TYPES.has(t.value)) return undefined;
  // Disambiguate: if this keyword is immediately followed by an operator or
  // a value-token, it's a type hint. Otherwise it's an operator keyword (like
  // CONTAINS). All FILTER_PROP_TYPES are distinct from operator keywords, so
  // we can consume safely.
  p.advance();
  const raw = t.value;
  switch (raw) {
    case "RICH_TEXT":
    case "TEXT":         return "rich_text";
    case "TITLE":        return "title";
    case "NUMBER":       return "number";
    case "SELECT":       return "select";
    case "MULTI_SELECT": return "multi_select";
    case "STATUS":       return "status";
    case "DATE":         return "date";
    case "CHECKBOX":     return "checkbox";
    case "URL":          return "url";
    case "EMAIL":        return "email";
    case "PHONE_NUMBER": return "phone_number";
    case "PEOPLE":       return "people";
    case "FILES":        return "files";
    case "RELATION":     return "relation";
    case "FORMULA":      return "formula";
    default:
      throw new ParseError(`unknown filter property type "${raw}"`, t.line, t.col);
  }
}

function parseOperatorAndValue(
  p: Cursor,
  _typeHint?: FilterPropertyType
): { operator: FilterOperator; value?: FilterValue } {
  const t = p.peek();

  // OP-based operators: = != < > <= >=
  if (t.kind === "OP") {
    p.advance();
    const value = parseAtomValue(p);
    const op: FilterOperator =
      t.value === "="  ? "equals" :
      t.value === "!=" ? "does_not_equal" :
      t.value === "<"  ? "less_than" :
      t.value === ">"  ? "greater_than" :
      t.value === "<=" ? "less_than_or_equal_to" :
      t.value === ">=" ? "greater_than_or_equal_to" :
      (() => { throw new ParseError(`unknown operator "${t.value}"`, t.line, t.col); })();
    return { operator: op, value };
  }

  if (t.kind !== "KEYWORD") {
    throw new ParseError(`expected an operator after property, got ${tokDesc(t)}`, t.line, t.col);
  }

  switch (t.value) {
    case "EQUALS": {
      p.advance();
      const value = parseAtomValue(p);
      return { operator: "equals", value };
    }
    case "CONTAINS": {
      p.advance();
      const value = parseAtomValue(p);
      return { operator: "contains", value };
    }
    case "STARTS": {
      p.advance();
      p.consume("KEYWORD", "WITH");
      const value = parseAtomValue(p);
      return { operator: "starts_with", value };
    }
    case "ENDS": {
      p.advance();
      p.consume("KEYWORD", "WITH");
      const value = parseAtomValue(p);
      return { operator: "ends_with", value };
    }
    case "BEFORE": {
      p.advance();
      const value = parseAtomValue(p);
      return { operator: "before", value };
    }
    case "AFTER": {
      p.advance();
      const value = parseAtomValue(p);
      return { operator: "after", value };
    }
    case "ON": {
      // ON OR BEFORE <v> | ON OR AFTER <v>
      p.advance();
      p.consume("KEYWORD", "OR");
      const dirTok = p.consume("KEYWORD");
      if (dirTok.value !== "BEFORE" && dirTok.value !== "AFTER") {
        throw new ParseError(`expected BEFORE or AFTER after ON OR, got ${tokDesc(dirTok)}`, dirTok.line, dirTok.col);
      }
      const value = parseAtomValue(p);
      return { operator: dirTok.value === "BEFORE" ? "on_or_before" : "on_or_after", value };
    }
    case "IS": {
      p.advance();
      // IS EMPTY | IS NOT EMPTY | IS CHECKED | IS UNCHECKED
      const neg = p.acceptKeyword("NOT") !== null;
      const tail = p.consume("KEYWORD");
      if (tail.value === "EMPTY") {
        return { operator: neg ? "is_not_empty" : "is_empty" };
      }
      if (tail.value === "CHECKED") {
        if (neg) throw new ParseError(`use IS UNCHECKED instead of IS NOT CHECKED`, tail.line, tail.col);
        return { operator: "is_checked" };
      }
      if (tail.value === "UNCHECKED") {
        if (neg) throw new ParseError(`use IS CHECKED instead of IS NOT UNCHECKED`, tail.line, tail.col);
        return { operator: "is_unchecked" };
      }
      throw new ParseError(`expected EMPTY, CHECKED, or UNCHECKED after IS, got ${tokDesc(tail)}`, tail.line, tail.col);
    }
    case "IN": {
      p.advance();
      return { operator: "in", value: parseInList(p, "IN") };
    }
    case "NOT": {
      // NOT IN ("a", "b") — the multi-value exclusion form. Notion's select /
      // status `does_not_equal` and multi_select `does_not_contain` accept
      // arrays as of 2026-04-17; this is the DSL spelling for that.
      //
      // `NOT` is otherwise only reachable via `IS NOT EMPTY`, which is handled
      // inside the IS branch above, so there's no ambiguity here.
      p.advance();
      const inTok = p.peek();
      if (inTok.kind !== "KEYWORD" || inTok.value !== "IN") {
        throw new ParseError(
          `expected IN after NOT (did you mean "IS NOT EMPTY"?), got ${tokDesc(inTok)}`,
          inTok.line,
          inTok.col
        );
      }
      p.advance();
      return { operator: "not_in", value: parseInList(p, "NOT IN") };
    }
    default:
      throw new ParseError(`unknown filter operator "${t.value}"`, t.line, t.col);
  }
}

/** Shared list body for `IN (...)` / `NOT IN (...)`. */
function parseInList(p: Cursor, label: string): FilterValue {
  p.consume("LPAREN", "(");
  const values: Array<string | number> = [];
  while (true) {
    const startTok = p.peek();
    const v = parseAtomValue(p);
    if (v.kind === "string") values.push(v.value);
    else if (v.kind === "number") values.push(v.value);
    else throw new ParseError(`${label} list items must be strings or numbers`, startTok.line, startTok.col);
    if (p.accept("COMMA")) continue;
    break;
  }
  p.consume("RPAREN", ")");
  return { kind: "list", values };
}

function parseAtomValue(p: Cursor): FilterValue {
  const t = p.peek();
  // We accept both IDENT ("double-quoted") and STRING ('single-quoted') as
  // string values. Notion-flavoured filter expressions like
  // `FILTER "Status" = "Done"` read naturally with double quotes on both
  // sides; the parser relies on position (LHS = property name, RHS = value)
  // to decide meaning.
  if (t.kind === "STRING" || t.kind === "IDENT") { p.advance(); return { kind: "string", value: t.value }; }
  if (t.kind === "NUMBER") {
    p.advance();
    const n = Number(t.value);
    if (!Number.isFinite(n)) {
      throw new ParseError(`invalid number "${t.value}"`, t.line, t.col);
    }
    return { kind: "number", value: n };
  }
  if (t.kind === "KEYWORD" && (t.value === "TRUE" || t.value === "FALSE")) {
    p.advance();
    return { kind: "boolean", value: t.value === "TRUE" };
  }
  // Relative date keywords (2026-03-30): TODAY, ONE_WEEK_FROM_NOW, …
  // Carried as their own FilterValue kind so the emitter can reject them on
  // non-date columns rather than emitting a literal text match.
  if (t.kind === "KEYWORD" && RELATIVE_DATE_KEYWORDS.has(t.value)) {
    p.advance();
    return { kind: "relative_date", value: t.value.toLowerCase() as RelativeDateValue };
  }
  // The `me` people-filter token (2026-03-30).
  if (t.kind === "KEYWORD" && t.value === "ME") {
    p.advance();
    return { kind: "me" };
  }
  throw new ParseError(
    `expected a value (string, number, boolean, a relative date like TODAY, or ME), got ${tokDesc(t)}`,
    t.line,
    t.col
  );
}

const RELATIVE_DATE_KEYWORDS: ReadonlySet<string> = new Set(
  RELATIVE_DATE_VALUES.map((v) => v.toUpperCase())
);

// -----------------------------------------------------------------------------
// SORT BY
// -----------------------------------------------------------------------------

function parseSortDirective(p: Cursor): DirectiveAst {
  p.consume("KEYWORD", "BY");
  const sorts: SortAst[] = [];
  while (true) {
    sorts.push(parseSortTerm(p));
    if (p.accept("COMMA")) continue;
    break;
  }
  return { kind: "sort", sorts };
}

function parseSortTerm(p: Cursor): SortAst {
  // Optional TIMESTAMP prefix
  if (p.peek().kind === "KEYWORD" && p.peek().value === "TIMESTAMP") {
    p.advance();
    const nameTok = consumeStringLike(p, "TIMESTAMP name");
    const kind = nameTok.value;
    if (kind !== "created_time" && kind !== "last_edited_time") {
      throw new ParseError(
        `TIMESTAMP sort must be 'created_time' or 'last_edited_time', got '${kind}'`,
        nameTok.line, nameTok.col
      );
    }
    const direction = parseSortDirection(p);
    return { kind: "timestamp", timestamp: kind, direction };
  }
  const nameTok = p.consume("IDENT");
  const direction = parseSortDirection(p);
  return { kind: "property", property: nameTok.value, direction };
}

function parseSortDirection(p: Cursor): "ascending" | "descending" {
  const t = p.peek();
  if (t.kind !== "KEYWORD") return "ascending"; // default
  switch (t.value) {
    case "ASC":
    case "ASCENDING":
      p.advance();
      return "ascending";
    case "DESC":
    case "DESCENDING":
      p.advance();
      return "descending";
    default:
      return "ascending";
  }
}

// -----------------------------------------------------------------------------
// GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY
// -----------------------------------------------------------------------------

function parseGroupByDirective(p: Cursor): DirectiveAst {
  p.consume("KEYWORD", "BY");
  const propertyType = maybeParseGroupByPropertyType(p);
  const nameTok = p.consume("IDENT");
  return {
    kind: "group_by",
    property: nameTok.value,
    ...(propertyType !== undefined ? { propertyType } : {}),
  };
}

const GROUP_BY_PROP_TYPES = new Set<string>([
  "SELECT", "MULTI_SELECT", "STATUS", "PEOPLE", "PERSON", "RELATION", "DATE",
  "CREATED_TIME", "LAST_EDITED_TIME", "TEXT", "TITLE", "URL", "EMAIL",
  "PHONE_NUMBER", "NUMBER", "CHECKBOX",
]);

function maybeParseGroupByPropertyType(p: Cursor): GroupByPropertyType | undefined {
  const t = p.peek();
  if (t.kind !== "KEYWORD") return undefined;
  if (!GROUP_BY_PROP_TYPES.has(t.value)) return undefined;
  // Only consume if the next token is an IDENT (property name). Otherwise this
  // could be a misidentified directive keyword.
  const next = p.peekAt(1);
  if (!next || next.kind !== "IDENT") return undefined;
  p.advance();
  switch (t.value) {
    case "SELECT":           return "select";
    case "MULTI_SELECT":     return "multi_select";
    case "STATUS":           return "status";
    case "PEOPLE":
    case "PERSON":           return "person";
    case "RELATION":         return "relation";
    case "DATE":             return "date";
    case "CREATED_TIME":     return "created_time";
    case "LAST_EDITED_TIME": return "last_edited_time";
    case "TEXT":             return "text";
    case "TITLE":            return "title";
    case "URL":              return "url";
    case "EMAIL":            return "email";
    case "PHONE_NUMBER":     return "phone_number";
    case "NUMBER":           return "number";
    case "CHECKBOX":         return "checkbox";
    default:
      throw new ParseError(`unknown GROUP BY property type "${t.value}"`, t.line, t.col);
  }
}

function parseCalendarByDirective(p: Cursor): DirectiveAst {
  p.consume("KEYWORD", "BY");
  const nameTok = p.consume("IDENT");
  return { kind: "calendar_by", property: nameTok.value };
}

function parseTimelineByDirective(p: Cursor): DirectiveAst {
  p.consume("KEYWORD", "BY");
  const startTok = p.consume("IDENT");
  let end: string | undefined;
  if (p.peek().kind === "KEYWORD" && p.peek().value === "TO") {
    p.advance();
    end = p.consume("IDENT").value;
  }
  return { kind: "timeline_by", start: startTok.value, ...(end !== undefined ? { end } : {}) };
}

function parseMapByDirective(p: Cursor): DirectiveAst {
  p.consume("KEYWORD", "BY");
  const nameTok = p.consume("IDENT");
  return { kind: "map_by", property: nameTok.value };
}

// -----------------------------------------------------------------------------
// CHART
// -----------------------------------------------------------------------------

const CHART_TYPES = new Set<string>(["COLUMN", "BAR", "LINE", "DONUT", "NUMBER"]);

const CHART_AGGREGATORS: ReadonlySet<string> = new Set<string>([
  "COUNT", "COUNT_VALUES", "SUM", "AVERAGE", "MEDIAN", "MIN", "MAX", "RANGE",
  "UNIQUE", "EMPTY", "NOT_EMPTY", "PERCENT_EMPTY", "PERCENT_NOT_EMPTY",
  "CHECKED", "UNCHECKED", "PERCENT_CHECKED", "PERCENT_UNCHECKED",
  "EARLIEST_DATE", "LATEST_DATE", "DATE_RANGE",
]);

const CHART_HEIGHTS = new Set<string>(["SMALL", "MEDIUM", "LARGE", "EXTRA_LARGE"]);

function parseChartDirective(p: Cursor): ChartAst {
  const typeTok = p.consume("KEYWORD");
  if (!CHART_TYPES.has(typeTok.value)) {
    throw new ParseError(
      `CHART type must be one of column|bar|line|donut|number, got "${typeTok.value}"`,
      typeTok.line, typeTok.col
    );
  }
  const chart: ChartAst = {
    chartType: typeTok.value.toLowerCase() as ChartAst["chartType"],
  };
  // Optional clauses in any order until directive end.
  while (!p.atDirectiveEnd()) {
    const t = p.peek();
    if (t.kind !== "KEYWORD") {
      throw new ParseError(`unexpected token in CHART: ${tokDesc(t)}`, t.line, t.col);
    }
    switch (t.value) {
      case "AGGREGATE": {
        p.advance();
        const fnTok = p.consume("KEYWORD");
        if (!CHART_AGGREGATORS.has(fnTok.value)) {
          throw new ParseError(
            `unknown aggregator "${fnTok.value}"`,
            fnTok.line, fnTok.col
          );
        }
        chart.aggregator = fnTok.value.toLowerCase() as ChartAggregator;
        if (p.peek().kind === "KEYWORD" && p.peek().value === "OF") {
          p.advance();
          chart.aggregatorProperty = p.consume("IDENT").value;
        }
        break;
      }
      case "BY": {
        // Optional X axis: BY "prop"
        p.advance();
        chart.xAxisProperty = p.consume("IDENT").value;
        break;
      }
      case "HEIGHT": {
        p.advance();
        const hTok = p.consume("KEYWORD");
        if (!CHART_HEIGHTS.has(hTok.value)) {
          throw new ParseError(
            `CHART HEIGHT must be small|medium|large|extra_large, got "${hTok.value}"`,
            hTok.line, hTok.col
          );
        }
        chart.height = hTok.value.toLowerCase() as ChartAst["height"];
        break;
      }
      default:
        throw new ParseError(`unexpected keyword in CHART: "${t.value}"`, t.line, t.col);
    }
  }
  return chart;
}

// -----------------------------------------------------------------------------
// FORM
// -----------------------------------------------------------------------------

const FORM_PERMISSIONS = new Set<string>(["NONE", "COMMENT_ONLY", "READER", "READ_AND_WRITE", "EDITOR"]);

function parseFormDirective(p: Cursor): FormAst {
  // FORM CLOSE | FORM OPEN | FORM ANONYMOUS <bool> | FORM PERMISSIONS <perm>
  const tok = p.consume("KEYWORD");
  const out: FormAst = {};
  switch (tok.value) {
    case "CLOSE":
      out.isClosed = true;
      break;
    case "OPEN":
      out.isClosed = false;
      break;
    case "ANONYMOUS": {
      const v = parseAtomValue(p);
      if (v.kind !== "boolean") {
        throw new ParseError(
          `FORM ANONYMOUS requires true or false, got ${v.kind}`,
          p.peek().line, p.peek().col
        );
      }
      out.anonymous = v.value;
      break;
    }
    case "PERMISSIONS": {
      const pm = p.consume("KEYWORD");
      if (!FORM_PERMISSIONS.has(pm.value)) {
        throw new ParseError(
          `FORM PERMISSIONS must be one of none|comment_only|reader|read_and_write|editor, got "${pm.value}"`,
          pm.line, pm.col
        );
      }
      out.permissions = pm.value.toLowerCase() as FormAst["permissions"];
      break;
    }
    default:
      throw new ParseError(
        `FORM must be followed by CLOSE, OPEN, ANONYMOUS, or PERMISSIONS, got "${tok.value}"`,
        tok.line, tok.col
      );
  }
  return out;
}

// -----------------------------------------------------------------------------
// SHOW
// -----------------------------------------------------------------------------

function parseShowDirective(p: Cursor): DirectiveAst {
  const properties: string[] = [];
  while (true) {
    properties.push(p.consume("IDENT").value);
    if (p.accept("COMMA")) continue;
    break;
  }
  return { kind: "show", properties };
}

// -----------------------------------------------------------------------------
// COVER
// -----------------------------------------------------------------------------

function parseCoverDirective(p: Cursor): CoverAst {
  const t = p.peek();
  if (t.kind === "IDENT") {
    p.advance();
    return { kind: "property", property: t.value };
  }
  if (t.kind === "KEYWORD" && t.value === "PAGE_COVER") {
    p.advance();
    return { kind: "page_cover" };
  }
  if (t.kind === "KEYWORD" && t.value === "PAGE_CONTENT") {
    p.advance();
    return { kind: "page_content" };
  }
  throw new ParseError(
    `COVER must be followed by "property-name" or PAGE_COVER or PAGE_CONTENT, got ${tokDesc(t)}`,
    t.line, t.col
  );
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function tokDesc(t: Token): string {
  switch (t.kind) {
    case "EOF":       return "end of input";
    case "NEWLINE":   return "newline";
    case "IDENT":     return `property "${t.value}"`;
    case "STRING":    return `string '${t.value}'`;
    case "KEYWORD":   return `keyword ${t.value}`;
    case "NUMBER":    return `number ${t.value}`;
    case "OP":        return `operator "${t.value}"`;
    default:          return `"${t.value}"`;
  }
}
