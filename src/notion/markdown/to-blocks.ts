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
import { normalizeIconInput } from "../icons";

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
    if (part.kind === "container_block") {
      // The pre-processor only carves out the SPAN; tryHtmlBlock owns the
      // parsing, so there is exactly one implementation of each container
      // syntax rather than one here and a second one for the tokens marked
      // hands back.
      const blocks = tryHtmlBlock(part.raw);
      if (blocks) {
        out.push(...blocks);
        continue;
      }
      // A balanced span we could not parse (e.g. <details> with no <summary>).
      // Lex it directly rather than recursing through splitSpecialBlocks —
      // that would re-extract the same span forever — so it degrades to the
      // literal-text paragraph it produced before this pass existed.
      for (const tok of mdLexer.lexer(part.raw) as TokensList) {
        out.push(...tokenToBlocks(tok));
      }
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
// Pre-processing: extract block equations `$$ … $$` and the HTML-ish container
// blocks (<details>, <tabs>, <column-list>) out-of-band before lex. All are
// multi-line constructs that marked's default paragraph rule tends to split
// across multiple tokens, so grabbing them in one pass up-front gives us a
// single contiguous string for each.
//
// WHY THIS PASS IS TAG-BALANCED AND NOT A REGEX
//
// Every one of these containers used to be found with a non-greedy
// `([\s\S]*?)</tag>` regex. Non-greedy means "stop at the FIRST closer", which
// is precisely wrong for a construct that nests: given five nested <details>,
// the outer one closed at the innermost `</details>`, the four inner openers
// were swallowed as literal text inside the toggle, and the four surplus
// `</details>` closers leaked out as a visible paragraph. Same shape for
// <tabs>/<tab> and <column-list>/<column>. That is silent mangling of valid
// input, so the scan counts depth instead — see findMatchingClose().
//
// The pass also stops at the OUTERMOST container rather than descending. A
// <details> inside a <tab> used to be ripped out from under it here, leaving
// the surrounding <tabs>/<tab> tags stranded as text. Now the whole <tabs> span
// leaves as one segment and its bodies are parsed by recursion, so a container
// is only ever interpreted by the parser that owns its context.
// -----------------------------------------------------------------------------

type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "equation_block"; expression: string }
  /** A balanced <details>/<tabs>/<column-list> span, verbatim. */
  | { kind: "container_block"; raw: string };

/** Block-level containers the pre-processor carves out whole. */
const CONTAINER_TAGS = ["details", "tabs", "column-list"] as const;

function splitSpecialBlocks(source: string): Segment[] {
  // First pass — extract container spans. These can straddle blank lines,
  // which marked would otherwise tokenise as separate paragraphs.
  const afterContainers = splitOnContainers(source);
  // Second pass — within each `markdown`-kind segment, extract $$…$$ blocks.
  const segments: Segment[] = [];
  for (const seg of afterContainers) {
    if (seg.kind !== "markdown") {
      segments.push(seg);
      continue;
    }
    segments.push(...splitOnEquations(seg.text));
  }
  if (segments.length === 0) segments.push({ kind: "markdown", text: source });
  return segments;
}

/**
 * Index of the `</tag>` that balances an opener whose body starts at `from`.
 *
 * Depth starts at 1 — the caller has already consumed the opening tag — and
 * every further `<tag …>` raises it, so nested containers close in the right
 * order. Returns null when the source never balances, which the callers treat
 * as "this isn't a container after all" rather than guessing.
 *
 * The tag patterns are deliberately exact about word boundaries: `<tab>` must
 * not match `<tabs>` and `<column>` must not match `<column-list>`, or a nested
 * <tabs> inside a <tab> would miscount depth in both directions.
 */
function findMatchingClose(
  source: string,
  tag: string,
  from: number
): { innerEnd: number; end: number } | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}\\s*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    if (m[0]!.startsWith("</")) {
      depth--;
      if (depth === 0) return { innerEnd: m.index, end: m.index + m[0]!.length };
    } else {
      depth++;
    }
  }
  return null;
}

