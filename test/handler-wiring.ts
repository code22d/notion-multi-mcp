// -----------------------------------------------------------------------------
// Handler-level wiring tests — the tools as an MCP client actually reaches them.
//
// Run with:
//   tsx test/handler-wiring.ts
//
// Most of this suite tests helpers directly. These tests go in through
// `register(def)` and drive a real handler with a real ToolContext, stubbing
// only `globalThis.fetch` and KV. That is the seam where "the helper is right
// but nobody called it" shows up — which is exactly the shape of the view-id
// bug below (parseViewId existed, four tools used it, notion_update_view did
// not), and the only way to prove the env flag reaches the client.
// -----------------------------------------------------------------------------

import type { Env, ToolContext, ToolDef, ToolResult } from "../src/mcp/types.ts";
import type { NotionAccount } from "../src/mcp/types.ts";
import { registerViewTools } from "../src/tools/views.ts";
import { registerPageTools } from "../src/tools/pages.ts";
import { createNotionClient } from "../src/accounts/resolver.ts";
import { validateBlockBodiesEnabled } from "../src/notion/client.ts";
import { NotionClient } from "../src/notion/client.ts";
import { validateBlockRequestTree } from "../src/notion/block-write-schema.ts";
import type { BlockRequest } from "../src/notion/markdown/to-blocks.ts";

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

class MockKV {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async list(opts: { prefix?: string } = {}): Promise<{ keys: Array<{ name: string }>; list_complete: boolean }> {
    const prefix = opts.prefix ?? "";
    return {
      keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    };
  }
}

const ACCOUNT: NotionAccount = {
  id: "acct-1",
  name: "Test",
  accessToken: "secret-access-token",
  botId: "bot-1",
  workspaceId: "ws-1",
  workspaceName: "Test WS",
  createdAt: 0,
};

function makeCtx(vars: Partial<Env> = {}): ToolContext {
  const kv = new MockKV();
  kv.store.set(`account:${ACCOUNT.id}`, JSON.stringify(ACCOUNT));
  kv.store.set(`name_index:${ACCOUNT.name.toLowerCase()}`, ACCOUNT.id);
  const env: Env = {
    NOTION_MCP_KV: kv as unknown as KVNamespace,
    MCP_AUTH_TOKEN: "mcp",
    NOTION_OAUTH_CLIENT_ID: "cid",
    NOTION_OAUTH_CLIENT_SECRET: "csecret",
    ...vars,
  };
  return { env, request: new Request("https://example.test/mcp"), baseUrl: "https://example.test" };
}

interface SentRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

/**
 * Swap `globalThis.fetch` for a recorder. NotionClient's default fetchImpl
 * resolves `fetch` from global scope at call time, so this is the real network
 * boundary and not a constructor option the production path never uses.
 */
async function withStubbedFetch<T>(
  respond: (req: SentRequest) => unknown,
  fn: (sent: SentRequest[]) => Promise<T>
): Promise<T> {
  const sent: SentRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const req: SentRequest = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    sent.push(req);
    const payload = respond(req);
    return {
      ok: true,
      status: 200,
      headers: {},
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    return await fn(sent);
  } finally {
    globalThis.fetch = original;
  }
}

function toolsFrom(register: (r: (def: ToolDef) => void) => void): Map<string, ToolDef> {
  const map = new Map<string, ToolDef>();
  register((def) => map.set(def.name, def));
  return map;
}

const VIEW_TOOLS = toolsFrom(registerViewTools);
const PAGE_TOOLS = toolsFrom(registerPageTools);

async function call(tools: Map<string, ToolDef>, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const def = tools.get(name);
  if (!def) throw new Error(`tool ${name} is not registered`);
  return def.handler(args, ctx);
}

// -----------------------------------------------------------------------------
// notion_update_view accepts the same view-id spellings as the other view tools
// -----------------------------------------------------------------------------

const DASHED = "1f0e4b2c-3d4e-5f60-7182-9304a5b6c7d8";
const BARE = "1f0e4b2c3d4e5f6071829304a5b6c7d8";

