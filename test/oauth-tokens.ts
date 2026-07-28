// -----------------------------------------------------------------------------
// Unit tests for OAuth token-pair persistence and refresh.
//
// Covers:
//   - tokenFieldsFromResponse: refresh_token / expires_in are optional and an
//     absent value writes no key at all (migration-compatible record shape)
//   - mergeTokenFields: a new refresh token replaces; an absent one is KEPT;
//     an absent expiry CLEARS
//   - isTokenExpired: absent expiresAt ⇒ never expired (pre-2026 records)
//   - refreshAccountToken: happy path persists, no-refresh-token is a no-op,
//     a lost refresh race recovers by re-reading the store
//   - NotionClient retries once on `unauthorized` with the refreshed token
//   - redactTokenMaterial: no token material reaches an error message
// -----------------------------------------------------------------------------

import {
  isTokenExpired,
  mergeTokenFields,
  redactTokenMaterial,
  tokenFieldsFromResponse,
  type NotionTokenResponse,
} from "../src/oauth/token.ts";
import { refreshAccountToken, recoverFromUnauthorized } from "../src/accounts/refresh.ts";
import { AccountStore } from "../src/accounts/store.ts";
import { NotionClient } from "../src/notion/client.ts";
import type { Env, NotionAccount } from "../src/mcp/types.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg !== sw) {
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string } = {}): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    const prefix = opts.prefix ?? "";
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
}

function mkEnv(kv: MockKV): Env {
  return {
    NOTION_MCP_KV: kv as unknown as KVNamespace,
    MCP_AUTH_TOKEN: "mcp-token",
    NOTION_OAUTH_CLIENT_ID: "client-id",
    NOTION_OAUTH_CLIENT_SECRET: "client-secret",
  };
}

/** An account record in the shape the PRE-2026 code wrote: no refresh fields. */
function legacyAccount(): NotionAccount {
  return {
    id: "acct-legacy",
    name: "Legacy",
    accessToken: "old-access",
    botId: "bot-1",
    workspaceId: "ws-1",
    workspaceName: "Legacy WS",
    createdAt: 1_000,
  };
}

function modernAccount(overrides: Partial<NotionAccount> = {}): NotionAccount {
  return {
    id: "acct-modern",
    name: "Modern",
    accessToken: "access-v1",
    refreshToken: "refresh-v1",
    expiresAt: 5_000_000,
    botId: "bot-2",
    workspaceId: "ws-2",
    workspaceName: "Modern WS",
    createdAt: 2_000,
    ...overrides,
  };
}

