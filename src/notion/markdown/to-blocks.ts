// -----------------------------------------------------------------------------
// Markdown → Notion BlockObjectRequest[]
//
// Uses `marked` for core Markdown tokenisation. Notion extensions (callouts,
// toggles, columns, page mentions, block equations) are handled via a small
// pre-processor that splits them out before passing the rest to marked, plus
// recognition of `html` tokens that marked produces.
//
// Output shape matches Notion's BlockObjectRequest union — the consumer (the
// notion_create_pages handler) can POST it straight to /v1/pages as `children`
// or to /v1/blocks/{id}/children.
// -----------------------------------------------------------------------------

import { Marked, type Token, type Tokens, type TokensList } from "marked";
import { tokensToRichText, type RichTextRun } from "./to-rich-text";

// Use a fresh Marked instance so we don't pollute any global config elsewhere.
// GFM is on by default in marked v18 but we set it explicitly for clarity.
const mdLexer = new Marked({ gfm: true, breaks: false });

// Allow-list of Notion code-block languages (matches LanguageRequest in the SDK).
// Anything outside this list is coerced to "plain text".
const KNOWN_LANGUAGES = new Set<string>([
  "abap", "abc", "agda", "arduino", "ascii art", "assembly", "bash", "basic", "bnf",
  "c", "c#", "c++", "clojure", "coffeescript", "coq", "css", "dart", "dhall", "diff",
  "docker", "ebnf", "elixir", "elm", "erlang", "f#", "flow", "fortran", "gherkin",
  "glsl", "go", "graphql", "groovy", "haskell", "hcl", "html", "idris", "java",
  "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
  "llvm ir", "lua", "makefile", "markdown", "markup", "matlab", "mathematica",
  "mermaid", "nix", "notion formula", "objective-c", "ocaml", "pascal", "perl",
  "php", "plain text", "powershell", "prolog", "protobuf", "purescript", "python",
  "r", "racket", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss",
  "shell", "smalltalk", "solidity", "sql", "swift", "toml", "typescript", "vb.net",
  "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml",
  "java/c/c++/c#",
]);

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  zsh: "bash",
  md: "markdown",
  yml: "yaml",
  txt: "plain text",
  "": "plain text",
};

/**
 * Simplified block request — mirrors a slice of Notion's BlockObjectRequest.
 * We type it loosely so TS doesn't complain when we emit the same shape with
 * different children arrays; Notion accepts any JSON that matches the runtime
 * schema, and we validate by round-tripping through the API in tests.
 */
export type BlockRequest = Record<string, unknown> & { type?: string };

