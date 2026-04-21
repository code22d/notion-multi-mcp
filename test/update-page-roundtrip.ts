// -----------------------------------------------------------------------------
// Unit + round-trip tests for notion_update_page (Phase 5).
//
// Run via `npm test` — follows the same node-script + plain-assert pattern as
// test/roundtrip.ts and test/ddl-roundtrip.ts.
//
// Covers:
//   - normaliseProperties scalar-map → Notion property shapes
//   - buildVerificationBody shape + expiry calculation
//   - checkPreservation scan (child_page / child_database preservation)
//   - cloneBlockForRequest (apply_template cloning semantics)
//   - update_content markdown-string-replace pipeline (fake client)
//   - replace_content preservation-gate failure (fake client)
// -----------------------------------------------------------------------------

import type { NotionBlockObject, NotionClient, PaginatedList } from "../src/notion/client.ts";
import type { HydratedBlock } from "../src/notion/markdown/from-blocks.ts";
import { blocksToMarkdown, blocksToMarkdownWithSpans } from "../src/notion/markdown/from-blocks.ts";
import { markdownToBlocks } from "../src/notion/markdown/to-blocks.ts";
import { normaliseProperties } from "../src/tools/update-page/properties.ts";
import { buildVerificationBody } from "../src/tools/update-page/verification.ts";
import { checkPreservation, extractPreservedIds } from "../src/tools/update-page/preservation.ts";
import { cloneBlockForRequest, normalizeId } from "../src/tools/update-page/shared.ts";
import { countOccurrences, updateContentHandler } from "../src/tools/update-page/content.ts";
import { replaceContentHandler } from "../src/tools/update-page/replace.ts";
import { planUpdate } from "../src/tools/update-page/diff.ts";
import {
  CLONE_FIXTURES,
  FAST_PATH_PAGE,
  FULL_FALLBACK_PAGE,
  HELLO_WORLD_PAGE,
  NESTED_TOGGLE_PAGE,
  PAGE_WITH_CHILD,
  PRESERVATION_FIXTURES,
  PROPERTY_FIXTURES,
  THREE_BLOCK_PAGE,
  VERIFICATION_FIXTURES,
} from "./update-page-fixtures.ts";

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

// -----------------------------------------------------------------------------
// normaliseProperties
// -----------------------------------------------------------------------------

console.log("\n[normaliseProperties]");
for (const f of PROPERTY_FIXTURES) {
  const got = normaliseProperties(f.input);
  eq(got.notionProps, f.expected, `${f.name}: props match`);
  if (f.expectedArchived !== undefined) {
    assert(got.archived === f.expectedArchived, `${f.name}: archived=${f.expectedArchived}`);
  }
  if (f.expectedInTrash !== undefined) {
    assert(got.inTrash === f.expectedInTrash, `${f.name}: inTrash=${f.expectedInTrash}`);
  }
}

// -----------------------------------------------------------------------------
// buildVerificationBody
// -----------------------------------------------------------------------------

console.log("\n[buildVerificationBody]");
for (const f of VERIFICATION_FIXTURES) {
  const got = buildVerificationBody(f.input, f.nowMs);
  eq(got, f.expected, `${f.name}: body matches`);
}

// Invalid status must throw.
console.log("\n[buildVerificationBody — invalid input]");
let threw = false;
try {
  buildVerificationBody({ verification_status: "unknown" }, 0);
} catch {
  threw = true;
}
assert(threw, "invalid verification_status throws");

// -----------------------------------------------------------------------------
// Preservation check
// -----------------------------------------------------------------------------

console.log("\n[checkPreservation]");
for (const f of PRESERVATION_FIXTURES) {
  const got = checkPreservation(f.existing, f.newMarkdown);
  const gotIds = got.missing.map((m) => m.id).sort();
  const wantIds = [...f.expectedMissingIds].sort();
  eq(gotIds, wantIds, `${f.name}: missing ids`);
}

