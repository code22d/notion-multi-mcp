// -----------------------------------------------------------------------------
// Emitted-request-body tests.
//
// Run with:
//   tsx test/block-write-schema.ts
//
// WHAT MAKES THESE DIFFERENT FROM THE REST OF THE SUITE
//
// Every other test here asserts against a stubbed `fetch`, and a stub accepts
// whatever body it is handed. So "we called appendBlockChildren with a tab
// block" passes while the body is one Notion refuses outright — which is
// exactly what happened: 805 tests were green while notion_duplicate_page
// returned
//
//   body.children[1].tab.children should be defined, instead was `undefined`
//
// These tests assert the SHAPE OF THE BYTES we would have sent, against
// src/notion/block-write-schema.ts — a transcription of the request types
// generated from Notion's own OpenAPI spec. Section 1 first proves the
// validator actually rejects each body that caused a real production 400, so
// the green ticks below it mean something.
//
// What they still cannot do: prove Notion agrees. The table is a transcription,
// not the server. A live smoke test is the only thing that closes that gap.
// -----------------------------------------------------------------------------

import type { NotionBlockObject, NotionClient, PaginatedList } from "../src/notion/client.ts";
import type { HydratedBlock } from "../src/notion/markdown/from-blocks.ts";
import type { BlockRequest } from "../src/notion/markdown/to-blocks.ts";
import { markdownToBlocks } from "../src/notion/markdown/to-blocks.ts";
import { blocksToMarkdown } from "../src/notion/markdown/from-blocks.ts";
import {
  describeBlockRequestProblems,
  validateBlockRequestTree,
} from "../src/notion/block-write-schema.ts";
import { cloneBlockTree, resolvePendingChildren } from "../src/notion/block-clone.ts";
import { DUPLICATE_CLONE_POLICY } from "../src/tools/duplicate-move.ts";
import { TEMPLATE_CLONE_POLICY } from "../src/tools/update-page/shared.ts";
import { applyTemplateHandler } from "../src/tools/update-page/template.ts";

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

