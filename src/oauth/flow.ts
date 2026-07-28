// -----------------------------------------------------------------------------
// Notion OAuth flow — authorize URL generation + callback handler.
//
// OAuth state pattern:
//   1. `notion_account_add({name})` generates a random `state` and stores it
//      under `oauth_state:{state}` → {proposedName, createdAt} with a 10-min TTL.
//   2. User opens the authorize URL in their browser and approves in Notion.
//   3. Notion redirects to /oauth/callback?code=...&state=...
//   4. Worker looks up state → gets proposedName. If missing/expired → error.
//   5. Worker POSTs to /v1/oauth/token with the code → gets access token + workspace info.
//   6. Worker builds a NotionAccount and persists it to KV.
//   7. State key is deleted.
//   8. User sees a success page.
// -----------------------------------------------------------------------------

import type { Env, NotionAccount } from "../mcp/types";
import { AccountStore } from "../accounts/store";
import {
  exchangeAuthorizationCode,
  tokenFieldsFromResponse,
  type NotionTokenResponse,
} from "./token";

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const STATE_TTL_SECONDS = 60 * 10; // 10 minutes

interface StateRecord {
  proposedName: string;
  createdAt: number;
}

// -----------------------------------------------------------------------------
// Authorize URL
// -----------------------------------------------------------------------------

export async function createAuthorizeUrl(
  env: Env,
  baseUrl: string,
  proposedName: string
): Promise<{ url: string; state: string }> {
  if (!env.NOTION_OAUTH_CLIENT_ID) {
    throw new Error(
      "NOTION_OAUTH_CLIENT_ID is not configured. Set it with `wrangler secret put NOTION_OAUTH_CLIENT_ID`."
    );
  }
  const trimmed = proposedName.trim();
  if (!trimmed) throw new Error("Name cannot be empty.");

  // Check that the name isn't already used (friendly early error).
  const store = new AccountStore(env.NOTION_MCP_KV);
  const existing = await store.getByName(trimmed);
  if (existing) {
    throw new Error(
      `An account named "${trimmed}" already exists (workspace: ${existing.workspaceName}). Pick a different name or remove the existing account first.`
    );
  }

  const state = cryptoRandomString(32);
  const record: StateRecord = { proposedName: trimmed, createdAt: Date.now() };
  await env.NOTION_MCP_KV.put(`oauth_state:${state}`, JSON.stringify(record), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const redirectUri = `${baseUrl}/oauth/callback`;
  const params = new URLSearchParams({
    client_id: env.NOTION_OAUTH_CLIENT_ID,
    response_type: "code",
    owner: "user",
    redirect_uri: redirectUri,
    state,
  });

  return {
    url: `${NOTION_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

// -----------------------------------------------------------------------------
// Callback handler
// -----------------------------------------------------------------------------

export async function handleOauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (error) {
    return htmlResponse(
      errorPage(`Notion returned error: ${error}. You can close this tab and try again.`)
    );
  }
  if (!code || !state) {
    return htmlResponse(errorPage("Missing `code` or `state` in the callback URL."), 400);
  }

  const stateKey = `oauth_state:${state}`;
  const stateRaw = await env.NOTION_MCP_KV.get(stateKey);
  if (!stateRaw) {
    return htmlResponse(
      errorPage("This authorization link has expired or was already used. Start over with notion_account_add."),
      400
    );
  }
  const stateRec = JSON.parse(stateRaw) as StateRecord;
  // Consume the state immediately so a second callback can't replay it.
  await env.NOTION_MCP_KV.delete(stateKey);

  // Exchange code for access token
  const redirectUri = `${deriveBaseUrl(request, env)}/oauth/callback`;
  let tokenData: NotionTokenResponse;
  try {
    tokenData = await exchangeCode(env, code, redirectUri);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return htmlResponse(errorPage(`Token exchange failed: ${message}`), 502);
  }

  const store = new AccountStore(env.NOTION_MCP_KV);
  const id = cryptoRandomString(24);
  // Persist the WHOLE token pair, not just the access token. Since 2026-06-08
  // Notion mints a fresh access_token AND refresh_token on every successful
  // authorization, with explicit guidance to store the pair from every
  // response. Both fields are spread conditionally, so a connection that
  // returns neither writes exactly the record shape the old code wrote.
  const tokenFields = tokenFieldsFromResponse(tokenData, Date.now());
  const account: NotionAccount = {
    id,
    name: stateRec.proposedName,
    accessToken: tokenFields.accessToken,
    ...(tokenFields.refreshToken !== undefined ? { refreshToken: tokenFields.refreshToken } : {}),
    ...(tokenFields.expiresAt !== undefined ? { expiresAt: tokenFields.expiresAt } : {}),
    botId: tokenData.bot_id,
    workspaceId: tokenData.workspace_id,
    workspaceName: tokenData.workspace_name ?? "(unnamed workspace)",
    ...(tokenData.workspace_icon ? { workspaceIcon: tokenData.workspace_icon } : {}),
    owner: tokenData.owner,
    createdAt: Date.now(),
  };

  try {
    await store.put(account);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return htmlResponse(errorPage(`Failed to persist account: ${message}`), 500);
  }

  return htmlResponse(successPage(account));
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function exchangeCode(env: Env, code: string, redirectUri: string): Promise<NotionTokenResponse> {
  // Delegates to oauth/token.ts so the code-exchange and refresh grants share
  // one implementation of the endpoint, the Basic-auth header, the pinned
  // notion-version, and the token-redacting error path.
  return exchangeAuthorizationCode(env, code, redirectUri);
}

function cryptoRandomString(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function deriveBaseUrl(request: Request, env: Env): string {
  if (env.PUBLIC_BASE_URL && env.PUBLIC_BASE_URL.length > 0) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function successPage(account: NotionAccount): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Account connected</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;
       max-width:480px;margin:80px auto;padding:0 24px;color:#1f2328;line-height:1.55}
  h1{font-size:22px}.card{border:1px solid #d0d7de;border-radius:12px;padding:24px;
       background:#f6f8fa}.k{color:#57606a}.v{font-weight:600}code{background:#eaeef2;
       padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body>
<h1>✅ Account connected</h1>
<div class="card">
<p><span class="k">Name:</span> <span class="v">${escapeHtml(account.name)}</span></p>
<p><span class="k">Workspace:</span> <span class="v">${escapeHtml(account.workspaceName)}</span></p>
<p><span class="k">Account ID:</span> <code>${account.id}</code></p>
</div>
<p>You can close this tab. The account is ready to use from Claude — reference it as <code>${escapeHtml(account.name)}</code>.</p>
</body></html>`;
}

function errorPage(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Error</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;
       max-width:480px;margin:80px auto;padding:0 24px;color:#1f2328;line-height:1.55}
  h1{font-size:22px;color:#cf222e}.card{border:1px solid #ffcccc;border-radius:12px;
       padding:24px;background:#fff5f5}
</style></head><body>
<h1>Something went wrong</h1>
<div class="card"><p>${escapeHtml(message)}</p></div>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
