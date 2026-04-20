// -----------------------------------------------------------------------------
// DDL lexer — tokenises the SQL-ish dialect that notion_create_database and
// notion_update_data_source accept.
//
// Token types:
//   IDENT       "Double-quoted identifier"  (column / property names)
//   STRING      'Single-quoted string'      (option names, formula exprs)
//   NUMBER      123 | 3.14                  (rare — kept for future use)
//   KEYWORD     TITLE, SELECT, ADD, etc.    (case-insensitive, upper-cased)
//   LPAREN RPAREN COMMA COLON SEMICOLON
//   EOF
//
// Everything is line/column-tracked so the parser can produce clean errors.
// -----------------------------------------------------------------------------

export type TokenKind =
  | "IDENT"
  | "STRING"
  | "NUMBER"
  | "KEYWORD"
  | "LPAREN"
  | "RPAREN"
  | "COMMA"
  | "COLON"
  | "SEMICOLON"
  | "NEWLINE"
  | "EOF";

export interface Token {
  kind: TokenKind;
  /** The canonical/normalized value.
   *  - KEYWORD: upper-cased (e.g. "TITLE", "SELECT")
   *  - IDENT: raw identifier text (quotes stripped, escapes resolved)
   *  - STRING: raw string content (quotes stripped, escapes resolved)
   *  - NUMBER: the source lexeme (e.g. "3.14")
   *  - Delimiters: the source lexeme (e.g. "(")
   *  - EOF / NEWLINE: ""
   */
  value: string;
  /** Source line (1-based). */
  line: number;
  /** Source column (1-based). */
  col: number;
}

// Keywords are case-insensitive in the source. We recognise everything that
// appears in the DDL grammar (both property types and statement-level words).
// Anything not in this set that looks like a bare word is treated as an error
// — identifiers must be double-quoted.
const KEYWORDS = new Set<string>([
  // Statement-level
  "CREATE", "TABLE", "ADD", "DROP", "RENAME", "ALTER", "COLUMN", "TO", "SET",
  // Property-type modifiers
  "DUAL", "FORMAT", "PREFIX",
  // Property types
  "TITLE", "RICH_TEXT", "NUMBER", "SELECT", "MULTI_SELECT", "STATUS",
  "DATE", "PEOPLE", "CHECKBOX", "URL", "EMAIL", "PHONE_NUMBER", "FILES",
  "RELATION", "ROLLUP", "FORMULA", "UNIQUE_ID",
  "CREATED_TIME", "CREATED_BY", "LAST_EDITED_TIME", "LAST_EDITED_BY",
  // Colours — appear unquoted after a colon inside option lists. We tokenise
  // them as keywords so the parser's colour lookup is uniform (it only ever
  // sees KEYWORD tokens for colour positions, not IDENT tokens).
  "DEFAULT", "GRAY", "BROWN", "ORANGE", "YELLOW",
  "GREEN", "BLUE", "PURPLE", "PINK", "RED",
  // Also-accepted synonyms (for parity with casual DDL)
  "TEXT", // alias for RICH_TEXT in some dialects — resolved in parser
]);

export class LexError extends Error {
  constructor(message: string, public readonly line: number, public readonly col: number) {
    super(`DDL lex error at ${line}:${col}: ${message}`);
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

    // Skip horizontal whitespace.
    if (ch === " " || ch === "\t" || ch === "\r") {
      advance();
      continue;
    }

    // Newlines are tokens — used as statement separators in notion_update_data_source.
    // In notion_create_database the parser just skips them.
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
    if (ch === "(") {
      out.push({ kind: "LPAREN", value: "(", line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === ")") {
      out.push({ kind: "RPAREN", value: ")", line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === ",") {
      out.push({ kind: "COMMA", value: ",", line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === ":") {
      out.push({ kind: "COLON", value: ":", line: startLine, col: startCol });
      advance();
      continue;
    }
    if (ch === ";") {
      out.push({ kind: "SEMICOLON", value: ";", line: startLine, col: startCol });
      advance();
      continue;
    }

    // Double-quoted identifier. Supports backslash-escape for `"` and `\`, and
    // the "" doubling convention (SQL-style).
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

    // Numbers — simple, no exponent/sign (not really needed by the grammar,
    // but keeps the door open).
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < source.length && source[j]! >= "0" && source[j]! <= "9") j++;
      if (source[j] === ".") {
        j++;
        while (j < source.length && source[j]! >= "0" && source[j]! <= "9") j++;
      }
      const lexeme = source.slice(i, j);
      out.push({ kind: "NUMBER", value: lexeme, line: startLine, col: startCol });
      advance(j - i);
      continue;
    }

    // Bare words → keyword (case-insensitive). Non-keyword bare words are an
    // error: identifiers must be double-quoted in this dialect.
    if (isIdentStart(ch)) {
      let j = i;
      while (j < source.length && isIdentCont(source[j]!)) j++;
      const word = source.slice(i, j);
      const upper = word.toUpperCase();
      if (!KEYWORDS.has(upper)) {
        throw new LexError(
          `unknown keyword "${word}" (identifiers must be double-quoted — did you mean "${word}"?)`,
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

/**
 * Read a quoted literal (double or single). Handles:
 *   - `\\` → `\`
 *   - `\"` / `\'` → the quote char
 *   - `""` / `''` (SQL-style doubling) → single quote char
 * Returns the decoded value and how many source characters were consumed
 * (including the surrounding quotes).
 */
function readQuoted(source: string, start: number, quote: '"' | "'"): { value: string; consumed: number } {
  let i = start + 1; // skip opening quote
  let out = "";
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\" && i + 1 < source.length) {
      const next = source[i + 1]!;
      if (next === "\\" || next === quote) {
        out += next;
        i += 2;
        continue;
      }
      if (next === "n") {
        out += "\n";
        i += 2;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i += 2;
        continue;
      }
      // Unknown escape — preserve as-is.
      out += ch + next;
      i += 2;
      continue;
    }
    if (ch === quote) {
      // SQL-style doubling: `""` inside a `"…"` = literal `"`
      if (source[i + 1] === quote) {
        out += quote;
        i += 2;
        continue;
      }
      return { value: out, consumed: i - start + 1 };
    }
    out += ch;
    i++;
  }
  // Unterminated literal — locate the start for error reporting.
  // The caller has startLine/startCol; we compute a reasonable message.
  throw new LexError(`unterminated ${quote === '"' ? "identifier" : "string"} literal`, -1, -1);
}