// extractPreservedIds sanity — mixed url + id forms should both register.
console.log("\n[extractPreservedIds]");
const mixed = `
Here's a link: <page id="abcdef1234567890abcdef1234567890">A</page>
And via URL: <page url="https://www.notion.so/Title-1111111111111111aaaaaaaaaaaaaaaa">B</page>
And a DB: <database id="2222222222222222bbbbbbbbbbbbbbbb">C</database>
`;
const ids = extractPreservedIds(mixed);
assert(ids.has(normalizeId("abcdef1234567890abcdef1234567890")), "id= form captured");
assert(ids.has(normalizeId("1111111111111111aaaaaaaaaaaaaaaa")), "url= form captured");
assert(ids.has(normalizeId("2222222222222222bbbbbbbbbbbbbbbb")), "database id= form captured");

// -----------------------------------------------------------------------------
// cloneBlockForRequest
// -----------------------------------------------------------------------------

console.log("\n[cloneBlockForRequest]");
for (const f of CLONE_FIXTURES) {
  const got = cloneBlockForRequest(f.input);
  eq(got, f.expected, `${f.name}: clone shape`);
}

// -----------------------------------------------------------------------------
// countOccurrences
// -----------------------------------------------------------------------------

console.log("\n[countOccurrences]");
eq(countOccurrences("aaa", "a"), 3, "overlapping candidates don't double-count");
eq(countOccurrences("abcabc", "abc"), 2, "two occurrences");
eq(countOccurrences("hello", "x"), 0, "no match");
eq(countOccurrences("", "a"), 0, "empty haystack");
eq(countOccurrences("abc", ""), 0, "empty needle is 0");

// -----------------------------------------------------------------------------
// Fake NotionClient — structural stand-in for the end-to-end tests.
// -----------------------------------------------------------------------------

interface FakeCall {
  method: string;
  args: unknown[];
}

function makeFakeClient(initial: HydratedBlock[]): { client: NotionClient; calls: FakeCall[]; currentChildren: () => HydratedBlock[] } {
  // Each id → its children (top-level use "__root__" as a sentinel).
  const childrenByParent = new Map<string, HydratedBlock[]>();
  childrenByParent.set("__root__", [...initial]);
  for (const b of flattenHydrated(initial)) {
    if (b.children) childrenByParent.set(b.id, [...b.children]);
  }
  const calls: FakeCall[] = [];

  const fake = {
    listBlockChildren: async (blockId: string): Promise<PaginatedList<NotionBlockObject>> => {
      calls.push({ method: "listBlockChildren", args: [blockId] });
      const list = childrenByParent.get(blockId) ?? childrenByParent.get("__root__") ?? [];
      return {
        object: "list",
        results: list as unknown as NotionBlockObject[],
        next_cursor: null,
        has_more: false,
      };
    },
    listAllBlockChildren: async (blockId: string): Promise<NotionBlockObject[]> => {
      calls.push({ method: "listAllBlockChildren", args: [blockId] });
      const list = childrenByParent.get(blockId) ?? childrenByParent.get("__root__") ?? [];
      return list as unknown as NotionBlockObject[];
    },
    deleteBlock: async (id: string): Promise<NotionBlockObject> => {
      calls.push({ method: "deleteBlock", args: [id] });
      const root = childrenByParent.get("__root__") ?? [];
      const next = root.filter((b) => b.id !== id);
      childrenByParent.set("__root__", next);
      return { object: "block", id, type: "paragraph", archived: true } as unknown as NotionBlockObject;
    },
    appendBlockChildren: async (
      parentId: string,
      body: unknown
    ): Promise<PaginatedList<NotionBlockObject>> => {
      calls.push({ method: "appendBlockChildren", args: [parentId, body] });
      const children = ((body as { children?: unknown[] })?.children ?? []) as HydratedBlock[];
      // Assign synthetic ids for round-tripping.
      const stamped: HydratedBlock[] = children.map((c, i) => ({
        ...c,
        id: `new-${parentId.slice(0, 4)}-${i}`,
        object: "block",
      })) as HydratedBlock[];
      const root = childrenByParent.get("__root__") ?? [];
      childrenByParent.set("__root__", [...root, ...stamped]);
      return {
        object: "list",
        results: stamped as unknown as NotionBlockObject[],
        next_cursor: null,
        has_more: false,
      };
    },
    updatePage: async (pageId: string, body: unknown) => {
      calls.push({ method: "updatePage", args: [pageId, body] });
      return { id: pageId } as unknown;
    },
    updateBlock: async (blockId: string, body: unknown) => {
      calls.push({ method: "updateBlock", args: [blockId, body] });
      return { id: blockId } as unknown;
    },
  };

  return {
    client: fake as unknown as NotionClient,
    calls,
    currentChildren: () => childrenByParent.get("__root__") ?? [],
  };
}

