// -----------------------------------------------------------------------------
// View DSL lexer — tokenises the directive grammar that notion_create_view
// and notion_update_view accept.
//
// Token types:
//   IDENT       "Double-quoted identifier"   (property names)
//   STRING      'Single-quoted string'       (filter values)
//   NUMBER      123 | 3.14                   (filter values, chart heights)
//   KEYWORD     FILTER, SORT, BY, ASC, ...   (case-insensitive, upper-cased)
//   OP          = != < > <= >=               (filter operators)
//   LPAREN RPAREN COMMA SEMICOLON
//   NEWLINE                                  (used as statement separator)
//   EOF
//
// Everything is line/column-tracked so the parser can produce clean errors.
// -----------------------------------------------------------------------------

export type TokenKind =
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "KEYWORD"
  | "OP"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "SEMICOLON"
  | "NEWLINE"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** Canonical/normalized value.
   *  - KEYWORD: upper-cased
   *  - IDENT: raw identifier text (quotes stripped, escapes resolved)
   *  - STRING: raw string content
   *  - NUMBER: the source lexeme (parser converts to number)
   *  - OP: the operator lexeme ("=", "!=", "<", ">", "<=", ">=")
   *  - Delimiters: the source lexeme
   *  - EOF / NEWLINE: ""
   */
  value: string;
  line: number;
  col: number;
}

// Keywords are case-insensitive. We recognise everything that the grammar
// uses — anything not here is an error if bare.
const KEYWORDS = new Set<string>([
  // Directives
  "FILTER", "SORT", "GROUP", "CALENDAR", "TIMELINE", "MAP", "CHART", "FORM",
  "SHOW", "COVER",
  // Structural
  "BY", "TO", "OF", "AND", "OR", "NOT", "IN", "IS", "ON",
  "ASC", "DESC", "ASCENDING", "DESCENDING",
  // Filter atoms
  "CONTAINS", "STARTS", "ENDS", "WITH", "BEFORE", "AFTER",
  "EMPTY", "CHECKED", "UNCHECKED", "EQUALS", "TIMESTAMP",
  // Form
  "CLOSE", "OPEN", "ANONYMOUS", "PERMISSIONS",
  "NONE", "COMMENT_ONLY", "READER", "READ_AND_WRITE", "EDITOR",
  // Chart
  "AGGREGATE", "COLUMN", "BAR", "LINE", "DONUT", "NUMBER",
  "HEIGHT", "SMALL", "MEDIUM", "LARGE", "EXTRA_LARGE",
  // Chart aggregators (matches ChartAggregator in ast.ts)
  "COUNT", "COUNT_VALUES", "SUM", "AVERAGE", "MEDIAN", "MIN", "MAX", "RANGE",
  "UNIQUE", "NOT_EMPTY", "PERCENT_EMPTY", "PERCENT_NOT_EMPTY",
  "PERCENT_CHECKED", "PERCENT_UNCHECKED", "EARLIEST_DATE", "LATEST_DATE",
  "DATE_RANGE",
  // Type overrides (match FilterPropertyType / GroupByPropertyType)
  "RICH_TEXT", "TEXT", "TITLE", "SELECT", "MULTI_SELECT", "STATUS", "DATE",
  "CHECKBOX", "URL", "EMAIL", "PHONE_NUMBER", "PEOPLE", "PERSON", "RELATION",
  "FILES", "FORMULA", "CREATED_TIME", "LAST_EDITED_TIME",
  // Cover
  "PAGE_COVER", "PAGE_CONTENT",
  // Booleans
  "TRUE", "FALSE",
  // Relative date values (2026-03-30) — bare keywords on date filters.
  "TODAY", "TOMORROW", "YESTERDAY", "ONE_WEEK_AGO", "ONE_WEEK_FROM_NOW",
  "ONE_MONTH_AGO", "ONE_MONTH_FROM_NOW",
  // The current-user token for people filters (2026-03-30).
  "ME",
  // Filter: NOT EMPTY etc. already covered by NOT + EMPTY tokens.
]);

export class LexError extends Error {
  constructor(message: string, public readonly line: number, public readonly col: number) {
    super(`View DSL lex error at ${line}:${col}: ${message}`);
  }
}

