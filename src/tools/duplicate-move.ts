// -----------------------------------------------------------------------------
// notion_duplicate_page — recursive block walker.
//
// Walks the source page's block tree, strips server-only fields, and re-creates
// the page under the requested parent (or the same parent as the source if
// none given). Nested children are appended via /v1/blocks/{id}/children in
// chunks of 100.
//
// Limitations (documented in the tool description):
//   - child_database and synced_block(original) aren't duplicable via the public
//     API — we emit a paragraph placeholder so the structure is preserved.
//   - unsupported / ai_block / table_of_contents / breadcrumb / link_preview
//     blocks without public request shapes are replaced with a note.
//   - File/image/video blocks with notion-hosted `file.url` values can't be
//     re-uploaded — the duplicate gets the read-only URL as an `external` link
//     so the block is still viewable (though it'll expire when the source does).
//
// notion_move_pages is unchanged — it was already wired in Phase 1.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { resolveAccount, ACCOUNT_PARAM_SCHEMA, createNotionClient } from "../accounts/resolver";
import {
  NotionClient,
  type NotionPageObject,
  type NotionRichText,
} from "../notion/client";
import {
  CHILDREN_PER_REQUEST,
  cloneBlockTree,
  resolvePendingChildren,
  type ClonePolicy,
  type ClonedBlock,
} from "../notion/block-clone";
import type { HydratedBlock } from "../notion/markdown/from-blocks";
import type { BlockRequest } from "../notion/markdown/to-blocks";
import { sanitizeIconForWrite, shouldDescendInto } from "./update-page/shared";

// Re-exported: the walker and the tests have always imported these from here.
export type { HydratedBlock, BlockRequest };

export function registerDuplicateAndMoveTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_duplicate_page",
    description:
      "Duplicate a Notion page on the specified account, including its block content (recursively). " +
      "Optionally moves the duplicate under a different parent via `parent` (page_id | database_id | data_source_id). " +
      "If `parent` is omitted, the duplicate is created under the same parent as the source.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string" },
        title: {
          type: "string",
          description: "Optional title for the duplicate. Defaults to the source page's title with ' (Copy)' appended.",
        },
        parent: {
          type: "object",
          description:
            "Optional new parent. Exactly one of: { page_id }, { database_id }, { data_source_id }. If omitted, the duplicate is placed under the source's parent.",
        },
      },
      required: ["account", "page_id"],
      additionalProperties: false,
    },
    handler: duplicatePageHandler,
  });

  register({
    name: "notion_move_pages",
    description:
      "Move one or more Notion pages/databases to a new parent on the specified account. Uses Notion's POST /pages/{id}/move endpoint, which accepts only `page_id` or `data_source_id` parents; `database_id` is auto-resolved to the database's first data source. `workspace` parents are not supported by Notion's public API.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_or_database_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        new_parent: {
          type: "object",
          description:
            "New parent: { type: 'page_id' | 'database_id' | 'data_source_id', ... }. `database_id` is auto-resolved to the database's default data source. `workspace` is rejected with a clear error — public API limitation.",
        },
      },
      required: ["account", "page_or_database_ids", "new_parent"],
      additionalProperties: false,
    },
    handler: moveHandler,
  });
}

// -----------------------------------------------------------------------------
// notion_duplicate_page
// -----------------------------------------------------------------------------