/** Primary entry — converts a Markdown string into Notion block requests. */
export function markdownToBlocks(markdown: string): BlockRequest[] {
  if (!markdown || markdown.trim() === "") return [];
  const parts = splitSpecialBlocks(markdown);
  const out: BlockRequest[] = [];
  for (const part of parts) {
    if (part.kind === "equation_block") {
      out.push({
        type: "equation",
        equation: { expression: part.expression },
      });
      continue;
    }
    if (part.kind === "details_block") {
      const summaryTokens = mdLexer
        .lexer(part.summary || " ")
        .flatMap((t) => ((t as Tokens.Paragraph).tokens ?? []));
      const body: Record<string, unknown> = { rich_text: toRichText(summaryTokens) };
      if (part.body && part.body.trim() !== "") body.children = markdownToBlocks(part.body);
      out.push({ type: "toggle", toggle: body });
      continue;
    }
    if (part.kind === "markdown") {
      const tokens = mdLexer.lexer(part.text) as TokensList;
      for (const tok of tokens) {
        const blocks = tokenToBlocks(tok);
        for (const b of blocks) out.push(b);
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Pre-processing: extract block equations `$$ … $$` and <details>…</details>
// spans out-of-band before lex. Both are multi-line constructs that marked's
// default paragraph rule tends to split across multiple tokens, so grabbing
// them in one pass up-front gives us a single contiguous string for each.
// -----------------------------------------------------------------------------

type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "equation_block"; expression: string }
  | { kind: "details_block"; summary: string; body: string };

function splitSpecialBlocks(source: string): Segment[] {
  // First pass — extract <details>…</details> spans. These can straddle blank
  // lines, which marked would otherwise tokenise as separate paragraphs.
  const afterDetails = splitOnDetails(source);
  // Second pass — within each `markdown`-kind segment, extract $$…$$ blocks.
  const segments: Segment[] = [];
  for (const seg of afterDetails) {
    if (seg.kind !== "markdown") {
      segments.push(seg);
      continue;
    }
    segments.push(...splitOnEquations(seg.text));
  }
  if (segments.length === 0) segments.push({ kind: "markdown", text: source });
  return segments;
}

function splitOnDetails(source: string): Segment[] {
  // Match <details>[whitespace-tolerant]<summary>…</summary> … </details>
  // across any number of intervening newlines / blank lines. Non-greedy on
  // the body so nested <details> don't swallow the outer closer.
  // Leading whitespace (incl. one or more spaces at line start) is allowed.
  const re = /(^|\n)[ \t]*<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>[ \t]*(?=\n|$)/gi;
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(last, m.index + m[1]!.length);
    if (before.trim() !== "") segments.push({ kind: "markdown", text: before });
    const summary = (m[2] ?? "").trim();
    const body = (m[3] ?? "").trim();
    segments.push({ kind: "details_block", summary, body });
    last = m.index + m[0].length;
  }
  const rest = source.slice(last);
  if (rest.trim() !== "") segments.push({ kind: "markdown", text: rest });
  return segments;
}

function splitOnEquations(source: string): Segment[] {
  const segments: Segment[] = [];
  // Match `$$` delimited blocks that occupy their own lines.
  const re = /(^|\n)\s*\$\$([\s\S]*?)\$\$\s*(?=\n|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(last, m.index + m[1]!.length);
    if (before.trim() !== "") segments.push({ kind: "markdown", text: before });
    segments.push({ kind: "equation_block", expression: (m[2] ?? "").trim() });
    last = m.index + m[0].length;
  }
  const rest = source.slice(last);
  if (rest.trim() !== "") segments.push({ kind: "markdown", text: rest });
  return segments;
}

// -----------------------------------------------------------------------------
// Token → block request
// -----------------------------------------------------------------------------

function tokenToBlocks(tok: Token): BlockRequest[] {
  switch (tok.type) {
    case "space":
      return [];
    case "heading":
      return [headingBlock(tok as Tokens.Heading)];
    case "paragraph": {
      const p = tok as Tokens.Paragraph;
      // Detect a paragraph that is really a single standalone image → image block.
      const imageBlock = tryStandaloneImage(p);
      if (imageBlock) return [imageBlock];
      // Detect a paragraph that is really a standalone <page id="..."> mention
      // with no other text → link_to_page block.
      const linkBlock = tryStandaloneLink(p);
      if (linkBlock) return [linkBlock];
      // Detect a paragraph that is purely a <details>/<column-list> HTML block
      // (marked sometimes leaves these as paragraphs).
      const htmlBlocks = tryHtmlBlock(p.raw);
      if (htmlBlocks) return htmlBlocks;
      return [
        {
          type: "paragraph",
          paragraph: { rich_text: toRichText(p.tokens) },
        },
      ];
    }
    case "blockquote": {
      const bq = tok as Tokens.Blockquote;
      const alert = detectAlert(bq);
      if (alert) return [alert];
      return [quoteBlock(bq)];
    }
    case "hr":
      return [{ type: "divider", divider: {} }];
    case "code":
      return [codeBlock(tok as Tokens.Code)];
    case "list":
      return listBlocks(tok as Tokens.List);
    case "table":
      return [tableBlock(tok as Tokens.Table)];
    case "html": {
      const h = tok as Tokens.HTML;
      const htmlBlocks = tryHtmlBlock(h.text ?? h.raw);
      if (htmlBlocks) return htmlBlocks;
      // Unknown HTML — keep it as a paragraph so nothing disappears silently.
      return [
        {
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: (h.text ?? h.raw).trim() } }],
          },
        },
      ];
    }
    default:
      return [];
  }
}

