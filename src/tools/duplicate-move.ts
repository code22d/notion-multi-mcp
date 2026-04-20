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
import { resolveAccount, ACCOUNT_PARAM_SCHEMA } from "../accounts/resolver";
import {
  NotionClient,
  type NotionBlockObject,
  type NotionPageObject,
  type NotionRichText,
} from "../notion/client";

const CHILDREN_PER_REQUEST = 100;

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
    description: "Move one or more Notion pages/databases to a new parent on the specified account.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_or_database_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        new_parent: {
          type: "object",
          description: "New parent: { type: 'page_id' | 'database_id' | 'data_source_id' | 'workspace', ... }",
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
  const client = new NotionClient(account);

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

  // 5) Convert the response tree into request-shaped children.
  const children = blockTree.map(toBlockRequest).filter((b): b is BlockRequest => b !== null);

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
    if (source.icon) body.icon = source.icon;
    if (source.cover) body.cover = source.cover;
    created = await client.createPage(body);

    // 7) Append overflow children + recursively append any nested children.
    for (let off = 0; off < overflow.length; off += CHILDREN_PER_REQUEST) {
      await client.appendBlockChildren(created.id, {
        children: overflow.slice(off, off + CHILDREN_PER_REQUEST),
      });
    }

    // Hydrate nested children under the newly created top-level blocks. We need
    // to fetch the created blocks to get their real IDs before we can attach
    // their children — do this in one pass per depth level.
    await hydrateChildrenRecursive(client, created.id, blockTree);
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

export interface HydratedBlock extends NotionBlockObject {
  children?: HydratedBlock[];
}