async function duplicatePageHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const pageId = typeof args.page_id === "string" ? args.page_id.trim() : "";
  if (!pageId) return textErr("`page_id` is required.");

  // 1) Fetch the source page for title, icon, cover, parent.
  let source: NotionPageObject;
  try {
    source = await client.getPage(pageId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`Couldn't read source page ${pageId}: ${msg}`);
  }

  // 2) Decide destination parent.
  const parent = normalizeParent(args.parent) ?? sourceParent(source);
  if (!parent) {
    return textErr("Couldn't determine a destination parent — pass `parent: { page_id | database_id | data_source_id }`.");
  }

  // 3) Build properties for the new page.
  const titleOverride = typeof args.title === "string" ? args.title : undefined;
  const properties = buildProperties(source, parent, titleOverride);

  // 4) Walk the source's block tree recursively.
  let blockTree: HydratedBlock[];
  try {
    blockTree = await fetchChildrenRecursive(client, pageId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`Couldn't read source block tree: ${msg}`);
  }

  // 5) Convert the response tree into request-shaped children. `cloned` keeps
  //    one entry per block we actually emit, in emit order, plus a record of
  //    every subtree the request body could not carry inline.
  const cloned = cloneBlockTree(blockTree, DUPLICATE_CLONE_POLICY);
  const children = cloned.map((c) => c.request);

  // 6) Create the new page with the first chunk of children.
  let created: NotionPageObject;
  try {
    const firstBatch = children.slice(0, CHILDREN_PER_REQUEST);
    const overflow = children.slice(CHILDREN_PER_REQUEST);
    const body: Record<string, unknown> = {
      parent: parentToRequest(parent),
      properties,
      children: firstBatch,
    };
    // sanitizeIconForWrite strips response-only fields that the write schema
    // rejects — notably custom_emoji's `name`/`url` and a native icon's
    // presentation extras. It returns undefined (never null) when there's no
    // icon, so this stays a plain truthiness check: assigning `icon: null`
    // here is what caused the duplicate_page null-icon bug.
    const clonedIcon = sanitizeIconForWrite(source.icon);
    if (clonedIcon) body.icon = clonedIcon;
    if (source.cover) body.cover = source.cover;
    created = await client.createPage(body);

    // 7) Append overflow children + recursively append any nested children.
    for (let off = 0; off < overflow.length; off += CHILDREN_PER_REQUEST) {
      await client.appendBlockChildren(created.id, {
        children: overflow.slice(off, off + CHILDREN_PER_REQUEST),
      });
    }

    // Attach whatever the request bodies couldn't carry inline. The page was
    // just created, so its children are exactly the blocks we emitted, in
    // order — which is what lets the resolver pair them up by index.
    await resolvePendingChildren(client, created.id, cloned, DUPLICATE_CLONE_POLICY);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_duplicate_page failed during creation: ${msg}`);
  }

  const title = extractTitle(created.properties) || titleOverride || "(untitled)";
  return {
    content: [
      {
        type: "text",
        text: `✅ Duplicated page as **${title}**\nurl: ${created.url}\nid: ${created.id}`,
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// Block walker — fetch source tree
// -----------------------------------------------------------------------------

async function fetchChildrenRecursive(client: NotionClient, blockId: string): Promise<HydratedBlock[]> {
  const top = await client.listAllBlockChildren(blockId);
  const out: HydratedBlock[] = [];
  for (const block of top) {
    const h = { ...block } as HydratedBlock;
    // shouldDescendInto also descends into containers whose write schema makes
    // `children` mandatory, regardless of has_children — see its comment.
    if (shouldDescendInto(block)) {
      h.children = await fetchChildrenRecursive(client, block.id);
    }
    out.push(h);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Block request-shape conversion
// -----------------------------------------------------------------------------

/**
 * duplicate_page's clone policy. Where a block has no create shape at all, the
 * duplicate keeps a visible italic note in its place rather than silently
 * losing the structure — the user asked for a copy of a page and should be able
 * to see what didn't survive.
 *
 * `breadcrumb` and `table_of_contents` used to be listed here too. They are
 * both perfectly creatable at the top level of a request, so they now clone
 * properly instead of degrading to a note.
 */
export const DUPLICATE_CLONE_POLICY: ClonePolicy = {
  substitute(block, kind) {
    if (kind === "child_page") {
      const cp = (block as unknown as Record<string, unknown>).child_page as { title?: string } | undefined;
      return paragraphPlaceholder(`[child page: ${cp?.title ?? "(untitled)"} — not recursively duplicated]`);
    }
    if (kind === "synced_reference") {
      return paragraphPlaceholder("[original synced block not duplicable via public API]");
    }
    return paragraphPlaceholder(`[original ${block.type} not duplicable via public API]`);
  },
  // A duplicate that mirrored the source's synced blocks would quietly couple
  // the copy to the original; duplicate_page has always left a note instead.
  syncedReference: "substitute",
};

/**
 * Convert one response-shape block into its request shape.
 *
 * Thin view over the shared clone engine — it discards the engine's record of
 * subtrees that need a follow-up append, so the handler uses `cloneBlockTree`
 * directly. Kept exported because it is the seam the block-shape tests use.
 */
export function toBlockRequest(block: HydratedBlock): BlockRequest | null {
  const [cloned] = cloneBlockTree([block], DUPLICATE_CLONE_POLICY);
  return cloned ? cloned.request : null;
}

function cloneShallow<T extends Record<string, unknown>>(obj: T): T {
  // Deep clone — blocks are small JSON.
  return JSON.parse(JSON.stringify(obj));
}

function paragraphPlaceholder(text: string): BlockRequest {
  return {
    type: "paragraph",
    paragraph: {
      rich_text: [
        { type: "text", text: { content: text }, annotations: { italic: true, color: "gray" } },
      ],
    },
  };
}

// Which blocks may carry inline children, and how deep, is no longer a list
// kept here — it is derived from src/notion/block-write-schema.ts by the shared
// clone engine. The old local list said "toggle, quote, callout, …" with no
// notion of depth and no notion of a container whose children are REQUIRED,
// which is exactly how `tab` slipped through.

// -----------------------------------------------------------------------------
// Parent & property helpers
// -----------------------------------------------------------------------------

interface NormalizedParent {
  type: "page_id" | "database_id" | "data_source_id";
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
}

function normalizeParent(raw: unknown): NormalizedParent | null {
  // Object-typed tool args are normally delivered pre-parsed by the MCP
  // transport, but some clients serialize them as a JSON string instead —
  // accept either form so the DSL works regardless of how the caller wrapped
  // the value.
  const obj = coerceToObject(raw);
  if (!obj) return null;
  if (typeof obj.page_id === "string" && obj.page_id) return { type: "page_id", page_id: obj.page_id };
  if (typeof obj.database_id === "string" && obj.database_id) return { type: "database_id", database_id: obj.database_id };
  if (typeof obj.data_source_id === "string" && obj.data_source_id) return { type: "data_source_id", data_source_id: obj.data_source_id };
  return null;
}

/** Parse object-or-JSON-string into a plain object, or return null on
 *  anything else. Exported for unit tests. */
export function coerceToObject(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sourceParent(page: NotionPageObject): NormalizedParent | null {
  const p = page.parent;
  if (!p || typeof p !== "object") return null;
  if (p.type === "page_id" && typeof p.page_id === "string") {
    return { type: "page_id", page_id: p.page_id };
  }
  if (p.type === "database_id" && typeof p.database_id === "string") {
    return { type: "database_id", database_id: p.database_id };
  }
  if (p.type === "data_source_id" && typeof p.data_source_id === "string") {
    return { type: "data_source_id", data_source_id: p.data_source_id };
  }
  // Everything else returns null, and the caller turns that into a clear
  // "pass `parent` explicitly" error rather than crashing. Two cases land here:
  //   - workspace: can't duplicate a top-level page via the API (needs admin).
  //   - agent_id (2026-05-11): pages parented by an agent serialize as
  //     `{ type: "agent_id", agent_id: "…" }`. There is no way to create a
  //     page under an agent via the public API, so a duplicate must be given
  //     a destination. Falling through here is the correct answer, not a gap.
  return null;
}

function parentToRequest(parent: NormalizedParent): Record<string, unknown> {
  switch (parent.type) {
    case "page_id":        return { type: "page_id", page_id: parent.page_id };
    case "database_id":    return { type: "database_id", database_id: parent.database_id };
    case "data_source_id": return { type: "data_source_id", data_source_id: parent.data_source_id };
  }
}

function buildProperties(
  source: NotionPageObject,
  parent: NormalizedParent,
  titleOverride: string | undefined
): Record<string, unknown> {
  // For page-under-page parents the only writeable property is `title`. For
  // database/data-source parents, we pass through the full property set,
  // substituting a fresh title if the user provided one.
  const props = cloneShallow(source.properties ?? {}) as Record<string, unknown>;

  // Compute the title string.
  let currentTitle = extractTitle(props);
  if (!currentTitle) currentTitle = "(untitled)";
  const targetTitle = titleOverride ?? `${currentTitle} (Copy)`;

  if (parent.type === "page_id") {
    return { title: [{ type: "text", text: { content: targetTitle } }] };
  }

  // database / data_source parent — strip read-only properties (formulas,
  // rollups, created_by, created_time, last_edited_by, last_edited_time,
  // unique_id) and rewrite the TITLE property.
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(props)) {
    const val = raw as { type?: string; id?: string; [k: string]: unknown } | undefined;
    if (!val || typeof val !== "object") continue;
    const t = val.type;
    if (
      t === "formula" || t === "rollup" || t === "created_time" || t === "last_edited_time" ||
      t === "created_by" || t === "last_edited_by" || t === "unique_id"
    ) continue;
    if (t === "title") {
      out[key] = { title: [{ type: "text", text: { content: targetTitle } }] };
      continue;
    }
    // Strip per-prop read-only `id` — the PATCH/POST accepts the payload as-is
    // when passed back. We leave `type`, the type-body, and the inner values.
    const copy: Record<string, unknown> = {};
    for (const [ik, iv] of Object.entries(val)) {
      if (ik === "id") continue;
      copy[ik] = iv;
    }
    out[key] = copy;
  }
  return out;
}

function extractTitle(properties: Record<string, unknown>): string {
  for (const key of Object.keys(properties)) {
    const p = properties[key] as { type?: string; title?: unknown[] } | undefined;
    if (p?.type === "title" && Array.isArray(p.title)) {
      return richTextArrayToPlain(p.title as NotionRichText[]);
    }
  }
  return "";
}

function richTextArrayToPlain(runs: NotionRichText[]): string {
  return runs.map((r) => r.plain_text ?? r.text?.content ?? "").join("");
}

// -----------------------------------------------------------------------------
// notion_move_pages
// -----------------------------------------------------------------------------

async function moveHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const ids = Array.isArray(args.page_or_database_ids) ? (args.page_or_database_ids as string[]) : [];
  const parent = coerceToObject(args.new_parent);
  if (ids.length === 0) return textErr("`page_or_database_ids` must have at least one id.");
  if (!parent || !parent.type) return textErr("`new_parent` is required and must have a `type`.");

  // Notion's POST /pages/{id}/move accepts only page_id or data_source_id
  // parents. Translate database_id → the database's first data_source_id,
  // and reject workspace parents with a clear error.
  let movePayload: { page_id?: string; data_source_id?: string; type?: "page_id" | "data_source_id" };
  try {
    movePayload = await resolveMoveTarget(client, parent);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return textErr(`notion_move_pages: ${msg}`);
  }

  const results: string[] = [];
  for (const id of ids) {
    try {
      const moved = await client.movePage(id, { parent: movePayload });
      // Post-verify: Notion has, in the past, returned 200 from /move even
      // when the move didn't actually land (especially on unsupported parent
      // combinations). Assert the returned parent matches what we asked for.
      if (!parentMatches(moved.parent, movePayload)) {
        results.push(
          `⚠ ${id}: Notion returned 200 but the page's parent is still ${JSON.stringify(moved.parent)} ` +
            `(expected ${JSON.stringify(movePayload)}). Check workspace permissions / page type.`
        );
      } else {
        results.push(`✅ Moved ${id} → ${JSON.stringify(movePayload)} (url: ${moved.url})`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`❌ ${id}: ${msg}`);
    }
  }
  const allFailed = results.every((r) => r.startsWith("❌") || r.startsWith("⚠"));
  return {
    content: [{ type: "text", text: results.join("\n") }],
    ...(allFailed ? { isError: true } : {}),
  };
}

