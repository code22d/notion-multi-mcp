// -----------------------------------------------------------------------------
// Page tools — notion_create_pages (Phase 2 real handler) and
// notion_update_page (Phase 5 real handler, see ./update-page/).
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount, createNotionClient } from "../accounts/resolver";
import { stripDashes, type NotionPageObject } from "../notion/client";
import { richTextToPlain } from "../notion/markdown/rich-text";
import { markdownToBlocks, type BlockRequest } from "../notion/markdown/to-blocks";
import { updatePageHandler, UPDATE_PAGE_INPUT_SCHEMA } from "./update-page";
import {
  coerceScalarToPropertyValue,
  needsTypeResolution,
  resolveTypesForParent,
  UNKNOWN_TYPES,
  type PropertyTypeResolver,
} from "../notion/property-values";

const CHILDREN_PER_REQUEST = 100;

export function registerPageTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_create_pages",
    description:
      "Create one or more Notion pages in the specified account, with properties and Markdown content. Parent can be a page_id (page under another page), database_id, or data_source_id. Markdown supports CommonMark plus Notion extensions: GFM task lists, callouts via `> [!NOTE]`, toggles via `<details>`, mentions via `<page id=\"…\">`, and $$block$$ equations.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        pages: {
          type: "array",
          description: "Pages to create (up to 100). Each item has content (Markdown), properties, icon, cover, template_id.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Page body as Notion-flavored Markdown." },
              properties: {
                type: "object",
                description:
                  "Property values. For page-under-page parents, `title` is the only supported property and may be passed as a plain string. For database/data-source parents, pass native Notion property values.",
              },
              icon: {
                type: "string",
                description: "Page icon: an emoji (e.g. \"💡\") or an https URL to an external image.",
              },
              cover: {
                type: "string",
                description: "Page cover: an https URL to an external image.",
              },
              template_id: {
                type: "string",
                description: "Optional Notion template id to apply to the newly created page.",
              },
            },
          },
        },
        parent: {
          type: "object",
          description:
            "Parent under which the pages are created. Exactly one of: { page_id }, { database_id }, { data_source_id }, { workspace: true }.",
        },
      },
      required: ["account", "pages", "parent"],
      additionalProperties: false,
    },
    handler: createPagesHandler,
  });

  register({
    name: "notion_update_page",
    description:
      "Update a Notion page on the specified account. Dispatches on `command`: `update_properties` " +
      "(patch property values, cover, icon, archive state), `update_content` (search-and-replace against " +
      "the page's Notion-flavored Markdown), `replace_content` (rewrite the whole body from Markdown), " +
      "`apply_template` (clone blocks from another page onto this one), `update_verification` " +
      "(set verified/unverified with optional expiry).",
    inputSchema: UPDATE_PAGE_INPUT_SCHEMA as unknown as Record<string, unknown>,
    handler: updatePageHandler,
  });
}

// -----------------------------------------------------------------------------
// notion_create_pages
// -----------------------------------------------------------------------------

