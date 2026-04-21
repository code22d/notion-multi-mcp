// -----------------------------------------------------------------------------
// Preservation check — when replace_content or update_content is about to
// delete the existing page contents, we must verify that any child_page or
// child_database blocks currently on the page are intentionally dropped.
//
// Matches native MCP behavior: before wiping content, scan the new markdown
// for `<page id="…">` / `<page url="…">` / `<database id="…">` / `<database url="…">`
// references. Any existing child_page/child_database id NOT present in the new
// markdown is a "would be deleted" item and the operation fails unless the
// caller passed `allow_deleting_content: true`.
// -----------------------------------------------------------------------------

import type { HydratedBlock } from "../../notion/markdown/from-blocks";
import { flattenHydrated, isChildPageOrDb, normalizeId } from "./shared";

export interface PreservationResult {
  /** Child pages/databases that would be deleted because they aren't referenced in the new content. */
  missing: Array<{ id: string; type: "child_page" | "child_database"; title: string }>;
}

/**
 * @param existing Hydrated tree of the page's CURRENT blocks.
 * @param newMarkdown The proposed new content as Notion-flavored Markdown.
 */
export function checkPreservation(
  existing: HydratedBlock[],
  newMarkdown: string
): PreservationResult {
  const children = flattenHydrated(existing).filter(isChildPageOrDb);
  if (children.length === 0) return { missing: [] };

  const preservedIds = extractPreservedIds(newMarkdown);
  const missing: PreservationResult["missing"] = [];
  for (const c of children) {
    const normId = normalizeId(c.id);
    if (preservedIds.has(normId)) continue;
    const content = (c as unknown as Record<string, unknown>)[c.type] as
      | { title?: string }
      | undefined;
    missing.push({
      id: c.id,
      type: c.type as "child_page" | "child_database",
      title: content?.title ?? "(untitled)",
    });
  }
  return { missing };
}

/**
 * Pull out every Notion id referenced by `<page>` / `<database>` tags in the
 * given markdown, via either `id="…"` or `url="…"` attributes. Ids are
 * normalised (dashes stripped, lowercased) so they compare cleanly against
 * ids returned by the Notion API.
 */
export function extractPreservedIds(markdown: string): Set<string> {
  const out = new Set<string>();
  // id="..." form — what our from-blocks emits (<page id="abc">...</page>).
  const idRe = /<(page|database)\s+id="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = idRe.exec(markdown))) {
    out.add(normalizeId(m[2]!));
  }
  // url="..." form — what native MCP emits and recommends for preservation.
  const urlRe = /<(page|database)\s+url="([^"]+)"/gi;
  while ((m = urlRe.exec(markdown))) {
    const id = extractIdFromNotionUrl(m[2]!);
    if (id) out.add(id);
  }
  // Also catch inline mentions: [title](notion.so/…) style links with embedded
  // uuids, which native sometimes emits. Best-effort.
  const uuidRe = /([a-f0-9]{32})|([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
  // Only scan inside URL-looking substrings to avoid false positives from code blocks.
  const urlLikeRe = /https?:\/\/[^\s)"'>]+/gi;
  let u: RegExpExecArray | null;
  while ((u = urlLikeRe.exec(markdown))) {
    const url = u[0];
    let id: RegExpExecArray | null;
    while ((id = uuidRe.exec(url))) {
      const raw = id[1] ?? id[2] ?? "";
      if (raw) out.add(normalizeId(raw));
    }
    uuidRe.lastIndex = 0;
  }
  return out;
}

function extractIdFromNotionUrl(url: string): string | null {
  // Notion URLs end in either a 32-hex id or a hyphenated uuid.
  const m32 = url.match(/([a-f0-9]{32})(?:[?#]|$)/i);
  if (m32) return normalizeId(m32[1]!);
  const muuid = url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (muuid) return normalizeId(muuid[1]!);
  return null;
}