/**
 * Translate the tool-level `new_parent` shape into the /move endpoint's
 * accepted body.
 *
 *   { type: "page_id", page_id }                 → passthrough
 *   { type: "data_source_id", data_source_id }   → passthrough
 *   { type: "database_id", database_id }         → fetch DB, use its first data_source_id
 *   { type: "workspace" }                        → reject
 *
 * Throws with a helpful message if the translation isn't possible.
 */
async function resolveMoveTarget(
  client: NotionClient,
  parent: Record<string, unknown>
): Promise<{ page_id?: string; data_source_id?: string; type?: "page_id" | "data_source_id" }> {
  const t = String(parent.type);
  if (t === "page_id") {
    const pageId = typeof parent.page_id === "string" ? parent.page_id : "";
    if (!pageId) throw new Error(`new_parent.page_id is required when type is "page_id"`);
    return { type: "page_id", page_id: pageId };
  }
  if (t === "data_source_id") {
    const dsId = typeof parent.data_source_id === "string" ? parent.data_source_id : "";
    if (!dsId) throw new Error(`new_parent.data_source_id is required when type is "data_source_id"`);
    return { type: "data_source_id", data_source_id: dsId };
  }
  if (t === "database_id") {
    const dbId = typeof parent.database_id === "string" ? parent.database_id : "";
    if (!dbId) throw new Error(`new_parent.database_id is required when type is "database_id"`);
    // Notion's API removed database_id as a move destination in 2025-09-03;
    // resolve to the database's first data source instead.
    const db = await client.getDatabase(dbId);
    const ds = db.data_sources?.[0];
    if (!ds || !ds.id) {
      throw new Error(
        `database "${dbId}" has no data_sources — pass a specific data_source_id instead.`
      );
    }
    return { type: "data_source_id", data_source_id: ds.id };
  }
  if (t === "workspace") {
    throw new Error(
      `moves to the workspace root are not supported by Notion's public API — move the page to a parent page or data source instead.`
    );
  }
  throw new Error(`unknown new_parent.type "${t}" — expected "page_id", "database_id", "data_source_id", or "workspace"`);
}

/** Does the returned page parent match what we asked for? */
function parentMatches(
  got: { type?: string; page_id?: unknown; data_source_id?: unknown; database_id?: unknown; [k: string]: unknown } | undefined,
  asked: { page_id?: string; data_source_id?: string; type?: "page_id" | "data_source_id" }
): boolean {
  if (!got) return false;
  if (asked.type === "page_id") {
    if (got.type !== "page_id") return false;
    return idsEqual(String(got.page_id ?? ""), asked.page_id ?? "");
  }
  if (asked.type === "data_source_id") {
    // Some pages under a data source come back with type "database_id" /
    // database_id set to the wrapping database; accept either shape as long
    // as the ids roll up correctly.
    if (got.type === "data_source_id") {
      return idsEqual(String(got.data_source_id ?? ""), asked.data_source_id ?? "");
    }
    if (got.type === "database_id") {
      // Can't fully check without another fetch; accept as a soft match.
      return true;
    }
    return false;
  }
  return false;
}

function idsEqual(a: string, b: string): boolean {
  return a.replace(/-/g, "") === b.replace(/-/g, "");
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