function flattenHydrated(blocks: HydratedBlock[]): HydratedBlock[] {
  const out: HydratedBlock[] = [];
  const visit = (b: HydratedBlock) => {
    out.push(b);
    if (b.children) for (const c of b.children) visit(c);
  };
  for (const b of blocks) visit(b);
  return out;
}

// -----------------------------------------------------------------------------
// Source-map / span tracker — pure function tests
// -----------------------------------------------------------------------------

console.log("\n[blocksToMarkdownWithSpans]");

{
  const { markdown, blockSpans } = blocksToMarkdownWithSpans(THREE_BLOCK_PAGE.existing);
  eq(blockSpans.length, 3, "one span per top-level block");
  // Spans cover every char: first starts at 0, last ends at md.length, and
  // offsets are monotone-increasing with 2-char gaps ("\n\n").
  assert(blockSpans[0]!.startOffset === 0, "first span starts at 0");
  assert(blockSpans[blockSpans.length - 1]!.endOffset === markdown.length, "last span ends at md end");
  for (let i = 1; i < blockSpans.length; i++) {
    const gap = blockSpans[i]!.startOffset - blockSpans[i - 1]!.endOffset;
    assert(gap === 2, `spans[${i - 1}]..spans[${i}] separated by a \\n\\n gap`);
  }
  // Slicing md by each span reproduces the per-block rendering.
  for (const span of blockSpans) {
    const sliced = markdown.slice(span.startOffset, span.endOffset);
    const rendered = blocksToMarkdown([span.block]);
    eq(sliced, rendered, `span ${span.blockId}: slice matches single-block render`);
  }
  // Metadata copied onto each span.
  eq(blockSpans[0]!.blockId, "tb-1", "span.blockId matches source");
  eq(blockSpans[0]!.blockType, "heading_2", "span.blockType matches source");
}

{
  // Empty input is well-behaved.
  const { markdown, blockSpans } = blocksToMarkdownWithSpans([]);
  eq(markdown, "", "empty input → empty markdown");
  eq(blockSpans.length, 0, "empty input → no spans");
}

// -----------------------------------------------------------------------------
// Diff planner — pure function against synthetic hydrated + request blocks
// -----------------------------------------------------------------------------

console.log("\n[planUpdate]");

{
  // 1:1 same-type swap → fast.
  const old = FAST_PATH_PAGE.existing;
  const newMd = blocksToMarkdown(old).replace("Alice", "Bob");
  const newBlocks = markdownToBlocks(newMd);
  const plan = planUpdate(old, newBlocks);
  assert(plan.kind === "fast", `single-word edit with unchanged prefix → fast (got ${plan.kind})`);
  if (plan.kind === "fast") {
    eq(plan.oldBlock.id, "fp-paragraph", "fast path identifies the right old block");
  }
}

{
  // Two affected middle blocks → medium.
  const old = HELLO_WORLD_PAGE.existing;
  const newMd = blocksToMarkdown(old).replace(/Alice/g, "Bob");
  const newBlocks = markdownToBlocks(newMd);
  const plan = planUpdate(old, newBlocks);
  assert(plan.kind === "medium", `two affected blocks with heading prefix → medium (got ${plan.kind})`);
  if (plan.kind === "medium") {
    eq(plan.deleteIds.sort(), ["b2", "b3"].sort(), "medium path targets only the affected blocks");
    eq(plan.afterId, "b1", "medium path uses the common-prefix block as the after anchor");
    eq(plan.insertBlocks.length, 2, "medium path inserts two replacement blocks");
  }
}

{
  // First block affected → full fallback.
  const old = FULL_FALLBACK_PAGE.existing;
  const newMd = blocksToMarkdown(old).replace("Alice", "Charlie");
  const newBlocks = markdownToBlocks(newMd);
  const plan = planUpdate(old, newBlocks);
  assert(plan.kind === "full", `first-block edit has no prefix anchor → full (got ${plan.kind})`);
}

