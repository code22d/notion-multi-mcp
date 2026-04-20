// -----------------------------------------------------------------------------
// DDL parser — recursive-descent. Two entry points:
//
//   parseCreateTable(sql) → CreateTableAst
//     Accepts one CREATE TABLE statement. The leading `CREATE TABLE` keywords
//     are optional — the native Notion MCP accepts a bare `(column-list)` as
//     schema, and our tool does the same for parity.
//
//   parseAlterStatements(sql) → AlterOp[]
//     Accepts one or more ALTER operations. Statements may be separated by
//     semicolons OR newlines (per Rene's spec). The optional `ALTER TABLE`
//     prefix is tolerated but not required.
//
// Error strategy: throw a ParseError with a line/col-anchored message. The
// tool handler maps these to MCP tool errors.
// -----------------------------------------------------------------------------

import type { CreateTableAst, AlterOp, ColumnDef, PropertyTypeAst, SelectOption, StatusOption, DdlColor } from "./ast";
import { LexError, tokenize, type Token } from "./lexer";

export class ParseError extends Error {
  constructor(message: string, public readonly line: number, public readonly col: number) {
    super(`DDL parse error at ${line}:${col}: ${message}`);
  }
}

const COLOR_NAMES: ReadonlySet<DdlColor> = new Set<DdlColor>([
  "default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red",
]);

// -----------------------------------------------------------------------------
// Entry points
// -----------------------------------------------------------------------------

export function parseCreateTable(sql: string): CreateTableAst {
  const tokens = lex(sql);
  const p = new Cursor(tokens);
  p.skipNewlines();
  // Optional leading `CREATE TABLE`.
  if (p.peek().kind === "KEYWORD" && p.peek().value === "CREATE") {
    p.consume("KEYWORD", "CREATE");
    // `TABLE` optional — we accept either `CREATE (...)` or `CREATE TABLE (...)`.
    if (p.peek().kind === "KEYWORD" && p.peek().value === "TABLE") p.advance();
    // Optional table name (ignored — Notion picks the name from the `title`
    // field on the API call, not from SQL).
    if (p.peek().kind === "IDENT") p.advance();
    p.skipNewlines();
  }
  p.consume("LPAREN", "(");
  const columns = parseColumnList(p);
  p.consume("RPAREN", ")");
  p.skipNewlines();
  // Allow an optional trailing semicolon.
  if (p.peek().kind === "SEMICOLON") p.advance();
  p.skipNewlines();
  if (p.peek().kind !== "EOF") {
    throw new ParseError(
      `unexpected token ${tokDesc(p.peek())} after CREATE TABLE (only one statement allowed)`,
      p.peek().line,
      p.peek().col
    );
  }
  if (columns.length === 0) {
    throw new ParseError("CREATE TABLE must declare at least one column", 1, 1);
  }
  return { kind: "create_table", columns };
}

