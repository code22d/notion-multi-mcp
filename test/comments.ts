// -----------------------------------------------------------------------------
// Unit tests for notion_create_comment response formatting (Bug 3 regression).
//
// The live handler takes a ctx with a KV-backed account store, so we test the
// pure formatter. Exercises shapes with missing / malformed fields to prove
// the previously-observed "Cannot read properties of undefined (reading 'id')"
// crash doesn't recur.
// -----------------------------------------------------------------------------

import { formatCreateCommentResult, getCommentsForClient, type GetCommentsClient } from "../src/tools/comments.ts";
import type { NotionCommentObject, NotionPageObject, NotionRichText, PaginatedList } from "../src/notion/client.ts";

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

function contains(haystack: string, needle: string, msg: string): void {
  assert(haystack.includes(needle), `${msg} (expected to contain "${needle}", got ${JSON.stringify(haystack)})`);
}

// -----------------------------------------------------------------------------
// Shape: full happy-path
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] happy-path");
{
  const result = formatCreateCommentResult({
    object: "comment",
    id: "cmt-123",
    discussion_id: "disc-abc",
    created_by: { object: "user", id: "user-xyz" },
    rich_text: [{ type: "text", plain_text: "hello world", text: { content: "hello world" } }],
  });
  contains(result, "cmt-123", "comment id present");
  contains(result, "disc-abc", "discussion id present");
  contains(result, "user-xyz", "author id present");
  contains(result, "hello world", "comment text present");
}

// -----------------------------------------------------------------------------
// Shape: missing created_by (Bug 3 root cause)
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] missing created_by");
{
  let threw = false;
  let result = "";
  try {
    result = formatCreateCommentResult({
      object: "comment",
      id: "cmt-123",
      discussion_id: "disc-abc",
      // created_by absent — the null-deref we hit in production
      rich_text: [{ type: "text", plain_text: "hi", text: { content: "hi" } }],
    });
  } catch {
    threw = true;
  }
  assert(!threw, "no crash when created_by is absent");
  contains(result, "cmt-123", "id still formatted");
  contains(result, "(unknown)", "author placeholder emitted");
}

// -----------------------------------------------------------------------------
// Shape: missing rich_text
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] missing rich_text");
{
  let threw = false;
  let result = "";
  try {
    result = formatCreateCommentResult({
      id: "cmt-1",
      discussion_id: "disc-1",
      created_by: { id: "user-1" },
    });
  } catch {
    threw = true;
  }
  assert(!threw, "no crash when rich_text is absent");
  contains(result, "(no text returned)", "text placeholder emitted");
}

// -----------------------------------------------------------------------------
// Shape: completely empty object
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] empty object");
{
  let threw = false;
  let result = "";
  try {
    result = formatCreateCommentResult({});
  } catch {
    threw = true;
  }
  assert(!threw, "no crash on empty response");
  contains(result, "Created comment (unknown)", "id placeholder emitted");
  contains(result, "Discussion: (unknown)", "discussion placeholder emitted");
  contains(result, "Author: (unknown)", "author placeholder emitted");
}

// -----------------------------------------------------------------------------
// Shape: completely null / undefined (defensive)
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] null/undefined");
{
  let threw = false;
  let r1 = "";
  let r2 = "";
  try {
    r1 = formatCreateCommentResult(null);
    r2 = formatCreateCommentResult(undefined);
  } catch {
    threw = true;
  }
  assert(!threw, "no crash on null/undefined");
  contains(r1, "(unknown)", "null → placeholders");
  contains(r2, "(unknown)", "undefined → placeholders");
}

// -----------------------------------------------------------------------------
// Shape: malformed rich_text (not an array)
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] malformed rich_text");
{
  let threw = false;
  let result = "";
  try {
    result = formatCreateCommentResult({
      id: "cmt-1",
      discussion_id: "disc-1",
      created_by: { id: "user-1" },
      rich_text: "oops-not-an-array",
    });
  } catch {
    threw = true;
  }
  assert(!threw, "no crash when rich_text is a string");
  contains(result, "(no text returned)", "text placeholder for non-array");
}

// -----------------------------------------------------------------------------
// Bug 3 regression — partial response + fallback produces NO placeholders.
//
// Notion's CreateCommentResponse is declared as
//   PartialCommentObjectResponse | CommentObjectResponse
// and in production we observed the partial shape (`{ object, id }` only)
// frequently enough that every created comment rendered with placeholder
// fields. With the fallback context supplied by the handler (what we sent +
// the bot id) the formatter should now render real values.
// -----------------------------------------------------------------------------

console.log("\n[formatCreateCommentResult] Bug 3: partial response + reply fallback → no placeholders");
{
  const partial = { object: "comment", id: "cmt-partial" };
  const fallbackRich: NotionRichText[] = [
    { type: "text", plain_text: "hi from test", text: { content: "hi from test" } },
  ];
  const result = formatCreateCommentResult(partial, {
    discussion_id: "disc-fallback",
    richText: fallbackRich,
    authorId: "bot-ReneCEO",
  });
  contains(result, "cmt-partial", "id from response");
  contains(result, "disc-fallback", "discussion id backfilled from fallback");
  contains(result, "bot-ReneCEO", "author id backfilled from account.botId");
  contains(result, "hi from test", "rich_text backfilled from request");
  assert(!result.includes("(unknown)"), "no (unknown) placeholders");
  assert(!result.includes("(no text returned)"), "no (no text returned) placeholder");
}