const VIEW_RESPONSE = {
  object: "view",
  id: BARE,
  parent: { type: "database_id", database_id: "db1" },
  name: "Renamed",
  type: "table",
};

console.log("\n[notion_update_view] a pasted Notion URL resolves to the view id");
{
  // Before this fix the handler did a bare .trim(), so the whole URL was sent
  // as a path segment and Notion 400'd — while notion_get_view, given the
  // identical string, worked.
  const res = await withStubbedFetch(
    () => VIEW_RESPONSE,
    (sent) =>
      call(
        VIEW_TOOLS,
        "notion_update_view",
        { account: "Test", view_id: `https://www.notion.so/My-Db-aaaa?v=${DASHED}&pvs=4`, name: "Renamed" },
        makeCtx()
      ).then((r) => ({ r, sent }))
  );
  assert(res.r.isError !== true, "the call succeeded");
  eq(res.sent.length, 1, "exactly one API call");
  eq(res.sent[0]!.url, `https://api.notion.com/v1/views/${BARE}`, "…to the parsed, dash-stripped view id");
}

console.log("\n[notion_update_view] the view:// form and a dashed uuid work too");
{
  for (const [label, input] of [
    ["view:// uri", `view://${DASHED}`],
    ["dashed uuid", DASHED],
    ["bare id", BARE],
  ] as const) {
    const res = await withStubbedFetch(
      () => VIEW_RESPONSE,
      (sent) =>
        call(VIEW_TOOLS, "notion_update_view", { account: "Test", view_id: input, name: "Renamed" }, makeCtx()).then(
          (r) => ({ r, sent })
        )
    );
    eq(res.sent[0]?.url, `https://api.notion.com/v1/views/${BARE}`, `${label} → same normalised id`);
  }
}

console.log("\n[notion_create_view] takes no view id, so parseViewId does not apply");
{
  // The audit generalised this row to "create and update both need it". Create
  // takes `database_id` + `data_source_id` and never a view id — there is no
  // ?v= in a database URL to parse — so routing it through parseViewId would
  // have been a no-op at best. What it does need is dash stripping, which it
  // already does.
  const res = await withStubbedFetch(
    () => ({ object: "view", id: "v-new", parent: { type: "database_id", database_id: "db1" }, name: "N", type: "table" }),
    (sent) =>
      call(
        VIEW_TOOLS,
        "notion_create_view",
        { account: "Test", database_id: DASHED, data_source_id: DASHED, name: "N", type: "table" },
        makeCtx()
      ).then((r) => ({ r, sent }))
  );
  assert(res.r.isError !== true, "the call succeeded");
  eq(res.sent[0]!.body?.database_id, BARE, "database_id is dash-stripped");
  eq(res.sent[0]!.body?.data_source_id, BARE, "data_source_id is dash-stripped");
}

// -----------------------------------------------------------------------------
// notion_create_pages survives content deeper than the request schema allows
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

/**
 * Enough of Notion to follow a create through its follow-up appends: blocks
 * get ids, INLINE children become listable blocks of their own (which is what
 * the deferral resolver walks down through), and GET /blocks/{id}/children
 * answers with what was actually stored under that id.
 */
function fakeNotion(): (req: SentRequest) => unknown {
  const byParent = new Map<string, Array<{ object: string; id: string; type: string }>>();
  let n = 0;

  // Ids are dash-free on purpose: every path segment the client builds goes
  // through stripDashes(), so a block returned as `blk-1` is fetched as `blk1`.
  // Real Notion ids are uuids and behave the same way.
  const register = (b: BlockRequest): { object: string; id: string; type: string } => {
    const id = `blk${++n}`;
    const type = String(b.type);
    const inner = (b as Record<string, unknown>)[type] as Record<string, unknown> | undefined;
    const children = Array.isArray(inner?.children) ? (inner!.children as BlockRequest[]) : [];
    if (children.length > 0) byParent.set(id, children.map(register));
    return { object: "block", id, type };
  };
  const store = (parentId: string, children: BlockRequest[]) => {
    const results = children.map(register);
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), ...results]);
    return results;
  };

  return (req) => {
    const path = new URL(req.url).pathname;
    if (path === "/v1/pages" && req.method === "POST") {
      store("page1", (req.body?.children ?? []) as BlockRequest[]);
      return { object: "page", id: "page1", url: "https://notion.so/page1", properties: {} };
    }
    const children = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (children) {
      const parentId = children[1]!;
      const results =
        req.method === "PATCH"
          ? store(parentId, (req.body?.children ?? []) as BlockRequest[])
          : (byParent.get(parentId) ?? []);
      return { object: "list", results, has_more: false, next_cursor: null };
    }
    return {};
  };
}

