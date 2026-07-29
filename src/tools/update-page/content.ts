// -----------------------------------------------------------------------------
// notion_update_page — "update_content" command.
//
// Native MCP semantics: take an array of { old_str, new_str, replace_all_matches? }
// and apply them as string-substitutions against the page's Notion-flavored
// MARKDOWN representation. Rendering through the shared from-blocks module
// means old_str is literally the same text `notion_fetch` would return, so
// callers can do "fetch then swap" round-trips.
//
// Phase 5.5 — after applying substitutions, we dispatch to the minimal API
// plan instead of blanket delete+append:
//
//   - fast   — in-place updateBlock on a single leaf block. Block id preserved,
//              so any comments on that block stay attached.
//   - medium — delete the affected range and append replacements immediately
//              after the last unchanged prefix block. Unaffected blocks
//              (including their ids) are left alone.
//   - full   — delete everything and append everything. Only used when the
//              affected range starts at page index 0 (no anchor available for
//              Notion's `after:` append) or when every block changes.
//
// Error cases:
//   - old_str not found in the rendered markdown
//   - old_str matches multiple times AND replace_all_matches isn't true
//     (ambiguity — fail loudly instead of silently editing the wrong spot)
//   - page has no children (nothing to match against)
// -----------------------------------------------------------------------------

import type { NotionClient } from "../../notion/client";
import type { ToolResult } from "../../mcp/types";
import { blocksToMarkdown } from "../../notion/markdown/from-blocks";
import { markdownToBlocks } from "../../notion/markdown/to-blocks";
import { fitRequestTree, hasPendingWork } from "../../notion/block-clone";
import { hydrateChildren, textErr, textOk } from "./shared";
import { replaceBlockRange, replaceContentHandler } from "./replace";
import { checkPreservation } from "./preservation";
import { planUpdate, type UpdatePlan } from "./diff";

export interface ContentUpdate {
  old_str: string;
  new_str: string;
  replace_all_matches?: boolean;
}

export interface UpdateContentOptions {
  allowDeletingContent?: boolean;
}

/**
 * medium-path insertion cap. If the planner wants to insert more than this in
 * one batch, we bail to the full path (which chunks via appendInChunks).
 * Notion's append endpoint caps at 100 children per call, and using `after:`
 * across multiple chunks inverts the insertion order — simpler to fall back.
 */
const MEDIUM_PATH_INSERT_CAP = 100;

export async function updateContentHandler(
  client: NotionClient,
  pageId: string,
  updatesRaw: unknown,
  opts: UpdateContentOptions = {}
): Promise<ToolResult> {
  const updates = validateUpdates(updatesRaw);
  if ("error" in updates) return textErr(updates.error);
  if (updates.list.length === 0) {
    return textErr("update_content requires a non-empty `content_updates` array.");
  }

  const existing = await hydrateChildren(client, pageId);
  if (existing.length === 0) {
    return textErr(
      "Page has no content to update. Use `replace_content` or `apply_template` to add content to an empty page."
    );
  }

  // Render current state to markdown. This is the canonical representation
  // callers are matching against — see native's "fetch first" guidance.
  let md = blocksToMarkdown(existing);

  // Apply updates sequentially; each replacement sees the result of prior ones.
  const applied: string[] = [];
  for (let i = 0; i < updates.list.length; i++) {
    const u = updates.list[i]!;
    const { old_str, new_str, replace_all_matches } = u;

    if (!md.includes(old_str)) {
      return textErr(
        `No match for content_updates[${i}].old_str in this page. ` +
          `Use notion_fetch to see the exact markdown, then copy the snippet verbatim. ` +
          `Missing: ${snippet(old_str)}`
      );
    }
    const occurrences = countOccurrences(md, old_str);
    if (occurrences > 1 && !replace_all_matches) {
      return textErr(
        `Ambiguous match: content_updates[${i}].old_str appears ${occurrences} times. ` +
          `Either set replace_all_matches: true to replace every occurrence, or include more surrounding ` +
          `context in old_str so it matches exactly once. Snippet: ${snippet(old_str)}`
      );
    }
    md = replace_all_matches ? splitJoinReplace(md, old_str, new_str) : md.replace(old_str, new_str);
    applied.push(
      `${i + 1}. Replaced ${occurrences > 1 ? `${occurrences}×` : "1×"} ${snippet(old_str)} → ${snippet(new_str)}`
    );
  }

  // Preservation check — if any existing child_page/child_database block is
  // missing from the new markdown, block the operation (unless the caller
  // explicitly passed allow_deleting_content). This runs BEFORE dispatch so
  // both fast and medium paths are guarded by the same gate.
  const preservation = checkPreservation(existing, md);
  if (preservation.missing.length > 0 && !opts.allowDeletingContent) {
    const lines = preservation.missing.map(
      (m) => `  - [${m.type}] ${m.title} (id: ${m.id})`
    );
    return textErr(
      `Refusing to delete child pages/databases that aren't referenced in the new content. ` +
        `To proceed anyway, pass allow_deleting_content: true. Affected items:\n${lines.join("\n")}`
    );
  }

  // Parse the new markdown, build the minimal plan, dispatch.
  const newBlocks = markdownToBlocks(md);
  const plan = planUpdate(existing, newBlocks);

  const summary = await executePlan(client, pageId, plan, md, existing, {
    allowDeletingContent: opts.allowDeletingContent,
  });

  const prelude = `Applied ${updates.list.length} content update${updates.list.length === 1 ? "" : "s"}:\n${applied.join("\n")}\n\n`;
  return { content: [{ type: "text", text: prelude + summary }] };
}

