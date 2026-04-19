// -----------------------------------------------------------------------------
// Rich text helpers — used by both directions of the markdown converter and
// by any tool that needs to extract/emit plain text from Notion rich text.
// -----------------------------------------------------------------------------

import type { NotionRichText } from "../client";

/** Concatenates all `plain_text` entries in a rich-text array. */
export function richTextToPlain(rt: NotionRichText[] | undefined | null): string {
  if (!rt || rt.length === 0) return "";
  return rt.map((r) => r.plain_text ?? "").join("");
}

/** Converts a rich-text array to Markdown (preserves bold/italic/links/code/etc.) */
export function richTextToMarkdown(rt: NotionRichText[] | undefined | null): string {
  if (!rt || rt.length === 0) return "";
  return rt.map(oneToMarkdown).join("");
}

function oneToMarkdown(r: NotionRichText): string {
  // Equations render as $expr$ — inline LaTeX.
  if (r.type === "equation" && r.equation?.expression) {
    return `$${r.equation.expression}$`;
  }

  // Mentions: render as a tagged span so from-blocks → to-blocks can round-trip them.
  if (r.type === "mention" && r.mention) {
    const m = r.mention as Record<string, unknown>;
    const mentionType = (m.type ?? "") as string;
    const label = r.plain_text ?? "";
    if (mentionType === "page" && m.page && typeof m.page === "object") {
      const pageId = (m.page as { id?: string }).id ?? "";
      return `<page id="${pageId}">${escapeMdInline(label)}</page>`;
    }
    if (mentionType === "database" && m.database && typeof m.database === "object") {
      const dbId = (m.database as { id?: string }).id ?? "";
      return `<database id="${dbId}">${escapeMdInline(label)}</database>`;
    }
    if (mentionType === "user" && m.user && typeof m.user === "object") {
      const userId = (m.user as { id?: string }).id ?? "";
      return `<user id="${userId}">${escapeMdInline(label)}</user>`;
    }
    if (mentionType === "date" && m.date && typeof m.date === "object") {
      const d = m.date as { start?: string; end?: string | null };
      const val = d.end ? `${d.start} → ${d.end}` : (d.start ?? "");
      return `<date>${val}</date>`;
    }
    // Fallback: plain text.
    return label;
  }

  let text = r.plain_text ?? "";
  const ann = r.annotations ?? {};
  if (ann.code) text = "`" + text + "`";
  if (ann.bold) text = "**" + text + "**";
  if (ann.italic) text = "*" + text + "*";
  if (ann.strikethrough) text = "~~" + text + "~~";
  if (ann.underline) text = "<u>" + text + "</u>";
  if (r.type === "text" && r.text?.link?.url) {
    text = `[${text}](${r.text.link.url})`;
  } else if (r.href && r.href !== "#") {
    text = `[${text}](${r.href})`;
  }
  return text;
}

function escapeMdInline(s: string): string {
  // Only escape the few chars that actually break our output.
  return s.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

/** Wraps a plain string into a single-element rich-text array (for writes to Notion). */
export function plainToRichText(s: string): NotionRichText[] {
  if (s === "") return [];
  return [
    {
      type: "text",
      text: { content: s },
      plain_text: s,
    },
  ];
}
