// -----------------------------------------------------------------------------
// Regression tests for bugs fixed in the 2026-04-20 bug-fix pass.
//   - Bug 2 (prior): update_verification pre-check for non-wiki pages
//   - Bug 4 (prior): <details>…</details> spanning multiple paragraphs → toggle
//   - Bug 5 (prior): Data Source title rendering prefers `title` rich_text
//   - apply_template strips response-only nulls (icon/color/caption → not sent
//     to Notion — synced_from:null preserved on synced_block)
// -----------------------------------------------------------------------------

import { markdownToBlocks } from "../src/notion/markdown/to-blocks.ts";
import { formatDataSourceSummary } from "../src/tools/fetch.ts";
import { dataSourceDisplayName } from "../src/notion/client.ts";
import type { NotionClient, NotionPageObject } from "../src/notion/client.ts";
import { updateVerificationHandler } from "../src/tools/update-page/verification.ts";
import { cloneBlockForRequest, stripResponseOnlyNulls } from "../src/tools/update-page/shared.ts";
import type { HydratedBlock } from "../src/notion/markdown/from-blocks.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg !== sw) {
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function richTextPlain(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs
    .map((r) => {
      const run = r as { type?: string; text?: { content?: string }; plain_text?: string };
      if (run.type === "text" || !run.type) return run.text?.content ?? "";
      return run.plain_text ?? "";
    })
    .join("");
}

// -----------------------------------------------------------------------------
// Bug 4 — <details> multi-paragraph → toggle
// -----------------------------------------------------------------------------