{
  // Edit inside a toggle's child → top-level affected block is the toggle,
  // which has children → not fast path → medium.
  const old = NESTED_TOGGLE_PAGE.existing;
  const newMd = blocksToMarkdown(old).replace("Alice", "Bob");
  const newBlocks = markdownToBlocks(newMd);
  const plan = planUpdate(old, newBlocks);
  assert(plan.kind === "medium", `nested edit falls through to medium (got ${plan.kind})`);
  if (plan.kind === "medium") {
    eq(plan.deleteIds, ["nt-toggle"], "medium path deletes only the toggle, not the outer para");
    eq(plan.afterId, "nt-outer", "anchor is the common-prefix paragraph");
  }
}

{
  // No-op: identical markdown on both sides.
  const old = HELLO_WORLD_PAGE.existing;
  const newBlocks = markdownToBlocks(blocksToMarkdown(old));
  const plan = planUpdate(old, newBlocks);
  assert(plan.kind === "noop", `identical input → noop (got ${plan.kind})`);
}

// -----------------------------------------------------------------------------
// update_content end-to-end — dispatch paths against the fake client
// -----------------------------------------------------------------------------

console.log("\n[update_content — fast path]");

{
  const { client, calls } = makeFakeClient(FAST_PATH_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    { old_str: "Alice", new_str: "Bob" },
  ]);
  assert(!result.isError, "fast path succeeds");
  assert(
    (result.content[0]?.text ?? "").includes("Fast path"),
    "summary mentions the fast path"
  );
  const updateBlockCalls = calls.filter((c) => c.method === "updateBlock");
  const deleteCalls = calls.filter((c) => c.method === "deleteBlock");
  const appendCalls = calls.filter((c) => c.method === "appendBlockChildren");
  eq(updateBlockCalls.length, 1, "exactly one updateBlock call");
  eq(deleteCalls.length, 0, "no deleteBlock calls — block id is preserved");
  eq(appendCalls.length, 0, "no appendBlockChildren calls — block id is preserved");
  const [blockId, body] = updateBlockCalls[0]!.args as [string, Record<string, unknown>];
  eq(blockId, "fp-paragraph", "updateBlock targeted the correct block id");
  assert(
    JSON.stringify(body).includes("Bob"),
    "updateBlock body carries the replacement text"
  );
  assert(
    !JSON.stringify(body).includes("Alice"),
    "updateBlock body doesn't carry the original text"
  );
}

console.log("\n[update_content — medium path]");

{
  const { client, calls } = makeFakeClient(HELLO_WORLD_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    { old_str: "Alice", new_str: "Bob", replace_all_matches: true },
  ]);
  assert(!result.isError, "medium path succeeds");
  assert(
    (result.content[0]?.text ?? "").includes("Medium path"),
    "summary mentions the medium path"
  );
  const deleteCalls = calls.filter((c) => c.method === "deleteBlock");
  const appendCalls = calls.filter((c) => c.method === "appendBlockChildren");
  eq(deleteCalls.length, 2, "only the 2 affected blocks deleted (heading kept)");
  const deletedIds = deleteCalls.map((c) => c.args[0] as string).sort();
  eq(deletedIds, ["b2", "b3"], "deleted the correct blocks — heading b1 retained");
  eq(appendCalls.length, 1, "exactly one appendBlockChildren call (small insert, single chunk)");
  const appendBody = appendCalls[0]!.args[1] as { children: unknown[]; after?: string };
  eq(appendBody.after, "b1", "appendBlockChildren anchored after the heading (b1)");
  eq(appendBody.children.length, 2, "append carries the two replacement paragraphs");
  assert(
    JSON.stringify(appendBody.children).includes("Bob"),
    "appended children reference Bob"
  );
}

console.log("\n[update_content — full fallback]");

{
  const { client, calls } = makeFakeClient(FULL_FALLBACK_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    { old_str: "Alice", new_str: "Charlie" },
  ]);
  assert(!result.isError, "full fallback succeeds");
  assert(
    (result.content[0]?.text ?? "").includes("Full fallback"),
    "summary mentions the fallback"
  );
  const deleteCalls = calls.filter((c) => c.method === "deleteBlock");
  const appendCalls = calls.filter((c) => c.method === "appendBlockChildren");
  eq(deleteCalls.length, 1, "first-block edit → all existing blocks deleted");
  eq(appendCalls.length, 1, "append happens without an anchor");
  const appendBody = appendCalls[0]!.args[1] as { children: unknown[]; after?: string };
  assert(appendBody.after === undefined, "full fallback does NOT pass an `after:` anchor");
}

