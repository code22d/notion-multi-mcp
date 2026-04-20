// -----------------------------------------------------------------------------
// Unit test for the notion_duplicate_page block-shape converter.
//
// Run with:
//   tsx test/duplicate-page.ts
//
// Pure function test — no network. We construct response-shaped blocks and
// assert the request-shaped output has the expected type, inlined children
// (where supported), and stripped server-only fields.
// -----------------------------------------------------------------------------

import { toBlockRequest, type HydratedBlock, type BlockRequest } from "../src/tools/duplicate-move.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function hydratedBlock(type: string, body: Record<string, unknown>, extras: Partial<HydratedBlock> = {}): HydratedBlock {
  return {
    object: "block",
    id: `fake-${Math.random().toString(36).slice(2, 8)}`,
    created_time: "2026-04-19T00:00:00Z",
    last_edited_time: "2026-04-19T00:00:00Z",
    has_children: Boolean(extras.children && extras.children.length > 0),
    archived: false,
    type,
    [type]: body,
    ...extras,
  };
}

// -----------------------------------------------------------------------------
// Test cases
// -----------------------------------------------------------------------------

console.log("\n=== duplicate_page: toBlockRequest ===");

// 1) Simple paragraph — server fields stripped.
{
  const src = hydratedBlock("paragraph", {
    rich_text: [{ type: "text", text: { content: "hello" }, plain_text: "hello" }],
  });
  const out = toBlockRequest(src);
  assert(out !== null, "paragraph returned a block request");
  if (out) {
    assert(out.type === "paragraph", "type preserved");
    assert(!("id" in out), "id stripped");
    assert(!("object" in out), "object stripped");
    assert(!("created_time" in out), "created_time stripped");
    assert(!("last_edited_time" in out), "last_edited_time stripped");
    assert(!("archived" in out), "archived stripped");
    assert(!("has_children" in out), "has_children stripped");
  }
}

// 2) Toggle with inline children — children inlined in request body.
{
  const child = hydratedBlock("paragraph", { rich_text: [{ type: "text", text: { content: "inner" } }] });
  const parent = hydratedBlock(
    "toggle",
    { rich_text: [{ type: "text", text: { content: "outer" } }] },
    { children: [child] }
  );
  const out = toBlockRequest(parent);
  assert(out !== null, "toggle returned a request");
  if (out) {
    const body = (out as Record<string, unknown>).toggle as { children?: BlockRequest[] } | undefined;
    assert(Array.isArray(body?.children) && body!.children!.length === 1, "toggle inlined one child");
    assert(body?.children?.[0]?.type === "paragraph", "inlined child is a paragraph");
    // Since inlined, children reference was cleared on the source.
    assert(parent.children === undefined, "source.children cleared after inline");
  }
}

// 3) child_database — converted to placeholder paragraph.
{
  const src = hydratedBlock("child_database", { title: "My DB" });
  const out = toBlockRequest(src);
  assert(out !== null, "child_database returned a placeholder");
  if (out) {
    assert(out.type === "paragraph", "child_database replaced with paragraph placeholder");
    const body = (out as Record<string, unknown>).paragraph as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
    const text = body?.rich_text?.[0]?.text?.content ?? "";
    assert(/not duplicable/i.test(text), "placeholder mentions not-duplicable");
  }
}

// 4) child_page — placeholder with original title.
{
  const src = hydratedBlock("child_page", { title: "My Nested Page" });
  const out = toBlockRequest(src);
  assert(out !== null, "child_page returned a placeholder");
  if (out) {
    const body = (out as Record<string, unknown>).paragraph as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
    const text = body?.rich_text?.[0]?.text?.content ?? "";
    assert(/My Nested Page/.test(text), "placeholder references original page title");
  }
}

// 5) unsupported — placeholder.
{
  const src = hydratedBlock("unsupported", {});
  const out = toBlockRequest(src);
  assert(out?.type === "paragraph", "unsupported becomes paragraph placeholder");
}

// 6) synced_block (original) — request body retains synced_from: null.
{
  const src = hydratedBlock("synced_block", { synced_from: null });
  const out = toBlockRequest(src);
  assert(out?.type === "synced_block", "synced_block preserved");
  const body = out ? ((out as Record<string, unknown>).synced_block as { synced_from?: unknown }) : undefined;
  assert(body?.synced_from === null, "synced_from: null preserved");
}

// 7) synced_block (reference) — becomes placeholder.
{
  const src = hydratedBlock("synced_block", { synced_from: { block_id: "xyz" } });
  const out = toBlockRequest(src);
  assert(out?.type === "paragraph", "synced_block reference becomes placeholder");
}

// 8) image with notion-hosted file.url — rewritten as external.
{
  const src = hydratedBlock("image", {
    type: "file",
    file: { url: "https://prod-files-secure.s3.amazonaws.com/abc/def.png", expiry_time: "2026-04-20T00:00:00Z" },
    caption: [],
  });
  const out = toBlockRequest(src);
  assert(out?.type === "image", "image type preserved");
  const body = out ? ((out as Record<string, unknown>).image as { type?: string; external?: { url?: string }; file?: unknown }) : undefined;
  assert(body?.type === "external", "image type flipped to external");
  assert(typeof body?.external?.url === "string" && body!.external!.url!.includes("amazonaws"), "external URL carried over");
  assert(body?.file === undefined, "old file object removed");
}

// 9) Paragraph with icon: null and color: null — response-only nulls stripped,
//    synced_from: null preserved on synced_block.
{
  const src = hydratedBlock("paragraph", {
    rich_text: [{ type: "text", text: { content: "hi" } }],
    icon: null,
    color: null,
  });
  const out = toBlockRequest(src);
  const body = out ? ((out as Record<string, unknown>).paragraph as Record<string, unknown>) : undefined;
  assert(body !== undefined && !("icon" in body), "paragraph.icon: null stripped from body");
  assert(body !== undefined && !("color" in body), "paragraph.color: null stripped from body");
  assert(Array.isArray(body?.rich_text), "rich_text preserved");
}
{
  const src = hydratedBlock("synced_block", { synced_from: null });
  const out = toBlockRequest(src);
  const body = out ? ((out as Record<string, unknown>).synced_block as Record<string, unknown>) : undefined;
  assert(body !== undefined && "synced_from" in body && body!.synced_from === null, "synced_from: null retained");
}

// 10) column_list + column with nested paragraph — inlined hierarchy preserved.
{
  const inner = hydratedBlock("paragraph", { rich_text: [{ type: "text", text: { content: "col item" } }] });
  const column = hydratedBlock("column", {}, { children: [inner] });
  const columnList = hydratedBlock("column_list", {}, { children: [column] });
  const out = toBlockRequest(columnList);
  assert(out?.type === "column_list", "column_list preserved");
  const listBody = out ? ((out as Record<string, unknown>).column_list as { children?: BlockRequest[] }) : undefined;
  assert(Array.isArray(listBody?.children) && listBody!.children!.length === 1, "column_list has one child");
  const colReq = listBody!.children![0]!;
  assert(colReq.type === "column", "child is a column");
  const colBody = (colReq as Record<string, unknown>).column as { children?: BlockRequest[] } | undefined;
  assert(Array.isArray(colBody?.children) && colBody!.children!.length === 1, "column has one child");
  assert(colBody!.children![0]!.type === "paragraph", "leaf is a paragraph");
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log(`\n=== duplicate_page: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
