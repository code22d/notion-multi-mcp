// -----------------------------------------------------------------------------
// Notion block tree → Markdown
//
// Walks a (hydrated) tree of Notion BlockObjectResponse values and emits
// Notion-flavored Markdown matching the conventions used by the native Notion
// MCP. Callers are responsible for hydrating nested children onto a `children`
// field before passing the blocks in — this module never makes API calls.
//
// Output:
//   - Standard CommonMark for paragraph/heading/list/quote/code/divider/table
//   - GFM task lists for to_do blocks
//   - GFM-style blockquote `> [!NOTE]` alerts for callouts
//   - HTML <details>/<summary> for toggles
//   - <page id="…">/<database id="…">/<user id="…">/<date>…</date> for mentions
//   - $…$ inline and $$…$$ block for equations
//   - <column-list>/<column> for multi-column layouts
//   - <!-- notion:<type> --> placeholders for unsupported/nice-to-have blocks
//     so that from-blocks → to-blocks never drops content silently
// -----------------------------------------------------------------------------

import type { NotionBlockObject, NotionRichText } from "../client";
import { richTextToMarkdown, richTextToPlain } from "./rich-text";

/**
 * A hydrated block — the normal response shape plus an optional `children`
 * array of the same (recursive). The create-pages handler and the round-trip
 * tests build this shape directly; the duplicate-page flow (future) would walk
 * the Notion API to populate it.
 */
export interface HydratedBlock extends NotionBlockObject {
  children?: HydratedBlock[];
}

interface Ctx {
  /** Current indentation (two-spaces per level). */
  indent: string;
  /** Tracks numbered-list index per indentation-level, keyed by depth. */
  listCounters: Map<string, number>;
}

export interface FromBlocksOptions {
  /** Initial indent (internal — for recursion). */
  indent?: string;
}

/** Top-level: converts a list of sibling blocks to Markdown. */
export function blocksToMarkdown(blocks: HydratedBlock[] | undefined, opts: FromBlocksOptions = {}): string {
  if (!blocks || blocks.length === 0) return "";
  const ctx: Ctx = { indent: opts.indent ?? "", listCounters: new Map() };
  return renderSiblings(blocks, ctx);
}

function renderSiblings(blocks: HydratedBlock[], ctx: Ctx): string {
  const parts: string[] = [];
  let prevType: string | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    // Reset numbered list counters when a non-list block intervenes.
    if (b.type !== "numbered_list_item" && prevType === "numbered_list_item") {
      ctx.listCounters.delete(ctx.indent);
    }
    const rendered = renderBlock(b, ctx);
    if (rendered !== null) parts.push(rendered);
    prevType = b.type;
  }
  // Reset counters left from the last run.
  ctx.listCounters.delete(ctx.indent);
  return parts.join("\n\n");
}

