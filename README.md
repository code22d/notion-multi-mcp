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
| `notion_create_pages` | ✅ Phase 2 — Markdown → Notion blocks conversion for CORE block types (paragraphs, headings, lists, task lists, quotes, code, divider, callouts, toggles, tables, images, page links, equations) |
| `notion_update_page` | 🚧 Phase 2 stub (Markdown diff engine still pending) |
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

## Local development

```bash
npm test          # full suite, no network
npm run typecheck
npx wrangler dev  # run the worker locally
```

### `VALIDATE_BLOCK_BODIES` — catching bad request bodies before Notion does

Every test in this repo asserts against a **stubbed `fetch`**, and a stub accepts any
body — including ones Notion rejects outright. That is how
`{"type":"tab","tab":{}}` shipped with a green suite and 400'd in production.

Setting `VALIDATE_BLOCK_BODIES=1` makes the Notion client check every
block-carrying request body (`notion_create_pages`' `children`, and every
`appendBlockChildren`) against [`src/notion/block-write-schema.ts`](./src/notion/block-write-schema.ts)
*before sending it*, and log anything the write schema would reject:

```bash
VALIDATE_BLOCK_BODIES=1 npx wrangler dev
```

Then exercise the create/append tools against a real workspace and watch the
wrangler console:

```
[notion-multi-mcp] VALIDATE_BLOCK_BODIES: createPage would send 1 block(s) Notion's
write schema rejects. Sending anyway.
  children[1]: `tab.children` is required by the write schema but is absent
```

Three things to know about it:

- **It logs, it never throws.** The request is sent regardless. The validator is a
  transcription of Notion's generated request types, not the server; a wrong verdict
  must cost a log line and nothing else.
- **It is off by default.** Unset, the cost is one boolean test per create/append and
  request bodies are byte-identical to what they'd otherwise be. Don't set it in
  `wrangler.toml` for a deploy.
- **It logs block paths, types and violations — never payloads.** No page text, no
  URLs, no icons, no token material.

All three of those, and three more, are pinned by
[`test/validate-block-bodies.ts`](./test/validate-block-bodies.ts) — off by default
(byte-identical requests, zero log calls), on for every accepted spelling and no
other, never throws (including when the validator itself raises mid-walk), never
leaks (a body stuffed with canaries in every field that could hold something
private), reports each of the three bodies that caused real production 400s, and
stays silent on a well-formed body carrying every block type this repo emits.

What it still cannot tell you is whether Notion **agrees** — the table is a
transcription of the SDK's generated request types, not the server. A false
positive costs a log line, which is the whole design; a false negative means the
flag is quietly narrower than it looks. Only a live call closes that.

## `notion_update_page` — when block ids survive, and when they don't

Notion attaches **block-level comments to block ids**. Delete a block and recreate it
with the same text and the comment thread does not come back. So "did this edit
preserve ids?" is really "did this edit preserve the discussion on the page?", and
`update_content` picks the narrowest of three strategies to keep as many as it can:

| path | what it does | ids preserved |
| --- | --- | --- |
| fast | `PATCH /v1/blocks/{id}` on the one leaf block that changed | ✅ all |
| medium | delete only the affected run, append the replacement anchored after the last unchanged block | ✅ every block outside the affected run |
| full | delete every block on the page, append the new content | ❌ **none** |

`replace_content` and `apply_template` are always a full rewrite — that is what they
are for. `update_content` uses the full path only when it has no alternative:

- **the edit changes the first block on the page.** The append endpoint can only place
  content *after* an existing block, and there is no prepend, so there is no anchor.
- **the edit inserts more than 100 blocks at once.** That needs several anchored
  appends in sequence, and their ordering depends on each response echoing the blocks
  it created — which nothing has yet confirmed against the live API.
- **every block on the page changed.** Nothing to preserve either way.

Deeply nested insertions used to be a fourth case and are not any more: content nested
deeper than one request body can carry is now split across follow-up appends *under the
blocks the anchored append just created*, so the anchor survives.

When the full path does fire, the tool result says what it cost, in as many words:

```
Full fallback — affected range starts at page index 0 (Notion has no prepend endpoint).
Replaced page 3acde14e… content — deleted 5 existing blocks, appended 5 new blocks.

⚠️  This rewrote the whole page: every block was deleted and recreated, so block ids
were NOT preserved and any block-level comments that were attached to them are gone.
The page's content is intact — this is a structural cost, not a content loss. …
```

If ids matter for a particular page, keep edits away from the first block — an
unchanged heading or intro paragraph at the top is enough of an anchor for everything
below it to take the medium path.

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
