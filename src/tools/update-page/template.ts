// -----------------------------------------------------------------------------
// notion_update_page — "apply_template" command.
//
// Notion has no public "apply template" endpoint. A "template" in the Notion
// sense is just another page whose blocks we clone onto the target. We fetch
// the template's full child tree, strip id/timestamp fields, and append the
// cloned tree to the target page (native MCP spec: template content is
// APPENDED to any existing content — we match that).
//
// `child_page` and `child_database` blocks in the template are skipped —
// cloning them would create dangling references or duplicate workspace
// entities.
// -----------------------------------------------------------------------------

import type { NotionClient } from "../../notion/client";
import type { ToolResult } from "../../mcp/types";
import { appendClonedTree, cloneBlockTree } from "../../notion/block-clone";
import { TEMPLATE_CLONE_POLICY, hydrateChildren, textErr, textOk } from "./shared";

export async function applyTemplateHandler(
  client: NotionClient,
  pageId: string,
  templateId: unknown
): Promise<ToolResult> {
  if (typeof templateId !== "string" || !templateId) {
    return textErr("apply_template requires a `template_id` string.");
  }
  const tree = await hydrateChildren(client, templateId);
  const cloned = cloneBlockTree(tree, TEMPLATE_CLONE_POLICY);
  const skipped = tree.length - cloned.length;
  if (cloned.length === 0) {
    const note = skipped > 0 ? ` (${skipped} blocks skipped — child_page/child_database can't be cloned)` : "";
    return textErr(`Template ${templateId} has no clonable content${note}.`);
  }
  // appendClonedTree, not a bare append: Notion's request schema refuses to
  // carry `children` past a fixed nesting depth, and refuses column_list/table
  // deeper still. Anything the request body couldn't hold is appended as a
  // follow-up call rather than silently dropped from the template.
  await appendClonedTree(client, pageId, cloned, TEMPLATE_CLONE_POLICY);
  const note = skipped > 0 ? ` (skipped ${skipped} child_page/child_database references)` : "";
  return textOk(`Applied template ${templateId} — appended ${cloned.length} top-level blocks to page ${pageId}${note}.`);
}
