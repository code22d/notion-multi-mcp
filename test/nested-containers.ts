// -----------------------------------------------------------------------------
// Nested HTML-ish containers, and the request bodies they produce.
//
// Run with:
//   tsx test/nested-containers.ts
//
// WHAT THIS FILE IS FOR
//
// `<details>`, `<tabs>`/`<tab>` and `<column-list>`/`<column>` were each found
// with a non-greedy `([\s\S]*?)</tag>` regex, which stops at the FIRST closer.
// Nest any of them and the outer one closed on the inner one's tag: the inner
// openers became literal text inside the block, the surplus closers leaked out
// as a visible paragraph, and the content between them was lost. A live
// notion_create_pages call with five nested `<details>` produced one toggle and
// a paragraph reading "</details></details></details></details>".
//
// The assertions below are about STRUCTURE and CONTENT SURVIVAL, both
// directions of the round trip, and — because a five-deep toggle chain is
// deeper than Notion's request body accepts — the bodies that chain turns into.
// -----------------------------------------------------------------------------

import { markdownToBlocks, type BlockRequest } from "../src/notion/markdown/to-blocks.ts";
import { blocksToMarkdown, type HydratedBlock } from "../src/notion/markdown/from-blocks.ts";
import { requestToHydratedish } from "../src/tools/update-page/diff.ts";
import {
  AUTHORED_CLONE_POLICY,
  fitRequestTree,
  resolvePendingChildren,
  type ClonedBlock,
} from "../src/notion/block-clone.ts";
import {
  describeBlockRequestProblems,
  validateBlockRequestTree,
} from "../src/notion/block-write-schema.ts";
import type { NotionBlockObject, NotionClient, PaginatedList } from "../src/notion/client.ts";

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

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg === sw) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
  }
}

/** Every emitted block satisfies Notion's documented write schema. */
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

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function body(block: BlockRequest | undefined): Record<string, unknown> {
  const type = block?.type;
  if (!block || typeof type !== "string") return {};
  return ((block as Record<string, unknown>)[type] as Record<string, unknown>) ?? {};
}

function kids(block: BlockRequest | undefined): BlockRequest[] {
  const c = body(block).children;
  return Array.isArray(c) ? (c as BlockRequest[]) : [];
}

function plain(block: BlockRequest | undefined): string {
  const runs = body(block).rich_text;
  if (!Array.isArray(runs)) return "";
  return runs
    .map((r) => {
      const run = r as { type?: string; text?: { content?: string }; plain_text?: string };
      if (run.type === "text" || !run.type) return run.text?.content ?? "";
      return run.plain_text ?? "";
    })
    .join("");
}

/** Every plain-text run anywhere in a request tree, in document order. */
function allText(blocks: BlockRequest[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    const t = plain(b);
    if (t) out.push(t);
    out.push(...allText(kids(b)));
  }
  return out;
}

/** `type` labels of a single-child chain, so a 5-deep nest reads as one line. */
function chainTypes(blocks: BlockRequest[]): string[] {
  const out: string[] = [];
  let cur: BlockRequest | undefined = blocks[0];
  while (cur) {
    out.push(String(cur.type));
    cur = kids(cur)[0];
  }
  return out;
}

/** request-shape → markdown, via the hydrated shape from-blocks expects. */
function renderBack(blocks: BlockRequest[]): string {
  return blocksToMarkdown(blocks.map(requestToHydratedish) as HydratedBlock[]);
}

// -----------------------------------------------------------------------------
// 1. The reported reproduction: five nested <details>
// -----------------------------------------------------------------------------

const FIVE_DEEP = `<details><summary>L1</summary>
<details><summary>L2</summary>
<details><summary>L3</summary>
<details><summary>L4</summary>
<details><summary>L5</summary>
Deepest content marker L6-BODY.
</details>
</details>
</details>
</details>
</details>`;

console.log("\n[<details>] five levels nest instead of collapsing to one");
{
  const blocks = markdownToBlocks(FIVE_DEEP);

  eq(blocks.length, 1, "one top-level block, not a toggle plus a leaked-tag paragraph");
  eq(
    chainTypes(blocks),
    ["toggle", "toggle", "toggle", "toggle", "toggle", "paragraph"],
    "five toggles deep, then the body paragraph"
  );
  eq(
    allText(blocks),
    ["L1", "L2", "L3", "L4", "L5", "Deepest content marker L6-BODY."],
    "every summary and the deepest body survive, in order"
  );

  const text = JSON.stringify(blocks);
  assert(!text.includes("</details>"), "no closing tag leaked into any rich_text");
  assert(!text.includes("<summary>"), "no summary tag leaked into any rich_text");
}

console.log("\n[<details>] round-trips through from-blocks and back unchanged");
{
  const first = markdownToBlocks(FIVE_DEEP);
  const md = renderBack(first);
  const second = markdownToBlocks(md);
  eq(chainTypes(second), chainTypes(first), "same structure after to→from→to");
  eq(allText(second), allText(first), "same content after to→from→to");
  eq(renderBack(second), md, "and the markdown is a fixed point");
}

