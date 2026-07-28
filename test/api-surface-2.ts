// -----------------------------------------------------------------------------
// Unit tests for the lower-value half of the 2026 API catch-up:
//
//   - tab blocks: read (from-blocks) and write (to-blocks), including the
//     round trip and rich-text labels
//   - status option groups in the DDL emitter
//   - is_locked / in_trash / archived on update_properties
//   - search filter.in_trash merging
//   - file upload helpers (content type guessing, blob building, error hints)
// -----------------------------------------------------------------------------

import { blocksToMarkdown, type HydratedBlock } from "../src/notion/markdown/from-blocks.ts";
import { markdownToBlocks } from "../src/notion/markdown/to-blocks.ts";
import { emitCreateProperties, normalizeStatusGroup } from "../src/notion/ddl/emit.ts";
import { parseCreateTable } from "../src/notion/ddl/parser.ts";
import { normaliseProperties } from "../src/tools/update-page/properties.ts";
import { buildBlob, guessContentType, explainUploadError } from "../src/tools/files.ts";

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

function contains(haystack: string, needle: string, msg: string): void {
  assert(haystack.includes(needle), `${msg} (expected to contain "${needle}", got ${JSON.stringify(haystack)})`);
}

function rt(text: string): Array<Record<string, unknown>> {
  return [{ type: "text", plain_text: text, text: { content: text } }];
}

/** Build a hydrated tab block the way Notion returns one. */
function tabBlock(
  tabs: Array<{ label: string; icon?: unknown; body?: HydratedBlock[] }>
): HydratedBlock {
  return {
    object: "block",
    id: "tab-1",
    type: "tab",
    tab: {},
    has_children: true,
    children: tabs.map((t, i) => ({
      object: "block" as const,
      id: `p-${i}`,
      type: "paragraph",
      paragraph: {
        rich_text: rt(t.label),
        ...(t.icon !== undefined ? { icon: t.icon } : {}),
      },
      ...(t.body ? { children: t.body, has_children: true } : {}),
    })) as HydratedBlock[],
  } as HydratedBlock;
}

function para(text: string): HydratedBlock {
  return {
    object: "block",
    id: `x-${text}`,
    type: "paragraph",
    paragraph: { rich_text: rt(text) },
  } as HydratedBlock;
}

// -----------------------------------------------------------------------------
// Tab blocks — read
// -----------------------------------------------------------------------------

console.log("\n[tab blocks] read: label, icon, and content");
{
  const md = blocksToMarkdown([
    tabBlock([
      { label: "Overview", icon: { type: "emoji", emoji: "📋" }, body: [para("First tab body.")] },
      { label: "Details", body: [para("Second tab body.")] },
    ]),
  ]);
  contains(md, "<tabs>", "opens a <tabs> container");
  contains(md, "</tabs>", "and closes it");
  contains(md, '<tab icon="📋"><summary>Overview</summary>', "first tab carries its label and icon");
  contains(md, "<tab><summary>Details</summary>", "a tab with no icon omits the attribute entirely");
  contains(md, "First tab body.", "first tab's content is rendered, not dropped");
  contains(md, "Second tab body.", "second tab's content is rendered");
  assert(!md.includes("notion:tab"), "no longer degrades to an opaque <!-- notion:tab --> comment");
}

console.log("\n[tab blocks] read: rich-text labels survive");
{
  const block = tabBlock([{ label: "x", body: [para("body")] }]);
  // Replace the label with genuinely formatted rich text.
  (block.children![0] as unknown as Record<string, unknown>).paragraph = {
    rich_text: [
      { type: "text", plain_text: "Bold", text: { content: "Bold" }, annotations: { bold: true } },
      { type: "text", plain_text: " label", text: { content: " label" } },
    ],
  };
  const md = blocksToMarkdown([block]);
  contains(md, "<summary>**Bold** label</summary>", "bold in a tab label is preserved — the reason label isn't an attribute");
}

console.log("\n[tab blocks] read: every icon variant renders as a re-parseable attribute");
{
  const cases: Array<[unknown, string]> = [
    [{ type: "emoji", emoji: "🚀" }, 'icon="🚀"'],
    [{ type: "icon", icon: { name: "pizza" } }, 'icon="icon:pizza"'],
    [{ type: "icon", icon: { name: "pizza", color: "blue" } }, 'icon="icon:pizza:blue"'],
    [{ type: "custom_emoji", custom_emoji: { id: "ce-1", name: "bufo" } }, 'icon="custom_emoji:ce-1"'],
    [{ type: "external", external: { url: "https://x/i.png" } }, 'icon="https://x/i.png"'],
  ];
  for (const [icon, expected] of cases) {
    const md = blocksToMarkdown([tabBlock([{ label: "T", icon, body: [para("b")] }])]);
    contains(md, expected, `${JSON.stringify(icon).slice(0, 40)} ⇒ ${expected}`);
  }
}