export function parseAlterStatements(sql: string): AlterOp[] {
  const tokens = lex(sql);
  const p = new Cursor(tokens);
  const ops: AlterOp[] = [];
  while (true) {
    p.skipStatementSeparators();
    if (p.peek().kind === "EOF") break;
    // Optional leading `ALTER TABLE` (followed by optional identifier).
    if (p.peek().kind === "KEYWORD" && p.peek().value === "ALTER") {
      // Could be `ALTER TABLE "Name"` prefix OR `ALTER COLUMN "X" SET …`.
      // Peek ahead to disambiguate.
      const next = p.peekAt(1);
      if (next && next.kind === "KEYWORD" && next.value === "TABLE") {
        p.advance(); // ALTER
        p.advance(); // TABLE
        if (p.peek().kind === "IDENT") p.advance(); // optional table name
        p.skipNewlines();
      }
      // else fall through — `ALTER COLUMN …` is a real op, not a prefix.
    }
    ops.push(parseOneAlterOp(p));
  }
  if (ops.length === 0) {
    throw new ParseError("no ALTER operations found in input", 1, 1);
  }
  return ops;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function lex(sql: string): Token[] {
  try {
    return tokenize(sql);
  } catch (err) {
    if (err instanceof LexError) {
      throw new ParseError(err.message.replace(/^DDL lex error at \S+: /, ""), err.line, err.col);
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

  /** Consume a token of the given kind (and optional literal value); throw otherwise. */
  consume(kind: Token["kind"], value?: string): Token {
    const t = this.peek();
    if (t.kind !== kind || (value !== undefined && t.value !== value)) {
      const want = value !== undefined ? `${kind} "${value}"` : kind;
      throw new ParseError(`expected ${want}, got ${tokDesc(t)}`, t.line, t.col);
    }
    return this.advance();
  }

  skipNewlines(): void {
    while (this.peek().kind === "NEWLINE") this.i++;
  }

  /** For ALTER — a statement separator is a semicolon, newline, or any mix thereof. */
  skipStatementSeparators(): void {
    while (this.peek().kind === "NEWLINE" || this.peek().kind === "SEMICOLON") this.i++;
  }

  /** Check-and-consume if match. */
  accept(kind: Token["kind"], value?: string): Token | null {
    const t = this.peek();
    if (t.kind !== kind) return null;
    if (value !== undefined && t.value !== value) return null;
    this.i++;
    return t;
  }
}

// -----------------------------------------------------------------------------
// Column list
// -----------------------------------------------------------------------------

function parseColumnList(p: Cursor): ColumnDef[] {
  const columns: ColumnDef[] = [];
  p.skipNewlines();
  if (p.peek().kind === "RPAREN") return columns;
  while (true) {
    p.skipNewlines();
    columns.push(parseColumnDef(p));
    p.skipNewlines();
    if (p.accept("COMMA")) continue;
    break;
  }
  p.skipNewlines();
  return columns;
}

function parseColumnDef(p: Cursor): ColumnDef {
  const nameTok = p.consume("IDENT");
  const type = parsePropertyType(p);
  return { name: nameTok.value, type };
}

// -----------------------------------------------------------------------------
// Property types
// -----------------------------------------------------------------------------

function parsePropertyType(p: Cursor): PropertyTypeAst {
  const tok = p.peek();
  if (tok.kind !== "KEYWORD") {
    throw new ParseError(`expected a property type keyword, got ${tokDesc(tok)}`, tok.line, tok.col);
  }
  const kw = tok.value;
  p.advance();

  switch (kw) {
    case "TITLE": return { kind: "title" };
    case "RICH_TEXT":
    case "TEXT":    return { kind: "rich_text" };
    case "DATE":    return { kind: "date" };
    case "PEOPLE":  return { kind: "people" };
    case "CHECKBOX":return { kind: "checkbox" };
    case "URL":     return { kind: "url" };
    case "EMAIL":   return { kind: "email" };
    case "PHONE_NUMBER": return { kind: "phone_number" };
    case "FILES":   return { kind: "files" };
    case "CREATED_TIME":    return { kind: "created_time" };
    case "CREATED_BY":      return { kind: "created_by" };
    case "LAST_EDITED_TIME":return { kind: "last_edited_time" };
    case "LAST_EDITED_BY":  return { kind: "last_edited_by" };

    case "NUMBER": {
      // Optional: FORMAT 'x'
      if (p.peek().kind === "KEYWORD" && p.peek().value === "FORMAT") {
        p.advance();
        const fmt = p.consume("STRING");
        return { kind: "number", format: fmt.value };
      }
      return { kind: "number" };
    }

    case "SELECT": {
      const options = parseOptionList(p, false);
      return { kind: "select", options: options as SelectOption[] };
    }
    case "MULTI_SELECT": {
      const options = parseOptionList(p, false);
      return { kind: "multi_select", options: options as SelectOption[] };
    }
    case "STATUS": {
      const options = parseOptionList(p, true);
      return { kind: "status", options: options as StatusOption[] };
    }

    case "RELATION": {
      p.consume("LPAREN", "(");
      const idTok = p.consume("STRING");
      let dual = false;
      if (p.accept("COMMA")) {
        const dualKw = p.consume("KEYWORD");
        if (dualKw.value !== "DUAL") {
          throw new ParseError(
            `expected DUAL after comma in RELATION(), got ${tokDesc(dualKw)}`,
            dualKw.line,
            dualKw.col
          );
        }
        dual = true;
      }
      p.consume("RPAREN", ")");
      return { kind: "relation", dataSourceId: idTok.value, dual };
    }

    case "ROLLUP": {
      p.consume("LPAREN", "(");
      const rel = p.consume("STRING");
      p.consume("COMMA", ",");
      const target = p.consume("STRING");
      p.consume("COMMA", ",");
      const fn = p.consume("STRING");
      p.consume("RPAREN", ")");
      return {
        kind: "rollup",
        relationPropertyName: rel.value,
        rollupPropertyName: target.value,
        function: fn.value,
      };
    }

    case "FORMULA": {
      p.consume("LPAREN", "(");
      const expr = p.consume("STRING");
      p.consume("RPAREN", ")");
      return { kind: "formula", expression: expr.value };
    }

    case "UNIQUE_ID": {
      if (p.peek().kind === "KEYWORD" && p.peek().value === "PREFIX") {
        p.advance();
        const prefix = p.consume("STRING");
        return { kind: "unique_id", prefix: prefix.value };
      }
      return { kind: "unique_id" };
    }

    default:
      throw new ParseError(`unknown property type "${kw}"`, tok.line, tok.col);
  }
}

/**
 * Parse the `('opt':color, 'opt2':color)` option list. For STATUS, each option
 * can have an extra middle token: `'name':'group':color`.
 *
 * We return Option[] — when withGroup=false, every entry has {name, color}.
 * When withGroup=true, entries may have {name, group, color}. The `color`
 * value is undefined if the token isn't a recognised colour.
 */
function parseOptionList(
  p: Cursor,
  withGroup: boolean
): Array<SelectOption | StatusOption> {
  p.consume("LPAREN", "(");
  const out: Array<SelectOption | StatusOption> = [];
  p.skipNewlines();
  if (p.accept("RPAREN")) return out;
  while (true) {
    p.skipNewlines();
    const nameTok = p.consume("STRING");
    let group: string | undefined;
    let color: DdlColor | undefined;

    // First colon — always separates name from (colour | group)
    if (p.accept("COLON")) {
      const second = p.peek();
      if (second.kind === "STRING" && withGroup) {
        // STATUS form: 'name':'group':color
        group = second.value;
        p.advance();
        if (p.accept("COLON")) {
          const colTok = p.consume("KEYWORD");
          color = parseColor(colTok.value, colTok.line, colTok.col);
        }
      } else if (second.kind === "KEYWORD") {
        color = parseColor(second.value, second.line, second.col);
        p.advance();
      } else if (second.kind === "STRING") {
        // `'name':'group'` with no trailing colour — group only (STATUS) or
        // a colour that was accidentally single-quoted (tolerant: treat as
        // colour if it matches).
        if (withGroup) {
          group = second.value;
          p.advance();
        } else if (COLOR_NAMES.has(second.value as DdlColor)) {
          color = second.value as DdlColor;
          p.advance();
        } else {
          throw new ParseError(
            `expected a colour keyword after ':' in option, got ${tokDesc(second)}`,
            second.line,
            second.col
          );
        }
      } else {
        throw new ParseError(
          `expected a colour after ':' in option, got ${tokDesc(second)}`,
          second.line,
          second.col
        );
      }
    }

    const entry: SelectOption & { group?: string } = { name: nameTok.value };
    if (color !== undefined) entry.color = color;
    if (withGroup && group !== undefined) entry.group = group;
    out.push(entry);

    p.skipNewlines();
    if (p.accept("COMMA")) continue;
    break;
  }
  p.skipNewlines();
  p.consume("RPAREN", ")");
  return out;
}

function parseColor(word: string, line: number, col: number): DdlColor {
  const lower = word.toLowerCase();
  if (!COLOR_NAMES.has(lower as DdlColor)) {
    throw new ParseError(
      `unknown colour "${word}" — must be one of ${[...COLOR_NAMES].join(", ")}`,
      line,
      col
    );
  }
  return lower as DdlColor;
}

// -----------------------------------------------------------------------------
// ALTER ops
// -----------------------------------------------------------------------------

function parseOneAlterOp(p: Cursor): AlterOp {
  const head = p.consume("KEYWORD");
  switch (head.value) {
    case "ADD": {
      // ADD COLUMN "Name" <type>   (COLUMN keyword is optional)
      if (p.peek().kind === "KEYWORD" && p.peek().value === "COLUMN") p.advance();
      const column = parseColumnDef(p);
      return { kind: "add", column };
    }
    case "DROP": {
      if (p.peek().kind === "KEYWORD" && p.peek().value === "COLUMN") p.advance();
      const name = p.consume("IDENT");
      return { kind: "drop", name: name.value };
    }
    case "RENAME": {
      if (p.peek().kind === "KEYWORD" && p.peek().value === "COLUMN") p.advance();
      const from = p.consume("IDENT");
      // Use peek-before-consume so "expected TO" is the error even if the
      // next token isn't a keyword (e.g. the user wrote `RENAME "A" "B"`).
      const toTok = p.peek();
      if (toTok.kind !== "KEYWORD" || toTok.value !== "TO") {
        throw new ParseError(
          `expected TO after RENAME COLUMN "${from.value}", got ${tokDesc(toTok)}`,
          toTok.line,
          toTok.col
        );
      }
      p.advance();
      const to = p.consume("IDENT");
      return { kind: "rename", from: from.value, to: to.value };
    }
    case "ALTER": {
      // ALTER COLUMN "Name" SET <type>
      if (p.peek().kind === "KEYWORD" && p.peek().value === "COLUMN") p.advance();
      const name = p.consume("IDENT");
      const setKw = p.consume("KEYWORD");
      if (setKw.value !== "SET") {
        throw new ParseError(`expected SET after ALTER COLUMN "${name.value}", got ${tokDesc(setKw)}`, setKw.line, setKw.col);
      }
      const type = parsePropertyType(p);
      return { kind: "alter_set", name: name.value, type };
    }
    default:
      throw new ParseError(
        `expected ADD, DROP, RENAME, or ALTER at start of statement, got ${tokDesc(head)}`,
        head.line,
        head.col
      );
  }
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function tokDesc(t: Token): string {
  switch (t.kind) {
    case "EOF": return "end of input";
    case "NEWLINE": return "newline";
    case "IDENT": return `identifier "${t.value}"`;
    case "STRING": return `string '${t.value}'`;
    case "KEYWORD": return `keyword ${t.value}`;
    case "NUMBER": return `number ${t.value}`;
    default: return `"${t.value}"`;
  }
}