// -----------------------------------------------------------------------------
// Specific block builders
// -----------------------------------------------------------------------------

function headingBlock(h: Tokens.Heading): BlockRequest {
  const depth = Math.min(Math.max(h.depth, 1), 4);
  const key = `heading_${depth}` as const;
  return {
    type: key,
    [key]: { rich_text: toRichText(h.tokens) },
  };
}

function quoteBlock(bq: Tokens.Blockquote): BlockRequest {
  // Flatten child tokens: inline text becomes the rich_text, nested block
  // elements become `children`.
  const richParts: RichTextRun[] = [];
  const childBlocks: BlockRequest[] = [];
  for (const child of bq.tokens ?? []) {
    if (child.type === "paragraph") {
      if (richParts.length > 0) richParts.push({ type: "text", text: { content: "\n" } });
      richParts.push(...toRichText((child as Tokens.Paragraph).tokens));
    } else {
      childBlocks.push(...tokenToBlocks(child));
    }
  }
  const body: Record<string, unknown> = { rich_text: richParts };
  if (childBlocks.length > 0) body.children = childBlocks;
  return { type: "quote", quote: body };
}

function detectAlert(bq: Tokens.Blockquote): BlockRequest | null {
  // GFM-style alert: first paragraph inside blockquote starts with "[!NAME]".
  const first = bq.tokens?.[0];
  if (!first || first.type !== "paragraph") return null;
  const para = first as Tokens.Paragraph;
  const match = para.raw.match(/^\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION|DANGER)\][^\S\n]*([\s\S]*)/i);
  if (!match) return null;
  const emojiMatch = (match[2] ?? "").match(/^\s*(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u);
  const emoji = emojiMatch?.[1] ?? defaultAlertEmoji(match[1]!);
  // Remainder of first paragraph after the [!NOTE] tag + optional emoji.
  const trimmed = (match[2] ?? "").replace(/^\s*(\p{Emoji_Presentation}|\p{Extended_Pictographic})\s*/u, "");
  const firstLineTokens = trimmed ? mdLexer.lexer(trimmed).flatMap((t) => ((t as Tokens.Paragraph).tokens ?? [])) : [];
  const richParts: RichTextRun[] = [...toRichText(firstLineTokens)];
  const childBlocks: BlockRequest[] = [];
  for (let i = 1; i < (bq.tokens?.length ?? 0); i++) {
    const child = bq.tokens![i]!;
    if (child.type === "paragraph") {
      if (richParts.length > 0) richParts.push({ type: "text", text: { content: "\n" } });
      richParts.push(...toRichText((child as Tokens.Paragraph).tokens));
    } else {
      childBlocks.push(...tokenToBlocks(child));
    }
  }
  const body: Record<string, unknown> = {
    rich_text: richParts,
    icon: { type: "emoji", emoji },
  };
  if (childBlocks.length > 0) body.children = childBlocks;
  return { type: "callout", callout: body };
}

function defaultAlertEmoji(kind: string): string {
  const normalized = kind.toUpperCase();
  switch (normalized) {
    case "NOTE":
      return "📝";
    case "TIP":
      return "💡";
    case "WARNING":
      return "⚠️";
    case "IMPORTANT":
      return "❗";
    case "CAUTION":
    case "DANGER":
      return "🚨";
    default:
      return "📝";
  }
}

