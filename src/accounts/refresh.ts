// -----------------------------------------------------------------------------
// Account-level token refresh.
//
// Sits between the low-level grant helpers (oauth/token.ts) and the account
// store: exchanges a stored refresh token for a fresh pair and persists the
// result, so the next request — and the next isolate — sees the new material.
//
// Two entry points, matching the two ways a token dies:
//
//   refreshAccountToken()   — the token is KNOWN stale (`expiresAt` has
//                             passed). Called ahead of the request.
//   recoverFromUnauthorized() — the token turned out to be dead mid-request
//                             (Notion said `unauthorized`). Called after.
//
// Everything here fails soft. If refresh isn't possible — no refresh token
// stored, Notion rejects the grant, KV write fails — the caller carries on
// with the credentials it already had and the request produces today's error.
// A workspace that has never needed refresh must not start failing because
// refresh exists.
//
// ⚠ STATUS: IMPLEMENTED, UNREACHABLE UNTIL RE-AUTH (as of 2026-07-28)
//
// Nothing in this file can execute against any account currently stored in KV.
// Both entry points funnel through refreshAccountToken(), which returns null on
// its first line when `account.refreshToken` is absent — and no account record
// written before 2026-07 has one, because Notion only began issuing refresh
// tokens to public connections authorized after 2026-06-08. The proactive
// branch in accounts/resolver.ts is inert for the matching reason: those same
// records have no `expiresAt`, so isTokenExpired() always answers false.
//
// That is by design, not a defect: the migration requirement was that no
// existing account needs re-authorization, and it is met. But it means the
// whole path — this file, oauth/token.ts's refresh grant, the `onUnauthorized`
// hook in notion/client.ts — is exercised only by its unit tests. Treat "token
// recovery is live" as false until proven otherwise.
//
// WHAT WOULD MAKE IT LIVE: re-authorize an account through
// notion_account_add against a Notion connection created (or re-consented)
// after 2026-06-08. The OAuth callback persists `refreshToken`/`expiresAt`
// when Notion returns them (oauth/flow.ts, oauth/token.ts:tokenFieldsFromResponse),
// and from that account's next 401 onwards this code runs for real. The first
// live exercise is worth watching: nothing here has ever met the token endpoint.
// -----------------------------------------------------------------------------

import type { Env, NotionAccount } from "../mcp/types";
import { AccountStore } from "./store";
import { exchangeRefreshToken, mergeTokenFields, tokenFieldsFromResponse } from "../oauth/token";

/**
 * Exchange an account's refresh token for a fresh pair and persist it.
 *
 * Returns the updated account, or null when refresh was not possible. Never
 * throws: every failure mode collapses to null so call sites can fall back to
 * the existing credentials without a try/catch.
 *
 * The re-read on failure handles a genuine race. Notion rotates refresh tokens,
 * so if two concurrent requests in different isolates both see an expired token
 * and both refresh, the loser's grant is rejected — its refresh token was
 * already consumed. Re-reading the account picks up whatever the winner
 * persisted, which is a valid token, rather than reporting failure for what is
 * actually a success by another path.
 */
export async function refreshAccountToken(
  env: Env,
  account: NotionAccount
): Promise<NotionAccount | null> {
  if (!account.refreshToken) return null;
  if (!env.NOTION_OAUTH_CLIENT_ID || !env.NOTION_OAUTH_CLIENT_SECRET) return null;

  const store = new AccountStore(env.NOTION_MCP_KV);

  try {
    const res = await exchangeRefreshToken(env, account.refreshToken);
    const updated = mergeTokenFields(account, tokenFieldsFromResponse(res, Date.now()));
    // allowOverwriteName: the name is unchanged, but put() would otherwise
    // reject the write on its own name-uniqueness index entry.
    await store.put(updated, { allowOverwriteName: true });
    return updated;
  } catch {
    // Possibly lost a refresh race — see the doc comment. Re-read and use the
    // other writer's result if it looks materially different from ours.
    try {
      const reread = await store.getById(account.id);
      if (reread && reread.accessToken !== account.accessToken) return reread;
    } catch {
      /* ignore — nothing more we can do */
    }
    return null;
  }
}

/**
 * Called by the API client when a request came back `unauthorized`.
 *
 * Returns a fresh access token to retry with, or null to let the original
 * error stand. Deliberately narrow: the client gets a string, never the
 * account object, so no token material beyond the one value it must send can
 * reach the request layer.
 */
export async function recoverFromUnauthorized(
  env: Env,
  account: NotionAccount
): Promise<string | null> {
  const updated = await refreshAccountToken(env, account);
  if (!updated) return null;
  // Keep the in-memory account in step so any later client built from this
  // same object during the current tool invocation uses the new token.
  account.accessToken = updated.accessToken;
  if (updated.refreshToken !== undefined) account.refreshToken = updated.refreshToken;
  if (updated.expiresAt !== undefined) account.expiresAt = updated.expiresAt;
  else delete account.expiresAt;
  return updated.accessToken;
}
