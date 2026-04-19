// -----------------------------------------------------------------------------
// Page tools — notion_create_pages (Phase 2 real handler) and
// notion_update_page (still a Phase 2 stub; arriving in a follow-up session
// once the Markdown diff engine is spec'd out).
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount } from "../accounts/resolver";
import { NotionClient, stripDashes, type NotionPageObject } from "../notion/client";
import { richTextToPlain } from "../notion/markdown/rich-text";
import { markdownToBlocks, type BlockRequest } from "../notion/markdown/to-blocks";
import { notYetImplemented } from "./_stub";

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
      "Update a Notion page on the specified account — properties, content, cover, icon, template application, or verification status. [Phase 2 — pending]",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        page_id: { type: "string" },
        command: {
          type: "string",
          enum: ["update_properties", "update_content", "replace_content", "apply_template", "update_verification"],
        },
        properties: { type: "object" },
        content_updates: { type: "array" },
        new_str: { type: "string" },
        template_id: { type: "string" },
        cover: { type: "string" },
        icon: { type: "string" },
        verification_status: { type: "string", enum: ["verified", "unverified"] },
        verification_expiry_days: { type: "integer" },
        allow_deleting_content: { type: "boolean" },
      },
      required: ["account", "page_id", "command"],
      additionalProperties: false,
    },
    handler: notYetImplemented(2, "Requires Markdown diff/replace engine to match native search-and-replace semantics."),
  });
}

// -----------------------------------------------------------------------------
// notion_create_pages
// -----------------------------------------------------------------------------

async function createPagesHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

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

  for (let i = 0; i < pagesRaw.length; i++) {
    const spec = pagesRaw[i] as Record<string, unknown> | undefined;
    if (!spec || typeof spec !== "object") {
      errors.push(`pages[${i}]: not an object`);
      continue;
    }
    try {
      const body = buildCreatePageBody(parent, spec);
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
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
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

function buildCreatePageBody(parent: NormalizedParent, spec: Record<string, unknown>): BuiltPageBody {
  const content = typeof spec.content === "string" ? spec.content : "";
  const children = markdownToBlocks(content);
  const properties = normalizeProperties(spec.properties, parent);
  const out: BuiltPageBody = { parent, properties, children };
  const icon = normalizeIcon(spec.icon);
  if (icon) out.icon = icon;
  const cover = normalizeCover(spec.cover);
  if (cover) out.cover = cover;
  return out;
}

function normalizeProperties(raw: unknown, parent: NormalizedParent): Record<string, unknown> {
  if (!raw || typeof raw !== "object") {
    // Page-under-page requires at least a title; default to empty so Notion can
    // untitled-fallback. Database parents must carry their own columns.
    return parent.type === "page_id" ? { title: [{ type: "text", text: { content: "" } }] } : {};
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = coercePropertyValue(key, value);
  }
  // Page-under-page needs a `title` property — auto-add if missing.
  if (parent.type === "page_id" && !("title" in out)) {
    out.title = [{ type: "text", text: { content: "" } }];
  }
  return out;
}

function coercePropertyValue(key: string, value: unknown): unknown {
  // Shorthand: string → title rich_text (when key is "title").
  if (typeof value === "string") {
    if (key.toLowerCase() === "title" || key === "Title" || key === "Name") {
      return { title: [{ type: "text", text: { content: value } }] };
    }
    return { rich_text: [{ type: "text", text: { content: value } }] };
  }
  // Shorthand: array of strings → multi_select (only when value is a pure string array).
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return { multi_select: (value as string[]).map((name) => ({ name })) };
  }
  if (typeof value === "boolean") return { checkbox: value };
  if (typeof value === "number") return { number: value };
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
