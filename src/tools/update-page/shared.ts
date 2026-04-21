// -----------------------------------------------------------------------------
// Shared helpers for notion_update_page's command handlers.
// -----------------------------------------------------------------------------

import type { ToolResult } from "../../mcp/types";
import type { NotionBlockObject, NotionClient } from "../../notion/client";
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

/** Emoji / URL / "none" → Notion icon object or null (for removal). */
export function normalizeIconInput(raw: unknown): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return undefined;
  if (raw === "" || raw.toLowerCase() === "none") return null;
  // :custom_emoji_name: — Notion supports custom emojis via a separate type.
  if (/^:[A-Za-z0-9_+\-]+:$/.test(raw)) {
    return { type: "custom_emoji", custom_emoji: { name: raw.slice(1, -1) } };
  }
  if (/^https?:\/\//i.test(raw)) {
    return { type: "external", external: { url: raw } };
  }
  return { type: "emoji", emoji: raw };
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
