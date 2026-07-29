// -----------------------------------------------------------------------------
// VALIDATE_BLOCK_BODIES — proving the safety net actually works.
//
// Run with:
//   tsx test/validate-block-bodies.ts
//
// The flag ships OFF, which is right, and means nobody has ever watched it run.
// An untested safety net is the same category of thing as an untested backup:
// the moment you need it is the worst moment to find out. `wrangler dev`
// against a live workspace is not reachable from here, but every property that
// matters IS reachable through the client's injectable seams — `logImpl` for
// what it says, `fetchImpl` for what actually goes on the wire.
//
// This file is about the VALIDATOR'S GUARANTEES. test/handler-wiring.ts covers
// the neighbouring question of whether the env var reaches the client at all
// (through a real ToolContext and the real console.warn sink); the two overlap
// deliberately at the boundary and neither subsumes the other.
//
// Six properties, in the order they'd bite if they were false:
//
//   1. OFF BY DEFAULT      — unset ⇒ zero log calls, and the bytes on the wire
//                            are identical to a client that never had the flag.
//   2. ON WHEN FLAGGED     — every accepted spelling switches it on; everything
//                            else, including plausible typos, leaves it off.
//   3. NEVER THROWS        — even when the validator itself raises. A
//                            diagnostic has no business failing a working
//                            request.
//   4. NEVER LEAKS         — block type, path and violation; never page text,
//                            URLs, icons, captions or token material.
//   5. CATCHES REAL BUGS   — the three bodies that caused actual production
//                            400s are each reported.
//   6. DOESN'T CRY WOLF    — a well-formed body logs nothing at all. A
//                            validator that fires on healthy input is one
//                            people learn to ignore, which is worse than none.
// -----------------------------------------------------------------------------

import type { NotionAccount } from "../src/mcp/types.ts";
import { NotionClient, validateBlockBodiesEnabled } from "../src/notion/client.ts";

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

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

const ACCOUNT: NotionAccount = {
  id: "acct-1",
  name: "Test",
  // Deliberately token-shaped: several assertions below check that nothing
  // matching Notion's secret formats reaches the log.
  accessToken: "ntn_SECRETTOKENVALUE0123456789",
  botId: "bot-1",
  workspaceId: "ws-1",
  workspaceName: "Test WS",
  createdAt: 0,
};

interface Harness {
  client: NotionClient;
  /** Every message handed to the log sink. */
  logs: string[];
  /** Raw request bodies as they reached fetch — strings, so byte-comparable. */
  sent: string[];
}

function makeClient(opts: { on?: boolean; logImpl?: (m: string) => void } = {}): Harness {
  const logs: string[] = [];
  const sent: string[] = [];
  const client = new NotionClient(ACCOUNT, {
    // `undefined` is the production default — the flag key absent entirely.
    validateBlockBodies: opts.on,
    logImpl: opts.logImpl ?? ((m) => logs.push(m)),
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      if (typeof init?.body === "string") sent.push(init.body);
      return {
        ok: true,
        status: 200,
        headers: {},
        json: async () => ({}),
        text: async () => "{}",
      } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  return { client, logs, sent };
}

/** The three bodies that produced real 400s from Notion, as they were sent. */
const PRODUCTION_400s = {
  bareTab: { type: "tab", tab: {} },
  nullIcon: {
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: "hi" } }], icon: null },
  },
  hostedImage: {
    type: "image",
    image: { type: "file", file: { url: "https://s3.example/signed", expiry_time: "2026-01-01" } },
  },
} as const;

// -----------------------------------------------------------------------------
// 1. OFF BY DEFAULT
// -----------------------------------------------------------------------------

console.log("\n[1. off by default] the flag absent ⇒ silent, and the bytes are unchanged");

{
  const body = { children: [PRODUCTION_400s.bareTab, PRODUCTION_400s.nullIcon] };

  const off = makeClient();
  await off.client.appendBlockChildren("b1", body);
  eq(off.logs, [], "no log calls at all — not an empty message, no call");
  eq(off.sent.length, 1, "the request went out");

  const on = makeClient({ on: true });
  await on.client.appendBlockChildren("b1", body);
  assert(on.logs.length === 1, "the same body DOES log with the flag on (so the comparison means something)");

  eq(on.sent[0], off.sent[0], "byte-identical request bodies with the flag on and off");
  assert(
    off.sent[0] === JSON.stringify(body),
    "…and both are exactly what the caller handed in — nothing normalised, nothing stripped"
  );
}

{
  // The same for createPage, the other call site, including that a body with
  // no `children` at all never reaches the validator.
  const off = makeClient();
  const on = makeClient({ on: true });
  const propsOnly = { parent: { page_id: "p1" }, properties: { title: "x" } };
  await off.client.createPage(propsOnly);
  await on.client.createPage(propsOnly);
  eq(on.logs, [], "a childless createPage is silent even with the flag on");
  eq(on.sent[0], off.sent[0], "…and its body is byte-identical either way");
}