console.log("\n[notion_create_pages] a five-level toggle chain is created, not rejected");
{
  const res = await withStubbedFetch(fakeNotion(), (sent) =>
    call(
      PAGE_TOOLS,
      "notion_create_pages",
      { account: "Test", parent: { page_id: "parent-1" }, pages: [{ content: FIVE_DEEP, properties: { title: "Deep" } }] },
      makeCtx()
    ).then((r) => ({ r, sent }))
  );

  assert(res.r.isError !== true, `create succeeded (${JSON.stringify(res.r.content?.[0]?.text)})`);

  // Every body that went out is one Notion's documented write schema accepts.
  const blockBodies = res.sent.filter((s) => Array.isArray(s.body?.children));
  assert(blockBodies.length >= 2, "the tree needed more than one request — deferral actually engaged");
  for (const s of blockBodies) {
    const problems = validateBlockRequestTree(s.body!.children);
    eq(problems.map((p) => `${p.path}: ${p.message}`), [], `body sent to ${new URL(s.url).pathname} is valid`);
  }

  // …and nothing was quietly dropped to achieve that.
  const wire = JSON.stringify(res.sent.map((s) => s.body));
  for (const marker of ["L1", "L2", "L3", "L4", "L5", "Deepest content marker L6-BODY."]) {
    assert(wire.includes(marker), `"${marker}" appears in some request body`);
  }
}

console.log("\n[notion_create_pages] ordinary content still takes exactly one request");
{
  const res = await withStubbedFetch(
    () => ({ object: "page", id: "page-2", url: "https://notion.so/page-2", properties: {} }),
    (sent) =>
      call(
        PAGE_TOOLS,
        "notion_create_pages",
        { account: "Test", parent: { page_id: "parent-1" }, pages: [{ content: "# Hi\n\nA paragraph.\n", properties: { title: "Flat" } }] },
        makeCtx()
      ).then((r) => ({ r, sent }))
  );
  assert(res.r.isError !== true, "create succeeded");
  eq(res.sent.length, 1, "no extra list/append calls for shallow content");
  eq(
    (res.sent[0]!.body!.children as BlockRequest[]).map((c) => c.type),
    ["heading_1", "paragraph"],
    "the same children the converter produced"
  );
}

console.log("\n[notion_update_page replace_content] the same depth handling applies");
{
  // replace_content is the other place authored markdown is sent verbatim. It
  // used to appendInChunks() the converter's output, so a deep tree 400'd here
  // for exactly the reason it did on create.
  const res = await withStubbedFetch(fakeNotion(), (sent) =>
    call(
      PAGE_TOOLS,
      "notion_update_page",
      { account: "Test", page_id: "page1", command: "replace_content", new_str: FIVE_DEEP },
      makeCtx()
    ).then((r) => ({ r, sent }))
  );

  assert(res.r.isError !== true, `replace succeeded (${JSON.stringify(res.r.content?.[0]?.text)})`);
  const blockBodies = res.sent.filter((s) => Array.isArray(s.body?.children));
  assert(blockBodies.length >= 2, "the deep subtree needed a follow-up request");
  for (const s of blockBodies) {
    const problems = validateBlockRequestTree(s.body!.children);
    eq(problems.map((p) => `${p.path}: ${p.message}`), [], `body sent to ${new URL(s.url).pathname} is valid`);
  }
  const wire = JSON.stringify(res.sent.map((s) => s.body));
  for (const marker of ["L1", "L5", "Deepest content marker L6-BODY."]) {
    assert(wire.includes(marker), `"${marker}" reached the page`);
  }
}