console.log("\n[Bug 4] <details> spanning blank lines becomes a toggle");
{
  const md = [
    "<details>",
    "<summary>Toggle heading</summary>",
    "",
    "Toggle body paragraph.",
    "",
    "</details>",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  eq(blocks.length, 1, "produces exactly one top-level block");
  eq(blocks[0]!.type, "toggle", "block type is toggle");
  const toggle = (blocks[0] as Record<string, unknown>).toggle as { rich_text?: unknown; children?: unknown[] };
  eq(richTextPlain(toggle.rich_text), "Toggle heading", "summary text is preserved");
  assert(Array.isArray(toggle.children) && toggle.children.length === 1, "exactly one child block");
  const child = (toggle.children as Array<Record<string, unknown>>)[0]!;
  eq(child.type, "paragraph", "child is a paragraph");
  const childPara = child.paragraph as { rich_text?: unknown };
  eq(richTextPlain(childPara.rich_text), "Toggle body paragraph.", "child text preserved");
}

console.log("\n[Bug 4] leading-space <details> still recognised");
{
  // User's exact repro had a single leading space before <details>.
  const md = " <details> <summary>Heading</summary> \nBody.\n </details> ";
  const blocks = markdownToBlocks(md);
  eq(blocks.length, 1, "one block");
  eq(blocks[0]!.type, "toggle", "toggle despite leading whitespace");
  const toggle = (blocks[0] as Record<string, unknown>).toggle as { rich_text?: unknown; children?: unknown[] };
  eq(richTextPlain(toggle.rich_text), "Heading", "summary text");
  assert(Array.isArray(toggle.children) && (toggle.children as unknown[]).length === 1, "one child");
}

console.log("\n[Bug 4] <details> alongside other markdown");
{
  const md = [
    "# Heading 1",
    "",
    "<details>",
    "<summary>Details summary</summary>",
    "",
    "Inner paragraph.",
    "",
    "</details>",
    "",
    "A trailing paragraph.",
  ].join("\n");
  const blocks = markdownToBlocks(md);
  const types = blocks.map((b) => b.type);
  eq(types, ["heading_1", "toggle", "paragraph"], "heading → toggle → paragraph sequence");
}

// -----------------------------------------------------------------------------
// Bug 5 — data source title rendering
// -----------------------------------------------------------------------------

console.log("\n[Bug 5] dataSourceDisplayName prefers title rich_text");
{
  const ds = {
    object: "data_source" as const,
    id: "ds-1",
    title: [
      { type: "text" as const, plain_text: "My Tasks", text: { content: "My Tasks" } },
    ],
    properties: {},
  };
  eq(dataSourceDisplayName(ds), "My Tasks", "title rich_text wins");
}

console.log("\n[Bug 5] dataSourceDisplayName falls back to legacy name");
{
  const ds = {
    object: "data_source" as const,
    id: "ds-2",
    name: "Legacy Name",
    properties: {},
  };
  eq(dataSourceDisplayName(ds), "Legacy Name", "legacy name path");
}

console.log("\n[Bug 5] dataSourceDisplayName handles missing fields");
{
  eq(dataSourceDisplayName({ object: "data_source" as const, id: "ds-3", properties: {} }), "(untitled)", "both absent → placeholder");
  eq(dataSourceDisplayName(null), "(untitled)", "null → placeholder");
  eq(dataSourceDisplayName({ object: "data_source" as const, id: "ds-4", title: [], properties: {} }), "(untitled)", "empty title array → placeholder");
}

console.log("\n[Bug 5] formatDataSourceSummary heading not 'undefined'");
{
  const ds = {
    object: "data_source" as const,
    id: "ds-live",
    database_parent: { database_id: "db-123" },
    title: [
      { type: "text" as const, plain_text: "Engineering Projects", text: { content: "Engineering Projects" } },
    ],
    properties: { Name: { type: "title" }, Status: { type: "status" } },
  };
  const out = formatDataSourceSummary(ds);
  assert(out.startsWith("# Data Source: Engineering Projects"), "heading uses title, not 'undefined'");
  assert(out.includes("Parent database: db-123"), "parent db rendered");
  assert(out.includes("- **Name**: title"), "schema rendered");
  assert(!out.includes("undefined"), "no 'undefined' leaks into output");
}

// -----------------------------------------------------------------------------
// Bug 2 — update_verification on non-wiki page returns friendly error
// -----------------------------------------------------------------------------

console.log("\n[Bug 2] update_verification on non-wiki page returns tool-level error");
{
  const calls: string[] = [];
  const fake = {
    getPage: async (_id: string): Promise<NotionPageObject> => {
      calls.push("getPage");
      return {
        object: "page",
        id: "p-reg",
        created_time: "2025-01-01T00:00:00Z",
        last_edited_time: "2025-01-01T00:00:00Z",
        archived: false,
        parent: { type: "page_id", page_id: "parent" },
        properties: {},
        url: "https://www.notion.so/p-reg",
        is_wiki_page: false,
      };
    },
    updatePage: async (_id: string, _body: unknown) => {
      calls.push("updatePage");
      return {} as NotionPageObject;
    },
  } as unknown as NotionClient;

  const res = await updateVerificationHandler(fake, "p-reg", { verification_status: "verified" });
  assert(res.isError === true, "returns isError:true");
  assert(calls.includes("getPage"), "getPage was called");
  assert(!calls.includes("updatePage"), "updatePage was NOT called on a regular page");
  const text = res.content[0]?.text ?? "";
  assert(text.includes("wiki"), "error message mentions 'wiki'");
  assert(!text.includes("Notion API 400"), "no raw 400 leaks through");
}

console.log("\n[Bug 2] update_verification on wiki home page still works");
{
  const calls: Array<{ method: string; body?: unknown }> = [];
  const fake = {
    getPage: async (_id: string): Promise<NotionPageObject> => {
      calls.push({ method: "getPage" });
      return {
        object: "page",
        id: "p-wiki",
        created_time: "2025-01-01T00:00:00Z",
        last_edited_time: "2025-01-01T00:00:00Z",
        archived: false,
        parent: { type: "workspace", workspace: true },
        properties: {},
        url: "https://www.notion.so/p-wiki",
        is_wiki_page: true,
      };
    },
    updatePage: async (_id: string, body: unknown) => {
      calls.push({ method: "updatePage", body });
      return {} as NotionPageObject;
    },
  } as unknown as NotionClient;

  const res = await updateVerificationHandler(fake, "p-wiki", { verification_status: "verified" });
  assert(res.isError !== true, "wiki page update succeeds");
  assert(calls.some((c) => c.method === "updatePage"), "updatePage IS called for wiki pages");
  const patched = calls.find((c) => c.method === "updatePage")?.body as { verification?: { state?: string } };
  eq(patched.verification?.state, "verified", "verification state forwarded");
}

console.log("\n[Bug 2] update_verification invalid status still rejects early");
{
  const fake = {
    getPage: async () => {
      throw new Error("should not be called for invalid status");
    },
  } as unknown as NotionClient;
  const res = await updateVerificationHandler(fake, "p-x", { verification_status: "nope" });
  assert(res.isError === true, "invalid status → isError");
  const text = res.content[0]?.text ?? "";
  assert(text.includes("verification_status"), "error mentions the field name");
}

// -----------------------------------------------------------------------------
// apply_template — response-only nulls stripped from cloned block requests
// -----------------------------------------------------------------------------
//
// Root cause: Notion's GET response shape includes `icon: null` / `color: null`
// on most block bodies, but POST/PATCH rejects `null` for those fields. The
// duplicate_page path already stripped them; apply_template's clone path did
// not, so applying a template that included paragraphs (almost every template)
// 400'd with "body.children[N].paragraph.icon should be an object or
// undefined, instead was null".
//
// Fix: `stripResponseOnlyNulls(body, type)` in update-page/shared.ts — called
// from `cloneBlockForRequest` and from duplicate_page's `sanitizeTypeBody` so
// the two paths can't drift.

console.log("\n[apply_template] stripResponseOnlyNulls drops icon/color/caption nulls");
{
  const body: Record<string, unknown> = {
    rich_text: [{ type: "text", text: { content: "hi" } }],
    icon: null,
    color: null,
    caption: null,
    is_toggleable: false,
  };
  stripResponseOnlyNulls(body, "paragraph");
  assert(!("icon" in body), "paragraph.icon null stripped");
  assert(!("color" in body), "paragraph.color null stripped");
  assert(!("caption" in body), "paragraph.caption null stripped");
  assert(body.is_toggleable === false, "non-null fields untouched");
  assert(Array.isArray(body.rich_text), "rich_text preserved");
}

console.log("\n[apply_template] stripResponseOnlyNulls keeps synced_from:null on synced_block");
{
  const body: Record<string, unknown> = {
    synced_from: null,
    icon: null,
  };
  stripResponseOnlyNulls(body, "synced_block");
  assert("synced_from" in body && body.synced_from === null, "synced_from:null preserved");
  assert(!("icon" in body), "other nulls still stripped");
}

console.log("\n[apply_template] stripResponseOnlyNulls on non-synced block strips EVERY null");
{
  const body: Record<string, unknown> = {
    synced_from: null, // not a synced_block → no preservation
    icon: null,
  };
  stripResponseOnlyNulls(body, "paragraph");
  assert(!("synced_from" in body), "synced_from stripped on non-synced_block types");
  assert(!("icon" in body), "icon stripped");
}

console.log("\n[apply_template] cloneBlockForRequest emits no icon/color nulls on paragraph");
{
  const src: HydratedBlock = {
    object: "block",
    id: "p-1",
    created_time: "2026-04-20T00:00:00Z",
    last_edited_time: "2026-04-20T00:00:00Z",
    has_children: false,
    archived: false,
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: "body" } }],
      icon: null,
      color: null,
    },
  } as HydratedBlock;
  const req = cloneBlockForRequest(src);
  assert(req !== null, "cloneBlockForRequest returned a request");
  if (req) {
    const body = (req as Record<string, unknown>).paragraph as Record<string, unknown>;
    assert(!("icon" in body), "icon:null stripped from cloned paragraph");
    assert(!("color" in body), "color:null stripped from cloned paragraph");
    assert(Array.isArray(body.rich_text), "rich_text carried through");
  }
}