console.log("\n[tab blocks] read: degenerate shapes don't crash");
{
  const empty = blocksToMarkdown([
    { object: "block", id: "t", type: "tab", tab: {} } as HydratedBlock,
  ]);
  contains(empty, "<tabs>", "a tab block with no children still renders a container");

  const noBody = blocksToMarkdown([tabBlock([{ label: "Empty" }])]);
  contains(noBody, "<summary>Empty</summary>", "a tab with a label but no content renders");
  contains(noBody, "</tab>", "…and is closed properly");
}

// -----------------------------------------------------------------------------
// Tab blocks — write
// -----------------------------------------------------------------------------

console.log("\n[tab blocks] write: <tabs> becomes a tab block whose children are PARAGRAPHS");
{
  const blocks = markdownToBlocks(
    `<tabs>
<tab icon="📋"><summary>Overview</summary>
Body one.
</tab>
<tab><summary>Details</summary>
Body two.
</tab>
</tabs>`
  );
  eq(blocks.length, 1, "one top-level block");
  eq(blocks[0]!.type, "tab", "…of type tab");

  const tab = blocks[0]! as unknown as Record<string, unknown>;
  const children = (tab.tab as Record<string, unknown>).children as Array<Record<string, unknown>>;
  eq(children.length, 2, "two tabs");
  // Notion REQUIRES paragraphs here; a nested "tab" child is a 400.
  eq(children[0]!.type, "paragraph", "first tab is a paragraph, not a nested tab block");
  eq(children[1]!.type, "paragraph", "second tab is a paragraph");

  const first = children[0]!.paragraph as Record<string, unknown>;
  const label = (first.rich_text as Array<Record<string, unknown>>)[0]!;
  eq((label.text as Record<string, unknown>).content, "Overview", "paragraph rich_text is the tab LABEL");
  eq(first.icon, { type: "emoji", emoji: "📋" }, "icon attribute normalised onto the paragraph");
  assert(Array.isArray(first.children) && (first.children as unknown[]).length > 0, "tab content lives in paragraph.children");

  const second = children[1]!.paragraph as Record<string, unknown>;
  assert(!("icon" in second), "a tab with no icon omits the key — no explicit null is sent");
}

console.log("\n[tab blocks] write: native icon and custom emoji attributes");
{
  const blocks = markdownToBlocks(
    `<tabs>
<tab icon="icon:pizza:blue"><summary>A</summary>
x
</tab>
<tab icon="custom_emoji:ce-9"><summary>B</summary>
y
</tab>
</tabs>`
  );
  const children = ((blocks[0]! as unknown as Record<string, unknown>).tab as Record<string, unknown>)
    .children as Array<Record<string, unknown>>;
  eq(
    (children[0]!.paragraph as Record<string, unknown>).icon,
    { type: "icon", icon: { name: "pizza", color: "blue" } },
    "native icon with colour parsed back"
  );
  eq(
    (children[1]!.paragraph as Record<string, unknown>).icon,
    { type: "custom_emoji", custom_emoji: { id: "ce-9" } },
    "custom emoji id parsed back"
  );
}

console.log("\n[tab blocks] round trip: read → write preserves labels, icons, and content");
{
  const md = blocksToMarkdown([
    tabBlock([
      { label: "Overview", icon: { type: "emoji", emoji: "📋" }, body: [para("Alpha")] },
      { label: "Details", icon: { type: "icon", icon: { name: "star", color: "red" } }, body: [para("Beta")] },
    ]),
  ]);
  const blocks = markdownToBlocks(md);
  eq(blocks.length, 1, "round trip yields a single tab block");
  eq(blocks[0]!.type, "tab", "…still a tab");

  const children = ((blocks[0]! as unknown as Record<string, unknown>).tab as Record<string, unknown>)
    .children as Array<Record<string, unknown>>;
  eq(children.length, 2, "both tabs survive");

  const p0 = children[0]!.paragraph as Record<string, unknown>;
  const p1 = children[1]!.paragraph as Record<string, unknown>;
  eq(
    ((p0.rich_text as Array<Record<string, unknown>>)[0]!.text as Record<string, unknown>).content,
    "Overview",
    "first label survives"
  );
  eq(p0.icon, { type: "emoji", emoji: "📋" }, "emoji icon survives");
  eq(p1.icon, { type: "icon", icon: { name: "star", color: "red" } }, "native icon survives with its colour");
  assert(JSON.stringify(p0.children).includes("Alpha"), "first tab's content survives");
  assert(JSON.stringify(p1.children).includes("Beta"), "second tab's content survives");
}

