// -----------------------------------------------------------------------------
// Shared helpers for notion_update_page's command handlers.
// -----------------------------------------------------------------------------

import type { ToolResult } from "../../mcp/types";
import { NATIVE_ICON_COLORS, type NotionBlockObject, type NotionClient } from "../../notion/client";
import type { HydratedBlock } from "../../notion/markdown/from-blocks";
import type { BlockRequest } from "../../notion/markdown/to-blocks";

export const CHILDREN_PER_REQUEST = 100;

export function textOk(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * Recursively walk the block tree under `parentId` and return it as a hydrated
 * tree (response-shape blocks with `children` populated).
 *
 * Used by replace_content, update_content, and apply_template. Kept separate
 * from `NotionClient` because the client is a thin API wrapper — this is the
 * "fetch everything" escalation we deliberately avoid in the shared client.
 */
export async function hydrateChildren(
  client: NotionClient,
  parentId: string
): Promise<HydratedBlock[]> {
  const direct = await client.listAllBlockChildren(parentId);
  const out: HydratedBlock[] = [];
  for (const child of direct) {
    const h: HydratedBlock = { ...child } as HydratedBlock;
    if (child.has_children) {
      h.children = await hydrateChildren(client, child.id);
    }
    out.push(h);
  }
  return out;
}

/**
 * Walk a hydrated tree and yield every block (including nested children).
 * Used for preservation-check scans that need to find child_page/child_database
 * blocks at any depth.
 */
export function flattenHydrated(blocks: HydratedBlock[]): HydratedBlock[] {
  const out: HydratedBlock[] = [];
  const visit = (b: HydratedBlock) => {
    out.push(b);
    if (b.children) for (const c of b.children) visit(c);
  };
  for (const b of blocks) visit(b);
  return out;
}

/**
 * Normalise a Notion UUID — strip dashes, lowercase. Lets us compare ids
 * extracted from URLs against ids returned by the API (which include dashes).
 */
export function normalizeId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/**
 * Strip response-only null fields from a block's type-body object in place.
 *
 * Notion's GET responses include fields like `icon: null`, `color: null`,
 * `caption: null` on most block bodies, but the POST/PATCH schema rejects
 * `null` for those fields — they must be an object or absent. Calling this on
 * a type body (e.g. `block.paragraph`, `block.callout`) removes any top-level
 * key whose value is `null`, with one exception: `synced_from: null` is a
 * meaningful signal for a synced_block ORIGINAL (vs a reference), so we keep
 * it when `type === "synced_block"`.
 *
 * Shared between apply_template's `cloneBlockForRequest` and
 * duplicate_page's `sanitizeTypeBody` so the two paths can't drift when Notion
 * adds new response-only nullable fields.
 */
export function stripResponseOnlyNulls(body: Record<string, unknown>, type: string): void {
  for (const key of Object.keys(body)) {
    if (body[key] === null) {
      if (type === "synced_block" && key === "synced_from") continue;
      delete body[key];
    }
  }
}

/**
 * Convert a hydrated response-shape block into a request-shape BlockRequest,
 * stripping fields the create/append endpoints reject (id, timestamps, parent,
 * etc.). Children are cloned recursively.
 *
 * Returns null for block types that cannot be re-created via the API — most
 * notably `child_page` and `child_database`, which reference workspace entities
 * rather than carrying reproducible content. The caller skips nulls.
 */
export function cloneBlockForRequest(block: HydratedBlock): BlockRequest | null {
  const type = block.type;
  if (!type) return null;
  // Structural refs to other workspace entities — can't be "applied" to a new
  // page; would create a dangling reference or a circular copy.
  if (type === "child_page" || type === "child_database") return null;
  // Unsupported blocks carry no reconstructable payload.
  if (type === "unsupported") return null;

  const payload = (block as unknown as Record<string, unknown>)[type];
  if (!payload || typeof payload !== "object") return null;

  // Strip runtime-only fields from nested block objects (table_row's `cells`
  // stays; everything else we keep). Deep-clone via JSON to avoid aliasing.
  const clonedPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  // Notion's GET response includes fields like `icon: null` / `color: null` on
  // most block bodies, but its POST/PATCH schema rejects `null` for those —
  // strip response-only nulls before we send the request.
  stripResponseOnlyNulls(clonedPayload, type);
  // `children` inside the payload (e.g. column_list.column_list.children) —
  // we'll rebuild from the hydrated block.children, but certain types carry
  // an inline children array (table → rows). Leave those alone.
  const request: BlockRequest = {
    type,
    [type]: clonedPayload,
  };

  // Attach recursively-cloned children for container types (toggle, callout,
  // quote, bulleted/numbered/to_do list items, column_list, column, synced_block).
  if (block.children && block.children.length > 0) {
    const childRequests: BlockRequest[] = [];
    for (const c of block.children) {
      const cloned = cloneBlockForRequest(c);
      if (cloned) childRequests.push(cloned);
    }
    if (childRequests.length > 0) {
      // Notion expects `children` under the type-payload for most containers.
      // For table, children are table_row objects under the payload. Our
      // from-blocks output keeps table rows under block.children too, so the
      // same shape works.
      (clonedPayload as Record<string, unknown>).children = childRequests;
    }
  }

  return request;
}

/**
 * Append a list of BlockRequests under `parentId` in 100-item chunks
 * (Notion's per-call cap).
 */
export async function appendInChunks(
  client: NotionClient,
  parentId: string,
  blocks: BlockRequest[]
): Promise<void> {
  for (let i = 0; i < blocks.length; i += CHILDREN_PER_REQUEST) {
    const slice = blocks.slice(i, i + CHILDREN_PER_REQUEST);
    await client.appendBlockChildren(parentId, { children: slice });
  }
}

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

/** URL / "none" → Notion cover object or null (for removal). */
export function normalizeCoverInput(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  if (raw === "" || raw.toLowerCase() === "none") return null;
  if (/^https?:\/\//i.test(raw)) {
    return { type: "external", external: { url: raw } };
  }
  return undefined;
}

/** Helper: is this block a page/database reference to another workspace entity? */
export function isChildPageOrDb(b: NotionBlockObject | HydratedBlock): boolean {
  return b.type === "child_page" || b.type === "child_database";
}