{
  // A validator that mutated the body it inspected would be a production bug
  // hiding behind a dev flag. Prove the caller's object survives untouched.
  const body = {
    children: [{ type: "tab", tab: {} } as Record<string, unknown>],
  };
  const before = JSON.stringify(body);
  const on = makeClient({ on: true });
  await on.client.appendBlockChildren("b1", body);
  eq(JSON.stringify(body), before, "the caller's object is not mutated by the check");
}

// -----------------------------------------------------------------------------
// 2. ON WHEN FLAGGED
// -----------------------------------------------------------------------------

console.log("\n[2. on when flagged] only explicit on-spellings, and they reach the check");

const ON_SPELLINGS: unknown[] = ["1", "true", "yes", "on", true, "TRUE", "  On  ", "YES"];
const OFF_SPELLINGS: unknown[] = [
  undefined,
  null,
  "",
  "   ",
  "0",
  "false",
  false,
  "no",
  "off",
  "maybe",
  "truthy",
  1,
  0,
  {},
  [],
  ["1"],
];

for (const raw of ON_SPELLINGS) {
  eq(validateBlockBodiesEnabled(raw), true, `${JSON.stringify(raw)} → on`);
}
for (const raw of OFF_SPELLINGS) {
  eq(validateBlockBodiesEnabled(raw), false, `${JSON.stringify(raw)} → off`);
}

// Surrounding whitespace is not a typo — it trims. Pinned separately so the
// on/off tables above stay unambiguous.
eq(validateBlockBodiesEnabled("1 "), true, '"1 " trims to "1" → on');
eq(validateBlockBodiesEnabled("\ttrue\n"), true, '"\\ttrue\\n" trims → on');

{
  // The parser being right is worth nothing if the boolean it returns doesn't
  // change what the client does. Drive each verdict all the way to the log.
  for (const raw of ["1", "true", "yes", "on", true]) {
    const h = makeClient({ on: validateBlockBodiesEnabled(raw) });
    await h.client.appendBlockChildren("b1", { children: [PRODUCTION_400s.bareTab] });
    eq(h.logs.length, 1, `${JSON.stringify(raw)} ⇒ the check actually ran`);
  }
  for (const raw of [undefined, "", "0", "false", "maybe", 1, {}]) {
    const h = makeClient({ on: validateBlockBodiesEnabled(raw) });
    await h.client.appendBlockChildren("b1", { children: [PRODUCTION_400s.bareTab] });
    eq(h.logs.length, 0, `${JSON.stringify(raw)} ⇒ the check did not run`);
    eq(h.sent.length, 1, `…and the request still went out`);
  }
}

// -----------------------------------------------------------------------------
// 3. NEVER THROWS
// -----------------------------------------------------------------------------

console.log("\n[3. never throws] not for a bad sink, not for a bad body, not for a bad validator");

async function survives(
  name: string,
  run: (h: Harness) => Promise<unknown>,
  h: Harness
): Promise<void> {
  let threw: unknown = null;
  try {
    await run(h);
  } catch (e) {
    threw = e;
  }
  eq(threw === null, true, `${name}: nothing escaped to the caller`);
  eq(h.sent.length, 1, `${name}: …and the request still went out`);
}

{
  // (a) The log sink explodes.
  const h = makeClient({
    on: true,
    logImpl: () => {
      throw new Error("sink blew up");
    },
  });
  await survives("throwing log sink", (x) => x.client.appendBlockChildren("b1", { children: [PRODUCTION_400s.bareTab] }), h);
}

{
  // (b) The VALIDATOR itself throws. `children` is a real array as far as
  // Array.isArray and JSON.stringify are concerned — only `forEach` raises,
  // and forEach is what validateBlockRequestTree walks with. So the throw
  // happens strictly inside the validator, after the flag test and before the
  // request, which is the window this guarantee is about.
  const hostile = new Proxy([{ type: "paragraph", paragraph: { rich_text: [] } }], {
    get(target, prop, recv) {
      if (prop === "forEach") throw new Error("validator blew up mid-walk");
      return Reflect.get(target, prop, recv);
    },
  });
  const h = makeClient({ on: true });
  eq(Array.isArray(hostile), true, "the hostile children value really does look like an array");
  await survives("throwing validator", (x) => x.client.appendBlockChildren("b1", { children: hostile }), h);
  eq(h.logs, [], "…and it stayed quiet rather than reporting nonsense");
  assert(
    h.sent[0]!.includes('"rich_text":[]'),
    "…and the body Notion received is the real one, not a degraded copy"
  );
}

