// -----------------------------------------------------------------------------
// Shared helpers for notion_update_page's command handlers.
// -----------------------------------------------------------------------------

import type { ToolResult } from "../../mcp/types";
import type { NotionBlockObject, NotionClient } from "../../notion/client";
import type { ClonePolicy } from "../../notion/block-clone";
import { cloneBlockTree } from "../../notion/block-clone";
import type { HydratedBlock } from "../../notion/markdown/from-blocks";
import type { BlockRequest } from "../../notion/markdown/to-blocks";

import { requiresChildren } from "../../notion/block-write-schema";

// The clone/append machinery lives in src/notion/block-clone.ts so duplicate_page
// and apply_template run the exact same code — the drift between two copies of
// it is what produced the null-icon bug and then the tab.children bug. Re-exported
// here so every existing import path keeps working.
export {
  CHILDREN_PER_REQUEST,
  appendInChunks,
  stripResponseOnlyNulls,
} from "../../notion/block-clone";

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
    if (shouldDescendInto(child)) {
      h.children = await hydrateChildren(client, child.id);
    }
    out.push(h);
  }
  return out;
}

/**
 * `has_children` is the normal signal, but for a container whose write schema
 * makes `children` REQUIRED we look anyway. Getting this wrong for those types
 * is not a cosmetic loss — it produces a request body Notion rejects outright,
 * naming a field the user never supplied. One extra (empty) list call for a
 * genuinely empty table/tab is a cheap price for not depending on a flag whose
 * behaviour we cannot verify from here.
 */
export function shouldDescendInto(block: NotionBlockObject | HydratedBlock): boolean {
  if (block.has_children) return true;
  return typeof block.type === "string" && requiresChildren(block.type);
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
 * apply_template's clone policy: a block with no write shape is dropped, and
 * a synced_block reference keeps pointing at the same original (the template
 * and the target live in one workspace, so mirroring is meaningful there).
 */
export const TEMPLATE_CLONE_POLICY: ClonePolicy = {
  substitute: () => null,
  syncedReference: "keep-link",
};

/**
 * Convert a hydrated response-shape block into a request-shape BlockRequest.
 *
 * Returns null for block types that cannot be re-created via the API — most
 * notably `child_page` and `child_database`, which reference workspace entities
 * rather than carrying reproducible content. The caller skips nulls.
 *
 * This is the SHALLOW view of the clone: it hands back the request body and
 * discards the record of anything that had to be appended separately. Callers
 * that actually send the result want `cloneBlockTree` + `appendClonedTree`
 * instead, or deep templates lose the subtrees Notion's request schema won't
 * carry inline. Kept for callers (and tests) that only care about the shape of
 * one block.
 */
export function cloneBlockForRequest(block: HydratedBlock): BlockRequest | null {
  const [cloned] = cloneBlockTree([block], TEMPLATE_CLONE_POLICY);
  return cloned ? cloned.request : null;
}

// Icon helpers moved to src/notion/icons.ts so the Markdown converter can use
// them without depending on tools/. Re-exported here to keep every existing
// import path working.
export { normalizeIconInput, sanitizeIconForWrite } from "../../notion/icons";

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
