// -----------------------------------------------------------------------------
// Block-level diff for notion_update_page's update_content command (Phase 5.5).
//
// Given the old hydrated page tree and the new request-shape blocks produced
// by `markdownToBlocks(finalMd)`, compute the minimal API plan that turns one
// into the other:
//
//   - fast   — single block, same type, both leaf, both childless → updateBlock
//              with the new type-payload. Block id is preserved so comments on
//              the block stay attached.
//   - medium — delete a contiguous run of old blocks + append a run of new
//              blocks at the right spot. Uses appendBlockChildren's `position`
//              (2026-03-11): `after_block` behind the last unchanged prefix
//              block, or `start` when the affected range begins at index 0.
//              Before `position` existed the second case had no expression at
//              all and had to be a full rewrite.
//   - full   — fall back to Phase 5's delete-all + append-all. Used only when
//              every block on the page changed, i.e. there is nothing left to
//              preserve, or when the insertion is too large to place in one
//              call (see MEDIUM_PATH_INSERT_CAP in content.ts).
//
// Alignment is done by comparing the single-block markdown rendering of each
// block on each side. This reuses the full from-blocks + to-blocks pipelines
// so the diff is in the same canonical form the user sees via notion_fetch.
// -----------------------------------------------------------------------------

import { blocksToMarkdown, type HydratedBlock } from "../../notion/markdown/from-blocks";
import type { BlockPosition } from "../../notion/client";
import type { BlockRequest } from "../../notion/markdown/to-blocks";

/** Block types whose native payload is just a rich_text (+ small scalars). */
const LEAF_TYPES = new Set<string>([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
  "callout",
  "code",
]);

export type UpdatePlan =
  | { kind: "noop" }
  | {
      kind: "fast";
      oldBlock: HydratedBlock;
      newBlock: BlockRequest;
    }
  | {
      kind: "medium";
      /** IDs of old blocks to delete (contiguous range). */
      deleteIds: string[];
      /** New blocks to insert (request-shape). */
      insertBlocks: BlockRequest[];
      /**
       * Where the insertion goes — Notion's `position` object (2026-03-11).
       * `after_block` behind the last common-prefix block, or `start` when the
       * affected range begins at page index 0 and there is nothing in front of
       * it to anchor to.
       */
      position: BlockPosition;
    }
  | {
      kind: "full";
      /** Diagnostic reason, surfaced in the tool result for debugging. */
      reason: string;
    };

/**
 * Build the diff plan.
 *
 * @param oldBlocks Top-level hydrated blocks currently on the page.
 * @param newBlocks Top-level request-shape blocks produced from the new markdown.
 */
