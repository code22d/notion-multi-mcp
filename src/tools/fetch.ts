// -----------------------------------------------------------------------------
// notion_fetch — get details on a page, database, or data source by ID/URL.
//
// Accepts the same `id` forms the native MCP accepts:
//   - Raw UUIDs (with or without dashes)
//   - notion.so URLs
//   - *.notion.site URLs
//   - collection:// URIs for data sources
//
// Returns a Markdown-style text response describing the object.
// For full parity with the native MCP (enhanced Markdown + <data-source>/<page-discussions>
// tags), see Phase 2 additions. This Phase 1 implementation returns a clean human-readable
// summary plus raw JSON for the caller to parse if needed.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA, createNotionClient } from "../accounts/resolver";
import { dataSourceDisplayName, stripDashes } from "../notion/client";
import { richTextToPlain } from "../notion/markdown/rich-text";

export function registerFetchTool(register: (def: ToolDef) => void): void {
  register({
    name: "notion_fetch",
    description:
      "Fetch a Notion page, database, or data source by URL or ID on the specified account. Returns a summary plus full JSON. Supports notion.so URLs, *.notion.site URLs, raw UUIDs, collection:// data-source URIs, and discussion:// URIs.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        id: {
          type: "string",
          description:
            "URL or ID of the Notion page, database, data source, or discussion to fetch.",
        },
        include_discussions: {
          type: "boolean",
          description: "Include discussion counts and markers (page-level only).",
        },
      },
      required: ["account", "id"],
      additionalProperties: false,
    },
    handler: fetchHandler,
  });
}

