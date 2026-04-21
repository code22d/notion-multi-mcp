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

  const verification: Record<string, unknown> = { state: status };
  if (status === "verified") {
    const expiry = args.verification_expiry_days;
    if (typeof expiry === "number" && Number.isFinite(expiry) && expiry > 0) {
      const now = new Date();
      const end = new Date(now.getTime() + expiry * 86400000);
      verification.date = { start: now.toISOString(), end: end.toISOString() };
    }
  }

  const body: Record<string, unknown> = { verification };
  const icon = normalizeIconInput(args.icon);
  if (icon !== undefined) body.icon = icon;
  const cover = normalizeCoverInput(args.cover);
  if (cover !== undefined) body.cover = cover;

  await client.updatePage(pageId, body);

  const expiryNote =
    status === "verified" && verification.date
      ? ` (expires ${((verification.date as { end?: string }).end ?? "").slice(0, 10)})`
      : "";
  return textOk(`Set verification=${status}${expiryNote} on page ${pageId}.`);
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
