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
import type { BlockRequest } from "../../notion/markdown/to-blocks";
import { appendInChunks, cloneBlockForRequest, hydrateChildren, textErr, textOk } from "./shared";

export async function applyTemplateHandler(
  client: NotionClient,
  pageId: string,
  templateId: unknown
): Promise<ToolResult> {
  if (typeof templateId !== "string" || !templateId) {
    return textErr("apply_template requires a `template_id` string.");
  }
  const tree = await hydrateChildren(client, templateId);
  const cloned: BlockRequest[] = [];
  let skipped = 0;
  for (const b of tree) {
    const c = cloneBlockForRequest(b);
    if (c) cloned.push(c);
    else skipped++;
  }
  if (cloned.length === 0) {
    const note = skipped > 0 ? ` (${skipped} blocks skipped — child_page/child_database can't be cloned)` : "";
    return textErr(`Template ${templateId} has no clonable content${note}.`);
  }
  await appendInChunks(client, pageId, cloned);
  const note = skipped > 0 ? ` (skipped ${skipped} child_page/child_database references)` : "";
  return textOk(`Applied template ${templateId} — appended ${cloned.length} top-level blocks to page ${pageId}${note}.`);
}