// -----------------------------------------------------------------------------
// VALIDATE_BLOCK_BODIES
// -----------------------------------------------------------------------------

console.log("\n[validateBlockBodiesEnabled] only explicit on-spellings turn it on");
{
  for (const on of ["1", "true", "TRUE", " yes ", "on"]) {
    eq(validateBlockBodiesEnabled(on), true, `"${on}" → on`);
  }
  for (const off of [undefined, null, "", "0", "false", "no", "off", "maybe", 1, {}]) {
    eq(validateBlockBodiesEnabled(off), false, `${JSON.stringify(off)} → off (default is always off)`);
  }
}

/** A body the write schema rejects: `tab.children` is required and absent. */
const BAD_BODY = { children: [{ type: "tab", tab: {} }] };

console.log("\n[VALIDATE_BLOCK_BODIES] unset ⇒ no log, and the request is unchanged");
{
  const logs: string[] = [];
  const sent: Array<Record<string, unknown> | undefined> = [];
  const client = new NotionClient(ACCOUNT, {
    logImpl: (m) => logs.push(m),
    fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
      sent.push(init?.body ? JSON.parse(init.body) : undefined);
      return { ok: true, status: 200, headers: {}, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch,
  });
  await client.appendBlockChildren("b1", BAD_BODY);
  eq(logs, [], "nothing logged");
  eq(sent[0], BAD_BODY, "the body went out byte-for-byte, untouched");
}

console.log("\n[VALIDATE_BLOCK_BODIES] on ⇒ logs the violation and STILL sends the request");
{
  const logs: string[] = [];
  const sent: Array<Record<string, unknown> | undefined> = [];
  const client = new NotionClient(ACCOUNT, {
    validateBlockBodies: true,
    logImpl: (m) => logs.push(m),
    fetchImpl: (async (_u: unknown, init?: { body?: string }) => {
      sent.push(init?.body ? JSON.parse(init.body) : undefined);
      return { ok: true, status: 200, headers: {}, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch,
  });

  await client.appendBlockChildren("b1", BAD_BODY);

  eq(logs.length, 1, "one log line");
  eq(sent.length, 1, "the request was still sent — this must never gate a call");
  eq(sent[0], BAD_BODY, "…with an unmodified body");

  const line = logs[0]!;
  assert(line.includes("VALIDATE_BLOCK_BODIES"), "log names the flag so it is greppable");
  assert(line.includes("appendBlockChildren"), "…and the operation");
  assert(line.includes("children[0]"), "…the path to the offending block");
  assert(line.includes("`tab.children` is required"), "…and the specific violation");
  assert(line.includes("Sending anyway"), "…and says plainly that the request was not blocked");
}

console.log("\n[VALIDATE_BLOCK_BODIES] the log cannot leak page content or credentials");
{
  const logs: string[] = [];
  const client = new NotionClient(ACCOUNT, {
    validateBlockBodies: true,
    logImpl: (m) => logs.push(m),
    fetchImpl: (async () =>
      ({ ok: true, status: 200, headers: {}, json: async () => ({}), text: async () => "{}" }) as unknown as Response) as unknown as typeof fetch,
  });

  await client.createPage({
    parent: { page_id: "p1" },
    properties: { title: [{ type: "text", text: { content: "TOP SECRET TITLE" } }] },
    children: [
      {
        type: "tab",
        tab: {},
      },
      {
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "CONFIDENTIAL BODY TEXT" } }],
          icon: null,
        },
      },
      { type: "image", image: { type: "file", file: { url: "https://signed.example/SECRET-URL" } } },
    ],
  });

  const line = logs.join("\n");
  assert(line.length > 0, "problems were reported");
  assert(!line.includes("CONFIDENTIAL BODY TEXT"), "no rich-text content in the log");
  assert(!line.includes("TOP SECRET TITLE"), "no property values in the log");
  assert(!line.includes("SECRET-URL"), "no media URLs in the log");
  assert(!line.includes(ACCOUNT.accessToken), "no token material in the log");
  assert(line.includes("`paragraph.icon` is null"), "but the actual defects are named");
}