/** The body is one Notion's documented write schema would accept. */
function assertValid(blocks: unknown, msg: string): void {
  const problems = validateBlockRequestTree(blocks);
  if (problems.length === 0) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}\n      ${describeBlockRequestProblems(problems).split("\n").join("\n      ")}`);
  }
}

/** The body is one Notion would reject, for the stated reason. */
function assertInvalid(blocks: unknown, needle: string, msg: string): void {
  const text = describeBlockRequestProblems(validateBlockRequestTree(blocks));
  assert(text.includes(needle), `${msg} (expected a complaint containing "${needle}", got ${text || "no problems"})`);
}

// -----------------------------------------------------------------------------
// Fixture builders — response shapes, the way Notion hands them back
// -----------------------------------------------------------------------------

let seq = 0;
function id(prefix: string): string {
  return `${prefix}-${++seq}`;
}

function rt(content: string): Record<string, unknown> {
  return { type: "text", text: { content }, plain_text: content, href: null };
}

function block(type: string, body: Record<string, unknown>, children?: HydratedBlock[]): HydratedBlock {
  return {
    object: "block",
    id: id(type),
    type,
    [type]: body,
    created_time: "2026-07-01T00:00:00.000Z",
    last_edited_time: "2026-07-01T00:00:00.000Z",
    has_children: Boolean(children && children.length > 0),
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: "src-page" },
    ...(children ? { children } : {}),
  } as unknown as HydratedBlock;
}

/** A paragraph as Notion returns it — note `icon: null`, which the write schema rejects. */
function para(text: string, children?: HydratedBlock[]): HydratedBlock {
  return block("paragraph", { rich_text: [rt(text)], color: "default", icon: null }, children);
}

/**
 * A tab block exactly as Notion returns one: the `tab` body is EMPTY and every
 * tab is a paragraph child whose rich_text is the label, `icon` the tab icon
 * and `children` the tab's content. This is the shape that broke duplication.
 */
function tabBlock(tabs: Array<{ label: string; icon?: unknown; body: HydratedBlock[] }>): HydratedBlock {
  return block(
    "tab",
    {},
    tabs.map((t) =>
      block(
        "paragraph",
        { rich_text: [rt(t.label)], color: "default", icon: t.icon ?? null },
        t.body
      )
    )
  );
}

/** The page from the bug report, as Notion would return its block tree. */
function reproductionTree(): HydratedBlock[] {
  return [
    para("Intro paragraph before the tabs."),
    tabBlock([
      { label: "Overview", icon: { type: "emoji", emoji: "📋" }, body: [para("Content of the first tab.")] },
      { label: "Bold details", body: [para("Second tab body.")] },
    ]),
    para("Closing paragraph after the tabs."),
  ];
}

// -----------------------------------------------------------------------------
// Recording fake client
// -----------------------------------------------------------------------------

interface Appended {
  parentId: string;
  children: BlockRequest[];
}

function makeRecordingClient(sourceByParent: Record<string, HydratedBlock[]> = {}): {
  client: NotionClient;
  appends: Appended[];
} {
  const childrenByParent = new Map<string, NotionBlockObject[]>();
  for (const [parent, kids] of Object.entries(sourceByParent)) {
    register(parent, kids);
  }
  function register(parentId: string, kids: HydratedBlock[]): void {
    childrenByParent.set(parentId, kids as unknown as NotionBlockObject[]);
    for (const k of kids) if (k.children) register(k.id, k.children);
  }

  const appends: Appended[] = [];
  let created = 0;

  /**
   * Mirror what Notion does with an accepted request: create a block per entry
   * and materialise its inlined `children` as that block's real children, so a
   * later listAllBlockChildren can address them.
   */
  function materialise(req: BlockRequest): NotionBlockObject {
    const type = String(req.type);
    const body = (req as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
    const kids = Array.isArray(body?.children) ? (body!.children as BlockRequest[]) : [];
    const madeId = `new-${++created}`;
    if (kids.length > 0) {
      childrenByParent.set(madeId, kids.map(materialise));
    }
    return {
      object: "block",
      id: madeId,
      type,
      [type]: body ?? {},
      has_children: kids.length > 0,
    } as unknown as NotionBlockObject;
  }

  const fake = {
    listAllBlockChildren: async (blockId: string): Promise<NotionBlockObject[]> =>
      childrenByParent.get(blockId) ?? [],
    appendBlockChildren: async (parentId: string, body: unknown): Promise<PaginatedList<NotionBlockObject>> => {
      const children = ((body as { children?: BlockRequest[] })?.children ?? []) as BlockRequest[];
      appends.push({ parentId, children });
      const results = children.map(materialise);
      const prior = childrenByParent.get(parentId) ?? [];
      childrenByParent.set(parentId, [...prior, ...results]);
      return { object: "list", results, next_cursor: null, has_more: false };
    },
  };
  return { client: fake as unknown as NotionClient, appends };
}

/** Every block body sent to the API across a run, flattened for validation. */
function allSentBodies(appends: Appended[]): BlockRequest[] {
  return appends.flatMap((a) => a.children);
}

// =============================================================================
// 1. The validator earns its keep — it rejects each body that caused a real 400
// =============================================================================

console.log("\n[validator] rejects the bodies that produced production 400s");
{
  // Bug 3 (this one): the tab block as duplicate_page used to emit it.
  assertInvalid(
    [{ type: "tab", tab: {} }],
    "tab.children` is required",
    "the exact body Notion rejected is caught, naming the same field"
  );

  // Bug 1: response-only nulls. `... icon should be an object or undefined,
  // instead was null` — the failure that produced stripResponseOnlyNulls().
  assertInvalid(
    [{ type: "paragraph", paragraph: { rich_text: [rt("x")], icon: null } }],
    "is null",
    "a response-only null in a type body is caught"
  );

  // Bug 2: media read back as a notion-hosted file, a shape the write schema
  // has no case for at all.
  assertInvalid(
    [{ type: "image", image: { type: "file", file: { url: "https://prod-files-secure/x.png" } } }],
    "media blocks accept only",
    "a notion-hosted file body is caught"
  );

  assertInvalid(
    [{ object: "block", id: "abc", type: "divider", divider: {} }],
    "response-only field",
    "response-only id/object fields are caught"
  );
  assertInvalid([{ type: "table", table: { children: [] } }], "table.table_width", "a table without table_width is caught");
  assertInvalid(
    [{ type: "column_list", column_list: { children: [{ type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } }] } }],
    "requires at least 2",
    "a one-column column_list is caught"
  );
  assertInvalid(
    [{ type: "tab", tab: { children: [{ type: "toggle", toggle: { rich_text: [] } }] } }],
    "accepts only paragraph",
    "a non-paragraph tab child is caught"
  );
}

