// -----------------------------------------------------------------------------
// Round-trip test for the Markdown ↔ Notion block converters.
//
// Run with:
//   node --experimental-strip-types test/roundtrip.ts
//
// Walks each fixture in fixtures.ts through:
//   1. blocks (response shape) → markdown      (from-blocks.ts)
//   2. markdown                → blocks (request shape)   (to-blocks.ts)
//
// Then asserts that step 2's block types, order, and plain-text content
// match what the fixture's sibling-level layout expects.
// -----------------------------------------------------------------------------

import { blocksToMarkdown } from "../src/notion/markdown/from-blocks.ts";
import { markdownToBlocks, type BlockRequest } from "../src/notion/markdown/to-blocks.ts";
import { FIXTURES } from "./fixtures.ts";

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

function runsToPlain(runs: unknown): string {
  if (!Array.isArray(runs)) return "";
  return runs
    .map((r) => {
      const run = r as { type?: string; text?: { content?: string }; equation?: { expression?: string }; plain_text?: string };
      if (run.type === "text" || !run.type) return run.text?.content ?? "";
      if (run.type === "equation") return run.equation?.expression ?? "";
      return run.plain_text ?? "";
    })
    .join("");
}

function blockRichTextPlain(block: BlockRequest): string {
  const key = block.type;
  if (!key || typeof key !== "string") return "";
  const body = (block as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
  if (!body) return "";
  if (key === "code") {
    return runsToPlain(body.rich_text);
  }
  if (key === "table" || key === "table_row" || key === "divider" || key === "image") return "";
  return runsToPlain(body.rich_text);
}

for (const fixture of FIXTURES) {
  console.log(`\n[fixture] ${fixture.name}`);
  const markdown = blocksToMarkdown(fixture.blocks);
  const blocks = markdownToBlocks(markdown);

  // Some renderings produce an extra divider or blank paragraph — filter to
  // non-empty blocks to keep assertions crisp.
  const meaningful = blocks.filter((b) => {
    if (b.type === "paragraph") {
      const p = (b as Record<string, unknown>).paragraph as { rich_text?: unknown[] } | undefined;
      return (p?.rich_text?.length ?? 0) > 0;
    }
    return true;
  });

  console.log(`  produced markdown (${markdown.length} chars, ${markdown.split("\n").length} lines):`);
  for (const line of markdown.split("\n")) console.log(`    ${line}`);
  console.log(`  produced blocks: ${meaningful.map((b) => b.type).join(", ")}`);

  // Type sequence check — allow structural blocks (table rows, column children)
  // to live inside their parent rather than at top level.
  const topTypes = meaningful.map((b) => b.type ?? "unknown");
  assert(
    topTypes.length === fixture.expectedTypes.length,
    `block count matches (got ${topTypes.length}, want ${fixture.expectedTypes.length})`
  );
  for (let i = 0; i < Math.min(topTypes.length, fixture.expectedTypes.length); i++) {
    assert(topTypes[i] === fixture.expectedTypes[i], `block[${i}].type = ${topTypes[i]} (want ${fixture.expectedTypes[i]})`);
  }

  // Plain-text content check (on the blocks that have rich_text).
  for (let i = 0; i < Math.min(meaningful.length, fixture.expectedPlain.length); i++) {
    const want = fixture.expectedPlain[i] ?? "";
    if (want === "") continue; // structural block
    const got = blockRichTextPlain(meaningful[i]!);
    assert(got === want, `block[${i}] plain text = ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  }
}

console.log(`\n───────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`───────────────────────────────`);
if (failed > 0) process.exit(1);
