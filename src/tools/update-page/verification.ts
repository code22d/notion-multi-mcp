// -----------------------------------------------------------------------------
// notion_update_page — "update_verification" command.
//
// PATCHes the page with a `verification` block. Notion's API accepts:
//   { verification: { state: "verified" | "unverified", date?: { start, end? } } }
// When `verification_expiry_days` is provided alongside state="verified", we
// compute start=now, end=now+N days (ISO-8601).
// -----------------------------------------------------------------------------

import type { NotionClient } from "../../notion/client";
import type { ToolResult } from "../../mcp/types";
import { textErr, textOk, normalizeIconInput, normalizeCoverInput } from "./shared";

export interface UpdateVerificationArgs {
  verification_status?: unknown;
  verification_expiry_days?: unknown;
  /** cover/icon can ride along with any command per native MCP. */
  cover?: unknown;
  icon?: unknown;
}

export async function updateVerificationHandler(
  client: NotionClient,
  pageId: string,
  args: UpdateVerificationArgs
): Promise<ToolResult> {
  const status = args.verification_status;
  if (status !== "verified" && status !== "unverified") {
    return textErr(
      `update_verification requires verification_status: "verified" or "unverified" (got ${JSON.stringify(status)}).`
    );
  }

  // Notion's public API only accepts a `verification` body on wiki-home pages.
  // PATCHing it on a regular page returns:
  //   "body failed validation: body.verification should be not present, instead was {...}"
  // Pre-check so Claude sees a meaningful tool-level error instead of a raw 400.
  let page;
  try {
    page = await client.getPage(pageId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textErr(`Could not load page ${pageId} to check wiki status: ${msg}`);
  }
  if (!page.is_wiki_page) {
    return textErr(
      `update_verification is only available on wiki home pages. Page ${pageId} is a regular page, so Notion's API rejects the verification body. ` +
        `To verify content, convert the page to a wiki (Notion UI → "Turn into wiki") or target a page that is already a wiki home.`
    );
  }

  const body: Record<string, unknown> = { verification: buildVerificationPatch(args) };
  const icon = normalizeIconInput(args.icon);
  if (icon !== undefined) body.icon = icon;
  const cover = normalizeCoverInput(args.cover);
  if (cover !== undefined) body.cover = cover;

  await client.updatePage(pageId, body);

  const verification = body.verification as { date?: { end?: string } };
  const expiryNote =
    status === "verified" && verification.date
      ? ` (expires ${(verification.date.end ?? "").slice(0, 10)})`
      : "";
  return textOk(`Set verification=${status}${expiryNote} on page ${pageId}.`);
}

/**
 * Internal — pure verification-body builder shared with buildVerificationBody().
 * Kept simple so the public buildVerificationBody() signature and its unit
 * fixtures stay unchanged.
 */
function buildVerificationPatch(args: UpdateVerificationArgs, nowMs: number = Date.now()): Record<string, unknown> {
  const status = args.verification_status;
  const verification: Record<string, unknown> = { state: status };
  if (status === "verified") {
    const expiry = args.verification_expiry_days;
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) {
      const start = new Date(nowMs);
      const end = new Date(nowMs + expiry * 86400000);
      verification.date = { start: start.toISOString(), end: end.toISOString() };
    }
  }
  return verification;
}

/**
 * Internal helper — exported so tests can assert the request body shape without
 * running the real handler against Notion.
 */
export function buildVerificationBody(args: UpdateVerificationArgs, nowMs: number = Date.now()): Record<string, unknown> {
  const status = args.verification_status;
  if (status !== "verified" && status !== "unverified") {
    throw new Error(`invalid verification_status: ${JSON.stringify(status)}`);
  }
  const verification: Record<string, unknown> = { state: status };
  if (status === "verified") {
    const expiry = args.verification_expiry_days;
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) {
      const start = new Date(nowMs);
      const end = new Date(nowMs + expiry * 86400000);
      verification.date = { start: start.toISOString(), end: end.toISOString() };
    }
  }
  const body: Record<string, unknown> = { verification };
  const icon = normalizeIconInput(args.icon);
  if (icon !== undefined) body.icon = icon;
  const cover = normalizeCoverInput(args.cover);
  if (cover !== undefined) body.cover = cover;
  return body;
}