async function fetchChildrenRecursive(client: NotionClient, blockId: string): Promise<HydratedBlock[]> {
  const top = await client.listAllBlockChildren(blockId);
  // Paginate children of each block with has_children=true, one level deep; recurse.
  const out: HydratedBlock[] = [];
  for (const block of top) {
    const h = block as HydratedBlock;
    if (block.has_children) {
      h.children = await fetchChildrenRecursive(client, block.id);
    }
    out.push(h);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Block request-shape conversion
// -----------------------------------------------------------------------------

export type BlockRequest = Record<string, unknown> & { type: string };

/** Fields Notion's REST API returns but doesn't accept on write. */
const STRIPPED_FIELDS = new Set<string>([
  "object", "id", "created_time", "last_edited_time", "created_by",
  "last_edited_by", "has_children", "archived", "in_trash", "parent",
  "request_id",
]);

export function toBlockRequest(block: HydratedBlock): BlockRequest | null {
  const type = block.type;
  if (!type) return null;

  // Types with no clean public-API creation path — substitute a note so the
  // structure is preserved but the duplicate doesn't crash on the server.
  if (
    type === "unsupported" ||
    type === "child_database" ||
    type === "ai_block" ||
    type === "breadcrumb" ||
    type === "table_of_contents"
  ) {
    return paragraphPlaceholder(`[original ${type} not duplicable via public API]`);
  }

  // synced_block (the "original") exposes its children via the usual API. The
  // "reference" form (a mirror) can't be faithfully re-linked, so we inline
  // the original's children as a toggle-less group.
  if (type === "synced_block") {
    const sb = (block as Record<string, unknown>)[type] as { synced_from?: unknown } | undefined;
    if (sb && sb.synced_from) {
      // Reference — can't duplicate. Replace with a paragraph note.
      return paragraphPlaceholder("[original synced block not duplicable via public API]");
    }
    // Originals: emit a fresh synced_block with synced_from=null — Notion
    // will create a new original that mirrors the children we append.
    return {
      type: "synced_block",
      synced_block: { synced_from: null },
    };
  }

  // child_page — when Notion's API returns child_page, the only creation path
  // is a nested page (new page with parent=current page). We can't do that
  // inline during duplicate, so emit a note with the original's title.
  if (type === "child_page") {
    const cp = (block as Record<string, unknown>)[type] as { title?: string } | undefined;
    const t = cp?.title ?? "(untitled)";
    return paragraphPlaceholder(`[child page: ${t} — not recursively duplicated]`);
  }

  // Clone the block, stripping server-only fields.
  const payload = cloneShallow(block);
  for (const k of STRIPPED_FIELDS) delete (payload as Record<string, unknown>)[k];

  // Drop our recursion helper.
  delete (payload as Record<string, unknown>).children;

  // Sanitize the per-type body (file.url with notion-hosted signed URL becomes
  // external).
  sanitizeTypeBody(payload, type);

  // Some block types can carry inline children at creation time (toggle,
  // quote, callout, column_list, column, table, bulleted_list_item, etc.).
  // Our recursion walker attaches children later via appendBlockChildren,
  // but we also set them inline when available to reduce API calls.
  if (block.children && block.children.length > 0 && supportsInlineChildren(type)) {
    const body = (payload as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
    if (body) {
      body.children = block.children.map(toBlockRequest).filter((b): b is BlockRequest => b !== null);
      // Once inlined, don't re-attach in the hydrate pass.
      block.children = undefined;
    }
  }

  return payload as BlockRequest;
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

/** Types whose request body accepts a `children` array inline. */
function supportsInlineChildren(type: string): boolean {
  return (
    type === "toggle" ||
    type === "quote" ||
    type === "callout" ||
    type === "column_list" ||
    type === "column" ||
    type === "synced_block" ||
    type === "bulleted_list_item" ||
    type === "numbered_list_item" ||
    type === "to_do" ||
    type === "table" ||
    type === "heading_1" ||
    type === "heading_2" ||
    type === "heading_3"
  );
}

function sanitizeTypeBody(payload: Record<string, unknown>, type: string): void {
  const body = payload[type];
  if (!body || typeof body !== "object") return;
  const b = body as Record<string, unknown>;

  // Files returned as `{ type: "file", file: { url, expiry_time } }` can't be
  // round-tripped — convert to external using the signed URL while it's fresh.
  if (b.type === "file" && b.file && typeof b.file === "object") {
    const f = b.file as { url?: string };
    if (f.url) {
      b.type = "external";
      b.external = { url: f.url };
      delete b.file;
    }
  }

  // Strip top-level null-valued fields from the type body. Notion's block
  // response shape includes things like `icon: null` and `color: null` on
  // most block bodies, but the request schema rejects `null` for those
  // fields (they must be an object or absent). synced_from:null is a
  // meaningful signal for a synced_block original, so keep that one.
  for (const key of Object.keys(b)) {
    if (b[key] === null && key !== "synced_from") {
      delete b[key];
    }
  }

  // Rich text runs also carry a plain_text and href that the API recomputes —
  // safe to keep but the API ignores them. We leave them as-is.
}

// -----------------------------------------------------------------------------
// Hydrate nested children after page creation
// -----------------------------------------------------------------------------

/**
 * After createPage with the top-level children, Notion assigns new block IDs.
 * We list the new page's children and, in order, append each original block's
 * sub-tree under the matching new block. Only runs for blocks whose children
 * weren't already inlined at request-build time.
 */
async function hydrateChildrenRecursive(
  client: NotionClient,
  parentBlockId: string,
  sourceTree: HydratedBlock[]
): Promise<void> {
  // Only fetch if there's anything to hydrate under this parent.
  if (!sourceTree.some(hasPendingChildren)) return;

  const createdChildren = await client.listAllBlockChildren(parentBlockId);

  // Notion appends the new blocks in the same order as our request, but skips
  // nothing. Our sourceTree may contain placeholder paragraphs (for
  // non-duplicable types) that don't need hydration — those entries have
  // `children` undefined. Iterate in order and pair by index.
  for (let i = 0; i < sourceTree.length && i < createdChildren.length; i++) {
    const src = sourceTree[i]!;
    const dst = createdChildren[i]!;
    if (!src.children || src.children.length === 0) continue;

    // Append this level of children, then recurse.
    const childrenPayload = src.children.map(toBlockRequest).filter((b): b is BlockRequest => b !== null);
    for (let off = 0; off < childrenPayload.length; off += CHILDREN_PER_REQUEST) {
      await client.appendBlockChildren(dst.id, {
        children: childrenPayload.slice(off, off + CHILDREN_PER_REQUEST),
      });
    }
    await hydrateChildrenRecursive(client, dst.id, src.children);
  }
}

function hasPendingChildren(b: HydratedBlock): boolean {
  if (!b.children || b.children.length === 0) return false;
  return true;
}

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
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.page_id === "string" && r.page_id) return { type: "page_id", page_id: r.page_id };
  if (typeof r.database_id === "string" && r.database_id) return { type: "database_id", database_id: r.database_id };
  if (typeof r.data_source_id === "string" && r.data_source_id) return { type: "data_source_id", data_source_id: r.data_source_id };
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
  // workspace — can't duplicate a top-level page via API (requires admin).
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
  const client = new NotionClient(account);

  const ids = Array.isArray(args.page_or_database_ids) ? (args.page_or_database_ids as string[]) : [];
  const parent = args.new_parent as Record<string, unknown> | undefined;
  if (ids.length === 0) return textErr("`page_or_database_ids` must have at least one id.");
  if (!parent || !parent.type) return textErr("`new_parent` is required and must have a `type`.");

  const results: string[] = [];
  for (const id of ids) {
    try {
      const updated = await client.updatePage(id, { parent });
      results.push(`✅ Moved ${id} → parent ${JSON.stringify(parent)} (now at ${updated.url})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`❌ ${id}: ${msg}`);
    }
  }
  return { content: [{ type: "text", text: results.join("\n") }] };
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