function renderBlock(block: HydratedBlock, ctx: Ctx): string | null {
  const type = block.type;
  const content = (block as unknown as Record<string, unknown>)[type] as Record<string, unknown> | undefined;

  switch (type) {
    case "paragraph":
      return renderTextBlock(content, ctx, "");
    case "heading_1":
      return renderHeading(content, ctx, "# ");
    case "heading_2":
      return renderHeading(content, ctx, "## ");
    case "heading_3":
      return renderHeading(content, ctx, "### ");
    case "heading_4":
      // Markdown doesn't have a direct fourth-level (heading_4 is rendered as #### by convention).
      return renderHeading(content, ctx, "#### ");
    case "bulleted_list_item":
      return renderListItem(block, ctx, "- ");
    case "numbered_list_item": {
      const n = (ctx.listCounters.get(ctx.indent) ?? 0) + 1;
      ctx.listCounters.set(ctx.indent, n);
      return renderListItem(block, ctx, `${n}. `);
    }
    case "to_do": {
      const checked = (content?.checked as boolean | undefined) ?? false;
      return renderListItem(block, ctx, checked ? "- [x] " : "- [ ] ");
    }
    case "toggle":
      return renderToggle(block, ctx);
    case "quote":
      return renderQuote(block, ctx);
    case "divider":
      return `${ctx.indent}---`;
    case "code":
      return renderCode(content, ctx);
    case "callout":
      return renderCallout(block, ctx);
    case "equation": {
      const expr = (content?.expression as string | undefined) ?? "";
      return `${ctx.indent}$$${expr}$$`;
    }
    case "image":
      return renderImage(content, ctx);
    case "video":
    case "pdf":
    case "file":
    case "audio":
      return renderMedia(type, content, ctx);
    case "bookmark":
    case "embed": {
      const url = (content?.url as string | undefined) ?? "";
      const caption = richTextToMarkdown((content?.caption as NotionRichText[] | undefined) ?? []);
      return `${ctx.indent}<${type} url="${url}">${caption}</${type}>`;
    }
    case "link_preview": {
      const url = (content?.url as string | undefined) ?? "";
      return `${ctx.indent}[link preview: ${url}](${url})`;
    }
    case "link_to_page":
      return renderLinkToPage(content, ctx);
    case "table":
      return renderTable(block, ctx);
    case "table_row":
      // Should only appear inside `table`; render defensively.
      return renderTableRow(content, ctx);
    case "column_list":
      return renderColumnList(block, ctx);
    case "column": {
      const rendered = renderChildren(block, ctx);
      return `${ctx.indent}<column>\n${rendered}\n${ctx.indent}</column>`;
    }
    case "child_page": {
      const title = (content?.title as string | undefined) ?? "";
      return `${ctx.indent}<page id="${block.id}">${title}</page>`;
    }
    case "child_database": {
      const title = (content?.title as string | undefined) ?? "";
      return `${ctx.indent}<database id="${block.id}">${title}</database>`;
    }
    case "synced_block":
      return renderSyncedBlock(block, ctx);
    case "breadcrumb":
      return `${ctx.indent}<!-- notion:breadcrumb -->`;
    case "table_of_contents":
      return `${ctx.indent}<!-- notion:table_of_contents -->`;
    case "template":
      return `${ctx.indent}<!-- notion:template: ${richTextToPlain(
        (content?.rich_text as NotionRichText[] | undefined) ?? []
      )} -->`;
    case "tab":
      return `${ctx.indent}<!-- notion:tab -->`;
    case "meeting_notes":
    case "transcription":
      return `${ctx.indent}<!-- notion:${type} -->`;
    case "unsupported":
      return `${ctx.indent}<!-- notion:unsupported -->`;
    default:
      return `${ctx.indent}<!-- notion:${type} -->`;
  }
}

// -----------------------------------------------------------------------------
// Specific renderers
// -----------------------------------------------------------------------------

function renderTextBlock(content: Record<string, unknown> | undefined, ctx: Ctx, prefix: string): string {
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const md = richTextToMarkdown(rt);
  // Paragraphs shouldn't have children in Notion (rare edge case — render them
  // as an indented sub-block after the paragraph text).
  return `${ctx.indent}${prefix}${md}`;
}

function renderHeading(content: Record<string, unknown> | undefined, ctx: Ctx, prefix: string): string {
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  return `${ctx.indent}${prefix}${richTextToMarkdown(rt)}`;
}

function renderListItem(block: HydratedBlock, ctx: Ctx, prefix: string): string {
  const content = (block as unknown as Record<string, unknown>)[block.type] as Record<string, unknown> | undefined;
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const text = richTextToMarkdown(rt);
  const head = `${ctx.indent}${prefix}${text}`;
  if (block.children && block.children.length > 0) {
    const childCtx: Ctx = { indent: ctx.indent + "  ", listCounters: new Map() };
    const rendered = renderSiblings(block.children, childCtx);
    return `${head}\n${rendered}`;
  }
  return head;
}