function splitOnContainers(source: string): Segment[] {
  // An opener has to start its own line (leading whitespace allowed), which is
  // the rule the old <details> pass used — an inline <details> in running prose
  // stays prose.
  const openRe = new RegExp(`(^|\\n)([ \\t]*)<(${CONTAINER_TAGS.join("|")})(?:\\s[^>]*)?>`, "gi");
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source))) {
    const tag = m[3]!.toLowerCase();
    const spanStart = m.index + m[1]!.length;
    const close = findMatchingClose(source, tag, m.index + m[0]!.length);
    // Unbalanced, or something other than whitespace follows the closer on its
    // line: not a block-level container. Leave it to marked and resume the
    // scan after the opener so a later, well-formed container still lands.
    if (!close || !/^[ \t]*(\n|$)/.test(source.slice(close.end))) {
      openRe.lastIndex = m.index + m[0]!.length;
      continue;
    }
    const before = source.slice(last, spanStart);
    if (before.trim() !== "") segments.push({ kind: "markdown", text: before });
    segments.push({ kind: "container_block", raw: source.slice(spanStart, close.end) });
    last = close.end;
    openRe.lastIndex = close.end;
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

/**
 * `raw` is exactly one balanced `<tag>…</tag>` and nothing else → its inner
 * text. Returns null when the tag never closes, or when content follows the
 * closer — both mean this isn't a standalone container block and the caller
 * should fall through to whatever it tries next.
 */
function parseContainer(raw: string, tag: string, openLength: number): { inner: string } | null {
  const close = findMatchingClose(raw, tag, openLength);
  if (!close) return null;
  if (raw.slice(close.end).trim() !== "") return null;
  return { inner: raw.slice(openLength, close.innerEnd) };
}

/**
 * Walk the direct `<item>…</item>` children of a container body, skipping any
 * that belong to a nested container of the same family.
 *
 * Depth-balanced per item, which is the whole point: the previous
 * `<item>([\s\S]*?)</item>` scan closed each item at the first `</item>` it
 * saw, so an item containing a nested container ended early and the nested
 * container's items were promoted to siblings.
 */
function scanContainerItems(
  body: string,
  tag: string
): Array<{ attrs: string; inner: string }> {
  const openRe = new RegExp(`<${tag}(\\s[^>]*)?>`, "gi");
  const items: Array<{ attrs: string; inner: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body))) {
    const close = findMatchingClose(body, tag, m.index + m[0]!.length);
    if (!close) break;
    items.push({
      attrs: m[1] ?? "",
      inner: body.slice(m.index + m[0]!.length, close.innerEnd).trim(),
    });
    openRe.lastIndex = close.end;
  }
  return items;
}