console.log("\n[apply_template] cloneBlockForRequest strips nulls inside callout bodies");
{
  const src: HydratedBlock = {
    object: "block",
    id: "c-1",
    created_time: "2026-04-20T00:00:00Z",
    last_edited_time: "2026-04-20T00:00:00Z",
    has_children: false,
    archived: false,
    type: "callout",
    callout: {
      rich_text: [{ type: "text", text: { content: "note" } }],
      icon: { type: "emoji", emoji: "💡" }, // real icon on the callout — NOT null
      color: null, // response-only null — must be stripped
    },
  } as HydratedBlock;
  const req = cloneBlockForRequest(src);
  assert(req !== null, "callout cloned");
  if (req) {
    const body = (req as Record<string, unknown>).callout as Record<string, unknown>;
    assert(body.icon !== null && body.icon !== undefined, "real icon object preserved");
    assert(!("color" in body), "color:null stripped");
  }
}

console.log("\n[apply_template] cloneBlockForRequest recurses: nested child paragraphs also stripped");
{
  const child: HydratedBlock = {
    object: "block",
    id: "p-child",
    created_time: "2026-04-20T00:00:00Z",
    last_edited_time: "2026-04-20T00:00:00Z",
    has_children: false,
    archived: false,
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: "inner" } }],
      icon: null,
      color: null,
    },
  } as HydratedBlock;
  const parent: HydratedBlock = {
    object: "block",
    id: "t-1",
    created_time: "2026-04-20T00:00:00Z",
    last_edited_time: "2026-04-20T00:00:00Z",
    has_children: true,
    archived: false,
    type: "toggle",
    toggle: { rich_text: [{ type: "text", text: { content: "outer" } }], color: null },
    children: [child],
  } as HydratedBlock;
  const req = cloneBlockForRequest(parent);
  assert(req !== null, "toggle cloned");
  if (req) {
    const toggleBody = (req as Record<string, unknown>).toggle as Record<string, unknown>;
    assert(!("color" in toggleBody), "toggle.color:null stripped");
    const kids = toggleBody.children as Array<Record<string, unknown>> | undefined;
    assert(Array.isArray(kids) && kids.length === 1, "one child inlined");
    const childBody = kids![0]!.paragraph as Record<string, unknown>;
    assert(!("icon" in childBody), "nested paragraph icon stripped");
    assert(!("color" in childBody), "nested paragraph color stripped");
  }
}

// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
