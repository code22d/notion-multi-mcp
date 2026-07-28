// -----------------------------------------------------------------------------
// Unit tests for the API surface added in the 2026 catch-up:
//
//   - request_status incomplete detection (incompleteStatusOf / describeTruncation)
//   - queryViewAll / queryDataSourceAll pagination, truncation reporting,
//     and view-query cache release
//   - view id parsing (bare / view:// / URL with ?v=)
//   - comment update/delete capability-hint errors
//   - native icon normalization round-trips
//   - custom emoji listing
//
// All against a stubbed fetch — no live calls.
// -----------------------------------------------------------------------------

import {
  NotionClient,
  describeTruncation,
  incompleteStatusOf,
} from "../src/notion/client.ts";
import { parseViewId } from "../src/tools/views.ts";
import { explainCommentMutationError } from "../src/tools/comments.ts";
import { normalizeIconInput, sanitizeIconForWrite } from "../src/tools/update-page/shared.ts";
import type { NotionAccount } from "../src/mcp/types.ts";

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

const ACCOUNT: NotionAccount = {
  id: "a1",
  name: "T",
  accessToken: "tok",
  botId: "b1",
  workspaceId: "w1",
  workspaceName: "W",
  createdAt: 0,
};

/** Route stubbed responses by "METHOD /path". Records the calls made. */
function routedClient(routes: Record<string, unknown | ((body: unknown) => unknown)>): {
  client: NotionClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = new NotionClient(ACCOUNT, {
    sleepImpl: async () => {},
    fetchImpl: (async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      const key = `${method} ${u.pathname}${u.search}`;
      calls.push(key);
      // Try exact match, then path-only match.
      const handler =
        routes[key] ?? routes[`${method} ${u.pathname}`] ?? undefined;
      if (handler === undefined) {
        return {
          ok: false,
          status: 404,
          headers: {},
          json: async () => ({}),
          text: async () => JSON.stringify({ message: `no stub for ${key}` }),
        };
      }
      const body =
        typeof handler === "function"
          ? (handler as (b: unknown) => unknown)(init?.body ? JSON.parse(init.body) : undefined)
          : handler;
      return {
        ok: true,
        status: 200,
        headers: {},
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

// -----------------------------------------------------------------------------
// incompleteStatusOf
// -----------------------------------------------------------------------------

console.log("\n[incompleteStatusOf] detects the 2026-04-20 truncation marker");
{
  eq(
    incompleteStatusOf({
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    }),
    { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    "incomplete + reason extracted"
  );
  eq(
    incompleteStatusOf({ request_status: { type: "incomplete" } }),
    { type: "incomplete" },
    "incomplete with no reason still reported"
  );
  eq(
    incompleteStatusOf({ request_status: { type: "incomplete", incomplete_reason: "future_reason" } }),
    { type: "incomplete", incomplete_reason: "future_reason" },
    "an unknown reason is passed through, not swallowed"
  );
}

console.log("\n[incompleteStatusOf] fails soft on complete / absent / malformed");
{
  eq(incompleteStatusOf({ request_status: { type: "complete" } }), null, "complete ⇒ null");
  eq(incompleteStatusOf({}), null, "field absent (pre-2026-04-20 response) ⇒ null");
  eq(incompleteStatusOf(null), null, "null response ⇒ null");
  eq(incompleteStatusOf("nonsense"), null, "non-object ⇒ null");
  eq(incompleteStatusOf({ request_status: "weird" }), null, "malformed request_status ⇒ null");
  eq(incompleteStatusOf({ request_status: {} }), null, "request_status with no type ⇒ null");
}

// -----------------------------------------------------------------------------
// describeTruncation
// -----------------------------------------------------------------------------

console.log("\n[describeTruncation] wording distinguishes Notion's cap from our own");
{
  const notionCapped = describeTruncation({
    incomplete: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    truncatedLocally: false,
    results: new Array(10_000).fill(0),
  });
  assert(notionCapped !== null, "Notion-capped set produces a warning");
  contains(notionCapped!, "INCOMPLETE", "banner is unmissable");
  contains(notionCapped!, "10,000", "names Notion's limit");
  contains(notionCapped!, "do not treat this as the full set", "tells the caller not to trust it as complete");

  const locallyCapped = describeTruncation({
    incomplete: null,
    truncatedLocally: true,
    results: new Array(100).fill(0),
  });
  assert(locallyCapped !== null, "locally-capped set produces a warning");
  contains(locallyCapped!, "TRUNCATED", "distinct wording from Notion's cap");
  contains(locallyCapped!, "max_results", "tells the caller which knob to turn");

  eq(
    describeTruncation({ incomplete: null, truncatedLocally: false, results: [1, 2] }),
    null,
    "a complete set produces NO warning"
  );
}

// -----------------------------------------------------------------------------
// queryViewAll
// -----------------------------------------------------------------------------

console.log("\n[queryViewAll] pages through the cached query and releases it");
{
  const { client, calls } = routedClient({
    "POST /v1/views/v1/queries": {
      object: "view_query",
      id: "q1",
      view_id: "v1",
      total_count: 3,
      results: [{ object: "page", id: "p1" }],
      next_cursor: "c1",
      has_more: true,
    },
    "GET /v1/views/v1/queries/q1?start_cursor=c1": {
      object: "list",
      results: [{ object: "page", id: "p2" }, { object: "page", id: "p3" }],
      next_cursor: null,
      has_more: false,
    },
    "DELETE /v1/views/v1/queries/q1": { deleted: true },
  });

  const out = await client.queryViewAll("v1");
  eq(out.results.map((r) => r.id), ["p1", "p2", "p3"], "collected every page");
  eq(out.incomplete, null, "not flagged incomplete");
  eq(out.truncatedLocally, false, "not truncated locally");
  eq(out.totalCount, 3, "total_count surfaced");
  assert(
    calls.includes("DELETE /v1/views/v1/queries/q1"),
    "released the 15-minute server-side cache when done"
  );
}

console.log("\n[queryViewAll] surfaces Notion's incomplete status instead of hiding it");
{
  // The trap this guards: has_more goes FALSE at the cap, so a naive paginator
  // sees a clean end-of-results and returns a truncated set that looks whole.
  const { client } = routedClient({
    "POST /v1/views/v1/queries": {
      object: "view_query",
      id: "q1",
      view_id: "v1",
      results: [{ object: "page", id: "p1" }],
      next_cursor: null,
      has_more: false,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    },
    "DELETE /v1/views/v1/queries/q1": { deleted: true },
  });

  const out = await client.queryViewAll("v1");
  eq(out.incomplete?.incomplete_reason, "query_result_limit_reached", "truncation reported despite has_more:false");
  const warning = describeTruncation(out);
  assert(warning !== null && warning.includes("INCOMPLETE"), "and renders as a visible warning");
}

console.log("\n[queryViewAll] an incomplete status on a LATER page is still caught");
{
  const { client } = routedClient({
    "POST /v1/views/v1/queries": {
      object: "view_query",
      id: "q1",
      view_id: "v1",
      results: [{ object: "page", id: "p1" }],
      next_cursor: "c1",
      has_more: true,
    },
    "GET /v1/views/v1/queries/q1?start_cursor=c1": {
      object: "list",
      results: [{ object: "page", id: "p2" }],
      next_cursor: null,
      has_more: false,
      request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
    },
    "DELETE /v1/views/v1/queries/q1": { deleted: true },
  });
  const out = await client.queryViewAll("v1");
  eq(out.incomplete?.type, "incomplete", "status from page 2 propagated");
}

console.log("\n[queryViewAll] maxResults truncates locally and says so");
{
  const { client } = routedClient({
    "POST /v1/views/v1/queries": {
      object: "view_query",
      id: "q1",
      view_id: "v1",
      results: [{ object: "page", id: "p1" }, { object: "page", id: "p2" }],
      next_cursor: "c1",
      has_more: true,
    },
    "DELETE /v1/views/v1/queries/q1": { deleted: true },
  });
  const out = await client.queryViewAll("v1", { maxResults: 2 });
  eq(out.results.length, 2, "stopped at the cap");
  eq(out.truncatedLocally, true, "flagged as locally truncated");
  eq(out.incomplete, null, "…and NOT confused with Notion's own cap");
}

console.log("\n[queryViewAll] a failed cache release does not fail the query");
{
  const { client } = routedClient({
    "POST /v1/views/v1/queries": {
      object: "view_query",
      id: "q1",
      view_id: "v1",
      results: [{ object: "page", id: "p1" }],
      next_cursor: null,
      has_more: false,
    },
    // No DELETE stub ⇒ the release 404s.
  });
  const out = await client.queryViewAll("v1");
  eq(out.results.map((r) => r.id), ["p1"], "results still returned; the cache expires on its own anyway");
}

// -----------------------------------------------------------------------------
// queryDataSourceAll
// -----------------------------------------------------------------------------

console.log("\n[queryDataSourceAll] pages and reports Notion's cap");
{
  let call = 0;
  const { client } = routedClient({
    "POST /v1/data_sources/ds1/query": () => {
      call++;
      if (call === 1) {
        return {
          object: "list",
          results: [{ object: "page", id: "r1" }],
          next_cursor: "c1",
          has_more: true,
        };
      }
      return {
        object: "list",
        results: [{ object: "page", id: "r2" }],
        next_cursor: null,
        has_more: false,
        request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" },
      };
    },
  });
  const out = await client.queryDataSourceAll("ds1");
  eq(out.results.map((r) => r.id), ["r1", "r2"], "collected both pages");
  eq(out.incomplete?.incomplete_reason, "query_result_limit_reached", "cap reported");
}

console.log("\n[queryDataSourceAll] forwards the filter body and the cursor");
{
  const seen: unknown[] = [];
  let call = 0;
  const { client } = routedClient({
    "POST /v1/data_sources/ds1/query": (body) => {
      seen.push(body);
      call++;
      return call === 1
        ? { object: "list", results: [{ id: "r1" }], next_cursor: "c1", has_more: true }
        : { object: "list", results: [{ id: "r2" }], next_cursor: null, has_more: false };
    },
  });
  await client.queryDataSourceAll("ds1", { filter: { property: "S", status: { equals: "Done" } }, is_archived: true });
  eq(
    (seen[0] as Record<string, unknown>).filter,
    { property: "S", status: { equals: "Done" } },
    "filter forwarded on the first call"
  );
  eq((seen[0] as Record<string, unknown>).is_archived, true, "is_archived forwarded");
  eq((seen[1] as Record<string, unknown>).start_cursor, "c1", "cursor forwarded on the second call");
  eq(
    (seen[1] as Record<string, unknown>).filter,
    { property: "S", status: { equals: "Done" } },
    "…and the filter is repeated, not dropped");
}

// -----------------------------------------------------------------------------
// listViews / deleteView
// -----------------------------------------------------------------------------

console.log("\n[listViews] sends the right query parameter for each scope");
{
  const { client, calls } = routedClient({
    "GET /v1/views": { object: "list", results: [{ object: "view", id: "v1" }], next_cursor: null, has_more: false },
  });
  await client.listViews({ databaseId: "db-1111" });
  await client.listViews({ dataSourceId: "ds-2222" });
  assert(calls[0]!.includes("database_id=db1111"), "database scope sends database_id (dashes stripped)");
  assert(calls[1]!.includes("data_source_id=ds2222"), "data source scope sends data_source_id");
  assert(!calls[0]!.includes("data_source_id"), "…and does not send the other id");
}

console.log("\n[deleteView] issues a DELETE and tolerates the partial response");
{
  const { client, calls } = routedClient({
    "DELETE /v1/views/v1": { object: "view", id: "v1", parent: { type: "database_id", database_id: "d1" }, type: "table" },
  });
  const out = await client.deleteView("v1");
  eq(calls[0], "DELETE /v1/views/v1", "correct method and path");
  eq(out.id, "v1", "identity fields returned (name/url are NOT in a delete response)");
}

// -----------------------------------------------------------------------------
// parseViewId
// -----------------------------------------------------------------------------

console.log("\n[parseViewId] accepts every form callers actually paste");
{
  eq(parseViewId("1f0e4b2c3d4e5f6071829304a5b6c7d8"), "1f0e4b2c3d4e5f6071829304a5b6c7d8", "bare id");
  eq(
    parseViewId("1f0e4b2c-3d4e-5f60-7182-9304a5b6c7d8"),
    "1f0e4b2c3d4e5f6071829304a5b6c7d8",
    "dashed uuid is normalised"
  );
  eq(parseViewId("view://abc123"), "abc123", "view:// uri");
  eq(
    parseViewId("https://app.notion.com/p/My-Db-aaaa?v=1f0e4b2c3d4e5f6071829304a5b6c7d8"),
    "1f0e4b2c3d4e5f6071829304a5b6c7d8",
    "app.notion.com URL with ?v="
  );
  eq(
    parseViewId("https://www.notion.so/My-Db-aaaa?v=1f0e4b2c-3d4e-5f60-7182-9304a5b6c7d8&pvs=4"),
    "1f0e4b2c3d4e5f6071829304a5b6c7d8",
    "legacy notion.so URL with ?v= and extra params"
  );
  eq(parseViewId("  abc  "), "abc", "surrounding whitespace trimmed");
}

// -----------------------------------------------------------------------------
// Comment mutation errors
// -----------------------------------------------------------------------------

console.log("\n[explainCommentMutationError] 404 explains the not-my-comment restriction");
{
  const msg = explainCommentMutationError(new Error("Notion API 404: Could not find comment"), "update", "c1");
  contains(msg, "only ", "states the ownership restriction");
  contains(msg, "IT created", "names the actual cause");
  contains(msg, "404 (not 403)", "warns that the status code is misleading");
  contains(msg, "Original error", "keeps the raw error for debugging");
  assert(!/^notion_update_comment failed/.test(msg), "does not fall through to the generic wrapper");
}

console.log("\n[explainCommentMutationError] 403 points at the capability, not the id");
{
  const msg = explainCommentMutationError(new Error("Notion API 403: restricted"), "delete", "c2");
  contains(msg, "Insert comments", "names the exact capability");
  contains(msg, "the name is misleading", "explains why a delete needs an *insert* capability");
  contains(msg, "notion.so/profile/integrations", "gives the URL to fix it");
}

console.log("\n[explainCommentMutationError] other errors pass through unchanged");
{
  const msg = explainCommentMutationError(new Error("Notion API 400: bad body"), "update", "c3");
  contains(msg, "notion_update_comment failed", "generic wrapper for unrelated failures");
  contains(msg, "bad body", "original text preserved");
}

console.log("\n[explainCommentMutationError] non-Error inputs don't crash");
{
  const msg = explainCommentMutationError("plain string failure", "delete", "c4");
  contains(msg, "plain string failure", "stringified safely");
}

// -----------------------------------------------------------------------------
// listCustomEmojis
// -----------------------------------------------------------------------------

console.log("\n[listCustomEmojis] name filter and pagination are forwarded");
{
  const { client, calls } = routedClient({
    "GET /v1/custom_emojis": {
      object: "list",
      results: [{ object: "custom_emoji", id: "e1", name: "bufo", url: "https://x/e1.png" }],
      next_cursor: null,
      has_more: false,
    },
  });
  const out = await client.listCustomEmojis({ name: "bufo", pageSize: 10 });
  assert(calls[0]!.includes("name=bufo"), "name filter forwarded");
  assert(calls[0]!.includes("page_size=10"), "page size forwarded");
  eq(out.results[0]?.id, "e1", "results parsed");
}

console.log("\n[listCustomEmojis] omits absent parameters entirely");
{
  const { client, calls } = routedClient({
    "GET /v1/custom_emojis": { object: "list", results: [], next_cursor: null, has_more: false },
  });
  await client.listCustomEmojis();
  eq(calls[0], "GET /v1/custom_emojis", "no stray empty query parameters");
}

// -----------------------------------------------------------------------------
// Native icons (see also test/duplicate-page.ts for the clone path)
// -----------------------------------------------------------------------------

console.log("\n[normalizeIconInput] native icon syntax");
{
  eq(
    normalizeIconInput("icon:pizza"),
    { type: "icon", icon: { name: "pizza" } },
    "icon:<name> ⇒ native icon"
  );
  eq(
    normalizeIconInput("icon:pizza:blue"),
    { type: "icon", icon: { name: "pizza", color: "blue" } },
    "icon:<name>:<color> ⇒ native icon with colour"
  );
  eq(
    normalizeIconInput("icon:star circle"),
    { type: "icon", icon: { name: "star circle" } },
    "icon-picker names with spaces are preserved (accepted since 2026-07-01)"
  );
}

console.log("\n[normalizeIconInput] pre-existing forms are UNCHANGED");
{
  eq(normalizeIconInput("🎉"), { type: "emoji", emoji: "🎉" }, "emoji unchanged");
  eq(
    normalizeIconInput("https://example.com/i.png"),
    { type: "external", external: { url: "https://example.com/i.png" } },
    "external URL unchanged"
  );
  eq(normalizeIconInput("none"), null, "'none' still clears the icon");
  eq(normalizeIconInput(""), null, "empty string still clears the icon");
  eq(normalizeIconInput(undefined), undefined, "undefined still means 'leave alone'");
  eq(normalizeIconInput(42), undefined, "non-strings still ignored");
}

console.log("\n[normalizeIconInput] custom emoji");
{
  eq(
    normalizeIconInput(":bufo:"),
    { type: "custom_emoji", custom_emoji: { name: "bufo" } },
    ":name: still resolves to a custom_emoji by name"
  );
  eq(
    normalizeIconInput("custom_emoji:2f1e4b2c3d4e5f6071829304a5b6c7d8"),
    { type: "custom_emoji", custom_emoji: { id: "2f1e4b2c3d4e5f6071829304a5b6c7d8" } },
    "custom_emoji:<id> writes an id, which is what Notion actually requires on a write"
  );
}

// -----------------------------------------------------------------------------
// sanitizeIconForWrite — the duplicate_page clone path.
//
// This is the area the previous null-icon bug came from, so the assertions
// below deliberately pin BOTH directions: the shapes that must be rewritten,
// and the shapes that must pass through untouched.
// -----------------------------------------------------------------------------

console.log("\n[sanitizeIconForWrite] round-trips a native icon");
{
  eq(
    sanitizeIconForWrite({ type: "icon", icon: { name: "pizza", color: "blue" } }),
    { type: "icon", icon: { name: "pizza", color: "blue" } },
    "name + colour survive a clone"
  );
  eq(
    sanitizeIconForWrite({ type: "icon", icon: { name: "pizza" } }),
    { type: "icon", icon: { name: "pizza" } },
    "colour is optional and no null is invented"
  );
  eq(
    sanitizeIconForWrite({ type: "icon", icon: { name: "pizza", color: null, extra: "response-only" } }),
    { type: "icon", icon: { name: "pizza" } },
    "response-only extras and a null colour are dropped, not echoed back"
  );
  eq(
    sanitizeIconForWrite({ type: "icon", icon: {} }),
    undefined,
    "a nameless native icon yields undefined (never null — that's the old bug)"
  );
}

console.log("\n[sanitizeIconForWrite] custom emoji is reduced to the writable id");
{
  eq(
    sanitizeIconForWrite({
      type: "custom_emoji",
      custom_emoji: { id: "45ce454c", name: "bufo", url: "https://x/bufo.png" },
    }),
    { type: "custom_emoji", custom_emoji: { id: "45ce454c" } },
    "response name + url stripped; only the id Notion's write schema wants remains"
  );
  eq(
    sanitizeIconForWrite({ type: "custom_emoji", custom_emoji: { name: "bufo" } }),
    { type: "custom_emoji", custom_emoji: { name: "bufo" } },
    "no id available ⇒ fall back to name rather than losing the icon"
  );
}

console.log("\n[sanitizeIconForWrite] existing shapes pass through byte-identical");
{
  eq(
    sanitizeIconForWrite({ type: "emoji", emoji: "🎉" }),
    { type: "emoji", emoji: "🎉" },
    "emoji untouched"
  );
  eq(
    sanitizeIconForWrite({ type: "external", external: { url: "https://x/i.png" } }),
    { type: "external", external: { url: "https://x/i.png" } },
    "external untouched"
  );
  eq(
    sanitizeIconForWrite({ type: "file", file: { url: "https://signed", expiry_time: "2026-01-01" } }),
    { type: "file", file: { url: "https://signed", expiry_time: "2026-01-01" } },
    "file icons keep TODAY's behaviour — this fix does not broaden into untested ground"
  );
}

console.log("\n[sanitizeIconForWrite] absent icon never becomes null");
{
  eq(sanitizeIconForWrite(null), undefined, "null icon ⇒ undefined");
  eq(sanitizeIconForWrite(undefined), undefined, "missing icon ⇒ undefined");
  eq(sanitizeIconForWrite("emoji"), undefined, "non-object ⇒ undefined");
  // The guard that matters: `if (icon) body.icon = icon` must never assign null.
  for (const input of [null, undefined, "", 0, false]) {
    const out = sanitizeIconForWrite(input);
    assert(out === undefined, `falsy input ${JSON.stringify(input)} ⇒ undefined, so no null reaches the request body`);
  }
}

// -----------------------------------------------------------------------------
// agent_id parent (2026-05-11) — must not choke anything
// -----------------------------------------------------------------------------

console.log("\n[agent_id parent] unknown parent types fail soft, as they always have");
{
  const agentParented = {
    object: "page" as const,
    id: "p1",
    parent: { type: "agent_id", agent_id: "ag-123" },
    properties: {},
  };
  // resolveTypesForPage is the documented fail-soft path for unknown parents.
  const { resolveTypesForPage } = await import("../src/notion/property-values.ts");
  const resolver = await resolveTypesForPage(
    {
      getPage: async () => agentParented as never,
      getDatabase: async () => {
        throw new Error("should not be called for an agent_id parent");
      },
      getDataSource: async () => {
        throw new Error("should not be called for an agent_id parent");
      },
    } as never,
    "p1"
  );
  eq(resolver("Anything"), undefined, "an agent_id parent yields unknown column types instead of throwing");
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
