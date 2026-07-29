// -----------------------------------------------------------------------------
// resolveAccount(args, ctx)
//
// Used by every Notion tool. Looks up `args.account` (name OR id) and returns
// the NotionAccount. If the account doesn't exist, throws a helpful error that
// the MCP layer will surface to Claude as a tool error.
// -----------------------------------------------------------------------------

import type { NotionAccount, ToolContext } from "../mcp/types";
import { AccountStore } from "./store";
import { NotionClient, validateBlockBodiesEnabled } from "../notion/client";
import { recoverFromUnauthorized, refreshAccountToken } from "./refresh";
import { isTokenExpired } from "../oauth/token";

/**
 * Build the API client for a resolved account, wired for token refresh.
 *
 * Every tool goes through here rather than `new NotionClient(account)` so the
 * reactive refresh-on-unauthorized path is universal — there is no call site
 * that silently opts out of it.
 */
export function createNotionClient(account: NotionAccount, ctx: ToolContext): NotionClient {
  return new NotionClient(account, {
    onUnauthorized: () => recoverFromUnauthorized(ctx.env, account),
    // Dev-only body validation. Unset in production, where this resolves to
    // false and the client's check is a single boolean test on the two methods
    // that carry blocks. See NotionClient.checkBlockBody().
    validateBlockBodies: validateBlockBodiesEnabled(ctx.env.VALIDATE_BLOCK_BODIES),
  });
}

export async function resolveAccount(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<NotionAccount> {
  const raw = args.account;
  if (typeof raw !== "string" || raw.trim() === "") {
    const store = new AccountStore(ctx.env.NOTION_MCP_KV);
    const list = await store.list();
    const hint =
      list.length > 0
        ? ` Available accounts: ${list.map((a) => `"${a.name}"`).join(", ")}.`
        : " No accounts are connected — use notion_account_add to connect one first.";
    throw new Error(`Missing required "account" parameter (name or id).${hint}`);
  }
  const store = new AccountStore(ctx.env.NOTION_MCP_KV);
  const acct = await store.resolve(raw.trim());
  if (!acct) {
    const list = await store.list();
    const hint =
      list.length > 0
        ? ` Available accounts: ${list.map((a) => `"${a.name}"`).join(", ")}.`
        : " No accounts are connected — use notion_account_add to connect one first.";
    throw new Error(`No Notion account matching "${raw}".${hint}`);
  }

  // Proactive refresh: if the stored token has a known expiry that has already
  // passed and a refresh token is available, exchange before the caller uses
  // it. A failed refresh returns null and we hand back the original account:
  // the request then produces today's error rather than a new refresh-specific
  // one.
  //
  // ⚠ UNREACHABLE UNTIL RE-AUTH (as of 2026-07-28). Every account currently in
  // KV was written before `expiresAt` existed, so isTokenExpired() answers
  // false for all of them and this branch never fires. That is the intended
  // migration behaviour — those accounts keep working untouched, no
  // re-authorization required — but it also means this line has never run
  // outside its unit tests. It goes live the first time an account is
  // authorized against a post-2026-06-08 Notion connection, which is when
  // Notion starts returning `expires_in`. See the header of accounts/refresh.ts.
  if (isTokenExpired(acct, Date.now())) {
    const refreshed = await refreshAccountToken(ctx.env, acct);
    if (refreshed) return refreshed;
  }
  return acct;
}

/** Shared JSON schema fragment — every Notion tool spreads this into its inputSchema. */
export const ACCOUNT_PARAM_SCHEMA = {
  account: {
    type: "string",
    description:
      "The name or id of the Notion account to use (as added via notion_account_add). Names are case-insensitive.",
  },
} as const;