console.log("\n[VALIDATE_BLOCK_BODIES] a validator that throws cannot break the request");
{
  const sent: string[] = [];
  const client = new NotionClient(ACCOUNT, {
    validateBlockBodies: true,
    // A log sink that explodes stands in for any failure inside the check —
    // the point is that the request survives whatever the diagnostic does.
    logImpl: () => {
      throw new Error("logging blew up");
    },
    fetchImpl: (async (u: unknown) => {
      sent.push(String(u));
      return { ok: true, status: 200, headers: {}, json: async () => ({}), text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch,
  });

  let threw: unknown = null;
  try {
    await client.appendBlockChildren("b1", BAD_BODY);
  } catch (e) {
    threw = e;
  }
  eq(threw, null, "appendBlockChildren did not throw");
  eq(sent.length, 1, "and the request went out anyway");
}

console.log("\n[VALIDATE_BLOCK_BODIES] bodies with no `children` are not touched at all");
{
  const logs: string[] = [];
  const client = new NotionClient(ACCOUNT, {
    validateBlockBodies: true,
    logImpl: (m) => logs.push(m),
    fetchImpl: (async () =>
      ({ ok: true, status: 200, headers: {}, json: async () => ({}), text: async () => "{}" }) as unknown as Response) as unknown as typeof fetch,
  });
  await client.createPage({ parent: { page_id: "p1" }, properties: {} });
  eq(logs, [], "a childless createPage is silent");
}

console.log("\n[VALIDATE_BLOCK_BODIES] the env var actually reaches the client");
{
  // The parser being right is worthless if createNotionClient never reads it —
  // the same "helper exists, nobody called it" failure as the view-id bug. This
  // goes through the real factory with a real ToolContext and defaults to
  // console.warn, so it also proves the production log sink works.
  const run = async (vars: Partial<Env>): Promise<string[]> => {
    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      await withStubbedFetch(
        () => ({}),
        () => createNotionClient(ACCOUNT, makeCtx(vars)).appendBlockChildren("b1", BAD_BODY)
      );
    } finally {
      console.warn = originalWarn;
    }
    return logs;
  };

  eq(await run({}), [], "unset ⇒ silent, exactly as production is today");
  eq(await run({ VALIDATE_BLOCK_BODIES: "0" }), [], "\"0\" ⇒ silent");
  const on = await run({ VALIDATE_BLOCK_BODIES: "1" });
  eq(on.length, 1, "\"1\" ⇒ one warning on console.warn");
  assert(on[0]!.includes("`tab.children` is required"), "…naming the violation");
}

console.log("\n[VALIDATE_BLOCK_BODIES] on ⇒ a well-formed create body stays silent");
{
  // Guards against the other failure mode: a validator that cries wolf is one
  // people learn to ignore.
  const logs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try {
    await withStubbedFetch(fakeNotion(), () =>
      call(
        PAGE_TOOLS,
        "notion_create_pages",
        {
          account: "Test",
          parent: { page_id: "parent-1" },
          // Table, tabs and a five-deep toggle chain — every shape that has
          // produced a real 400 in this repo, in one page.
          pages: [
            {
              content: `| a | b |\n| --- | --- |\n| 1 | 2 |\n\n<tabs>\n<tab><summary>T</summary>\nbody\n</tab>\n</tabs>\n\n${FIVE_DEEP}`,
              properties: { title: "T" },
            },
          ],
        },
        makeCtx({ VALIDATE_BLOCK_BODIES: "1" })
      )
    );
  } finally {
    console.warn = originalWarn;
  }
  eq(logs, [], "nothing logged — every body notion_create_pages emitted was valid");
}

// -----------------------------------------------------------------------------
console.log(`\n=== handler wiring: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
