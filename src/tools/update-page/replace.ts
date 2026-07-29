// -----------------------------------------------------------------------------
// notion_update_page — "replace_content" command (and the shared implementation
// that update_content delegates to).
//
// Pipeline:
//   1. Hydrate the page's block tree.
//   2. Preservation check — if any existing child_page/child_database block's
//      id is NOT referenced by the new markdown, fail (unless the caller set
//      allow_deleting_content: true).
//   3. Parse new markdown → BlockRequest[].
//   4. Delete every top-level existing block (archives recursively).
//   5. Append the new blocks in 100-item chunks.
//
// Block IDs are not preserved — this is delete + append, not in-place edit.
// For in-place edits, callers should use update_content with a narrow
// substitution that keeps block structure unchanged (see content.ts).
// -----------------------------------------------------------------------------

import type { BlockPosition, NotionClient } from "../../notion/client";
import type { HydratedBlock } from "../../notion/markdown/from-blocks";
import type { ToolResult } from "../../mcp/types";
import { markdownToBlocks, type BlockRequest } from "../../notion/markdown/to-blocks";
import { hydrateChildren, textErr, textOk } from "./shared";
import {
  AUTHORED_CLONE_POLICY,
  appendClonedTree,
  fitRequestTree,
  hasPendingWork,
} from "../../notion/block-clone";
import { checkPreservation } from "./preservation";

/**
 * Core delete+append helper — the medium path of update_content uses this
 * directly, and replace_content wraps it to do the whole page at once.
 *
 * `position` places the insertion — Notion's 2026-03-11 append position, so
 * `after_block` behind a surviving block or `start` at the top of the page.
 *
 * The inserted tree goes through the same write-schema fitting the create path
 * uses, so an insertion nested deeper than one request body can carry is split
 * across follow-up appends instead of forcing the caller to give up on the
 * position. Those follow-ups land under blocks this call just created, which
 * hold nothing else — so only the FIRST request needs a position, and keeping
 * it is what keeps the untouched blocks on the page (and their comments) alive.
 */
export async function replaceBlockRange(
  client: NotionClient,
  pageId: string,
  deleteIds: string[],
  insertBlocks: BlockRequest[],
  position?: BlockPosition
): Promise<{ deleted: number; inserted: number; deferred: boolean }> {
  let deleted = 0;
  for (const id of deleteIds) {
    try {
      await client.deleteBlock(id);
      deleted++;
    } catch {
      // Block may already be archived or missing — press on.
    }
  }
  if (insertBlocks.length === 0) return { deleted, inserted: 0, deferred: false };

  const fitted = fitRequestTree(insertBlocks);
  const deferred = hasPendingWork(fitted);
  await appendClonedTree(client, pageId, fitted, AUTHORED_CLONE_POLICY, position);
  return { deleted, inserted: fitted.length, deferred };
}

export interface ReplaceContentOptions {
  allowDeletingContent?: boolean;
  /** Pre-fetched tree (update_content passes it in to avoid a second fetch). */
  existing?: HydratedBlock[];
  /** Pre-parsed request blocks; if omitted we parse `newMarkdown` ourselves. */
  newBlocks?: BlockRequest[];
}

export async function replaceContentHandler(
  client: NotionClient,
  pageId: string,
  newMarkdown: string,
  opts: ReplaceContentOptions = {}
): Promise<ToolResult> {
  const existing = opts.existing ?? (await hydrateChildren(client, pageId));

  const preservation = checkPreservation(existing, newMarkdown);
  if (preservation.missing.length > 0 && !opts.allowDeletingContent) {
    const lines = preservation.missing.map(
      (m) => `  - [${m.type}] ${m.title} (id: ${m.id})`
    );
    return textErr(
      `Refusing to delete child pages/databases that aren't referenced in the new content. ` +
        `To proceed anyway, pass allow_deleting_content: true. Affected items:\n${lines.join("\n")}`
    );
  }

  const newBlocks = opts.newBlocks ?? markdownToBlocks(newMarkdown);

  // Delete top-level children — archival cascades to nested descendants.
  let deleted = 0;
  for (const b of existing) {
    try {
      await client.deleteBlock(b.id);
      deleted++;
    } catch (e) {
      // Continue — a block may already be archived; swallow and press on so
      // one stale block doesn't strand the page in a half-deleted state.
      const _err = e instanceof Error ? e.message : String(e);
      void _err;
    }
  }

  // Same write-schema fitting the create path does: markdown can nest deeper
  // than Notion's request body accepts, and appendClonedTree sends the surplus
  // as follow-up requests instead of losing it to a 400. Shallow content emits
  // exactly the same bodies appendInChunks did, in the same chunks.
  await appendClonedTree(client, pageId, fitRequestTree(newBlocks), AUTHORED_CLONE_POLICY);

  return textOk(
    `Replaced page ${pageId} content — deleted ${deleted} existing block${deleted === 1 ? "" : "s"}, appended ${newBlocks.length} new block${newBlocks.length === 1 ? "" : "s"}.`
  );
}
