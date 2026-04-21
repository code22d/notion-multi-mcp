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

import type { NotionClient } from "../../notion/client";
import type { HydratedBlock } from "../../notion/markdown/from-blocks";
import type { ToolResult } from "../../mcp/types";
import { markdownToBlocks, type BlockRequest } from "../../notion/markdown/to-blocks";
import { appendInChunks, hydrateChildren, textErr, textOk } from "./shared";
import { checkPreservation } from "./preservation";

/**
 * Core delete+append helper — the medium path of update_content uses this
 * directly, and replace_content wraps it to do the whole page at once.
 *
 * When `afterId` is provided, Notion's `after:` parameter anchors the
 * insertion immediately after that block. Caller must ensure insertBlocks fits
 * in a single 100-item append — for larger batches, either chunk without an
 * anchor (i.e. full replace) or fall back to delete-all + append-all.
 */
export async function replaceBlockRange(
  client: NotionClient,
  pageId: string,
  deleteIds: string[],
  insertBlocks: BlockRequest[],
  afterId?: string
): Promise<{ deleted: number; inserted: number }> {
  let deleted = 0;
  for (const id of deleteIds) {
    try {
      await client.deleteBlock(id);
      deleted++;
    } catch {
      // Block may already be archived or missing — press on.
    }
  }
  if (insertBlocks.length > 0) {
    const body: { children: BlockRequest[]; after?: string } = { children: insertBlocks };
    if (afterId) body.after = afterId;
    await client.appendBlockChildren(pageId, body);
  }
  return { deleted, inserted: insertBlocks.length };
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

  await appendInChunks(client, pageId, newBlocks);

  return textOk(
    `Replaced page ${pageId} content — deleted ${deleted} existing block${deleted === 1 ? "" : "s"}, appended ${newBlocks.length} new block${newBlocks.length === 1 ? "" : "s"}.`
  );
}
