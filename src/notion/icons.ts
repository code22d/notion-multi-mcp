// -----------------------------------------------------------------------------
// Icon normalization — the single place that knows how Notion's icon shapes map
// to and from the strings tools and Markdown accept.
//
// Lives in the notion/ layer rather than tools/ because BOTH sides need it:
// the update-page and duplicate-page tools, and the Markdown converter (a tab
// block's paragraph carries an `icon`). Keeping it here means to-blocks.ts
// doesn't have to reach up into tools/, which would invert the dependency
// direction between the converter and the tools that use it.
//
// Re-exported from tools/update-page/shared.ts so existing imports still work.
// -----------------------------------------------------------------------------

import { NATIVE_ICON_COLORS } from "./client";

/**
 * Emoji / native icon / custom emoji / URL / "none" → Notion icon object,
 * null (remove the icon), or undefined (leave it alone).
 *
 * The three-way return is load-bearing and easy to break: `undefined` means
 * "the caller didn't ask to change the icon" and `null` means "clear it". The
 * duplicate_page null-icon bug came from conflating them, so every branch
 * below returns one deliberately.
 *
 * Accepted spellings, in match order:
 *
 *   ""  / "none"                → null (clear)
 *   ":name:"                    → custom_emoji BY NAME
 *   "custom_emoji:<id>"         → custom_emoji BY ID
 *   "icon:<name>"               → native icon (2026-03-25)
 *   "icon:<name>:<color>"       → native icon with a colour
 *   "https://…"                 → external image
 *   anything else               → literal emoji character
 *
 * On custom emoji: Notion's WRITE schema wants `{ id }`, while responses carry
 * `{ id, name, url }`. The `:name:` form is kept because it's what a human
 * types, but it is only reliable if Notion resolves names on write — use
 * `custom_emoji:<id>` (ids come from notion_list_custom_emojis) when you need
 * certainty. See the report for the open question here.
 */
export function normalizeIconInput(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  if (raw === "" || raw.toLowerCase() === "none") return null;
  // :custom_emoji_name: — Notion supports custom emojis via a separate type.
  if (/^:[A-Za-z0-9_+\-]+:$/.test(raw)) {
    return { type: "custom_emoji", custom_emoji: { name: raw.slice(1, -1) } };
  }
  // custom_emoji:<id> — the id form Notion's write schema actually documents.
  const customById = /^custom_emoji:(.+)$/i.exec(raw);
  if (customById) {
    return { type: "custom_emoji", custom_emoji: { id: customById[1]!.trim() } };
  }
  // icon:<name> or icon:<name>:<color> — native Notion icons (2026-03-25).
  // Since 2026-07-01 `name` also accepts icon-picker labels, which contain
  // spaces ("star circle"), so the name is NOT restricted to a word charset.
  const nativeIcon = /^icon:(.+)$/i.exec(raw);
  if (nativeIcon) {
    const rest = nativeIcon[1]!.trim();
    // Only treat a trailing ":word" as a colour when it IS one of Notion's
    // colours. Otherwise it belongs to the name — splitting greedily would
    // mangle any future picker label that happens to contain a colon.
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const maybeColor = rest.slice(lastColon + 1).trim().toLowerCase();
      if ((NATIVE_ICON_COLORS as readonly string[]).includes(maybeColor)) {
        return { type: "icon", icon: { name: rest.slice(0, lastColon).trim(), color: maybeColor } };
      }
    }
    return { type: "icon", icon: { name: rest } };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { type: "external", external: { url: raw } };
  }
  return { type: "emoji", emoji: raw };
}

/**
 * Strip response-only fields from an icon read off an existing object so it
 * can be sent back on a write (duplicate_page's clone path).
 *
 * Two shapes carry fields that only exist in RESPONSES:
 *   - custom_emoji: responses give `{ id, name, url }`; the write schema wants
 *     `{ id }`. Echoing `url` back risks a 400 on a stricter validator.
 *   - icon (native, 2026-03-25): responses may carry extra presentation
 *     fields; only `name` and `color` are writable.
 *
 * Everything else is passed through BYTE-IDENTICAL, including `file` icons.
 * A file icon's signed URL expires and arguably can't be re-attached — but
 * duplicate_page has always forwarded it, and this function exists to fix the
 * native-icon and custom-emoji cases, not to change behaviour that is already
 * in the field. The duplicate_page null-icon bug came from exactly this kind
 * of well-meant broadening.
 *
 * Returns undefined when there is no icon to write, so callers can keep using
 * `if (icon) body.icon = icon` and never assign a null.
 */
export function sanitizeIconForWrite(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const icon = raw as Record<string, unknown>;
  const type = typeof icon.type === "string" ? icon.type : undefined;

  if (type === "custom_emoji") {
    const ce = icon.custom_emoji as Record<string, unknown> | undefined;
    const id = ce && typeof ce.id === "string" ? ce.id : undefined;
    if (id) return { type: "custom_emoji", custom_emoji: { id } };
    // No id (shouldn't happen on a response) — fall back to the name form
    // rather than dropping the icon entirely.
    const name = ce && typeof ce.name === "string" ? ce.name : undefined;
    if (name) return { type: "custom_emoji", custom_emoji: { name } };
    return undefined;
  }

  if (type === "icon") {
    const nat = icon.icon as Record<string, unknown> | undefined;
    const name = nat && typeof nat.name === "string" ? nat.name : undefined;
    if (!name) return undefined;
    const color = nat && typeof nat.color === "string" ? nat.color : undefined;
    return { type: "icon", icon: { name, ...(color ? { color } : {}) } };
  }

  return icon;
}