function renderToggle(block: HydratedBlock, ctx: Ctx): string {
  const content = (block as unknown as Record<string, unknown>).toggle as Record<string, unknown> | undefined;
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const summary = richTextToMarkdown(rt);
  const inner = renderChildren(block, ctx);
  return `${ctx.indent}<details>\n${ctx.indent}<summary>${summary}</summary>\n${inner}\n${ctx.indent}</details>`;
}

function renderQuote(block: HydratedBlock, ctx: Ctx): string {
  const content = (block as unknown as Record<string, unknown>).quote as Record<string, unknown> | undefined;
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const body = richTextToMarkdown(rt);
  const lines = body.split("\n").map((l) => `${ctx.indent}> ${l}`);
  if (block.children && block.children.length > 0) {
    const childCtx: Ctx = { indent: ctx.indent, listCounters: new Map() };
    const inner = renderSiblings(block.children, childCtx);
    const innerLines = inner.split("\n").map((l) => `${ctx.indent}> ${l}`);
    lines.push(`${ctx.indent}>`, ...innerLines);
  }
  return lines.join("\n");
}

function renderCode(content: Record<string, unknown> | undefined, ctx: Ctx): string {
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const lang = (content?.language as string | undefined) ?? "";
  const caption = richTextToMarkdown((content?.caption as NotionRichText[] | undefined) ?? []);
  const normalized = normalizeCodeLanguage(lang);
  const body = richTextToPlain(rt);
  const lines = body.split("\n").map((l) => `${ctx.indent}${l}`);
  const fence = `${ctx.indent}\`\`\`${normalized}`;
  const end = `${ctx.indent}\`\`\``;
  if (caption) {
    return [fence, ...lines, end, `${ctx.indent}<caption>${caption}</caption>`].join("\n");
  }
  return [fence, ...lines, end].join("\n");
}

function renderCallout(block: HydratedBlock, ctx: Ctx): string {
  const content = (block as unknown as Record<string, unknown>).callout as Record<string, unknown> | undefined;
  const rt = (content?.rich_text as NotionRichText[] | undefined) ?? [];
  const icon = content?.icon as { type?: string; emoji?: string } | undefined;
  const emoji = icon?.type === "emoji" ? icon.emoji : undefined;
  const firstLine = `${ctx.indent}> [!NOTE]${emoji ? ` ${emoji}` : ""}`;
  const body = richTextToMarkdown(rt);
  const bodyLines = body.split("\n").map((l) => `${ctx.indent}> ${l}`);
  const result = [firstLine, ...bodyLines];
  if (block.children && block.children.length > 0) {
    const childCtx: Ctx = { indent: ctx.indent, listCounters: new Map() };
    const inner = renderSiblings(block.children, childCtx);
    const innerLines = inner.split("\n").map((l) => `${ctx.indent}> ${l}`);
    result.push(`${ctx.indent}>`, ...innerLines);
  }
  return result.join("\n");
}

function renderImage(content: Record<string, unknown> | undefined, ctx: Ctx): string {
  const url = extractMediaUrl(content);
  const caption = richTextToMarkdown((content?.caption as NotionRichText[] | undefined) ?? []);
  return `${ctx.indent}![${caption}](${url})`;
}

function renderMedia(type: string, content: Record<string, unknown> | undefined, ctx: Ctx): string {
  const url = extractMediaUrl(content);
  const caption = richTextToMarkdown((content?.caption as NotionRichText[] | undefined) ?? []);
  return `${ctx.indent}<${type} url="${url}">${caption}</${type}>`;
}

function extractMediaUrl(content: Record<string, unknown> | undefined): string {
  if (!content) return "";
  const kind = content.type as string | undefined;
  if (kind === "external" && content.external && typeof content.external === "object") {
    return (content.external as { url: string }).url;
  }
  if (kind === "file" && content.file && typeof content.file === "object") {
    return (content.file as { url: string }).url;
  }
  if (kind === "file_upload" && content.file_upload && typeof content.file_upload === "object") {
    return `file_upload://${(content.file_upload as { id: string }).id}`;
  }
  return "";
}

