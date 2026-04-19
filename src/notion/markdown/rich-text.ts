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
  let text = r.plain_text ?? "";
  // Escape markdown metacharacters only if we're in a plain text run.
  // For now, avoid aggressive escaping — it's noisy. Callers who need strict
  // escaping should wrap this.
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
