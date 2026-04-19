// -----------------------------------------------------------------------------
// Cloudflare Worker entry. Routes:
//
//   POST /mcp/{MCP_AUTH_TOKEN}  → MCP JSON-RPC endpoint. Token in URL path acts
//                                  as the shared secret (Claude's custom connector
//                                  UI does not support a custom Authorization header,
//                                  so the token goes into the URL instead).
//   Also accepts `Authorization: Bearer {token}` on /mcp for clients that do
//   support headers (curl, other MCP clients).
//
//   GET  /oauth/callback        → Notion OAuth redirect target (no auth — Notion hits this)
//   GET  /                      → Plain info page (no secrets)
//   GET  /health                → "ok"
// -----------------------------------------------------------------------------

import { handleMcpRequest } from "./mcp/server";
import { handleOauthCallback } from "./oauth/flow";
import type { Env } from "./mcp/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Path-based auth: /mcp/{MCP_AUTH_TOKEN}
    if (env.MCP_AUTH_TOKEN && url.pathname === `/mcp/${env.MCP_AUTH_TOKEN}`) {
      return handleMcpRequest(request, env, { prevalidated: true });
    }
    // Header-based auth fallback: POST /mcp with Authorization: Bearer ...
    if (url.pathname === "/mcp") {
      return handleMcpRequest(request, env, { prevalidated: false });
    }

    if (url.pathname === "/oauth/callback") {
      return handleOauthCallback(request, env);
    }

    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(indexHtml(url.host), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function indexHtml(host: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>notion-multi-mcp</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;
margin:80px auto;padding:0 24px;color:#1f2328;line-height:1.55}code{background:#eaeef2;
padding:2px 6px;border-radius:4px}h1{font-size:22px}</style></head><body>
<h1>notion-multi-mcp</h1>
<p>Multi-account Notion MCP server. Point your MCP client at:</p>
<p><code>https://${host}/mcp/&lt;MCP_AUTH_TOKEN&gt;</code></p>
<p>or <code>https://${host}/mcp</code> with header <code>Authorization: Bearer &lt;MCP_AUTH_TOKEN&gt;</code>.</p>
<p>OAuth callback for Notion integrations: <code>https://${host}/oauth/callback</code></p>
</body></html>`;
}