console.log("\n[update_content — nested toggle edit falls through]");

{
  const { client, calls } = makeFakeClient(NESTED_TOGGLE_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    { old_str: "Alice", new_str: "Bob" },
  ]);
  assert(!result.isError, "nested edit succeeds");
  // Not fast path — the toggle has children.
  const updateBlockCalls = calls.filter((c) => c.method === "updateBlock");
  eq(updateBlockCalls.length, 0, "nested edit does NOT use the fast path (toggle has children)");
  const deleteCalls = calls.filter((c) => c.method === "deleteBlock");
  eq(deleteCalls.length, 1, "medium path deletes only the toggle, not the outer paragraph");
  eq(deleteCalls[0]!.args[0], "nt-toggle", "deleted the right block");
}

console.log("\n[update_content — validation + error cases (unchanged from Phase 5)]");

{
  const { client } = makeFakeClient(HELLO_WORLD_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    { old_str: "nonexistent string", new_str: "x" },
  ]);
  assert(result.isError === true, "not-found returns an error");
  assert(
    (result.content[0]?.text ?? "").includes("No match"),
    "error message names the no-match condition"
  );
}

{
  const { client } = makeFakeClient(HELLO_WORLD_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", [
    // "Alice" appears twice in the fixture.
    { old_str: "Alice", new_str: "Bob" },
  ]);
  assert(result.isError === true, "ambiguous match without replace_all is an error");
  assert(
    (result.content[0]?.text ?? "").toLowerCase().includes("ambiguous"),
    "error message names the ambiguity"
  );
}

{
  const { client } = makeFakeClient(HELLO_WORLD_PAGE.existing);
  const result = await updateContentHandler(client, "page-1", []);
  assert(result.isError === true, "empty content_updates is an error");
}

{
  const { client } = makeFakeClient([]);
  const result = await updateContentHandler(client, "page-1", [{ old_str: "a", new_str: "b" }]);
  assert(result.isError === true, "empty page is an error for update_content");
}

// -----------------------------------------------------------------------------
// replace_content — preservation gate
// -----------------------------------------------------------------------------

console.log("\n[replace_content — preservation gate]");

{
  const { client, calls } = makeFakeClient(PAGE_WITH_CHILD.existing);
  const result = await replaceContentHandler(
    client,
    "page-1",
    "Brand new content — no references to the child page"
  );
  assert(result.isError === true, "refuses to drop child_page without allow_deleting_content");
  assert(
    (result.content[0]?.text ?? "").includes("child pages/databases"),
    "error message references child pages/databases"
  );
  const deletes = calls.filter((c) => c.method === "deleteBlock").length;
  assert(deletes === 0, "no deletes happen when the preservation gate fails");
}

{
  const { client, calls } = makeFakeClient(PAGE_WITH_CHILD.existing);
  const result = await replaceContentHandler(
    client,
    "page-1",
    "Brand new content — no references to the child page",
    { allowDeletingContent: true }
  );
  assert(!result.isError, "allow_deleting_content lets the preservation gate pass");
  const deletes = calls.filter((c) => c.method === "deleteBlock").length;
  assert(deletes === PAGE_WITH_CHILD.existing.length, `deleted all ${PAGE_WITH_CHILD.existing.length} existing blocks with allow_deleting_content`);
}

{
  const { client, calls } = makeFakeClient(PAGE_WITH_CHILD.existing);
  const result = await replaceContentHandler(
    client,
    "page-1",
    'New content referencing <page id="3333333333333333cccccccccccccccc">Sub Doc</page>'
  );
  assert(!result.isError, "preservation via <page id> tag passes the gate");
  const deletes = calls.filter((c) => c.method === "deleteBlock").length;
  assert(deletes === PAGE_WITH_CHILD.existing.length, "deletes still happen — preservation check is advisory, not about keeping blocks");
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log(`\n───────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`───────────────────────────────`);
if (failed > 0) process.exit(1);