function tokenResponse(over: Partial<NotionTokenResponse> = {}): NotionTokenResponse {
  return {
    access_token: "access-v2",
    token_type: "bearer",
    bot_id: "bot-2",
    workspace_name: "Modern WS",
    workspace_icon: null,
    workspace_id: "ws-2",
    owner: { type: "user" },
    duplicated_template_id: null,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// tokenFieldsFromResponse
// -----------------------------------------------------------------------------

console.log("\n[tokenFieldsFromResponse] optional fields are omitted, not undefined");
{
  const NOW = 1_000_000;
  const bare = tokenFieldsFromResponse(tokenResponse(), NOW);
  eq(bare, { accessToken: "access-v2" }, "no refresh_token / expires_in ⇒ only accessToken");
  eq(Object.keys(bare), ["accessToken"], "no stray undefined keys (record shape matches pre-2026 writes)");

  const full = tokenFieldsFromResponse(
    tokenResponse({ refresh_token: "refresh-v2", expires_in: 3600 }),
    NOW
  );
  eq(
    full,
    { accessToken: "access-v2", refreshToken: "refresh-v2", expiresAt: NOW + 3_600_000 },
    "expires_in is converted to an ABSOLUTE expiresAt"
  );
}

console.log("\n[tokenFieldsFromResponse] degenerate values are treated as absent");
{
  const NOW = 1_000_000;
  eq(
    tokenFieldsFromResponse(tokenResponse({ refresh_token: null }), NOW),
    { accessToken: "access-v2" },
    "refresh_token: null ⇒ absent (the refresh grant is documented to allow null)"
  );
  eq(
    tokenFieldsFromResponse(tokenResponse({ refresh_token: "" }), NOW),
    { accessToken: "access-v2" },
    "empty-string refresh_token ⇒ absent"
  );
  eq(
    tokenFieldsFromResponse(tokenResponse({ expires_in: 0 }), NOW),
    { accessToken: "access-v2" },
    "expires_in: 0 ⇒ absent (would otherwise mean 'already expired')"
  );
  eq(
    tokenFieldsFromResponse(tokenResponse({ expires_in: null }), NOW),
    { accessToken: "access-v2" },
    "expires_in: null ⇒ absent"
  );
}

// -----------------------------------------------------------------------------
// mergeTokenFields
// -----------------------------------------------------------------------------

console.log("\n[mergeTokenFields] refresh-token replacement rules");
{
  const acct = modernAccount();
  const withNew = mergeTokenFields(acct, { accessToken: "a2", refreshToken: "r2", expiresAt: 9_000 });
  eq(withNew.accessToken, "a2", "access token replaced");
  eq(withNew.refreshToken, "r2", "a new refresh token replaces the stored one");
  eq(withNew.expiresAt, 9_000, "expiry replaced");

  const withoutNew = mergeTokenFields(acct, { accessToken: "a3" });
  eq(
    withoutNew.refreshToken,
    "refresh-v1",
    "an ABSENT refresh token keeps the stored one — dropping it would strip the ability to ever refresh again"
  );
  eq(withoutNew.expiresAt, undefined, "an absent expiry CLEARS the stored one ('no known expiry')");
  assert(!("expiresAt" in withoutNew), "…and removes the key entirely rather than leaving undefined");
}

console.log("\n[mergeTokenFields] does not mutate its input");
{
  const acct = modernAccount();
  mergeTokenFields(acct, { accessToken: "a9" });
  eq(acct.accessToken, "access-v1", "original account object untouched");
}

console.log("\n[mergeTokenFields] a legacy record can gain refresh material");
{
  const acct = legacyAccount();
  const upgraded = mergeTokenFields(acct, { accessToken: "a2", refreshToken: "r1", expiresAt: 42 });
  eq(upgraded.refreshToken, "r1", "legacy account picks up a refresh token on re-auth");
  eq(upgraded.expiresAt, 42, "…and an expiry");
  eq(upgraded.workspaceName, "Legacy WS", "unrelated fields preserved");
}

// -----------------------------------------------------------------------------
// isTokenExpired
// -----------------------------------------------------------------------------

console.log("\n[isTokenExpired] absent expiresAt ⇒ never expired (migration safety)");
{
  eq(isTokenExpired(legacyAccount(), 999_999_999_999), false, "pre-2026 record is never treated as expired");
}

console.log("\n[isTokenExpired] boundary behaviour with skew");
{
  const acct = modernAccount({ expiresAt: 1_000_000 });
  eq(isTokenExpired(acct, 500_000), false, "well before expiry ⇒ live");
  eq(isTokenExpired(acct, 1_000_001), true, "past expiry ⇒ expired");
  eq(isTokenExpired(acct, 950_000), true, "inside the 60s skew window ⇒ refresh early");
  eq(isTokenExpired(acct, 930_000), false, "outside the skew window ⇒ still live");
  eq(isTokenExpired(acct, 999_999, 0), false, "skew is configurable");
}

// -----------------------------------------------------------------------------
// redactTokenMaterial
// -----------------------------------------------------------------------------

console.log("\n[redactTokenMaterial] token material never reaches an error string");
{
  const body = JSON.stringify({
    access_token: "secret_ntn_abc123",
    refresh_token: "secret_refresh_xyz",
    workspace_name: "Fine To Show",
  });
  const out = redactTokenMaterial(body);
  assert(!out.includes("secret_ntn_abc123"), "access_token value removed");
  assert(!out.includes("secret_refresh_xyz"), "refresh_token value removed");
  assert(out.includes("Fine To Show"), "non-secret fields survive so errors stay diagnosable");
  assert(out.includes("[redacted]"), "replacement marker present");
}

console.log("\n[redactTokenMaterial] handles escaped quotes inside the token value");
{
  const out = redactTokenMaterial('{"access_token":"ab\\"cd","x":1}');
  assert(!out.includes("ab"), "value with an escaped quote is fully removed");
  assert(out.includes('"x":1'), "the rest of the body is intact");
}

// -----------------------------------------------------------------------------
// refreshAccountToken
// -----------------------------------------------------------------------------

/** Install a stub global fetch for the token endpoint; returns a restore fn. */
function stubTokenFetch(handler: (body: Record<string, unknown>) => { status: number; json: unknown }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    const { status, json } = handler(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

console.log("\n[refreshAccountToken] happy path exchanges and persists");
{
  const kv = new MockKV();
  const env = mkEnv(kv);
  const store = new AccountStore(kv as unknown as KVNamespace);
  const acct = modernAccount();
  await store.put(acct);

  let sentGrant = "";
  let sentRefresh = "";
  const restore = stubTokenFetch((body) => {
    sentGrant = String(body.grant_type);
    sentRefresh = String(body.refresh_token);
    return { status: 200, json: tokenResponse({ access_token: "access-v2", refresh_token: "refresh-v2", expires_in: 3600 }) };
  });
  const out = await refreshAccountToken(env, acct);
  restore();

  eq(sentGrant, "refresh_token", "used the refresh_token grant");
  eq(sentRefresh, "refresh-v1", "sent the stored refresh token");
  eq(out?.accessToken, "access-v2", "returned the new access token");
  eq(out?.refreshToken, "refresh-v2", "returned the rotated refresh token");

  const persisted = await store.getById("acct-modern");
  eq(persisted?.accessToken, "access-v2", "new access token was PERSISTED");
  eq(persisted?.refreshToken, "refresh-v2", "rotated refresh token was PERSISTED");
  assert(typeof persisted?.expiresAt === "number", "an absolute expiry was persisted");
}

console.log("\n[refreshAccountToken] no refresh token ⇒ null, no network call");
{
  const kv = new MockKV();
  const env = mkEnv(kv);
  let called = false;
  const restore = stubTokenFetch(() => {
    called = true;
    return { status: 200, json: tokenResponse() };
  });
  const out = await refreshAccountToken(env, legacyAccount());
  restore();
  eq(out, null, "returns null for an account with no refresh token");
  eq(called, false, "never hit the token endpoint");
}

console.log("\n[refreshAccountToken] Notion rejects the grant ⇒ null (fails soft)");
{
  const kv = new MockKV();
  const env = mkEnv(kv);
  const store = new AccountStore(kv as unknown as KVNamespace);
  const acct = modernAccount();
  await store.put(acct);

  const restore = stubTokenFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
  const out = await refreshAccountToken(env, acct);
  restore();
  eq(out, null, "returns null rather than throwing");

  const persisted = await store.getById("acct-modern");
  eq(persisted?.accessToken, "access-v1", "the stored token was left alone");
}

console.log("\n[refreshAccountToken] a lost refresh race recovers by re-reading the store");
{
  const kv = new MockKV();
  const env = mkEnv(kv);
  const store = new AccountStore(kv as unknown as KVNamespace);
  const acct = modernAccount();
  await store.put(acct);

  // Simulate the other isolate winning: it already persisted a new token, and
  // our grant is rejected because our refresh token was consumed.
  await store.put({ ...acct, accessToken: "access-from-winner", refreshToken: "refresh-from-winner" }, { allowOverwriteName: true });

  const restore = stubTokenFetch(() => ({ status: 400, json: { error: "invalid_grant" } }));
  const out = await refreshAccountToken(env, acct);
  restore();

  eq(out?.accessToken, "access-from-winner", "picked up the winner's token instead of reporting failure");
}

console.log("\n[refreshAccountToken] missing OAuth client config ⇒ null, no network call");
{
  const kv = new MockKV();
  const env = { ...mkEnv(kv), NOTION_OAUTH_CLIENT_ID: "" };
  let called = false;
  const restore = stubTokenFetch(() => {
    called = true;
    return { status: 200, json: tokenResponse() };
  });
  const out = await refreshAccountToken(env, modernAccount());
  restore();
  eq(out, null, "returns null when the worker has no OAuth credentials");
  eq(called, false, "never hit the token endpoint");
}

// -----------------------------------------------------------------------------
// recoverFromUnauthorized + NotionClient retry
// -----------------------------------------------------------------------------

console.log("\n[recoverFromUnauthorized] returns only the access token and syncs the in-memory account");
{
  const kv = new MockKV();
  const env = mkEnv(kv);
  const store = new AccountStore(kv as unknown as KVNamespace);
  const acct = modernAccount();
  await store.put(acct);

  const restore = stubTokenFetch(() => ({
    status: 200,
    json: tokenResponse({ access_token: "access-v2", refresh_token: "refresh-v2" }),
  }));
  const token = await recoverFromUnauthorized(env, acct);
  restore();

  eq(token, "access-v2", "returns the bare access token string");
  eq(acct.accessToken, "access-v2", "in-memory account updated for the rest of this invocation");
  eq(acct.refreshToken, "refresh-v2", "…including the rotated refresh token");
  eq(acct.expiresAt, undefined, "…and the cleared expiry (response carried no expires_in)");
}

console.log("\n[NotionClient] retries once on `unauthorized` with the refreshed token");
{
  const responses = [
    { status: 401, body: { code: "unauthorized", message: "API token is invalid." } },
    { status: 200, body: { object: "page", id: "p1" } },
  ];
  const sentAuth: string[] = [];
  let i = 0;
  let refreshCalls = 0;

  const client = new NotionClient(modernAccount(), {
    fetchImpl: (async (_u: string, init?: { headers?: Record<string, string> }) => {
      sentAuth.push(init?.headers?.authorization ?? "");
      const spec = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return {
        ok: spec.status === 200,
        status: spec.status,
        headers: {},
        json: async () => spec.body,
        text: async () => JSON.stringify(spec.body),
      };
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
    onUnauthorized: async () => {
      refreshCalls++;
      return "access-v2";
    },
  });

  const out = await client.request<{ id: string }>("/pages/p1");
  eq(out.id, "p1", "request succeeded after refresh");
  eq(refreshCalls, 1, "refresh was attempted exactly once");
  eq(sentAuth[0], "Bearer access-v1", "first attempt used the stale token");
  eq(sentAuth[1], "Bearer access-v2", "retry used the REFRESHED token");
}

console.log("\n[NotionClient] refresh is attempted at most once per request");
{
  let refreshCalls = 0;
  let calls = 0;
  const client = new NotionClient(modernAccount(), {
    fetchImpl: (async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        headers: {},
        json: async () => ({}),
        text: async () => JSON.stringify({ code: "unauthorized", message: "nope" }),
      };
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
    onUnauthorized: async () => {
      refreshCalls++;
      return "access-v2";
    },
  });

  let threw = "";
  try {
    await client.request("/pages/p1");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(refreshCalls, 1, "did not loop refresh→401→refresh");
  eq(calls, 2, "one original attempt plus one post-refresh retry");
  assert(threw.includes("401"), "the original error surfaces once refresh can't help");
}

console.log("\n[NotionClient] no refresh hook ⇒ 401 behaves exactly as before");
{
  let calls = 0;
  const client = new NotionClient(legacyAccount(), {
    fetchImpl: (async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        headers: {},
        json: async () => ({}),
        text: async () => JSON.stringify({ code: "unauthorized", message: "nope" }),
      };
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
  });
  let threw = "";
  try {
    await client.request("/pages/p1");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(calls, 1, "single attempt, no retry");
  assert(threw.includes("Notion API 401"), "unchanged error message");
}

console.log("\n[NotionClient] a refresh that returns null lets the original error stand");
{
  let calls = 0;
  const client = new NotionClient(modernAccount(), {
    fetchImpl: (async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        headers: {},
        json: async () => ({}),
        text: async () => JSON.stringify({ code: "unauthorized", message: "nope" }),
      };
    }) as unknown as typeof fetch,
    sleepImpl: async () => {},
    onUnauthorized: async () => null,
  });
  let threw = "";
  try {
    await client.request("/pages/p1");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  eq(calls, 1, "no retry when refresh isn't possible");
  assert(threw.includes("Notion API 401"), "today's error is returned");
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