function tryHtmlBlock(raw: string): BlockRequest[] | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<")) return null;

  // <caption>…</caption> is emitted by from-blocks for code-block captions.
  // It carries no round-trip-able content yet, so drop it silently.
  if (/^<caption>[\s\S]*?<\/caption>\s*$/i.test(trimmed)) return [];

  // <details><summary>…</summary> … </details> → toggle.
  //
  // Nesting is handled by taking the BALANCED closer and then recursing on the
  // body: a toggle inside a toggle is just markdownToBlocks() run again. The
  // old non-greedy regex stopped at the first `</details>`, which turned five
  // nested toggles into one toggle plus four lines of visible closing tags.
  const detailsOpen = /^<details(?:\s[^>]*)?>/i.exec(trimmed);
  if (detailsOpen) {
    const parsed = parseContainer(trimmed, "details", detailsOpen[0].length);
    if (parsed) {
      const summaryOpen = /^\s*<summary(?:\s[^>]*)?>/i.exec(parsed.inner);
      if (summaryOpen) {
        const summaryClose = findMatchingClose(parsed.inner, "summary", summaryOpen[0].length);
        if (summaryClose) {
          const summaryMd = parsed.inner.slice(summaryOpen[0].length, summaryClose.innerEnd);
          const bodyMd = parsed.inner.slice(summaryClose.end).trim();
          const summaryTokens = mdLexer.lexer(summaryMd).flatMap((t) => ((t as Tokens.Paragraph).tokens ?? []));
          const body: Record<string, unknown> = { rich_text: toRichText(summaryTokens) };
          if (bodyMd) body.children = markdownToBlocks(bodyMd);
          return [{ type: "toggle", toggle: body }];
        }
      }
    }
  }

  // Undo the attribute escaping tabIconAttribute() applies on the way out, so
  // an icon containing a quote or an ampersand round-trips. Order is the exact
  // reverse of the encoder's (`&` then `"`): decoding `&amp;` first would turn
  // an encoded `&amp;quot;` into `&quot;` and then into a `"` that was never
  // there.
  const decodeHtmlAttr = (s: string): string =>
    s.replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  // <tabs>…</tabs> → tab block (Notion 2026-03-25).
  //
  // A tab block's direct children must all be PARAGRAPHS: the paragraph's
  // rich_text is the tab label, its optional `icon` the tab icon, and its
  // `children` the tab's content. So each <tab> here becomes one paragraph,
  // NOT a block of its own — getting that inverted produces a 400 that reads
  // like an unrelated schema error.
  const tabsOpen = /^<tabs(?:\s[^>]*)?>/i.exec(trimmed);
  if (tabsOpen) {
    const parsed = parseContainer(trimmed, "tabs", tabsOpen[0].length);
    if (parsed) {
      const tabs: BlockRequest[] = [];
      // Balanced per item, so a <tabs> nested inside a <tab> body closes its own
      // <tab>s rather than the outer one's. The item scan never sees the nested
      // <tabs>/</tabs> at all — those tags don't match the <tab> patterns — and
      // the nested item tags balance out within the outer body.
      for (const item of scanContainerItems(parsed.inner, "tab")) {
        const labelOpen = /^\s*<summary(?:\s[^>]*)?>/i.exec(item.inner);
        if (!labelOpen) continue;
        const labelClose = findMatchingClose(item.inner, "summary", labelOpen[0].length);
        if (!labelClose) continue;
        const labelMd = item.inner.slice(labelOpen[0].length, labelClose.innerEnd);
        const bodyMd = item.inner.slice(labelClose.end).trim();
        const labelTokens = mdLexer.lexer(labelMd).flatMap((t) => ((t as Tokens.Paragraph).tokens ?? []));
        const paragraph: Record<string, unknown> = { rich_text: toRichText(labelTokens) };
        const iconRaw = /\bicon="([^"]*)"/i.exec(item.attrs)?.[1];
        if (iconRaw) {
          const icon = normalizeIconInput(decodeHtmlAttr(iconRaw));
          // normalizeIconInput returns null for ""/"none"; a tab with no icon
          // should simply omit the key rather than send an explicit null.
          if (icon) paragraph.icon = icon;
        }
        if (bodyMd) paragraph.children = markdownToBlocks(bodyMd);
        tabs.push({ type: "paragraph", paragraph });
      }
      if (tabs.length === 0) return null;
      return [{ type: "tab", tab: { children: tabs } }];
    }
  }

  // <column-list>…</column-list> → column_list with nested columns
  const colListOpen = /^<column-list(?:\s[^>]*)?>/i.exec(trimmed);
  if (colListOpen) {
    const parsed = parseContainer(trimmed, "column-list", colListOpen[0].length);
    if (parsed) {
      const columns: BlockRequest[] = [];
      // Same balancing story as <tabs>: a column-list nested inside a column
      // keeps its own columns. The old non-greedy `<column>…</column>` scan
      // hoisted an inner list's columns up as siblings of the outer one's,
      // turning a 2-column layout into a 3-column one.
      for (const item of scanContainerItems(parsed.inner, "column")) {
        columns.push({
          type: "column",
          column: { children: markdownToBlocks(item.inner) },
        });
      }
      if (columns.length === 0) return null;
      return [{ type: "column_list", column_list: { children: columns } }];
    }
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