console.log("\n[formatCreateCommentResult] Bug 3: partial response + page-level fallback → meaningful discussion line");
{
  const partial = { object: "comment", id: "cmt-page" };
  const result = formatCreateCommentResult(partial, {
    page_id: "page-abc",
    richText: [{ type: "text", plain_text: "first comment", text: { content: "first comment" } }],
    authorId: "bot-1",
  });
  contains(result, "cmt-page", "id rendered");
  contains(result, "page-abc", "page id surfaced in discussion line (we don't know the new discussion id)");
  contains(result, "first comment", "text from fallback");
  contains(result, "bot-1", "author from fallback");
  assert(!result.includes("Discussion: (unknown)"), "no (unknown) discussion placeholder");
}

console.log("\n[formatCreateCommentResult] full response wins over fallback");
{
  const full = {
    object: "comment",
    id: "cmt-full",
    discussion_id: "disc-from-api",
    created_by: { object: "user", id: "user-from-api" },
    rich_text: [{ type: "text", plain_text: "from api", text: { content: "from api" } }],
  };
  const result = formatCreateCommentResult(full, {
    discussion_id: "disc-fallback",
    authorId: "bot-fallback",
    richText: [{ type: "text", plain_text: "from fallback", text: { content: "from fallback" } }],
  });
  contains(result, "disc-from-api", "response discussion_id preferred");
  contains(result, "user-from-api", "response author preferred");
  contains(result, "from api", "response rich_text preferred");
  assert(!result.includes("disc-fallback"), "fallback discussion not used when api provides");
  assert(!result.includes("bot-fallback"), "fallback author not used when api provides");
}

// -----------------------------------------------------------------------------
// Bug 2 regression — getCommentsForClient 404 → Read-comments capability hint
// when the underlying page IS accessible.
// -----------------------------------------------------------------------------

function mkPage(id: string): NotionPageObject {
  return {
    object: "page",
    id,
    created_time: "2025-01-01T00:00:00Z",
    last_edited_time: "2025-01-01T00:00:00Z",
    archived: false,
    parent: { type: "page_id", page_id: "parent" },
    properties: {},
    url: `https://www.notion.so/${id}`,
  };
}

console.log("\n[getCommentsForClient] Bug 2: 404 on listComments but page is accessible → capability error");
{
  const calls: string[] = [];
  const fake: GetCommentsClient = {
    async listComments(_id, _opts) {
      calls.push("listComments");
      // Mirror client.request()'s error shape: `Notion API ${status}: ${message}`
      throw new Error(
        "Notion API 404: Could not find block with ID: abc. Make sure the relevant pages and databases are shared with your integration."
      );
    },
    async getPage(id) {
      calls.push("getPage");
      return mkPage(id);
    },
  };

  let res: Awaited<ReturnType<typeof getCommentsForClient>> | null = null;
  let threw = false;
  try {
    res = await getCommentsForClient(fake, { targetId: "page-xyz" });
  } catch {
    threw = true;
  }
  assert(!threw, "helper did not rethrow when page is reachable");
  assert(res?.isError === true, "returns isError:true");
  assert(calls.includes("listComments"), "listComments was attempted");
  assert(calls.includes("getPage"), "getPage probe fired after 404");
  const text = res?.content[0]?.text ?? "";
  contains(text, "Read comments", "error surfaces the Read comments capability");
  contains(text, "notion.so/profile/integrations", "error points to the right settings URL");
  assert(!text.includes("not shared"), "does NOT parrot the misleading 'not shared' wording");
}

console.log("\n[getCommentsForClient] Bug 2: 404 AND page also inaccessible → rethrow original");
{
  const fake: GetCommentsClient = {
    async listComments(_id, _opts) {
      throw new Error("Notion API 404: Could not find block with ID: abc.");
    },
    async getPage(_id) {
      throw new Error("Notion API 404: Could not find page with ID: abc.");
    },
  };

  let threw: Error | null = null;
  try {
    await getCommentsForClient(fake, { targetId: "page-xyz" });
  } catch (e) {
    threw = e as Error;
  }
  assert(threw !== null, "rethrows the original 404 when page probe also 404s");
  assert(/^Notion API 404/.test(threw?.message ?? ""), "keeps the original Notion 404 message");
}

console.log("\n[getCommentsForClient] happy path returns grouped output");
{
  const comments: NotionCommentObject[] = [
    {
      object: "comment",
      id: "c1",
      parent: { type: "page_id", page_id: "p" },
      discussion_id: "d1",
      created_time: "2025-01-01T00:00:00Z",
      last_edited_time: "2025-01-01T00:00:00Z",
      created_by: { object: "user", id: "u1" },
      rich_text: [{ type: "text", plain_text: "hello", text: { content: "hello" } }],
    },
    {
      object: "comment",
      id: "c2",
      parent: { type: "page_id", page_id: "p" },
      discussion_id: "d1",
      created_time: "2025-01-01T00:00:01Z",
      last_edited_time: "2025-01-01T00:00:01Z",
      created_by: { object: "user", id: "u2" },
      rich_text: [{ type: "text", plain_text: "world", text: { content: "world" } }],
    },
  ];
  const fake: GetCommentsClient = {
    async listComments(_id, _opts): Promise<PaginatedList<NotionCommentObject>> {
      return { object: "list", results: comments, next_cursor: null, has_more: false };
    },
    async getPage(id) {
      return mkPage(id);
    },
  };

  const res = await getCommentsForClient(fake, { targetId: "p" });
  assert(res.isError !== true, "no error on happy path");
  const text = res.content[0]?.text ?? "";
  contains(text, "Discussion d1", "renders discussion header");
  contains(text, "hello", "renders first comment text");
  contains(text, "world", "renders second comment text");
  contains(text, "2 total", "total count matches");
}

// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