function renderLinkToPage(content: Record<string, unknown> | undefined, ctx: Ctx): string {
  if (!content) return "";
  const kind = content.type as string | undefined;
  if (kind === "page_id") {
    return `${ctx.indent}<page id="${content.page_id as string}"></page>`;
  }
  if (kind === "database_id") {
    return `${ctx.indent}<database id="${content.database_id as string}"></database>`;
  }
  if (kind === "comment_id") {
    return `${ctx.indent}<!-- notion:link_to_comment: ${content.comment_id as string} -->`;
  }
  return `${ctx.indent}<!-- notion:link_to_page -->`;
}

function renderTable(block: HydratedBlock, ctx: Ctx): string {
  const content = (block as unknown as Record<string, unknown>).table as Record<string, unknown> | undefined;
  const hasHeader = (content?.has_column_header as boolean | undefined) ?? false;
  const rows = (block.children ?? []).filter((c) => c.type === "table_row");
  if (rows.length === 0) return `${ctx.indent}<!-- notion:table (empty) -->`;
  const cellMatrix = rows.map((r) => {
    const row = (r as unknown as Record<string, unknown>).table_row as Record<string, unknown> | undefined;
    return ((row?.cells as NotionRichText[][] | undefined) ?? []).map((cell) => richTextToMarkdown(cell));
  });
  const width = Math.max(...cellMatrix.map((r) => r.length));
  const out: string[] = [];
  const pad = (r: string[]) => {
    while (r.length < width) r.push("");
    return r;
  };
  const headerCells = hasHeader ? pad(cellMatrix[0] ?? []) : Array(width).fill(" ");
  out.push(`${ctx.indent}| ${headerCells.map(cellEscape).join(" | ")} |`);
  out.push(`${ctx.indent}| ${Array(width).fill("---").join(" | ")} |`);
  for (let i = hasHeader ? 1 : 0; i < cellMatrix.length; i++) {
    out.push(`${ctx.indent}| ${pad(cellMatrix[i] ?? []).map(cellEscape).join(" | ")} |`);
  }
  return out.join("\n");
}

function renderTableRow(content: Record<string, unknown> | undefined, ctx: Ctx): string {
  const cells = ((content?.cells as NotionRichText[][] | undefined) ?? []).map((c) => richTextToMarkdown(c));
  return `${ctx.indent}| ${cells.map(cellEscape).join(" | ")} |`;
}

function renderColumnList(block: HydratedBlock, ctx: Ctx): string {
  const inner = renderChildren(block, { ...ctx, indent: ctx.indent + "  " });
  return `${ctx.indent}<column-list>\n${inner}\n${ctx.indent}</column-list>`;
}

function renderSyncedBlock(block: HydratedBlock, ctx: Ctx): string {
  const content = (block as unknown as Record<string, unknown>).synced_block as Record<string, unknown> | undefined;
  const syncedFrom = content?.synced_from as { block_id?: string } | null | undefined;
  if (syncedFrom && syncedFrom.block_id) {
    return `${ctx.indent}<!-- notion:synced_block from=${syncedFrom.block_id} -->`;
  }
  // Original synced block — render children inline with a marker for round-trips.
  const inner = renderChildren(block, ctx);
  return `${ctx.indent}<!-- notion:synced_block (source) -->\n${inner}`;
}

function renderChildren(block: HydratedBlock, ctx: Ctx): string {
  if (!block.children || block.children.length === 0) return "";
  const childCtx: Ctx = { indent: ctx.indent + "  ", listCounters: new Map() };
  return renderSiblings(block.children, childCtx);
}

function cellEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Normalise Notion's code languages to common Markdown tags. Notion uses
 * labels like "plain text" that GFM tolerates but some renderers don't.
 */
function normalizeCodeLanguage(lang: string): string {
  const l = (lang ?? "").toLowerCase().trim();
  if (!l) return "";
  if (l === "plain text") return "";
  if (l === "shell") return "bash";
  return l.replace(/\s+/g, "-");
}
