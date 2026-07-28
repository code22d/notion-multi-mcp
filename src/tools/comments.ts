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
import { resolveAccount, ACCOUNT_PARAM_SCHEMA, createNotionClient } from "../accounts/resolver";
import { NotionClient, type NotionRichText } from "../notion/client";
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
  const client = createNotionClient(account, ctx);

  const rich: NotionRichText[] = Array.isArray(args.rich_text)
    ? (args.rich_text as NotionRichText[])
    : plainToRichText(String(args.text ?? ""));

  if (rich.length === 0) {
    return { isError: true, content: [{ type: "text", text: "Provide either `text` or a non-empty `rich_text` array." }] };
  }

  const discussionId = typeof args.discussion_id === "string" ? args.discussion_id.trim() : "";
  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";

  let body: Record<string, unknown>;
  if (discussionId) {
    body = { discussion_id: discussionId, rich_text: rich };
  } else if (pageId) {
    body = { parent: { page_id: pageId }, rich_text: rich };
  } else {
    return {
      isError: true,
      content: [{ type: "text", text: "Provide either `page_id` (for page-level) or `discussion_id` (to reply)." }],
    };
  }

  const created = await client.createComment(body);
  // Notion's POST /v1/comments can return a PartialCommentObjectResponse —
  // `{ object: "comment", id }` only — omitting discussion_id, created_by and
  // rich_text. Pass fallback context so the formatter shows real values when
  // the API returns the partial shape. See formatCreateCommentResult.
  const text = formatCreateCommentResult(created, {
    discussion_id: discussionId || undefined,
    page_id: pageId || undefined,
    richText: rich,
    authorId: account.botId,
  });
  return { content: [{ type: "text", text }] };
}

/**
 * Context from the create request that the formatter uses to backfill any
 * fields absent from Notion's response. Every field is optional — the
 * formatter gracefully degrades to "(unknown)" / "(no text returned)" if the
 * fallback itself is missing something.
 */
export interface CreateCommentFallback {
  /** discussion_id we sent in the request (for replies). */
  discussion_id?: string;
  /** page_id we sent in the request (for new page-level comments). */
  page_id?: string;
  /** rich_text we sent in the request — used as comment text fallback. */
  richText?: NotionRichText[];
  /** Bot id of the integration that created the comment. */
  authorId?: string;
}

/**
 * Format the response from POST /v1/comments as a user-visible block of text.
 *
 * Exported for unit tests. Notion's API typings declare the response as
 * `PartialCommentObjectResponse | CommentObjectResponse` — in practice the
 * partial shape (`{ object, id }` only, missing discussion_id / created_by /
 * rich_text) appears often enough that a previous iteration of this formatter
 * fell through to placeholders on every real request. We now accept an
 * optional `fallback` populated from the request context (handler passes what
 * it sent + the integration's bot id) and prefer those values when the
 * response omits them. If neither the response nor the fallback has a field,
 * we still emit an `(unknown)` / `(no text returned)` placeholder rather than
 * crashing.
 */
export function formatCreateCommentResult(
  created: unknown,
  fallback: CreateCommentFallback = {}
): string {
  // Defensive read — accept any shape, validate each field independently.
  const obj = (created && typeof created === "object" ? (created as Record<string, unknown>) : {}) as {
    id?: unknown;
    discussion_id?: unknown;
    created_by?: { id?: unknown } | null;
    rich_text?: unknown;
  };

  const id = typeof obj.id === "string" && obj.id ? obj.id : "(unknown)";

  let discussion: string;
  if (typeof obj.discussion_id === "string" && obj.discussion_id) {
    discussion = obj.discussion_id;
  } else if (fallback.discussion_id) {
    discussion = fallback.discussion_id;
  } else if (fallback.page_id) {
    // Page-level create — we don't know the new discussion id, but we can tell
    // the user which page it was anchored to so the output isn't opaque.
    discussion = `(new discussion on page ${fallback.page_id})`;
  } else {
    discussion = "(unknown)";
  }

  let author: string;
  if (obj.created_by && typeof obj.created_by === "object" && typeof obj.created_by.id === "string") {
    author = obj.created_by.id;
  } else if (fallback.authorId) {
    author = fallback.authorId;
  } else {
    author = "(unknown)";
  }

  let text: string;
  if (Array.isArray(obj.rich_text) && obj.rich_text.length > 0) {
    text = richTextToMarkdown(obj.rich_text as NotionRichText[]);
  } else if (fallback.richText && fallback.richText.length > 0) {
    text = richTextToMarkdown(fallback.richText);
  } else {
    text = "(no text returned)";
  }

  return [
    `✅ Created comment ${id}`,
    `Discussion: ${discussion}`,
    `Author: ${author}`,
    `Text: ${text}`,
  ].join("\n");
}

async function getCommentsHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const targetId = String(args.page_id ?? args.block_id ?? "").trim();
  if (!targetId) {
    return { isError: true, content: [{ type: "text", text: "Provide `page_id` or `block_id`." }] };
  }

  const discussionFilter = typeof args.discussion_id === "string" && args.discussion_id ? args.discussion_id : undefined;
  return getCommentsForClient(client, { targetId, discussionFilter });
}

/**
 * Subset of NotionClient that the comments fetch logic actually needs. Keeps
 * the unit test decoupled from request/fetch plumbing — a plain mock object
 * implementing these two methods is enough.
 */
export interface GetCommentsClient {
  listComments: NotionClient["listComments"];
  getPage: NotionClient["getPage"];
}

/**
 * Core logic for notion_get_comments, isolated from ToolContext / account
 * resolution so it can be unit tested against a mock client.
 *
 * The 404 branch is the reason this exists as a separate function: Notion
 * returns `404 — Could not find block with ID … make sure the relevant pages
 * and databases are shared with your integration` from GET /v1/comments when
 * the page IS shared but the integration lacks the "Read comments" capability.
 * The message is misleading — the user has already shared the page and will
 * chase the wrong fix. We probe GET /pages/{id}: if that succeeds the share is
 * fine and the real remedy is enabling the capability at
 * notion.so/profile/integrations. If it also 404s, the page genuinely isn't
 * shared with the integration and the original error stands.
 */
export async function getCommentsForClient(
  client: GetCommentsClient,
  opts: { targetId: string; discussionFilter?: string }
): Promise<ToolResult> {
  const { targetId, discussionFilter } = opts;

  const all: import("../notion/client").NotionCommentObject[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await client.listComments(targetId, cursor ? { startCursor: cursor } : {});
      all.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
  } catch (err) {
    if (isNotion404(err)) {
      const pageReachable = await probePageAccessible(client, targetId);
      if (pageReachable) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `The page ${targetId} is shared with the integration, but the comments endpoint returned 404. ` +
                `This means the integration lacks the "Read comments" capability. ` +
                `Enable it at https://www.notion.so/profile/integrations — open the integration, go to Capabilities, ` +
                `and tick "Read comments" (and "Insert comments" if you also want notion_create_comment to work).`,
            },
          ],
        };
      }
    }
    throw err;
  }

  let filtered = all;
  if (discussionFilter) {
    filtered = all.filter((c) => c.discussion_id === discussionFilter);
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

function isNotion404(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // client.request() throws `Notion API ${status}: ${message}`.
  return /^Notion API 404\b/.test(err.message);
}

async function probePageAccessible(client: GetCommentsClient, id: string): Promise<boolean> {
  try {
    await client.getPage(id);
    return true;
  } catch {
    return false;
  }
}