function codeBlock(c: Tokens.Code): BlockRequest {
  const rawLang = (c.lang ?? "").toLowerCase().trim();
  const aliased = LANGUAGE_ALIASES[rawLang] ?? rawLang;
  const language = KNOWN_LANGUAGES.has(aliased) ? aliased : "plain text";
  return {
    type: "code",
    code: {
      rich_text: [{ type: "text", text: { content: c.text } }],
      language,
    },
  };
}

function listBlocks(list: Tokens.List): BlockRequest[] {
  const out: BlockRequest[] = [];
  for (const item of list.items) {
    out.push(listItemBlock(item, list.ordered));
  }
  return out;
}

function listItemBlock(item: Tokens.ListItem, ordered: boolean): BlockRequest {
  // Split the item's tokens into inline-leading-content and block-level children.
  const leadingInline: Token[] = [];
  const childBlocks: BlockRequest[] = [];
  let seenBlock = false;
  for (const child of item.tokens ?? []) {
    // Task-list markers are emitted as their own `checkbox` token — already
    // captured by item.task / item.checked, so drop them from the inline stream.
    if (child.type === "checkbox") continue;
    if (!seenBlock && (child.type === "text" || child.type === "paragraph")) {
      // Marked wraps list-item text in a `text` token with inner inline tokens
      // when the list is tight, and a `paragraph` when loose. Either way, a
      // task-list item has an inner `checkbox` token we need to strip.
      if (child.type === "paragraph") {
        if (leadingInline.length > 0) leadingInline.push({ type: "text", raw: "\n", text: "\n" } as Tokens.Text);
        const inner = ((child as Tokens.Paragraph).tokens ?? []).filter((t) => t.type !== "checkbox");
        leadingInline.push(...inner);
      } else {
        const t = child as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) {
          leadingInline.push(...t.tokens.filter((tok) => tok.type !== "checkbox"));
        } else {
          leadingInline.push({ type: "text", raw: t.text, text: t.text } as Tokens.Text);
        }
      }
    } else {
      seenBlock = true;
      childBlocks.push(...tokenToBlocks(child));
    }
  }
  const richText = toRichText(leadingInline);

  if (item.task) {
    const body: Record<string, unknown> = {
      rich_text: richText,
      checked: item.checked ?? false,
    };
    if (childBlocks.length > 0) body.children = childBlocks;
    return { type: "to_do", to_do: body };
  }
  const key = ordered ? "numbered_list_item" : "bulleted_list_item";
  const body: Record<string, unknown> = { rich_text: richText };
  if (childBlocks.length > 0) body.children = childBlocks;
  return { type: key, [key]: body };
}

function tableBlock(t: Tokens.Table): BlockRequest {
  const width = Math.max(t.header.length, ...t.rows.map((r) => r.length));
  const rowsOut: BlockRequest[] = [];
  const headerCells: RichTextRun[][] = t.header.map((c) => toRichText(c.tokens));
  while (headerCells.length < width) headerCells.push([]);
  rowsOut.push({ type: "table_row", table_row: { cells: headerCells } });
  for (const r of t.rows) {
    const cells = r.map((c) => toRichText(c.tokens));
    while (cells.length < width) cells.push([]);
    rowsOut.push({ type: "table_row", table_row: { cells } });
  }
  return {
    type: "table",
    table: {
      table_width: width,
      has_column_header: true,
      has_row_header: false,
      children: rowsOut,
    },
  };
}

// -----------------------------------------------------------------------------
// HTML-block extensions: <details>, <column-list>/<column>, standalone tags.
// -----------------------------------------------------------------------------