console.log("\n[tab blocks] write: an empty <tabs> falls through rather than emitting a broken block");
{
  const blocks = markdownToBlocks(`<tabs>\n</tabs>`);
  assert(
    !blocks.some((b) => b.type === "tab"),
    "no tab block is emitted when there are no <tab> children (Notion would reject it)"
  );
}

// -----------------------------------------------------------------------------
// Status option groups (DDL)
// -----------------------------------------------------------------------------

console.log("\n[status groups] normalizeStatusGroup folds common spellings onto Notion's three");
{
  eq(normalizeStatusGroup("To-do"), "To-do", "canonical form passes through");
  eq(normalizeStatusGroup("todo"), "To-do", "'todo'");
  eq(normalizeStatusGroup("To Do"), "To-do", "'To Do'");
  eq(normalizeStatusGroup("not_started"), "To-do", "'not_started'");
  eq(normalizeStatusGroup("in progress"), "In progress", "'in progress'");
  eq(normalizeStatusGroup("In_Progress"), "In progress", "'In_Progress'");
  eq(normalizeStatusGroup("done"), "Complete", "'done'");
  eq(normalizeStatusGroup("Completed"), "Complete", "'Completed'");
  eq(
    normalizeStatusGroup("Something Else"),
    "Something Else",
    "an unrecognised group is passed through so Notion can validate it authoritatively"
  );
}

console.log("\n[status groups] the DDL emitter now emits `group` instead of dropping it");
{
  const ast = parseCreateTable(
    `CREATE TABLE ("Name" TITLE, "Stage" STATUS('Backlog':'todo':gray, 'Building':'in progress':blue, 'Shipped':'done':green))`
  );
  const props = emitCreateProperties(ast);
  const status = (props as Record<string, Record<string, Record<string, unknown>>>)["Stage"]!;
  const options = status.status!.options as Array<Record<string, unknown>>;
  eq(options.length, 3, "three options");
  eq(options[0], { name: "Backlog", color: "gray", group: "To-do" }, "group emitted and canonicalised");
  eq(options[1], { name: "Building", color: "blue", group: "In progress" }, "second option");
  eq(options[2], { name: "Shipped", color: "green", group: "Complete" }, "third option");
}

console.log("\n[status groups] omitting the group keeps the old syntax working and sends NO group");
{
  const ast = parseCreateTable(`CREATE TABLE ("Name" TITLE, "Stage" STATUS('Open':yellow, 'Shut':green))`);
  const props = emitCreateProperties(ast);
  const status = (props as Record<string, Record<string, Record<string, unknown>>>)["Stage"]!;
  const options = status.status!.options as Array<Record<string, unknown>>;
  eq(options[0], { name: "Open", color: "yellow" }, "no group key at all");
  assert(!("group" in options[1]!), "…on any option");
  // This matters on UPDATE: absent group means "keep the option's existing
  // group". Emitting a default would silently re-file every option.
}

console.log("\n[status groups] group without a colour");
{
  const ast = parseCreateTable(`CREATE TABLE ("Name" TITLE, "Stage" STATUS('Backlog':'todo'))`);
  const props = emitCreateProperties(ast);
  const status = (props as Record<string, Record<string, Record<string, unknown>>>)["Stage"]!;
  const options = status.status!.options as Array<Record<string, unknown>>;
  eq(options[0], { name: "Backlog", group: "To-do" }, "group alone is fine");
}

// -----------------------------------------------------------------------------
// is_locked / in_trash / archived on update_properties
// -----------------------------------------------------------------------------

