# notion-multi-mcp

A multi-account Notion MCP server, hosted on Cloudflare Workers. Gives you (and Claude) the ability to switch between client Notion workspaces mid-session without reconnecting.

## What's included today (Phase 1)

| Tool | Status |
| --- | --- |
| `notion_account_add` | ✅ Kicks off OAuth, returns authorize URL |
| `notion_account_list` | ✅ Lists connected accounts by name + workspace |
| `notion_account_remove` | ✅ Removes by name or id |
| `notion_account_rename` | ✅ Renames with uniqueness enforcement |
| `notion_fetch` | ✅ Fetch pages, databases, data sources |
| `notion_search` | ✅ Workspace search |
| `notion_get_users` | ✅ List/filter users, self-lookup |
| `notion_get_teams` | ⚠️ Notion public API doesn't expose this — returns explanatory note |
| `notion_get_comments` | ✅ Fully implemented |
| `notion_create_comment` | ✅ Page-level + replies (content-anchored not supported by public API) |
| `notion_move_pages` | ✅ Fully implemented |
| `notion_create_pages` | 🚧 Phase 2 stub (needs Notion-flavored Markdown converter) |
| `notion_update_page` | 🚧 Phase 2 stub |
| `notion_create_database` | 🚧 Phase 3 stub (needs SQL DDL parser) |
| `notion_update_data_source` | 🚧 Phase 3 stub |
| `notion_create_view` / `notion_update_view` | 🚧 Phase 4 stub (needs View DSL parser) |
| `notion_duplicate_page` | 🚧 Phase 4 stub (needs block walker) |

Phase 2/3/4 stubs register with the same tool names + parity schemas, so Claude sees the complete tool surface and Phases can be upgraded in place without breaking anything.

## Deploy (one-time setup)

### 1. Create the Notion public OAuth integration

Go to https://www.notion.so/profile/integrations → **+ New integration** → **Public**.

- Capabilities: check all (read/update/insert content, read/insert comments, read user info)
- Redirect URIs: `https://notion-multi-mcp.<YOUR-CF-SUBDOMAIN>.workers.dev/oauth/callback`
  (you'll know the exact URL after the first deploy — start with a placeholder, then update)

Grab the **OAuth Client ID** and **OAuth Client Secret**.

### 2. Create the KV namespace

```bash
npx wrangler kv namespace create NOTION_MCP_KV
```

Copy the returned `id` into `wrangler.toml` under `[[kv_namespaces]]`.

### 3. Set secrets

```bash
npx wrangler secret put MCP_AUTH_TOKEN              # any long random string — you'll paste this in your MCP client config
npx wrangler secret put NOTION_OAUTH_CLIENT_ID
npx wrangler secret put NOTION_OAUTH_CLIENT_SECRET
```

### 4. Deploy

```bash
npm install
npx wrangler deploy
```

Note the URL the deploy returns (e.g. `https://notion-multi-mcp.reneceo.workers.dev`).

### 5. Update the Notion integration's redirect URI

Go back to your Notion integration and set the redirect URI to:
```
https://<worker-url>/oauth/callback
```

## Connect it to Claude

Add this to your Claude MCP client config (Claude Desktop, Claude Code, or Cowork's MCP settings):

```json
{
  "mcpServers": {
    "notion-multi": {
      "transport": {
        "type": "http",
        "url": "https://<worker-url>/mcp",
        "headers": {
          "Authorization": "Bearer <MCP_AUTH_TOKEN>"
        }
      }
    }
  }
}
```

(Exact UI varies by client. The values you need: the `/mcp` URL and the `Authorization: Bearer ...` header.)

## Adding your first account

Once connected to Claude:

1. Ask Claude: **"Add a new Notion account called VirtualLatinos"**
2. Claude calls `notion_account_add({ name: "VirtualLatinos" })` and gets back an authorize URL.
3. Open that URL in your browser → log in to the client's Notion → pick the pages to share with the integration → approve.
4. You'll see a ✅ success page. The account is ready.
5. `notion_account_list` will now show it.

To use it: just reference the name. "**Fetch the homepage from VirtualLatinos**" → Claude calls `notion_fetch({ account: "VirtualLatinos", id: "..." })`.

## Architecture

```
┌────────────┐      HTTP         ┌──────────────────────────────┐     Notion REST API
│   Claude   │ ───────────────▶  │  Cloudflare Worker (/mcp)    │  ───────────────────▶  Notion
│            │  Bearer token     │                              │  Per-account Bearer
└────────────┘                   │  ├── OAuth callback handler  │
                                 │  ├── Account store (KV)      │
                                 │  ├── Account resolver        │
                                 │  ├── Tool registry           │
                                 │  └── Notion API client       │
                                 └──────────────────────────────┘
                                           │
                                           ▼
                                   ┌───────────────────┐
                                   │  Cloudflare KV    │
                                   │                   │
                                   │  account:{id}     │
                                   │  name_index:{lc}  │
                                   │  accounts         │
                                   │  oauth_state:{s}  │
                                   └───────────────────┘
```

## Roadmap

See [PHASE2-ROADMAP.md](./PHASE2-ROADMAP.md) for the Phase 2 build plan (Markdown converter + page tools). Phases 3 and 4 build on the same scaffolding.

## Security notes

- **`MCP_AUTH_TOKEN`** is required on every `/mcp` request. Treat it like a password.
- **Access tokens** are stored per-account in KV. Cloudflare KV is encrypted at rest. If you rotate your CF account, KV carries over.
- **OAuth state** keys expire after 10 minutes and are consumed on first use — can't be replayed.
- **Removing an account** deletes the token from your KV but does **not** revoke the integration inside the client's Notion workspace. Revoke there if needed (clients can revoke at any time from their workspace settings).
