// -----------------------------------------------------------------------------
// notion_create_comment, notion_get_comments
//
// Fully implemented in Phase 1. Notion's comment API is simple enough that
// we don't need the full Markdown/DDL/DSL infrastructure for parity.
//
// Note on selection_with_ellipsis: the native MCP supports creating a comment
// anchored to a specific string selection inside a block. Notion's public API
// only supports page-level comments and replies to existing discussions — it
// does NOT support the content-anchored create the native MCP's internal API
// offers. We expose what's supported and return a clear note for the unsupported
// case so Claude can fall back gracefully.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import { NotionClient } from "../notion/client";
import { plainToRichText, richTextToMarkdown } from "../notion/markdown/rich-text";

export function registerCommentTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_comment",
    description:
      "Create a comment on a Notion page or reply to a discussion. Provide `page_id` for a page-level comment, or `discussion_id` to reply to an existing discussion. Note: anchoring a comment to specific block content (selection_with_ellipsis) is not supported by Notion's public API and will return an explanatory error.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string", description: "Page to comment on." },
        discussion_id: { type: "string", description: "Existing discussion to reply to." },
        text: {
          type: "string",
          description: "Comment text (plain text). For rich formatting, use `rich_text` instead.",
        },
        rich_text: {
          type: "array",
          description: "Array of Notion rich_text objects (for advanced formatting).",
        },
        selection_with_ellipsis: {
          type: "string",
          description:
            "[Not supported by Notion public API] Anchor comment to specific content. Will error if provided — use page_id for page-level comments instead.",
        },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: createCommentHandler,
  });

  register({
    name: "notion_get_comments",
    description:
      "Get comments for a Notion page (the block_id can also be a regular block for block-level comments). Returns all comments grouped by discussion.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string", description: "Page or block id to get comments for." },
        block_id: { type: "string", description: "Alias for page_id — a specific block's comments." },
        discussion_id: { type: "string", description: "Filter to a specific discussion." },
        include_all_blocks: { type: "boolean", description: "Accepted for parity; ignored (Notion public API returns everything at the given id)." },
        include_resolved: { type: "boolean", description: "Accepted for parity; Notion returns all comments." },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: getCommentsHandler,
  });
}

// -----------------------------------------------------------------------------

async function createCommentHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (args.selection_with_ellipsis) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            "selection_with_ellipsis (content-anchored comments) is not supported by Notion's public REST API. " +
            "Create a page-level comment (page_id) or reply to an existing discussion (discussion_id) instead.",
        },
      ],
    };
  }

  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const rich = Array.isArray(args.rich_text)
    ? (args.rich_text as import("../notion/client").NotionRichText[])
    : plainToRichText(String(args.text ?? ""));

  if (rich.length === 0) {
    return { isError: true, content: [{ type: "text", text: "Provide either `text` or a non-empty `rich_text` array." }] };
  }

  let body: Record<string, unknown>;
  if (typeof args.discussion_id === "string" && args.discussion_id.trim()) {
    body = { discussion_id: args.discussion_id.trim(), rich_text: rich };
  } else if (typeof args.page_id === "string" && args.page_id.trim()) {
    body = { parent: { page_id: args.page_id.trim() }, rich_text: rich };
  } else {
    return {
      isError: true,
      content: [{ type: "text", text: "Provide either `page_id` (for page-level) or `discussion_id` (to reply)." }],
    };
  }

  const created = await client.createComment(body);
  return {
    content: [
      {
        type: "text",
        text: [
          `✅ Created comment ${created.id}`,
          `Discussion: ${created.discussion_id}`,
          `Author: ${created.created_by.id}`,
          `Text: ${richTextToMarkdown(created.rich_text)}`,
        ].join("\n"),
      },
    ],
  };
}

async function getCommentsHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const targetId = String(args.page_id ?? args.block_id ?? "").trim();
  if (!targetId) {
    return { isError: true, content: [{ type: "text", text: "Provide `page_id` or `block_id`." }] };
  }

  const all: import("../notion/client").NotionCommentObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listComments(targetId, cursor ? { startCursor: cursor } : {});
    all.push(...page.results);
    cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
  } while (cursor);

  let filtered = all;
  if (typeof args.discussion_id === "string" && args.discussion_id) {
    filtered = all.filter((c) => c.discussion_id === args.discussion_id);
  }

  // Group by discussion
  const byDiscussion = new Map<string, typeof all>();
  for (const c of filtered) {
    const arr = byDiscussion.get(c.discussion_id) ?? [];
    arr.push(c);
    byDiscussion.set(c.discussion_id, arr);
  }

  const lines: string[] = [`# Comments (${filtered.length} total, ${byDiscussion.size} discussions)`, ""];
  for (const [discussionId, comments] of byDiscussion) {
    lines.push(`## Discussion ${discussionId}`);
    for (const c of comments) {
      lines.push(`- **${c.created_by.id}** at ${c.created_time}:  ${richTextToMarkdown(c.rich_text)}`);
    }
    lines.push("");
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}