console.log("\n[update_properties] is_locked is lifted out of `properties` onto the body");
{
  eq(normaliseProperties({ is_locked: true }).isLocked, true, "boolean true");
  eq(normaliseProperties({ is_locked: false }).isLocked, false, "boolean false");
  eq(normaliseProperties({ is_locked: "__YES__" }).isLocked, true, "__YES__ sentinel");
  eq(normaliseProperties({ is_locked: "__NO__" }).isLocked, false, "__NO__ sentinel");
  eq(normaliseProperties({ is_locked: 1 }).isLocked, true, "numeric 1");
  assert(
    !("is_locked" in normaliseProperties({ is_locked: true }).notionProps),
    "is_locked does NOT leak into the properties map — Notion would reject it as an unknown column"
  );
}

console.log("\n[update_properties] is_locked is untouched when absent");
{
  eq(normaliseProperties({ Name: "x" }).isLocked, undefined, "absent ⇒ undefined ⇒ key omitted from the PATCH");
}

console.log("\n[update_properties] archived / in_trash still behave exactly as before");
{
  const r = normaliseProperties({ archived: true, in_trash: false, Name: "x" });
  eq(r.archived, true, "archived preserved (still valid on the pinned 2025-09-03)");
  eq(r.inTrash, false, "in_trash preserved");
  eq(Object.keys(r.notionProps), ["Name"], "neither leaks into properties");
}

console.log("\n[update_properties] all three controls can be set together");
{
  const r = normaliseProperties({ archived: false, in_trash: false, is_locked: true });
  eq([r.archived, r.inTrash, r.isLocked], [false, false, true], "independent flags");
}

// -----------------------------------------------------------------------------
// File upload helpers
// -----------------------------------------------------------------------------

console.log("\n[guessContentType] extension → MIME");
{
  eq(guessContentType("report.html"), "text/html", ".html");
  eq(guessContentType("report.HTM"), "text/html", ".HTM (case-insensitive)");
  eq(guessContentType("data.csv"), "text/csv", ".csv");
  eq(guessContentType("a.json"), "application/json", ".json");
  eq(guessContentType("notes.md"), "text/markdown", ".md");
  eq(guessContentType("pic.png"), "image/png", ".png");
  eq(guessContentType("doc.pdf"), "application/pdf", ".pdf");
  eq(guessContentType("mystery.qqq"), "application/octet-stream", "unknown extension falls back");
  eq(guessContentType("noextension"), "application/octet-stream", "no extension falls back");
}

console.log("\n[buildBlob] text content");
{
  const blob = buildBlob({ content: "<h1>hi</h1>" }, "a.html");
  assert(blob instanceof Blob, "returns a Blob");
  eq((blob as Blob).type, "text/html", "type inferred from the filename");
  eq(await (blob as Blob).text(), "<h1>hi</h1>", "content preserved");
}

console.log("\n[buildBlob] explicit content_type wins over the guess");
{
  const blob = buildBlob({ content: "x", content_type: "text/plain" }, "a.html");
  eq((blob as Blob).type, "text/plain", "explicit type respected");
}

console.log("\n[buildBlob] base64 content");
{
  const blob = buildBlob({ content_base64: btoa("binary-ish") }, "a.bin");
  assert(blob instanceof Blob, "returns a Blob");
  eq(await (blob as Blob).text(), "binary-ish", "base64 decoded");
}

console.log("\n[buildBlob] error cases explain the Worker constraint");
{
  const noContent = buildBlob({}, "a.html");
  assert(typeof noContent === "string", "missing content is an error");
  contains(noContent as string, "cannot read files from your machine", "explains WHY a path won't work");

  const both = buildBlob({ content: "a", content_base64: "Yg==" }, "a.html");
  assert(typeof both === "string", "both fields is an error");
  contains(both as string, "exactly one", "says which to pick");

  const badB64 = buildBlob({ content_base64: "!!!not base64!!!" }, "a.bin");
  assert(typeof badB64 === "string", "invalid base64 is an error");
  contains(badB64 as string, "not valid base64", "names the problem");
}

console.log("\n[explainUploadError] actionable hints");
{
  const forbidden = explainUploadError(new Error("Notion API 403: restricted resource"));
  contains(forbidden, "Insert content", "403 names the capability to enable");
  contains(forbidden, "notion.so/profile/integrations", "…and where to enable it");

  const tooBig = explainUploadError(new Error("Notion API 413: file too large"));
  contains(tooBig, "20MB", "413 names the single-part cap");
  contains(tooBig, "multi-part", "…and says the alternative isn't implemented");

  const other = explainUploadError(new Error("Notion API 500: boom"), "notion_create_html_block");
  contains(other, "notion_create_html_block failed", "unrelated errors use the caller's tool name");
  contains(other, "boom", "original text preserved");
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