// -----------------------------------------------------------------------------
// Dispatcher — turns the plan into API calls.
// -----------------------------------------------------------------------------

async function executePlan(
  client: NotionClient,
  pageId: string,
  plan: UpdatePlan,
  finalMd: string,
  existing: Parameters<typeof hydrateChildren> extends unknown ? Awaited<ReturnType<typeof hydrateChildren>> : never,
  opts: { allowDeletingContent?: boolean }
): Promise<string> {
  switch (plan.kind) {
    case "noop":
      return `No changes to apply — the substitutions left every block unchanged on page ${pageId}.`;

    case "fast": {
      const type = plan.newBlock.type!;
      const payload = (plan.newBlock as Record<string, unknown>)[type];
      await client.updateBlock(plan.oldBlock.id, { [type]: payload });
      return (
        `Fast path: updated 1 ${type} block in place (id preserved: ${plan.oldBlock.id}). ` +
        `Block-level comments on this block are retained.`
      );
    }

    case "medium": {
      // If the medium-path insertion would exceed Notion's per-call cap,
      // fall back to the full path rather than do clever chunking.
      if (plan.insertBlocks.length > MEDIUM_PATH_INSERT_CAP) {
        return fullFallback(client, pageId, finalMd, existing, opts, "medium-path insertion exceeded 100 blocks");
      }
      // Same reasoning for depth. The medium path is one anchored append
      // (`after:`), and appendClonedTree has no `after` — so a tree too deep
      // for a single request body cannot be split here without losing the
      // anchor. Hand it to the full path, which does handle deferral. Costs
      // the id preservation this path exists for; the alternative is a 400.
      if (hasPendingWork(fitRequestTree(plan.insertBlocks))) {
        return fullFallback(
          client,
          pageId,
          finalMd,
          existing,
          opts,
          "medium-path insertion nested deeper than one request body can carry"
        );
      }
      const { deleted, inserted } = await replaceBlockRange(
        client,
        pageId,
        plan.deleteIds,
        plan.insertBlocks,
        plan.afterId
      );
      const preservedCount = existing.length - plan.deleteIds.length;
      return (
        `Medium path: deleted ${deleted} block${deleted === 1 ? "" : "s"}, ` +
        `inserted ${inserted} replacement${inserted === 1 ? "" : "s"} after block ${plan.afterId}. ` +
        `${preservedCount} existing block${preservedCount === 1 ? "" : "s"} kept their ids (and any attached comments).`
      );
    }

    case "full":
      return fullFallback(client, pageId, finalMd, existing, opts, plan.reason);
  }
}

async function fullFallback(
  client: NotionClient,
  pageId: string,
  finalMd: string,
  existing: Awaited<ReturnType<typeof hydrateChildren>>,
  opts: { allowDeletingContent?: boolean },
  reason: string
): Promise<string> {
  // We already ran the preservation check above, so allow the full replace to
  // skip its own check by handing it allowDeletingContent=true. The outer
  // gate already decided this is allowed.
  const result = await replaceContentHandler(client, pageId, finalMd, {
    existing,
    allowDeletingContent: true,
  });
  const inner = result.content[0]?.text ?? "";
  void opts;
  return `Full fallback (${reason}): ${inner}`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function validateUpdates(raw: unknown): { list: ContentUpdate[] } | { error: string } {
  if (raw === undefined || raw === null) return { list: [] };
  if (!Array.isArray(raw)) return { error: "`content_updates` must be an array." };
  if (raw.length > 100) return { error: "`content_updates` has a 100-item cap per call; split the request." };
  const out: ContentUpdate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | null;
    if (!item || typeof item !== "object") return { error: `content_updates[${i}] must be an object.` };
    if (typeof item.old_str !== "string") return { error: `content_updates[${i}].old_str must be a string.` };
    if (typeof item.new_str !== "string") return { error: `content_updates[${i}].new_str must be a string.` };
    const entry: ContentUpdate = { old_str: item.old_str, new_str: item.new_str };
    if (item.replace_all_matches !== undefined) {
      if (typeof item.replace_all_matches !== "boolean") {
        return { error: `content_updates[${i}].replace_all_matches must be a boolean.` };
      }
      entry.replace_all_matches = item.replace_all_matches;
    }
    out.push(entry);
  }
  return { list: out };
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function splitJoinReplace(haystack: string, needle: string, replacement: string): string {
  if (needle === "") return haystack;
  return haystack.split(needle).join(replacement);
}

function snippet(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, " ");
  if (oneLine.length <= max) return JSON.stringify(oneLine);
  return JSON.stringify(oneLine.slice(0, max - 1) + "…");
}