// -----------------------------------------------------------------------------
// 2. The other two container syntaxes had the same flaw
// -----------------------------------------------------------------------------

console.log("\n[<tabs>] a tab block nested inside a tab body stays a tab block");
{
  const blocks = markdownToBlocks(`<tabs>
<tab><summary>Outer</summary>
<tabs>
<tab><summary>Inner</summary>
inner body
</tab>
</tabs>
</tab>
</tabs>`);

  eq(blocks.length, 1, "one top-level tab block");
  eq(blocks[0]!.type, "tab", "…of type tab");
  const outerTab = kids(blocks[0])[0];
  eq(plain(outerTab), "Outer", "outer tab keeps its label");
  const nested = kids(outerTab)[0];
  eq(nested?.type, "tab", "the nested <tabs> became a tab block, not literal text");
  eq(plain(kids(nested)[0]), "Inner", "…with the inner tab's label intact");
  assert(!JSON.stringify(blocks).includes("<tabs>"), "no <tabs> tag leaked into rich_text");
}

console.log("\n[<column-list>] a nested list keeps its own columns");
{
  const blocks = markdownToBlocks(`<column-list>
<column>
<column-list>
<column>x</column>
<column>y</column>
</column-list>
</column>
<column>z</column>
</column-list>`);

  eq(blocks.length, 1, "one top-level column_list");
  eq(kids(blocks[0]).length, 2, "two outer columns — the inner list's columns were hoisted before");
  const inner = kids(kids(blocks[0])[0])[0];
  eq(inner?.type, "column_list", "the nested list survived as a column_list");
  eq(kids(inner).length, 2, "…with both of its own columns");
  eq(allText(blocks), ["x", "y", "z"], "all column content present, in order");
}

console.log("\n[cross-container] a <details> inside a <tab> is parsed by the tab, not stolen from it");
{
  // The pre-processor used to extract <details> spans from the whole document
  // before anything else looked at it, which ripped this toggle out from under
  // the <tabs> and left the surrounding tags stranded as text.
  const blocks = markdownToBlocks(`<tabs>
<tab><summary>A</summary>
<details><summary>D</summary>
inner
</details>
</tab>
</tabs>`);

  eq(blocks.length, 1, "one top-level block");
  eq(blocks[0]!.type, "tab", "the <tabs> survived");
  const toggle = kids(kids(blocks[0])[0])[0];
  eq(toggle?.type, "toggle", "the <details> became a toggle inside the tab");
  eq(plain(toggle), "D", "…with its summary");
  eq(plain(kids(toggle)[0]), "inner", "…and its body");
  assert(!JSON.stringify(blocks).includes("</tab>"), "no stranded closing tag");
}

console.log("\n[unbalanced] a <details> that never closes degrades to text, it does not eat the document");
{
  const blocks = markdownToBlocks(`<details><summary>Broken</summary>\nbody\n\nA later paragraph.`);
  const text = allText(blocks).join(" ");
  assert(text.includes("A later paragraph."), "content after the unclosed tag still arrives");
  assert(blocks.length >= 1, "something is emitted rather than nothing");
}

// -----------------------------------------------------------------------------
// 3. Tab icon attribute escaping — the round-trip asymmetry (audit Finding 4)
// -----------------------------------------------------------------------------

console.log("\n[tab icon] an icon URL containing &amp;, & and \" survives the round trip");
{
  // The encoder escaped only `"` while the decoder undid both `&quot;` and
  // `&amp;`, so a literal `&amp;` in the URL came back as a bare `&`.
  const url = 'https://ex.com/i.png?a=1&amp;b=2&c=3&title=say%20"hi"';
  const tabBlock: HydratedBlock = {
    object: "block",
    id: "tab-1",
    type: "tab",
    tab: {},
    children: [
      {
        object: "block",
        id: "tab-item-1",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "Label" }, plain_text: "Label" }],
          icon: { type: "external", external: { url } },
        },
        children: [],
      } as unknown as HydratedBlock,
    ],
  } as unknown as HydratedBlock;

  const md = blocksToMarkdown([tabBlock]);
  assert(md.includes("&amp;amp;"), "the literal `&amp;` was escaped on the way out");
  assert(!md.includes('icon="https://ex.com/i.png?a=1&b=2'), "…so it is not written as a bare &");

  const back = markdownToBlocks(md);
  const icon = body(kids(back[0])[0]).icon as { external?: { url?: string } } | undefined;
  eq(icon?.external?.url, url, "the URL comes back byte-for-byte");

  // And a second pass is stable — no progressive escaping or unescaping.
  const md2 = blocksToMarkdown(back.map(requestToHydratedish) as HydratedBlock[]);
  const icon2 = body(kids(markdownToBlocks(md2)[0])[0]).icon as { external?: { url?: string } } | undefined;
  eq(icon2?.external?.url, url, "still identical after a second round trip");
}

// -----------------------------------------------------------------------------
// 4. Depth beyond the write schema — what the create path actually sends
// -----------------------------------------------------------------------------

interface Recorded {
  parentId: string;
  children: BlockRequest[];
}