async function createPagesHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const parentRaw = args.parent;
  const parent = normalizeParent(parentRaw);
  if (!parent) {
    return textErr(
      "`parent` must be an object with exactly one of: page_id, database_id, data_source_id, workspace: true."
    );
  }
  const pagesRaw = args.pages;
  if (!Array.isArray(pagesRaw) || pagesRaw.length === 0) {
    return textErr("`pages` must be a non-empty array of page specs.");
  }
  if (pagesRaw.length > 100) {
    return textErr("`pages` has a 100-item cap per call. Split the request.");
  }

  const created: Array<{ id: string; url: string; title: string }> = [];
  const errors: string[] = [];

  // Every page in a single call shares one parent, so resolve the column types
  // once for the whole batch. Skipped entirely when no page passes an ambiguous
  // bare string, and when the parent is a page/workspace (no schema).
  const anyAmbiguous = pagesRaw.some((p) => {
    if (!p || typeof p !== "object") return false;
    const props = (p as Record<string, unknown>).properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return false;
    return needsTypeResolution(props as Record<string, unknown>);
  });
  const resolveType: PropertyTypeResolver = anyAmbiguous
    ? await resolveTypesForParent(client, parent)
    : UNKNOWN_TYPES;

  for (let i = 0; i < pagesRaw.length; i++) {
    const spec = pagesRaw[i] as Record<string, unknown> | undefined;
    if (!spec || typeof spec !== "object") {
      errors.push(`pages[${i}]: not an object`);
      continue;
    }
    try {
      const body = buildCreatePageBody(parent, spec, resolveType);
      const firstBatch = body.children.slice(0, CHILDREN_PER_REQUEST);
      const overflow = body.children.slice(CHILDREN_PER_REQUEST);

      const page: NotionPageObject = await client.createPage({
        parent: body.parent,
        properties: body.properties,
        icon: body.icon,
        cover: body.cover,
        children: firstBatch,
      });

      // Append any overflow children in further chunks of 100.
      for (let off = 0; off < overflow.length; off += CHILDREN_PER_REQUEST) {
        const slice = overflow.slice(off, off + CHILDREN_PER_REQUEST);
        await client.appendBlockChildren(page.id, { children: slice });
      }

      created.push({
        id: page.id,
        url: page.url,
        title: extractPageTitle(page.properties) || "(untitled)",
      });
    } catch (e) {
      errors.push(`pages[${i}]: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lines: string[] = [];
  lines.push(`# Created ${created.length} page${created.length === 1 ? "" : "s"}`);
  for (const p of created) {
    lines.push(`- **${p.title}** — ${p.url}\n  id: ${p.id}`);
  }
  if (errors.length > 0) {
    lines.push("", `## Errors (${errors.length})`);
    for (const e of errors) lines.push(`- ${e}`);
  }
  const isError = created.length === 0 && errors.length > 0;
  return { content: [{ type: "text", text: lines.join("\n") }], isError };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface NormalizedParent {
  type: "page_id" | "database_id" | "data_source_id" | "workspace";
  page_id?: string;
  database_id?: string;
  data_source_id?: string;
  workspace?: boolean;
}

function normalizeParent(raw: unknown): NormalizedParent | null {
  // Accept either a parsed object or a JSON-string, defensively — some MCP
  // clients serialize object-typed args as strings (observed on optional
  // object args through the Cowork transport).
  let r: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    r = raw as Record<string, unknown>;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (s.startsWith("{") && s.endsWith("}")) {
      try {
        const parsed = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          r = parsed as Record<string, unknown>;
        }
      } catch {
        /* fall through to null */
      }
    }
  }
  if (!r) return null;
  if (typeof r.page_id === "string" && r.page_id) {
    return { type: "page_id", page_id: stripDashes(r.page_id) };
  }
  if (typeof r.database_id === "string" && r.database_id) {
    return { type: "database_id", database_id: stripDashes(r.database_id) };
  }
  if (typeof r.data_source_id === "string" && r.data_source_id) {
    return { type: "data_source_id", data_source_id: stripDashes(r.data_source_id) };
  }
  if (r.workspace === true) {
    return { type: "workspace", workspace: true };
  }
  return null;
}

interface BuiltPageBody {
  parent: NormalizedParent;
  properties: Record<string, unknown>;
  icon?: Record<string, unknown>;
  cover?: Record<string, unknown>;
  children: BlockRequest[];
}

function buildCreatePageBody(
  parent: NormalizedParent,
  spec: Record<string, unknown>,
  resolveType: PropertyTypeResolver = UNKNOWN_TYPES
): BuiltPageBody {
  const content = typeof spec.content === "string" ? spec.content : "";
  const children = markdownToBlocks(content);
  const properties = normalizeProperties(spec.properties, parent, resolveType);
  const out: BuiltPageBody = { parent, properties, children };
  const icon = normalizeIcon(spec.icon);
  if (icon) out.icon = icon;
  const cover = normalizeCover(spec.cover);
  if (cover) out.cover = cover;
  return out;
}

function normalizeProperties(
  raw: unknown,
  parent: NormalizedParent,
  resolveType: PropertyTypeResolver = UNKNOWN_TYPES
): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    // Page-under-page requires at least a title; default to empty so Notion can
    // untitled-fallback. Database parents must carry their own columns.
    return parent.type === "page_id" ? { title: [{ type: "text", text: { content: "" } }] } : {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = coercePropertyValue(key, value, resolveType);
  }
  // Page-under-page needs a `title` property — auto-add if missing.
  if (parent.type === "page_id" && !("title" in out)) {
    out.title = [{ type: "text", text: { content: "" } }];
  }
  return out;
}

function coercePropertyValue(
  key: string,
  value: unknown,
  resolveType: PropertyTypeResolver = UNKNOWN_TYPES
): unknown {
  // Shorthand: array of strings → multi_select (only when value is a pure string array).
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return { multi_select: (value as string[]).map((name) => ({ name })) };
  }
  // Scalars — serialize against the column's real type when the schema told us
  // one, otherwise the historical name/value heuristic. See property-values.ts.
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return coerceScalarToPropertyValue(key, value, resolveType(key));
  }
  // Otherwise assume the caller passed a native Notion property value object.
  return value;
}

function normalizeIcon(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  // URLs → external image icon.
  if (/^https?:\/\//i.test(raw)) {
    return { type: "external", external: { url: raw } };
  }
  // Anything else is treated as an emoji — Notion accepts a 1–2 grapheme string.
  return { type: "emoji", emoji: raw };
}

function normalizeCover(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== "string" || raw === "") return undefined;
  if (/^https?:\/\//i.test(raw)) {
    return { type: "external", external: { url: raw } };
  }
  return undefined;
}

function extractPageTitle(properties: Record<string, unknown>): string {
  for (const key of Object.keys(properties)) {
    const p = properties[key] as { type?: string; title?: unknown[] } | undefined;
    if (p?.type === "title" && Array.isArray(p.title)) {
      return richTextToPlain(p.title as import("../notion/client").NotionRichText[]);
    }
  }
  return "";
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}