function tryHtmlBlock(raw: string): BlockRequest[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<")) return null;

  // <caption>…</caption> is emitted by from-blocks for code-block captions.
  // It carries no round-trip-able content yet, so drop it silently.
  if (/^<caption>[\s\S]*?<\/caption>\s*$/i.test(trimmed)) return [];

  // <details>…</details> → toggle
  const detailsMatch = trimmed.match(
    /^<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)\s*<\/details>\s*$/i
  );
  if (detailsMatch) {
    const summaryMd = detailsMatch[1] ?? "";
    const bodyMd = (detailsMatch[2] ?? "").trim();
    const summaryTokens = mdLexer.lexer(summaryMd).flatMap((t) => ((t as Tokens.Paragraph).tokens ?? []));
    const body: Record<string, unknown> = { rich_text: toRichText(summaryTokens) };
    if (bodyMd) body.children = markdownToBlocks(bodyMd);
    return [{ type: "toggle", toggle: body }];
  }

  // <column-list>…</column-list> → column_list with nested columns
  const colListMatch = trimmed.match(/^<column-list>\s*([\s\S]*?)\s*<\/column-list>\s*$/i);
  if (colListMatch) {
    const inside = colListMatch[1] ?? "";
    const colRe = /<column>\s*([\s\S]*?)\s*<\/column>/gi;
    const columns: BlockRequest[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = colRe.exec(inside))) {
      const colBody = cm[1] ?? "";
      columns.push({
        type: "column",
        column: { children: markdownToBlocks(colBody) },
      });
    }
    if (columns.length === 0) return null;
    return [{ type: "column_list", column_list: { children: columns } }];
  }

  // Standalone <page id="..">Title</page> at block level → link_to_page
  const pageLink = trimmed.match(/^<page\s+id="([^"]+)"\s*>([\s\S]*?)<\/page>\s*$/i);
  if (pageLink) {
    return [
      {
        type: "link_to_page",
        link_to_page: { type: "page_id", page_id: pageLink[1]! },
      },
    ];
  }

  const dbLink = trimmed.match(/^<database\s+id="([^"]+)"\s*>([\s\S]*?)<\/database>\s*$/i);
  if (dbLink) {
    return [
      {
        type: "link_to_page",
        link_to_page: { type: "database_id", database_id: dbLink[1]! },
      },
    ];
  }

  // <bookmark url="…">caption</bookmark> / <embed …> / <video …> / <pdf …> / <file …>
  const mediaMatch = trimmed.match(/^<(bookmark|embed|video|pdf|file|audio)\s+url="([^"]+)"\s*>([\s\S]*?)<\/\1>\s*$/i);
  if (mediaMatch) {
    const [, kind, url, captionMd] = mediaMatch;
    const captionTokens = captionMd
      ? mdLexer.lexer(captionMd).flatMap((t) => ((t as Tokens.Paragraph).tokens ?? []))
      : [];
    const caption = toRichText(captionTokens);
    if (kind === "bookmark" || kind === "embed") {
      return [{ type: kind, [kind]: { url, caption } }];
    }
    // file-backed media uses {external: {url}, caption}
    return [
      {
        type: kind!,
        [kind!]: { external: { url }, caption },
      },
    ];
  }

  return null;
}

function tryStandaloneImage(p: Tokens.Paragraph): BlockRequest | null {
  // Paragraph contains exactly one image token (no meaningful text around it).
  const nonSpace = (p.tokens ?? []).filter((t) => !(t.type === "text" && (t as Tokens.Text).text.trim() === ""));
  if (nonSpace.length !== 1 || nonSpace[0]!.type !== "image") return null;
  const img = nonSpace[0] as Tokens.Image;
  const captionTokens = img.tokens ?? [];
  const caption = toRichText(captionTokens);
  return {
    type: "image",
    image: { type: "external", external: { url: img.href }, caption },
  };
}

function tryStandaloneLink(p: Tokens.Paragraph): BlockRequest | null {
  const blocks = tryHtmlBlock(p.raw.trim());
  if (blocks && blocks.length > 0 && blocks[0]!.type === "link_to_page") return blocks[0]!;
  return null;
}

// -----------------------------------------------------------------------------
// Rich text shim
// -----------------------------------------------------------------------------

function toRichText(tokens: Token[] | undefined): RichTextRun[] {
  return tokensToRichText(tokens);
}