/**
 * Client stub that records append bodies and hands back ids, so a deferred
 * subtree can be resolved against something.
 *
 * It registers INLINE children too, recursively, because that is what Notion
 * does: blocks nested in a `children` array become real, listable blocks. The
 * deferral resolver walks down through inlined blocks to reach the one that
 * actually has pending work, so a stub that only knew about top-level appends
 * would make that walk look broken when it isn't.
 */
function makeRecordingClient(): { client: NotionClient; appends: Recorded[] } {
  const appends: Recorded[] = [];
  const byParent = new Map<string, NotionBlockObject[]>();
  let n = 0;

  const register = (b: BlockRequest): NotionBlockObject => {
    const id = `blk-${++n}`;
    const type = String(b.type);
    const obj = { object: "block", id, type } as unknown as NotionBlockObject;
    const inner = (b as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
    const children = Array.isArray(inner?.children) ? (inner!.children as BlockRequest[]) : [];
    if (children.length > 0) byParent.set(id, children.map(register));
    return obj;
  };

  const client = {
    async appendBlockChildren(blockId: string, reqBody: unknown): Promise<PaginatedList<NotionBlockObject>> {
      const children = ((reqBody as { children?: BlockRequest[] }).children ?? []) as BlockRequest[];
      appends.push({ parentId: blockId, children });
      const results = children.map(register);
      byParent.set(blockId, [...(byParent.get(blockId) ?? []), ...results]);
      return { object: "list", results, has_more: false, next_cursor: null } as unknown as PaginatedList<NotionBlockObject>;
    },
    async listAllBlockChildren(blockId: string): Promise<NotionBlockObject[]> {
      return byParent.get(blockId) ?? [];
    },
  } as unknown as NotionClient;

  return { client, appends };
}

console.log("\n[fitRequestTree] shallow content is passed through untouched");
{
  const blocks = markdownToBlocks("# Title\n\nA paragraph.\n\n- one\n- two\n");
  const fitted = fitRequestTree(blocks);
  eq(fitted.map((c) => c.request), blocks, "byte-identical requests — no rewrite for ordinary markdown");
  eq(fitted.some((c) => c.pending && c.pending.length > 0), false, "nothing deferred");
}

console.log("\n[fitRequestTree] the five-toggle chain is split into bodies Notion accepts");
{
  const fitted = fitRequestTree(markdownToBlocks(FIVE_DEEP));
  const firstBody = fitted.map((c) => c.request);

  assertValid(firstBody, "the create body is one the write schema accepts");
  assert(
    fitted.some((c) => hasPending(c)),
    "…because the part it cannot carry was deferred, not inlined and not dropped"
  );

  // Drive the deferral to completion against a recording client and check that
  // every follow-up body is valid too, and that the deepest marker arrives.
  const { client, appends } = makeRecordingClient();
  await (async () => {
    // Simulate a page create: the first body's blocks already exist as the
    // page's children, which is the state resolvePendingChildren expects.
    await client.appendBlockChildren("page-1", { children: firstBody });
    appends.length = 0; // that call stands in for createPage, not an append
    await resolvePendingChildren(client, "page-1", fitted, AUTHORED_CLONE_POLICY);
  })();

  assert(appends.length > 0, "a follow-up append was issued for the deferred subtree");
  for (const a of appends) assertValid(a.children, `follow-up body to ${a.parentId} is valid`);

  const everything = [...firstBody, ...appends.flatMap((a) => a.children)];
  const text = allText(everything);
  for (const want of ["L1", "L2", "L3", "L4", "L5", "Deepest content marker L6-BODY."]) {
    assert(text.includes(want), `"${want}" survives creation across the split requests`);
  }
}

function hasPending(c: ClonedBlock): boolean {
  if (c.pending && c.pending.length > 0) return true;
  return (c.inlined ?? []).some(hasPending);
}

console.log("\n[fitRequestTree] a nested column_list unwraps rather than emitting an illegal tier");
{
  const fitted = fitRequestTree(
    markdownToBlocks(`<column-list>
<column>
<column-list>
<column>x</column>
<column>y</column>
</column-list>
</column>
<column>z</column>
</column-list>`)
  );
  const requests = fitted.map((c) => c.request);
  assertValid(requests, "the emitted body is valid — column_list is tier-1 only");

  // Notion's schema is unambiguous here and there is no deferral that saves the
  // outer layout: a `column` must carry at least one child at send time, and
  // its only child is the tier-illegal inner list. So the outer wrapper is the
  // thing that gives way — the same "unwrap, don't drop" rule the clone path
  // applies to a below-minimum column_list. Content and the inner layout both
  // survive; only the outer two-column arrangement is lost.
  eq(
    requests.map((r) => r.type),
    ["column_list", "paragraph"],
    "inner list promoted to the top level, the other column's content beside it"
  );
  eq(allText(requests), ["x", "y", "z"], "no column content is lost");
  eq(kids(requests[0]).length, 2, "the inner list keeps both of its columns");
}

// -----------------------------------------------------------------------------
console.log(`\n=== nested containers: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
