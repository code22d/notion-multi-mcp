// -----------------------------------------------------------------------------
// resolveAccount(args, ctx)
//
// Used by every Notion tool. Looks up `args.account` (name OR id) and returns
// the NotionAccount. If the account doesn't exist, throws a helpful error that
// the MCP layer will surface to Claude as a tool error.
// -----------------------------------------------------------------------------

import type { NotionAccount, ToolContext } from "../mcp/types";
import { AccountStore } from "./store";

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