async function fetchHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const rawId = String(args.id ?? "").trim();
  if (!rawId) return { isError: true, content: [{ type: "text", text: "`id` is required." }] };

  const target = parseNotionIdentifier(rawId);
  const client = createNotionClient(account, ctx);

  if (target.kind === "data_source") {
    const ds = await client.getDataSource(target.id);
    return textBlock(formatDataSourceSummary(ds));
  }

  // Try page first — that's the most common case.
  try {
    const page = await client.getPage(target.id);
    const title = extractPageTitle(page.properties);
    const parts: string[] = [
      `# Page: ${title || "(untitled)"}`,
      `URL: ${page.url}`,
      `ID: ${page.id}`,
      `Last edited: ${page.last_edited_time}`,
      `Archived: ${page.archived ? "yes" : "no"}`,
    ];

    // Append block children (text content) — shallow walk, since a full enhanced-markdown
    // conversion is in Phase 2. For now we render plain-text outlines.
    try {
      const blocks = await client.listAllBlockChildren(target.id);
      if (blocks.length > 0) {
        parts.push("", "## Content (plain outline)", renderBlocksAsOutline(blocks));
      }
    } catch {
      // ignore — block read failures shouldn't break the page fetch
    }

    parts.push("", "## Properties", describeProperties(page.properties));
    parts.push("", "## Raw JSON", "```json", JSON.stringify(page, null, 2), "```");

    if (args.include_discussions) {
      try {
        const comments = await client.listComments(target.id);
        parts.push("", "## Discussions", `Total top-level comments: ${comments.results.length}`);
      } catch {
        /* ignore */
      }
    }

    return textBlock(parts.join("\n"));
  } catch (pageErr) {
    // Not a page — try database.
    try {
      const db = await client.getDatabase(target.id);
      const title = db.title.map((r) => r.plain_text ?? "").join("");
      const parts: string[] = [
        `# Database: ${title || "(untitled)"}`,
        `URL: ${db.url}`,
        `ID: ${db.id}`,
        `Inline: ${db.is_inline ? "yes" : "no"}`,
      ];
      if (db.data_sources && db.data_sources.length > 0) {
        parts.push("", "## Data Sources");
        for (const ds of db.data_sources) {
          parts.push(`- ${dataSourceDisplayName(ds)} — collection://${ds.id}`);
        }
      }
      parts.push("", "## Properties", describeProperties(db.properties));
      parts.push("", "## Raw JSON", "```json", JSON.stringify(db, null, 2), "```");
      return textBlock(parts.join("\n"));
    } catch (dbErr) {
      const pageMsg = pageErr instanceof Error ? pageErr.message : String(pageErr);
      const dbMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      throw new Error(
        `Could not fetch "${rawId}" as a page or database. Page error: ${pageMsg}. Database error: ${dbMsg}.`
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Identifier parsing
// -----------------------------------------------------------------------------

interface ParsedIdentifier {
  kind: "page_or_database" | "data_source" | "discussion";
  id: string;
}

export function parseNotionIdentifier(input: string): ParsedIdentifier {
  const trimmed = input.trim();

  // collection:// prefix = data source
  if (trimmed.startsWith("collection://")) {
    return { kind: "data_source", id: stripDashes(trimmed.slice("collection://".length)) };
  }

  // discussion:// prefix
  if (trimmed.startsWith("discussion://")) {
    // Format: discussion://pageId/blockId/discussionId — for our purposes we return the discussion id.
    const parts = trimmed.slice("discussion://".length).split("/");
    const last = parts[parts.length - 1] ?? "";
    return { kind: "discussion", id: stripDashes(last) };
  }

  // URL form: notion.so/... or *.notion.site/...
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      // Pick the last path segment, then the trailing 32-hex UUID
      const lastSeg = u.pathname.split("/").filter(Boolean).pop() ?? "";
      const match = lastSeg.match(/([0-9a-fA-F]{32})/) ?? lastSeg.match(/([0-9a-fA-F-]{36})/);
      if (match) return { kind: "page_or_database", id: stripDashes(match[1]!) };
    } catch {
      /* fall through */
    }
  }

  // Bare UUID
  const match = trimmed.match(/^[0-9a-fA-F-]{32,36}$/);
  if (match) return { kind: "page_or_database", id: stripDashes(trimmed) };

  // Last resort — try stripping dashes & see if we got 32 hex chars
  const s = stripDashes(trimmed);
  if (/^[0-9a-fA-F]{32}$/.test(s)) return { kind: "page_or_database", id: s };

  throw new Error(`Could not parse Notion identifier: "${input}"`);
}

// -----------------------------------------------------------------------------
// Rendering helpers (light — Phase 2 replaces these with full Markdown spec)
// -----------------------------------------------------------------------------

function extractPageTitle(properties: Record<string, unknown>): string {
  for (const key of Object.keys(properties)) {
    const p = properties[key] as { type?: string; title?: unknown[] } | undefined;
    if (p?.type === "title" && Array.isArray(p.title)) {
      return richTextToPlain(p.title as import("../notion/client").NotionRichText[]);
    }
  }
  return "";
}

function describeProperties(properties: Record<string, unknown> | undefined | null): string {
  // In API version 2025-09-03+, database properties live on the individual
  // data sources, not the top-level database object. Guard accordingly.
  if (!properties) return "_(none — properties live on the data sources; fetch a `collection://<id>` to see them)_";
  const keys = Object.keys(properties);
  if (keys.length === 0) return "_(none)_";
  return keys
    .map((k) => {
      const p = properties[k] as { type?: string } | undefined;
      return `- **${k}**: ${p?.type ?? "unknown"}`;
    })
    .join("\n");
}

function renderBlocksAsOutline(blocks: import("../notion/client").NotionBlockObject[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    lines.push(`- [${b.type}] ${summarizeBlock(b)}`);
  }
  return lines.join("\n");
}

function summarizeBlock(b: import("../notion/client").NotionBlockObject): string {
  const bucket = (b as Record<string, unknown>)[b.type];
  if (bucket && typeof bucket === "object" && "rich_text" in bucket) {
    const rt = (bucket as { rich_text: import("../notion/client").NotionRichText[] }).rich_text;
    const preview = richTextToPlain(rt).slice(0, 120);
    return preview;
  }
  return "";
}

function textBlock(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Pure formatter for a data-source `notion_fetch` response. Exported so tests
 * can assert the heading renders the correct name across legacy `name` and
 * 2025-09-03 `title` (rich_text array) shapes, without needing a live client.
 */
export function formatDataSourceSummary(ds: import("../notion/client").NotionDataSourceObject): string {
  return [
    `# Data Source: ${dataSourceDisplayName(ds)}`,
    `ID: ${ds.id}`,
    `Parent database: ${ds.database_parent?.database_id ?? "(none)"}`,
    "",
    "## Schema",
    describeProperties(ds.properties),
    "",
    "## Raw JSON",
    "```json",
    JSON.stringify(ds, null, 2),
    "```",
  ].join("\n");
}