export function planUpdate(oldBlocks: HydratedBlock[], newBlocks: BlockRequest[]): UpdatePlan {
  if (oldBlocks.length === 0 && newBlocks.length === 0) {
    return { kind: "noop" };
  }

  // Render every block (both sides) as a single-element markdown string for
  // equality comparison. We don't need spans here — just the canonical text.
  const oldRendered = oldBlocks.map((b) => blocksToMarkdown([b]));
  const newHydratedish = newBlocks.map(requestToHydratedish);
  const newRendered = newHydratedish.map((b) => blocksToMarkdown([b]));

  // Longest common prefix.
  let prefix = 0;
  const maxPrefix = Math.min(oldRendered.length, newRendered.length);
  while (prefix < maxPrefix && oldRendered[prefix] === newRendered[prefix]) prefix++;

  // Longest common suffix — stop once we bump into the prefix region on either
  // side (don't double-count blocks).
  let suffix = 0;
  while (
    suffix < oldRendered.length - prefix &&
    suffix < newRendered.length - prefix &&
    oldRendered[oldRendered.length - 1 - suffix] === newRendered[newRendered.length - 1 - suffix]
  ) {
    suffix++;
  }

  const affectedOld = oldBlocks.slice(prefix, oldBlocks.length - suffix);
  const affectedNew = newBlocks.slice(prefix, newBlocks.length - suffix);

  if (affectedOld.length === 0 && affectedNew.length === 0) {
    return { kind: "noop" };
  }

  // Fast path: 1:1 replacement with same leaf type and no children on either
  // side. updateBlock preserves the block id → any comments stay attached.
  //
  // This is checked BEFORE the no-prefix case below, and the order matters: an
  // updateBlock names its target by id and needs no anchor at all, so a page
  // whose FIRST (or only) block gets a one-word edit belongs here. It used to
  // fall out of the prefix===0 branch into a whole-page rewrite, losing the id
  // and every comment on it to preserve an anchor nothing was going to use.
  if (
    affectedOld.length === 1 &&
    affectedNew.length === 1 &&
    affectedOld[0]!.type === affectedNew[0]!.type &&
    LEAF_TYPES.has(affectedOld[0]!.type) &&
    !hasChildrenOld(affectedOld[0]!) &&
    !hasChildrenNew(affectedNew[0]!)
  ) {
    return {
      kind: "fast",
      oldBlock: affectedOld[0]!,
      newBlock: affectedNew[0]!,
    };
  }

  // No common prefix — the insertion goes at the very top of the page. Before
  // 2026-03-11 that was a full rewrite, because the only placement the append
  // endpoint offered was `after:<block>` and there was no block in front to
  // name. `position: { type: "start" }` is exactly that missing prepend, so
  // the trailing blocks (and their ids, and their comments) survive.
  //
  // The one case still worth a full rewrite is when EVERY block changed:
  // there is nothing left to preserve, and delete-all + append-all is one
  // fewer moving part than delete-all + prepend.
  if (prefix === 0) {
    if (affectedOld.length === oldBlocks.length && affectedNew.length === newBlocks.length) {
      return { kind: "full", reason: "entire page changed" };
    }
    return {
      kind: "medium",
      deleteIds: affectedOld.map((b) => b.id),
      insertBlocks: affectedNew,
      position: { type: "start" },
    };
  }

  // Medium path: delete the affected run, append the replacement blocks
  // immediately after the last unchanged prefix block.
  return {
    kind: "medium",
    deleteIds: affectedOld.map((b) => b.id),
    insertBlocks: affectedNew,
    position: { type: "after_block", after_block: { id: oldBlocks[prefix - 1]!.id } },
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * markdownToBlocks returns request-shape blocks where nested children live
 * under `block[type].children`. blocksToMarkdown (used for single-block
 * rendering during alignment) expects hydrated shape: children at the top
 * level, under `block.children`. Lift them over so a single helper drives
 * both sides of the comparison.
 */
export function requestToHydratedish(block: BlockRequest): HydratedBlock {
  const type = block.type;
  if (!type) return { ...(block as object), id: "__tmp__", object: "block" } as unknown as HydratedBlock;
  const payload = (block as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
  const rawChildren = payload && Array.isArray((payload as { children?: unknown[] }).children)
    ? ((payload as { children: unknown[] }).children as BlockRequest[])
    : undefined;
  // Clone payload without the children field so the renderer doesn't
  // double-count them (it uses block.children for nested rendering).
  let cleanedPayload: Record<string, unknown> | undefined;
  if (payload) {
    cleanedPayload = { ...payload };
    if (rawChildren) delete (cleanedPayload as { children?: unknown }).children;
  }
  const hydrated: HydratedBlock = {
    object: "block",
    id: "__tmp__",
    type,
    has_children: !!rawChildren && rawChildren.length > 0,
    [type]: cleanedPayload ?? {},
  } as unknown as HydratedBlock;
  if (rawChildren && rawChildren.length > 0) {
    hydrated.children = rawChildren.map(requestToHydratedish);
  }
  return hydrated;
}

function hasChildrenOld(block: HydratedBlock): boolean {
  if (block.has_children === true) return true;
  if (block.children && block.children.length > 0) return true;
  return false;
}

function hasChildrenNew(block: BlockRequest): boolean {
  const type = block.type;
  if (!type) return false;
  const payload = (block as Record<string, unknown>)[type] as
    | { children?: unknown[] }
    | undefined;
  return Array.isArray(payload?.children) && payload.children.length > 0;
}