console.log("\n[validator] accepts well-formed bodies (it is not just always-fail)");
{
  assertValid([{ type: "paragraph", paragraph: { rich_text: [rt("hi")] } }], "a plain paragraph is accepted");
  assertValid([{ type: "divider", divider: {} }], "a divider is accepted");
  assertValid(
    [{ type: "synced_block", synced_block: { synced_from: null } }],
    "synced_from: null survives — it is the ORIGINAL marker, not a stray null"
  );
  assertValid(
    [{ type: "table", table: { table_width: 2, children: [{ type: "table_row", table_row: { cells: [[], []] } }] } }],
    "a table with width and a row is accepted"
  );
}

console.log("\n[validator] knows the request schema shrinks with nesting depth");
{
  // column_list is a tier-1-only type: legal at the top of a request body,
  // absent from the schema one level down.
  const columnList = {
    type: "column_list",
    column_list: {
      children: [
        { type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
        { type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
      ],
    },
  };
  assertValid([columnList], "column_list is valid at the top level");
  assertInvalid(
    [{ type: "toggle", toggle: { rich_text: [], children: [columnList] } }],
    "not part of the request schema at nesting tier",
    "…and invalid nested inside a toggle"
  );
  assertInvalid(
    [
      {
        type: "toggle",
        toggle: {
          rich_text: [],
          children: [
            { type: "toggle", toggle: { rich_text: [], children: [{ type: "toggle", toggle: { rich_text: [], children: [] } }] } },
          ],
        },
      },
    ],
    "may not carry `children` at nesting tier 3",
    "a fourth level of inline children is caught"
  );
}

// =============================================================================
// 2. The reproduction — the page from the bug report, both directions
// =============================================================================

console.log("\n[reproduction] CREATE path: the markdown from the bug report");
{
  const md = `Intro paragraph before the tabs.

<tabs>
  <tab icon="📋"><summary>Overview</summary>
    Content of the first tab.
  </tab>
  <tab><summary>**Bold** details</summary>
    Second tab body.
  </tab>
</tabs>

Closing paragraph after the tabs.`;

  const blocks = markdownToBlocks(md);
  assertValid(blocks, "notion_create_pages emits a body the write schema accepts");

  const tab = blocks.find((b) => b.type === "tab");
  assert(tab !== undefined, "the markdown produced a tab block");
  const tabBody = tab ? ((tab as Record<string, unknown>).tab as { children?: BlockRequest[] }) : undefined;
  assert(Array.isArray(tabBody?.children) && tabBody!.children!.length === 2, "with both tabs as paragraph children");
}

console.log("\n[reproduction] DUPLICATE path: the same page, read back and re-emitted");
{
  const cloned = cloneBlockTree(reproductionTree(), DUPLICATE_CLONE_POLICY);
  const body = cloned.map((c) => c.request);

  // The assertion that would have caught the bug. Before the fix this body was
  // [paragraph, {type:"tab", tab:{}}, paragraph] and Notion 400'd on index 1.
  assertValid(body, "duplicate_page emits a body the write schema accepts");

  assert(body.length === 3, "three top-level blocks, in order");
  assert(body[1]?.type === "tab", "the tab block is at children[1] — where Notion pointed");

  const tabBody = (body[1] as Record<string, unknown>).tab as { children?: BlockRequest[] } | undefined;
  assert(tabBody !== undefined && "children" in tabBody!, "`tab.children` is DEFINED — the field Notion named");
  assert(Array.isArray(tabBody?.children) && tabBody!.children!.length === 2, "both tabs survived the clone");

  const first = tabBody!.children![0]! as Record<string, unknown>;
  assert(first.type === "paragraph", "a tab is a paragraph, not a block type of its own");
  const firstBody = first.paragraph as Record<string, unknown>;
  assert(
    JSON.stringify(firstBody.rich_text).includes("Overview"),
    "the tab's label survived as the paragraph's rich_text"
  );
  assert(
    JSON.stringify(firstBody.icon) === JSON.stringify({ type: "emoji", emoji: "📋" }),
    "the tab's icon survived"
  );
  const firstContent = firstBody.children as BlockRequest[] | undefined;
  assert(
    Array.isArray(firstContent) && JSON.stringify(firstContent).includes("Content of the first tab."),
    "the tab's BODY survived — inlining the tab without this silently empties every tab"
  );

  const secondBody = (tabBody!.children![1] as Record<string, unknown>).paragraph as Record<string, unknown>;
  assert(!("icon" in secondBody), "a tab with no icon sends no `icon` key rather than icon: null");
}

console.log("\n[reproduction] round-trip: the duplicate reads back as the same markdown");
{
  const original = blocksToMarkdown(reproductionTree());
  assert(original.includes("<tabs>"), "source renders as <tabs>");
  assert(original.includes('<tab icon="📋"><summary>Overview</summary>'), "…with label and icon");
  assert(original.includes("Content of the first tab."), "…and tab content");
}

// =============================================================================
// 3. Container audit — one case per type whose children the schema requires
// =============================================================================

console.log("\n[containers] every required-children type emits a valid body");
{
  const tabs = cloneBlockTree([tabBlock([{ label: "One", body: [para("a")] }])], DUPLICATE_CLONE_POLICY);
  assertValid(tabs.map((c) => c.request), "tab");

  const table = block(
    "table",
    { table_width: 2, has_column_header: true, has_row_header: false },
    [
      block("table_row", { cells: [[rt("a")], [rt("b")]] }),
      block("table_row", { cells: [[rt("c")], [rt("d")]] }),
    ]
  );
  const tableOut = cloneBlockTree([table], DUPLICATE_CLONE_POLICY);
  assertValid(tableOut.map((c) => c.request), "table (table_width + table_row children)");
  const tableBody = (tableOut[0]!.request as Record<string, unknown>).table as Record<string, unknown>;
  assert(tableBody.table_width === 2, "table_width carried over — required and unguessable from the rows alone");
  assert(Array.isArray(tableBody.children) && (tableBody.children as unknown[]).length === 2, "both rows inlined");

  const columnList = block("column_list", {}, [
    block("column", { width_ratio: 0.5 }, [para("left")]),
    block("column", { width_ratio: 0.5 }, [para("right")]),
  ]);
  const colOut = cloneBlockTree([columnList], DUPLICATE_CLONE_POLICY);
  assertValid(colOut.map((c) => c.request), "column_list + column");

  const syncedOriginal = block("synced_block", { synced_from: null }, [para("mirrored")]);
  assertValid(
    cloneBlockTree([syncedOriginal], DUPLICATE_CLONE_POLICY).map((c) => c.request),
    "synced_block original (synced_from: null is kept, children optional)"
  );
}

console.log("\n[containers] a childless required-children container is never emitted");
{
  // Notion has no valid representation of a tab block with no tabs. Emitting
  // one is a 400 naming a field the user never supplied and cannot act on; the
  // block renders as nothing, so dropping it loses no content.
  const empty = block("tab", {});
  const out = cloneBlockTree([empty], DUPLICATE_CLONE_POLICY);
  assert(out.length === 0, "an empty tab block is dropped rather than sent");
  assertValid(out.map((c) => c.request), "…leaving a valid body");

  const emptyTable = block("table", { table_width: 2 });
  assert(cloneBlockTree([emptyTable], DUPLICATE_CLONE_POLICY).length === 0, "a row-less table is dropped");

  // Surrounding content must not be collateral damage.
  const mixed = cloneBlockTree([para("before"), block("tab", {}), para("after")], DUPLICATE_CLONE_POLICY);
  assert(mixed.length === 2, "the blocks around a dropped tab are kept");
  assertValid(mixed.map((c) => c.request), "…and the body stays valid");
}

console.log("\n[containers] hosted media is rewritten on BOTH clone paths");
{
  const img = block("image", {
    type: "file",
    file: { url: "https://prod-files-secure.s3.amazonaws.com/a/b.png", expiry_time: "2026-07-02T00:00:00.000Z" },
    caption: [],
  });
  for (const [name, policy] of [
    ["duplicate_page", DUPLICATE_CLONE_POLICY],
    ["apply_template", TEMPLATE_CLONE_POLICY],
  ] as const) {
    const out = cloneBlockTree([img], policy);
    assertValid(out.map((c) => c.request), `${name} rewrites a notion-hosted image to external`);
  }
}

console.log("\n[containers] blocks with no create shape are handled, not sent");
{
  for (const type of ["child_database", "unsupported", "ai_block"]) {
    const dup = cloneBlockTree([block(type, { title: "x" })], DUPLICATE_CLONE_POLICY);
    assert(dup.length === 1 && dup[0]!.request.type === "paragraph", `${type} → placeholder for duplicate_page`);
    assertValid(dup.map((c) => c.request), `…and that placeholder is a valid body (${type})`);
    const tpl = cloneBlockTree([block(type, { title: "x" })], TEMPLATE_CLONE_POLICY);
    assert(tpl.length === 0, `${type} → skipped for apply_template`);
  }
}

// =============================================================================
// 4. Nesting depth — nothing is inlined past what the schema carries, and
//    nothing that gets deferred is lost
// =============================================================================

console.log("\n[depth] deep nesting is split across requests instead of overflowing one");
{
  const deep = block("toggle", { rich_text: [rt("L1")] }, [
    block("toggle", { rich_text: [rt("L2")] }, [
      block("toggle", { rich_text: [rt("L3")] }, [block("toggle", { rich_text: [rt("L4")] }, [para("L5")])]),
    ]),
  ]);
  const cloned = cloneBlockTree([deep], DUPLICATE_CLONE_POLICY);
  assertValid(cloned.map((c) => c.request), "the first request body stays inside the schema's nesting limit");

  // Stand in for what duplicate_page does after createPage: the new page holds
  // the emitted top-level blocks, and the resolver attaches the rest.
  const { client, appends } = makeRecordingClient({ "page-1": [] });
  await client.appendBlockChildren("page-1", { children: cloned.map((c) => c.request) });
  await resolvePendingChildren(client, "page-1", cloned, DUPLICATE_CLONE_POLICY);

  const sent = allSentBodies(appends);
  assertValid(sent, "every follow-up request body is valid too");
  assert(appends.length > 1, "the deferred subtree really did become a second request");
  assert(
    JSON.stringify(sent).includes("L5"),
    "the deepest content is appended, not dropped — deferral must be lossless"
  );
}

console.log("\n[depth] a column_list nested too deep is appended rather than emitted illegally");
{
  const nested = block("toggle", { rich_text: [rt("outer")] }, [
    block("column_list", {}, [block("column", {}, [para("left")]), block("column", {}, [para("right")])]),
  ]);
  const cloned = cloneBlockTree([nested], DUPLICATE_CLONE_POLICY);
  assertValid(cloned.map((c) => c.request), "the toggle is emitted without an illegal inline column_list");

  const { client, appends } = makeRecordingClient();
  await client.appendBlockChildren("page-1", { children: cloned.map((c) => c.request) });
  await resolvePendingChildren(client, "page-1", cloned, DUPLICATE_CLONE_POLICY);
  const sent = allSentBodies(appends);
  assertValid(sent, "and every request in the sequence is valid");
  assert(JSON.stringify(sent).includes("column_list"), "the column_list still reaches the page");
  assert(JSON.stringify(sent).includes("left") && JSON.stringify(sent).includes("right"), "with both columns' contents");
}

// =============================================================================
// 5. apply_template — the sibling path, end to end
// =============================================================================

console.log("\n[apply_template] emits a valid body for the same tab page");
{
  const tree = reproductionTree();
  const { client, appends } = makeRecordingClient({ "template-1": tree });
  const res = await applyTemplateHandler(client, "target-1", "template-1");

  assert(res.isError !== true, `apply_template succeeded (${JSON.stringify(res.content?.[0])})`);
  assert(appends.length >= 1, "it appended something");
  assert(appends[0]!.parentId === "target-1", "…to the target page");
  assertValid(allSentBodies(appends), "every body apply_template sends is one the write schema accepts");

  const tab = appends[0]!.children.find((b) => b.type === "tab");
  assert(tab !== undefined, "the template's tab block was cloned");
  const tabBody = tab ? ((tab as Record<string, unknown>).tab as { children?: BlockRequest[] }) : undefined;
  assert(Array.isArray(tabBody?.children) && tabBody!.children!.length === 2, "with `tab.children` populated");
}

console.log("\n[apply_template] deep templates append what the body cannot carry");
{
  const deep = block("toggle", { rich_text: [rt("L1")] }, [
    block("toggle", { rich_text: [rt("L2")] }, [
      block("toggle", { rich_text: [rt("L3")] }, [block("toggle", { rich_text: [rt("L4")] }, [para("deep leaf")])]),
    ]),
  ]);
  const { client, appends } = makeRecordingClient({ "template-2": [deep] });
  await applyTemplateHandler(client, "target-2", "template-2");

  const sent = allSentBodies(appends);
  assertValid(sent, "every body is valid");
  assert(
    JSON.stringify(sent).includes("deep leaf"),
    "the deepest block reaches the page — apply_template used to send one over-nested body and drop the rest"
  );
}

console.log("\n[apply_template] a template that is only unclonable blocks is an error, not a bad request");
{
  const { client, appends } = makeRecordingClient({ "template-3": [block("child_database", { title: "db" })] });
  const res = await applyTemplateHandler(client, "target-3", "template-3");
  assert(res.isError === true, "reports an error rather than appending nothing");
  assert(appends.length === 0, "and sends no request at all");
}

// -----------------------------------------------------------------------------

console.log(`\n=== block write schema: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