export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const advance = (n = 1): void => {
    for (let k = 0; k < n; k++) {
      const ch = source[i];
      if (ch === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < source.length) {
    const ch = source[i]!;
    const startLine = line;
    const startCol = col;

    // Horizontal whitespace.
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }

    // Newlines are tokens — used as directive separators.
    if (ch === "\n") {
      out.push({ kind: "NEWLINE", value: "", line: startLine, col: startCol });
      advance();
      continue;
    }

    // Line comments: -- to end of line
    if (ch === "-" && source[i + 1] === "-") {
      while (i < source.length && source[i] !== "\n") advance();
      continue;
    }

    // Block comments: /* ... */
    if (ch === "/" && source[i + 1] === "*") {
      advance(2);
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) advance();
      if (i < source.length) advance(2);
      continue;
    }

    // Single-character delimiters.
    if (ch === "(") { out.push({ kind: "LPAREN", value: "(", line: startLine, col: startCol }); advance(); continue; }
    if (ch === ")") { out.push({ kind: "RPAREN", value: ")", line: startLine, col: startCol }); advance(); continue; }
    if (ch === ",") { out.push({ kind: "COMMA", value: ",", line: startLine, col: startCol }); advance(); continue; }
    if (ch === ";") { out.push({ kind: "SEMICOLON", value: ";", line: startLine, col: startCol }); advance(); continue; }

    // Operators: =, !=, <, >, <=, >=
    if (ch === "=") {
      out.push({ kind: "OP", value: "=", line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === "!" && source[i + 1] === "=") {
      out.push({ kind: "OP", value: "!=", line: startLine, col: startCol });
      advance(2);
      continue;
    }
    if (ch === "<") {
      if (source[i + 1] === "=") {
        out.push({ kind: "OP", value: "<=", line: startLine, col: startCol });
        advance(2);
      } else {
        out.push({ kind: "OP", value: "<", line: startLine, col: startCol });
        advance();
      }
      continue;
    }
    if (ch === ">") {
      if (source[i + 1] === "=") {
        out.push({ kind: "OP", value: ">=", line: startLine, col: startCol });
        advance(2);
      } else {
        out.push({ kind: "OP", value: ">", line: startLine, col: startCol });
        advance();
      }
      continue;
    }

    // Double-quoted identifier.
    if (ch === '"') {
      const parsed = readQuoted(source, i, '"');
      out.push({ kind: "IDENT", value: parsed.value, line: startLine, col: startCol });
      advance(parsed.consumed);
      continue;
    }

    // Single-quoted string.
    if (ch === "'") {
      const parsed = readQuoted(source, i, "'");
      out.push({ kind: "STRING", value: parsed.value, line: startLine, col: startCol });
      advance(parsed.consumed);
      continue;
    }

    // Numbers — integer or decimal, optional leading `-`.
    if (ch >= "0" && ch <= "9") {
      const lexeme = readNumber(source, i);
      out.push({ kind: "NUMBER", value: lexeme, line: startLine, col: startCol });
      advance(lexeme.length);
      continue;
    }
    if (ch === "-" && source[i + 1] !== undefined && source[i + 1]! >= "0" && source[i + 1]! <= "9") {
      const lexeme = "-" + readNumber(source, i + 1);
      out.push({ kind: "NUMBER", value: lexeme, line: startLine, col: startCol });
      advance(lexeme.length);
      continue;
    }

    // Bare words → keyword (case-insensitive). Non-keyword bare words are an
    // error: identifiers (property names) must be double-quoted.
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentCont(source[j]!)) j++;
      const word = source.slice(i, j);
      const upper = word.toUpperCase();
      if (!KEYWORDS.has(upper)) {
        throw new LexError(
          `unknown keyword "${word}" (property names must be double-quoted — did you mean "${word}"?)`,
          startLine,
          startCol
        );
      }
      out.push({ kind: "KEYWORD", value: upper, line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)}`, startLine, startCol);
  }

  out.push({ kind: "EOF", value: "", line, col });
  return out;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentCont(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function readNumber(source: string, start: number): string {
  let j = start;
  while (j < source.length && source[j]! >= "0" && source[j]! <= "9") j++;
  if (source[j] === ".") {
    j++;
    while (j < source.length && source[j]! >= "0" && source[j]! <= "9") j++;
  }
  return source.slice(start, j);
}

function readQuoted(source: string, start: number, quote: '"' | "'"): { value: string; consumed: number } {
  let i = start + 1;
  let out = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1]!;
      if (next === "\\" || next === quote) { out += next; i += 2; continue; }
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === quote) {
      if (source[i + 1] === quote) { out += quote; i += 2; continue; }
      return { value: out, consumed: i - start + 1 };
    }
    out += ch;
    i++;
  }
  throw new LexError(`unterminated ${quote === '"' ? "identifier" : "string"} literal`, -1, -1);
}