{
  // (c) A body that cannot be READ at all. This one genuinely fails — but it
  // fails identically with the flag off, because JSON.stringify hits the same
  // getter when the request is serialised. The point is that turning the
  // validator on introduces no failure the caller didn't already have; a
  // guarantee of "never throws" that quietly meant "throws earlier" would be
  // worth nothing.
  const makeBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = { parent: { page_id: "p1" } };
    Object.defineProperty(body, "children", {
      enumerable: true,
      get(): never {
        throw new Error("children getter blew up");
      },
    });
    return body;
  };
  const attempt = async (on: boolean): Promise<string> => {
    try {
      await makeClient({ on }).client.createPage(makeBody());
      return "no throw";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const withFlag = await attempt(true);
  const withoutFlag = await attempt(false);
  eq(withoutFlag, "children getter blew up", "an unreadable body already fails with the flag OFF");
  eq(withFlag, withoutFlag, "…and fails identically with it ON — the check adds no new failure mode");
}

// -----------------------------------------------------------------------------
// 4. NEVER LEAKS
// -----------------------------------------------------------------------------

console.log("\n[4. never leaks] type, path and violation — nothing from the payload");

{
  // Every field that could plausibly carry something private, each stuffed
  // with a distinct canary, on blocks that are ALSO genuinely invalid so the
  // validator has plenty to say about them.
  const CANARIES = [
    "CANARY-PAGE-TITLE",
    "CANARY-BODY-TEXT",
    "CANARY-CAPTION",
    "CANARY-CODE",
    "CANARY-EQUATION",
    "CANARY-TABLE-CELL",
    "CANARY-EMOJI",
    "CANARY-BOOKMARK-URL",
    "https://signed.example/CANARY-MEDIA-URL",
    "https://icon.example/CANARY-ICON-URL",
    ACCOUNT.accessToken,
  ];

  const h = makeClient({ on: true });
  await h.client.createPage({
    parent: { page_id: "p1" },
    properties: { title: [{ type: "text", text: { content: "CANARY-PAGE-TITLE" } }] },
    children: [
      { type: "tab", tab: {} },
      {
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "CANARY-BODY-TEXT" } }],
          icon: null,
          color: null,
        },
      },
      {
        type: "image",
        image: {
          type: "file",
          file: { url: "https://signed.example/CANARY-MEDIA-URL" },
          caption: [{ type: "text", text: { content: "CANARY-CAPTION" } }],
        },
      },
      {
        type: "callout",
        callout: {
          rich_text: [],
          icon: { type: "external", external: { url: "https://icon.example/CANARY-ICON-URL" } },
          children: [{ type: "column_list", column_list: { children: [] } }],
        },
      },
      { type: "code", code: { rich_text: [{ type: "text", text: { content: "CANARY-CODE" } }] } },
      { type: "equation", equation: { latex: "CANARY-EQUATION" } },
      { type: "table_row", table_row: { cells: [[{ type: "text", text: { content: "CANARY-TABLE-CELL" } }]] }, id: "x" },
      { type: "bookmark", bookmark: { url: "CANARY-BOOKMARK-URL" }, has_children: false },
      { type: "child_page", child_page: { title: "CANARY-EMOJI" } },
    ],
  });

  const log = h.logs.join("\n");
  assert(log.length > 0, "the body was reported at all (otherwise this proves nothing)");

  for (const canary of CANARIES) {
    assert(!log.includes(canary), `no ${canary.startsWith("http") ? "URL" : "value"} in the log: ${canary.slice(0, 32)}`);
  }
  // Belt and braces: nothing shaped like a Notion credential, whatever its value.
  assert(!/ntn_[A-Za-z0-9]/.test(log), "nothing matching Notion's `ntn_` token format");
  assert(!/secret_[A-Za-z0-9]/.test(log), "nothing matching Notion's legacy `secret_` token format");

  // …while the violations themselves are named, precisely.
  assert(log.includes("`tab.children` is required"), "names the missing tab children");
  assert(log.includes("`paragraph.icon` is null"), "names the null icon");
  assert(log.includes("`image.file`"), "names the response-only media shape");
  assert(log.includes("`column_list`"), "names the tier-illegal column_list");
  assert(log.includes("`code.language` is required"), "names the missing code language");
  assert(log.includes("`equation.expression` is required"), "names the missing equation expression");
  assert(log.includes("`child_page` has no create shape"), "names the unwritable block type");
  assert(log.includes("response-only field `id`"), "names the response-only id");
  assert(log.includes("response-only field `has_children`"), "names the response-only has_children");
  assert(/children\[\d\]/.test(log), "carries an array path so the block is findable");
}

