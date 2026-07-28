// -----------------------------------------------------------------------------
// Notion OAuth token endpoint — shared by the initial code exchange (flow.ts)
// and the refresh path (used by the account resolver and the API client).
//
// Why this file exists separately from flow.ts: the refresh grant needs the
// same endpoint, the same Basic-auth credential construction, and the same
// response parsing as the authorization_code grant. Keeping one implementation
// means the two can't drift — in particular the notion-version header, which
// was previously hardcoded to "2022-06-28" in flow.ts while the API client
// pinned "2025-09-03".
//
// TOKEN HYGIENE — read before editing:
//   Nothing in this module may put token material into an Error message, a
//   log line, or an HTTP response body. Notion's token endpoint returns
//   `access_token` and `refresh_token` in a 200 body, so any code path that
//   echoes a raw response body is a leak. `redactTokenMaterial()` below is the
//   only sanctioned way to surface a token-endpoint body, and error paths must
//   route through it.
// -----------------------------------------------------------------------------

import type { Env, NotionAccount } from "../mcp/types";
import { NOTION_VERSION } from "../notion/client";

const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/**
 * Notion's token-endpoint response.
 *
 * `refresh_token` and `expires_in` are OPTIONAL and may legitimately be absent:
 * internal integrations and public connections created before 2026-06-08 don't
 * return them. Notion's own OpenAPI spec for the refresh grant doesn't document
 * `expires_in` at all, so treat its presence as a bonus rather than a contract.
 * Absent values must behave exactly as they did before this field existed.
 */
export interface NotionTokenResponse {
  access_token: string;
  token_type: string;
  bot_id: string;
  workspace_name: string | null;
  workspace_icon: string | null;
  workspace_id: string;
  owner: unknown;
  duplicated_template_id: string | null;
  /** Present on public connections authorized on/after 2026-06-08. */
  refresh_token?: string | null;
  /** Lifetime in seconds, when Notion chooses to send one. */
  expires_in?: number | null;
}

/** The credential fields we persist on an account, derived from a token response. */
export interface PersistableTokenFields {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, unix ms. Derived from `expires_in` at receipt time. */
  expiresAt?: number;
}

/**
 * Strip anything token-shaped out of a string before it can reach an error
 * message, a log, or an HTML error page.
 *
 * Applied to token-endpoint response bodies. A non-2xx body shouldn't contain
 * credentials, but "shouldn't" is not a guarantee worth betting a client's
 * workspace token on — and a future refactor that surfaces a 200 body through
 * the same path would otherwise leak silently.
 */
export function redactTokenMaterial(text: string): string {
  return text.replace(
    /("(?:access_token|refresh_token|token)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[redacted]"'
  );
}

/**
 * POST the token endpoint with an arbitrary grant body.
 *
 * Throws with a REDACTED body on non-2xx. Callers must not re-read the
 * response themselves.
 */
async function postTokenEndpoint(
  env: Env,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch
): Promise<NotionTokenResponse> {
  const creds = btoa(`${env.NOTION_OAUTH_CLIENT_ID}:${env.NOTION_OAUTH_CLIENT_SECRET}`);
  const res = await fetchImpl(NOTION_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${creds}`,
      "content-type": "application/json",
      // Was hardcoded "2022-06-28" here while the API client pinned
      // "2025-09-03". Aligned to the shared constant so a version bump is a
      // single-line change in one file.
      "notion-version": NOTION_VERSION,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion token endpoint returned ${res.status}: ${redactTokenMaterial(text)}`);
  }
  return (await res.json()) as NotionTokenResponse;
}

/** Exchange an authorization code for a token pair. */
export function exchangeAuthorizationCode(
  env: Env,
  code: string,
  redirectUri: string,
  fetchImpl?: typeof fetch
): Promise<NotionTokenResponse> {
  return postTokenEndpoint(
    env,
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    fetchImpl
  );
}

/** Exchange a refresh token for a fresh token pair. */
export function exchangeRefreshToken(
  env: Env,
  refreshToken: string,
  fetchImpl?: typeof fetch
): Promise<NotionTokenResponse> {
  return postTokenEndpoint(env, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}

/**
 * Project a token response onto the fields we persist.
 *
 * Both optional fields are omitted (not set to undefined) when Notion doesn't
 * send them, so the stored JSON of an integration that returns neither is
 * byte-identical to what the pre-2026 code wrote. That keeps the migration
 * story trivial: old records simply look like new records from an integration
 * that returns no refresh material.
 *
 * A `refresh_token` of null — which the refresh grant is documented to allow —
 * is treated as "absent", never as "clear the stored one". See
 * mergeTokenFields() for why that distinction matters.
 */
export function tokenFieldsFromResponse(
  res: NotionTokenResponse,
  now: number
): PersistableTokenFields {
  const out: PersistableTokenFields = { accessToken: res.access_token };
  if (typeof res.refresh_token === "string" && res.refresh_token !== "") {
    out.refreshToken = res.refresh_token;
  }
  if (typeof res.expires_in === "number" && Number.isFinite(res.expires_in) && res.expires_in > 0) {
    out.expiresAt = now + res.expires_in * 1000;
  }
  return out;
}

/**
 * Fold freshly-issued token fields into an existing account.
 *
 * Rules, in order of how easy each is to get wrong:
 *
 *  - A new `refreshToken` replaces the old one. Notion mints a fresh pair per
 *    authorization since 2026-06-08, and the guidance is to store the pair
 *    from EVERY response including re-authorizations.
 *  - No `refreshToken` in the response KEEPS the stored one. The refresh grant
 *    may return null, and dropping our only refresh token on that response
 *    would strip the account's ability to ever refresh again — converting a
 *    recoverable state into a re-authorize-from-scratch state.
 *  - No `expiresAt` in the response CLEARS the stored one. Absent expiry means
 *    "no known expiry", which is exactly the pre-2026 long-lived-token
 *    behaviour; carrying a stale past expiry forward would make every
 *    subsequent request try to refresh.
 */
export function mergeTokenFields(
  account: NotionAccount,
  fields: PersistableTokenFields
): NotionAccount {
  const next: NotionAccount = { ...account, accessToken: fields.accessToken };
  if (fields.refreshToken !== undefined) {
    next.refreshToken = fields.refreshToken;
  }
  if (fields.expiresAt !== undefined) {
    next.expiresAt = fields.expiresAt;
  } else {
    delete next.expiresAt;
  }
  return next;
}

/**
 * Is this account's access token known to be expired?
 *
 * False when no `expiresAt` is stored — which is every account written by the
 * pre-2026 code, and every integration Notion doesn't send `expires_in` for.
 * Those keep behaving exactly as they did: we never pre-emptively refresh, and
 * a genuinely-dead token surfaces as today's `unauthorized` error.
 *
 * `skewMs` refreshes slightly ahead of the wire expiry so a token doesn't die
 * mid-flight on a slow request.
 */
export function isTokenExpired(account: NotionAccount, now: number, skewMs = 60_000): boolean {
  if (typeof account.expiresAt !== "number") return false;
  return account.expiresAt - skewMs <= now;
}