{
  // The cap exists so one malformed 100-block body can't bury the console;
  // it must not silently swallow the count either.
  const h = makeClient({ on: true });
  const many = Array.from({ length: 30 }, () => ({ type: "tab", tab: {} }));
  await h.client.appendBlockChildren("b1", { children: many });
  const log = h.logs.join("\n");
  assert(log.includes("would send 30 block(s)"), "the true total is stated");
  assert(log.includes("… and 10 more"), "…and the elided remainder is counted, not dropped");
  eq(log.split("\n").filter((l) => l.includes("is required by the write schema")).length, 20,
    "exactly 20 problems are spelled out");
}

// -----------------------------------------------------------------------------
// 5. CATCHES THE REAL BUGS
// -----------------------------------------------------------------------------

console.log("\n[5. catches real bugs] each body that caused a production 400 is reported");

{
  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      "the bare tab that 400'd duplicate_page",
      PRODUCTION_400s.bareTab,
      "`tab.children` is required by the write schema but is absent",
    ],
    [
      "a paragraph carrying the response-only `icon: null`",
      PRODUCTION_400s.nullIcon,
      "`paragraph.icon` is null",
    ],
    [
      "an image carrying a notion-hosted `file`",
      PRODUCTION_400s.hostedImage,
      "`image.file` is a response-only shape",
    ],
  ];

  for (const [name, block, expected] of cases) {
    const viaAppend = makeClient({ on: true });
    await viaAppend.client.appendBlockChildren("b1", { children: [block] });
    assert(viaAppend.logs.join("\n").includes(expected), `appendBlockChildren reports ${name}`);

    const viaCreate = makeClient({ on: true });
    await viaCreate.client.createPage({ parent: { page_id: "p1" }, children: [block] });
    assert(viaCreate.logs.join("\n").includes(expected), `createPage reports ${name}`);
  }
}

{
  // Found while writing these: the media check discriminated on `type`, but
  // the write schema's union discriminates on the SOURCE KEY — `type` is
  // optional in both arms. A media block with neither `external` nor
  // `file_upload` matched no arm and was passed as fine.
  const h = makeClient({ on: true });
  await h.client.appendBlockChildren("b1", {
    children: [{ type: "image", image: { caption: [] } }],
  });
  assert(
    h.logs.join("\n").includes("carries neither `external` nor `file_upload`"),
    "a media block with no source at all is reported"
  );
}

{
  // The other side of that fix: `object: "block"` is declared on every
  // alternative of the request union, so reporting it was a wrong verdict.
  const h = makeClient({ on: true });
  await h.client.appendBlockChildren("b1", {
    children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }],
  });
  eq(h.logs, [], "`object: \"block\"` is accepted by the write schema and is not reported");
}

// -----------------------------------------------------------------------------
// 6. DOESN'T CRY WOLF
// -----------------------------------------------------------------------------

console.log("\n[6. doesn't cry wolf] a well-formed body logs nothing");

{
  const h = makeClient({ on: true });
  await h.client.createPage({
    parent: { page_id: "p1" },
    properties: { title: [{ type: "text", text: { content: "Fine" } }] },
    children: [
      { type: "heading_1", heading_1: { rich_text: [{ type: "text", text: { content: "H" } }] } },
      { type: "divider", divider: {} },
      {
        type: "table",
        table: {
          table_width: 2,
          has_column_header: true,
          children: [{ type: "table_row", table_row: { cells: [[], []] } }],
        },
      },
      {
        type: "tab",
        tab: {
          children: [
            {
              type: "paragraph",
              paragraph: {
                rich_text: [{ type: "text", text: { content: "Tab one" } }],
                children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
              },
            },
          ],
        },
      },
      {
        type: "column_list",
        column_list: {
          children: [
            { type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
            { type: "column", column: { children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } },
          ],
        },
      },
      { type: "image", image: { type: "external", external: { url: "https://example.com/a.png" } } },
      { type: "file", file: { type: "file_upload", file_upload: { id: "fu-1" }, name: "doc.pdf" } },
      { type: "synced_block", synced_block: { synced_from: null, children: [{ type: "divider", divider: {} }] } },
      { type: "code", code: { language: "typescript", rich_text: [{ type: "text", text: { content: "x" } }] } },
      { type: "equation", equation: { expression: "e=mc^2" } },
      { type: "breadcrumb", breadcrumb: {} },
      { type: "table_of_contents", table_of_contents: { color: "default" } },
      {
        type: "toggle",
        toggle: {
          rich_text: [],
          children: [{ type: "toggle", toggle: { rich_text: [], children: [{ type: "paragraph", paragraph: { rich_text: [] } }] } }],
        },
      },
    ],
  });
  eq(h.logs, [], "every block type this repo emits, at every legal tier, and not one complaint");
}

// -----------------------------------------------------------------------------
console.log(`\n=== VALIDATE_BLOCK_BODIES: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
