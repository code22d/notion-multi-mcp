// -----------------------------------------------------------------------------
// Thin wrapper around the Notion REST API. One instance per tool invocation —
// bound to a specific account's access token. Handles auth headers, error
// translation, and a small retry on 429/5xx.
// -----------------------------------------------------------------------------

import type { NotionAccount } from "../mcp/types";
import { describeBlockRequestProblems, validateBlockRequestTree } from "./block-write-schema";

const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2025-09-03";

// -----------------------------------------------------------------------------
// Retry policy
//
// Notion advertises a retry delay via the `Retry-After` response header on 429
// (rate_limited) and 529 (service_overload). The docs describe it as "an
// integer number of seconds (in decimal)"; we also tolerate the HTTP-date form
// that RFC 9110 permits, since a proxy in front of the API could emit it.
//
// Why this matters more than it used to: on 2026-06-16 Notion added a
// WORKSPACE-level rate limit shared across every connection into a workspace
// and scaled to plan, layered on top of the existing per-connection limit.
// Several connectors share this workspace's budget, so 429s are realistic and
// Notion's advertised delay can far exceed the old fixed 1.4s backoff ceiling.
//
// The attempt budget turns on whether the response told us WHEN to come back,
// not on the status class:
//   - A 429 carrying Retry-After gets MAX_ATTEMPTS_RETRY_AFTER tries. Notion has
//     named the moment the request will succeed, so sleeping that long and
//     retrying is very likely to work — extra attempts are cheap in expectation.
//   - Everything else retriable (5xx, and a 429 with no Retry-After) gets
//     MAX_ATTEMPTS_DEFAULT tries, the original count. Those retries are blind.
//     Raising the budget for an unheadered 429 would be self-defeating: it spends
//     extra requests against a workspace-level limit we're already over, making
//     contention worse for every other connector sharing the budget — the exact
//     failure this policy exists to soften. A 5xx carries no promise that waiting
//     helps at all.
//
// Two ceilings bound the worst case, because a Cloudflare Worker cannot sleep
// indefinitely — the MCP client's HTTP request is held open the whole time:
//   - MAX_SINGLE_SLEEP_MS caps one sleep, so a hostile or buggy Retry-After
//     (e.g. "86400") can't park a Worker for a day.
//   - MAX_TOTAL_SLEEP_MS caps the sum across all attempts of one request.
// Exceeding either is surfaced as a clear error naming the advertised delay,
// rather than silently clamping and retrying too early (which would just burn
// another request against the limit we're already over).
const MAX_ATTEMPTS_RETRY_AFTER = 5;
const MAX_ATTEMPTS_DEFAULT = 3;
const MAX_SINGLE_SLEEP_MS = 60_000;
const MAX_TOTAL_SLEEP_MS = 60_000;

/** Seams for tests — production passes neither and gets global fetch + real sleep. */
export interface NotionClientOptions {
  /** Injectable fetch. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep. Defaults to a real setTimeout. Tests record instead of waiting. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock, used only to resolve HTTP-date `Retry-After` values. */
  nowImpl?: () => number;
  /**
   * Called at most once per request when Notion answers `unauthorized`.
   * Returns a fresh access token to retry with, or null to let the original
   * error stand. Wired by createNotionClient() in accounts/resolver.ts; absent
   * in tests and in any call site that doesn't have an Env to refresh against.
   */
  onUnauthorized?: () => Promise<string | null>;
  /**
   * Dev-only: check block-carrying request bodies against the write schema and
   * LOG what Notion would reject. Off unless VALIDATE_BLOCK_BODIES is set —
   * see validateBlockBodiesEnabled() and checkBlockBody() below.
   */
  validateBlockBodies?: boolean;
  /** Injectable log sink for the above. Defaults to console.warn. */
  logImpl?: (message: string) => void;
}

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;
  private readonly validateBlockBodies: boolean;
  private readonly logImpl: ((message: string) => void) | undefined;

  constructor(private readonly account: NotionAccount, opts: NotionClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init));
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.nowImpl = opts.nowImpl ?? (() => Date.now());
    this.onUnauthorized = opts.onUnauthorized;
    this.validateBlockBodies = opts.validateBlockBodies === true;
    this.logImpl = opts.logImpl;
  }

  // -------------------------------------------------------------------
  // Dev-only request-body validation
  //
  // WHY THIS EXISTS
  //
  // Every test in this repo asserts against a stubbed `fetch`, and a stub
  // accepts any body Notion would reject. That blind spot is how
  // `{"type":"tab","tab":{}}` shipped green and 400'd in production. This hook
  // runs block-write-schema.ts's validator over the bodies we are about to
  // send, so `wrangler dev` against a real workspace catches the class the
  // suite structurally cannot.
  //
  // THREE RULES, IN ORDER OF IMPORTANCE
  //
  // 1. It LOGS, it never throws, and the request is sent either way. The
  //    validator is a transcription of generated types, not the server; if it
  //    is wrong, a false positive must cost a log line and nothing else. Even
  //    an exception thrown *inside* the validator is swallowed — a diagnostic
  //    has no business failing a working request.
  // 2. It is OFF unless the flag is set. When off, the only cost is one boolean
  //    test per create/append call and production bodies are byte-identical to
  //    what they were before this existed. Nothing here mutates `body`.
  // 3. It logs the block PATH, TYPE and VIOLATION — never the payload. The
  //    validator's messages are built from block type names, field names and
  //    tier numbers, so page text, URLs, icons and (above all) tokens cannot
  //    reach the log. Anything added to those messages later must keep that
  //    property.
  // -------------------------------------------------------------------

  /** Cap the log so a badly-formed 100-block body can't bury everything else. */
  private static readonly MAX_LOGGED_PROBLEMS = 20;

  private checkBlockBody(operation: string, body: unknown): void {
    if (!this.validateBlockBodies) return;
    try {
      const children = (body as { children?: unknown } | null | undefined)?.children;
      if (children === undefined) return;
      const problems = validateBlockRequestTree(children);
      if (problems.length === 0) return;
      const shown = problems.slice(0, NotionClient.MAX_LOGGED_PROBLEMS);
      const more =
        problems.length > shown.length ? `\n  … and ${problems.length - shown.length} more` : "";
      const log = this.logImpl ?? ((m: string) => console.warn(m));
      log(
        `[notion-multi-mcp] VALIDATE_BLOCK_BODIES: ${operation} would send ${problems.length} ` +
          `block(s) Notion's write schema rejects. Sending anyway.\n  ` +
          describeBlockRequestProblems(shown).split("\n").join("\n  ") +
          more
      );
    } catch {
      /* A diagnostic must never be the reason a request fails. */
    }
  }

  // -------------------------------------------------------------------
  // Low-level request
  // -------------------------------------------------------------------

  async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}
  ): Promise<T> {
    const method = init.method ?? "GET";
    const url = new URL(`${NOTION_API}${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.account.accessToken}`,
      "notion-version": NOTION_VERSION,
    };
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }

    // Retry 429 (rate_limited) and 5xx. HTTP 529 `service_overload` needs no
    // branch of its own: 529 >= 500, so it already lands in the 5xx arm, and
    // Notion's own docs say to "handle it the same way" as a 429 — which the
    // Retry-After path below does, since we read the header on both classes.
    let lastError: Error | null = null;
    let totalSlept = 0;
    let attempt = 0;
    // Token refresh is attempted at most once per request. Without this latch
    // a permanently-rejected token would loop: refresh, 401, refresh, 401.
    let refreshAttempted = false;
    // Bound the loop by the larger of the two budgets; the check inside decides
    // when to actually give up, based on whether a Retry-After was present.
    const maxAttempts = Math.max(MAX_ATTEMPTS_RETRY_AFTER, MAX_ATTEMPTS_DEFAULT);
    while (attempt < maxAttempts) {
      const res = await this.fetchImpl(url.toString(), { method, headers, body });
      if (res.ok) {
        return (await res.json()) as T;
      }
      // Parse error body
      const text = await res.text();
      let parsed: { code?: string; message?: string } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not json */
      }
      const msg = parsed?.message ?? text;

      // Dead access token: if the account carries a refresh token, exchange it
      // and retry this request once with the new credential. This does NOT
      // count against the retry-attempt budget — it's a different failure mode
      // from rate limiting, and a refresh that works should not eat an attempt
      // that a subsequent 429 might need.
      if (
        (res.status === 401 || parsed?.code === "unauthorized") &&
        !refreshAttempted &&
        this.onUnauthorized
      ) {
        refreshAttempted = true;
        const fresh = await this.onUnauthorized();
        if (fresh) {
          headers.authorization = `Bearer ${fresh}`;
          continue;
        }
        // Refresh not possible or rejected — fall through to today's error.
      }

      const isRateLimited = res.status === 429;
      const retriable = isRateLimited || res.status >= 500;
      if (!retriable) {
        // Non-retriable
        throw new Error(`Notion API ${res.status}: ${msg}`);
      }

      lastError = new Error(`Notion API ${res.status}: ${msg}`);
      attempt++;

      // Read the advertised delay BEFORE choosing the attempt budget — the budget
      // depends on whether Notion named a retry window, not just on the status.
      const advertised = parseRetryAfterMs(readHeader(res, "retry-after"), this.nowImpl());

      // Only a 429 that told us when to come back earns the larger budget. An
      // unheadered 429 retries blind, so it keeps the original count rather than
      // spending extra requests against a limit we're already over.
      const attemptsAllowed =
        isRateLimited && advertised !== null ? MAX_ATTEMPTS_RETRY_AFTER : MAX_ATTEMPTS_DEFAULT;
      // Break BEFORE sleeping, not after. The pre-2026-07 loop slept on its
      // final attempt and then threw, so a persistent 5xx cost 100+400+900 =
      // 1400ms of wall clock, 900ms of which bought nothing — the request was
      // already over. Breaking here makes that 100+400 = 500ms.
      //
      // BEHAVIOUR CHANGE (2026-07-28, undocumented at the time): the ATTEMPT
      // count for 5xx is unchanged at 3, which is what the catch-up report
      // meant by "unchanged"; the total sleep is not. It is strictly an
      // improvement — a Worker holding the MCP client's HTTP request open has
      // no reason to sleep after deciding to give up — but it is a visible
      // difference in how long a hard failure takes to surface, so it belongs
      // in writing rather than in the diff only.
      if (attempt >= attemptsAllowed) break;

      // Prefer Notion's advertised delay; fall back to the original
      // exponential curve (100ms, 400ms, 900ms, …) when the header is absent.
      let waitMs: number;
      if (advertised !== null) {
        if (advertised > MAX_SINGLE_SLEEP_MS) {
          throw new Error(
            `Notion API ${res.status}: ${msg} — Retry-After asked for ${Math.round(advertised / 1000)}s, ` +
              `which exceeds this client's ${MAX_SINGLE_SLEEP_MS / 1000}s single-wait ceiling. ` +
              `Retry the operation later.`
          );
        }
        waitMs = advertised;
      } else {
        waitMs = 100 * Math.pow(attempt, 2);
      }

      if (totalSlept + waitMs > MAX_TOTAL_SLEEP_MS) {
        throw new Error(
          `Notion API ${res.status}: ${msg} — retrying would exceed this client's ` +
            `${MAX_TOTAL_SLEEP_MS / 1000}s total-wait budget for one request. Retry the operation later.`
        );
      }
      totalSlept += waitMs;
      await this.sleepImpl(waitMs);
    }
    throw lastError ?? new Error("Notion API: unknown error");
  }

  // -------------------------------------------------------------------
  // Typed helpers — used by the Phase 1 tools
  // -------------------------------------------------------------------

  /** GET /v1/pages/{page_id} */
  getPage(pageId: string): Promise<NotionPageObject> {
    return this.request<NotionPageObject>(`/pages/${stripDashes(pageId)}`);
  }

  /** GET /v1/databases/{database_id} — legacy DB endpoint (pre-data-sources). */
  getDatabase(databaseId: string): Promise<NotionDatabaseObject> {
    return this.request<NotionDatabaseObject>(`/databases/${stripDashes(databaseId)}`);
  }

  /** GET /v1/data_sources/{data_source_id} */
  getDataSource(dataSourceId: string): Promise<NotionDataSourceObject> {
    return this.request<NotionDataSourceObject>(`/data_sources/${stripDashes(dataSourceId)}`);
  }

  /** GET /v1/blocks/{block_id}/children — paginated. */
  async listBlockChildren(
    blockId: string,
    opts: { startCursor?: string; pageSize?: number } = {}
  ): Promise<PaginatedList<NotionBlockObject>> {
    return this.request<PaginatedList<NotionBlockObject>>(`/blocks/${stripDashes(blockId)}/children`, {
      query: {
        start_cursor: opts.startCursor,
        page_size: opts.pageSize ?? 100,
      },
    });
  }

  /** Walks the entire child tree (one level) — handy for block → markdown conversion. */
  async listAllBlockChildren(blockId: string): Promise<NotionBlockObject[]> {
    const all: NotionBlockObject[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listBlockChildren(blockId, cursor ? { startCursor: cursor } : {});
      all.push(...page.results);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor);
    return all;
  }

  /** POST /v1/search */
  search(body: {
    query?: string;
    sort?: { direction: "ascending" | "descending"; timestamp: "last_edited_time" };
    // API 2025-09-03 renamed filter value from "database" to "data_source".
    // `in_trash` (2026-07-15) is a SEPARATE key on the same filter object, not
    // another `value` — set it to list trashed pages and data sources.
    filter?: { value?: "page" | "data_source"; property?: "object"; in_trash?: boolean };
    start_cursor?: string;
    page_size?: number;
  }): Promise<PaginatedList<NotionPageObject | NotionDatabaseObject | NotionDataSourceObject>> {
    return this.request(`/search`, { method: "POST", body });
  }

  /** GET /v1/users — paginated. */
  listUsers(opts: { startCursor?: string; pageSize?: number } = {}): Promise<PaginatedList<NotionUserObject>> {
    return this.request<PaginatedList<NotionUserObject>>(`/users`, {
      query: { start_cursor: opts.startCursor, page_size: opts.pageSize ?? 100 },
    });
  }

  /** GET /v1/users/me */
  getMe(): Promise<NotionUserObject> {
    return this.request<NotionUserObject>(`/users/me`);
  }

  /** GET /v1/users/{user_id} */
  getUser(userId: string): Promise<NotionUserObject> {
    return this.request<NotionUserObject>(`/users/${stripDashes(userId)}`);
  }

  /** GET /v1/comments?block_id=... — paginated. */
  listComments(blockId: string, opts: { startCursor?: string; pageSize?: number } = {}): Promise<PaginatedList<NotionCommentObject>> {
    return this.request<PaginatedList<NotionCommentObject>>(`/comments`, {
      query: {
        block_id: stripDashes(blockId),
        start_cursor: opts.startCursor,
        page_size: opts.pageSize ?? 100,
      },
    });
  }

  /** POST /v1/comments */
  createComment(body: unknown): Promise<NotionCommentObject> {
    return this.request<NotionCommentObject>(`/comments`, { method: "POST", body });
  }

  /** POST /v1/pages */
  createPage(body: unknown): Promise<NotionPageObject> {
    this.checkBlockBody("createPage", body);
    return this.request<NotionPageObject>(`/pages`, { method: "POST", body });
  }

  /** PATCH /v1/pages/{id} */
  updatePage(pageId: string, body: unknown): Promise<NotionPageObject> {
    return this.request<NotionPageObject>(`/pages/${stripDashes(pageId)}`, { method: "PATCH", body });
  }

  /**
   * POST /v1/pages/{id}/move — Notion's dedicated move endpoint.
   *
   * IMPORTANT: /pages/{id}/move accepts ONLY `{ parent: { page_id } }` or
   * `{ parent: { data_source_id } }`. The PATCH /pages endpoint's body
   * whitelist does NOT include `parent`, so using PATCH for moves silently
   * no-ops the parent field and returns the page with its old parent — which
   * the caller will then mistake for success. Always use this endpoint for
   * moves and post-verify with getPage if you want to be certain it took.
   */
  movePage(pageId: string, body: unknown): Promise<NotionPageObject> {
    return this.request<NotionPageObject>(`/pages/${stripDashes(pageId)}/move`, { method: "POST", body });
  }

  /** POST /v1/blocks/{parent_id}/children — append. */
  appendBlockChildren(blockId: string, body: unknown): Promise<PaginatedList<NotionBlockObject>> {
    this.checkBlockBody("appendBlockChildren", body);
    return this.request<PaginatedList<NotionBlockObject>>(`/blocks/${stripDashes(blockId)}/children`, {
      method: "PATCH",
      body,
    });
  }

  /** DELETE /v1/blocks/{id} — marks block as archived (Notion has no true delete). */
  deleteBlock(blockId: string): Promise<NotionBlockObject> {
    return this.request<NotionBlockObject>(`/blocks/${stripDashes(blockId)}`, { method: "DELETE" });
  }

  /** PATCH /v1/blocks/{id} */
  updateBlock(blockId: string, body: unknown): Promise<NotionBlockObject> {
    return this.request<NotionBlockObject>(`/blocks/${stripDashes(blockId)}`, { method: "PATCH", body });
  }

  /** POST /v1/databases — create a new database. */
  createDatabase(body: unknown): Promise<NotionDatabaseObject> {
    return this.request<NotionDatabaseObject>(`/databases`, { method: "POST", body });
  }

  /** PATCH /v1/databases/{id} — update schema on a legacy (single-source) DB. */
  updateDatabase(databaseId: string, body: unknown): Promise<NotionDatabaseObject> {
    return this.request<NotionDatabaseObject>(`/databases/${stripDashes(databaseId)}`, {
      method: "PATCH",
      body,
    });
  }

  /** POST /v1/databases/{id}/query — paginated. */
  queryDatabase(databaseId: string, body: unknown = {}): Promise<PaginatedList<NotionPageObject>> {
    return this.request<PaginatedList<NotionPageObject>>(`/databases/${stripDashes(databaseId)}/query`, {
      method: "POST",
      body,
    });
  }

  /** PATCH /v1/data_sources/{id} */
  updateDataSource(dataSourceId: string, body: unknown): Promise<NotionDataSourceObject> {
    return this.request<NotionDataSourceObject>(`/data_sources/${stripDashes(dataSourceId)}`, {
      method: "PATCH",
      body,
    });
  }

  /** POST /v1/views — create a view on a data source. */
  createView(body: unknown): Promise<NotionViewObject> {
    return this.request<NotionViewObject>(`/views`, { method: "POST", body });
  }

  /** GET /v1/views/{id} */
  getView(viewId: string): Promise<NotionViewObject> {
    return this.request<NotionViewObject>(`/views/${stripDashes(viewId)}`);
  }

  /** PATCH /v1/views/{id} */
  updateView(viewId: string, body: unknown): Promise<NotionViewObject> {
    return this.request<NotionViewObject>(`/views/${stripDashes(viewId)}`, { method: "PATCH", body });
  }

  /**
   * DELETE /v1/views/{id}
   *
   * Returns a PARTIAL view object — identity fields only (`object`, `id`,
   * `parent`, `type`). Don't expect `name` or `url` back.
   */
  deleteView(viewId: string): Promise<Partial<NotionViewObject> & { object: "view"; id: string }> {
    return this.request(`/views/${stripDashes(viewId)}`, { method: "DELETE" });
  }

  /**
   * GET /v1/views?database_id=… | ?data_source_id=…
   *
   * At least one of the two ids is required. Results are MINIMAL view
   * references (`{ object: "view", id }`) — call getView() on each id for the
   * full object.
   */
  listViews(opts: {
    databaseId?: string;
    dataSourceId?: string;
    startCursor?: string;
    pageSize?: number;
  }): Promise<PaginatedList<{ object: "view"; id: string }>> {
    return this.request(`/views`, {
      query: {
        database_id: opts.databaseId ? stripDashes(opts.databaseId) : undefined,
        data_source_id: opts.dataSourceId ? stripDashes(opts.dataSourceId) : undefined,
        start_cursor: opts.startCursor,
        page_size: opts.pageSize,
      },
    });
  }

  /**
   * POST /v1/views/{id}/queries — run the view's own filters/sorts.
   *
   * Notion caches the full result set server-side and hands back the first
   * page plus a query id. The cache expires 15 minutes after creation; paging
   * against an expired query 404s. Callers that finish early should call
   * deleteViewQuery() to release it.
   */
  createViewQuery(
    viewId: string,
    body: { page_size?: number } = {}
  ): Promise<NotionViewQueryObject> {
    return this.request<NotionViewQueryObject>(`/views/${stripDashes(viewId)}/queries`, {
      method: "POST",
      body,
    });
  }

  /** GET /v1/views/{id}/queries/{query_id} — page through a cached view query. */
  getViewQueryResults(
    viewId: string,
    queryId: string,
    opts: { startCursor?: string; pageSize?: number } = {}
  ): Promise<PaginatedList<{ object: "page"; id: string }>> {
    return this.request(`/views/${stripDashes(viewId)}/queries/${stripDashes(queryId)}`, {
      query: { start_cursor: opts.startCursor, page_size: opts.pageSize },
    });
  }

  /** DELETE /v1/views/{id}/queries/{query_id} — release the cached result set. */
  deleteViewQuery(viewId: string, queryId: string): Promise<{ deleted?: boolean }> {
    return this.request(`/views/${stripDashes(viewId)}/queries/${stripDashes(queryId)}`, {
      method: "DELETE",
    });
  }

  /**
   * Run a view's query and collect every page of results.
   *
   * Stops at `maxResults` so a 10k-row view can't blow the Worker's memory or
   * wall-clock budget, and reports BOTH truncation causes distinctly:
   *   - `incomplete` — Notion itself capped the set (request_status)
   *   - `truncatedLocally` — we stopped early at maxResults
   * Silently returning a short list for either reason is exactly the failure
   * mode the 2026-04-20 request_status change exists to prevent.
   */
  async queryViewAll(
    viewId: string,
    opts: { pageSize?: number; maxResults?: number } = {}
  ): Promise<CollectedPages<{ object: "page"; id: string }> & { totalCount?: number }> {
    const maxResults = opts.maxResults ?? 1000;
    const first = await this.createViewQuery(viewId, opts.pageSize ? { page_size: opts.pageSize } : {});
    const results: Array<{ object: "page"; id: string }> = [...(first.results ?? [])];
    let incomplete = incompleteStatusOf(first);
    let truncatedLocally = false;
    let cursor = first.has_more ? (first.next_cursor ?? undefined) : undefined;

    try {
      while (cursor && results.length < maxResults) {
        const page = await this.getViewQueryResults(viewId, first.id, {
          startCursor: cursor,
          ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
        });
        results.push(...page.results);
        incomplete = incomplete ?? incompleteStatusOf(page);
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      }
      if (cursor) truncatedLocally = true;
    } finally {
      // Best-effort cache release. A failure here is harmless — the cache
      // expires on its own after 15 minutes.
      try {
        await this.deleteViewQuery(viewId, first.id);
      } catch {
        /* ignore */
      }
    }

    return {
      results: results.slice(0, maxResults),
      incomplete,
      truncatedLocally,
      ...(typeof first.total_count === "number" ? { totalCount: first.total_count } : {}),
    };
  }

  /** PATCH /v1/comments/{id} — GA 2026-04-17. */
  updateComment(commentId: string, body: unknown): Promise<NotionCommentObject> {
    return this.request<NotionCommentObject>(`/comments/${stripDashes(commentId)}`, {
      method: "PATCH",
      body,
    });
  }

  /** DELETE /v1/comments/{id} — GA 2026-04-17. */
  deleteComment(commentId: string): Promise<unknown> {
    return this.request(`/comments/${stripDashes(commentId)}`, { method: "DELETE" });
  }

  /** POST /v1/data_sources/{id}/query — the 2025-09-03 successor to database query. */
  queryDataSource(dataSourceId: string, body: unknown = {}): Promise<PaginatedList<NotionPageObject>> {
    return this.request<PaginatedList<NotionPageObject>>(
      `/data_sources/${stripDashes(dataSourceId)}/query`,
      { method: "POST", body }
    );
  }

  /**
   * Page through a data source query, collecting rows.
   *
   * Same contract as queryViewAll(): truncation is always reported, never
   * silent. Data source queries are the other endpoint Notion caps at 10,000
   * results with a `request_status` of `incomplete`.
   */
  async queryDataSourceAll(
    dataSourceId: string,
    body: Record<string, unknown> = {},
    opts: { maxResults?: number } = {}
  ): Promise<CollectedPages<NotionPageObject>> {
    const maxResults = opts.maxResults ?? 1000;
    const results: NotionPageObject[] = [];
    let incomplete: NotionRequestStatus | null = null;
    let cursor: string | undefined;
    let truncatedLocally = false;

    do {
      const page = await this.queryDataSource(dataSourceId, {
        ...body,
        ...(cursor !== undefined ? { start_cursor: cursor } : {}),
      });
      results.push(...page.results);
      incomplete = incomplete ?? incompleteStatusOf(page);
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      if (cursor && results.length >= maxResults) {
        truncatedLocally = true;
        break;
      }
    } while (cursor);

    return { results: results.slice(0, maxResults), incomplete, truncatedLocally };
  }

  /** GET /v1/custom_emojis — cursor-paginated, optional `name` filter. */
  listCustomEmojis(
    opts: { name?: string; startCursor?: string; pageSize?: number } = {}
  ): Promise<PaginatedList<NotionCustomEmojiObject>> {
    return this.request<PaginatedList<NotionCustomEmojiObject>>(`/custom_emojis`, {
      query: {
        name: opts.name,
        start_cursor: opts.startCursor,
        page_size: opts.pageSize,
      },
    });
  }

  // -------------------------------------------------------------------
  // File Upload API
  //
  // Three-step for the common case: create → send → attach. `single_part`
  // (the default) covers everything up to 20MB, which is the only mode a
  // Worker can realistically drive — see sendFileUpload().
  // -------------------------------------------------------------------

  /** POST /v1/file_uploads — reserve an upload slot. */
  createFileUpload(body: {
    mode?: "single_part" | "multi_part" | "external_url";
    filename?: string;
    content_type?: string;
    number_of_parts?: number;
    external_url?: string;
  }): Promise<NotionFileUploadObject> {
    return this.request<NotionFileUploadObject>(`/file_uploads`, { method: "POST", body });
  }

  /** GET /v1/file_uploads/{id} — poll status (`pending` → `uploaded`). */
  getFileUpload(fileUploadId: string): Promise<NotionFileUploadObject> {
    return this.request<NotionFileUploadObject>(`/file_uploads/${stripDashes(fileUploadId)}`);
  }

  /** GET /v1/file_uploads — list prior uploads. */
  listFileUploads(
    opts: { status?: string; startCursor?: string; pageSize?: number } = {}
  ): Promise<PaginatedList<NotionFileUploadObject>> {
    return this.request<PaginatedList<NotionFileUploadObject>>(`/file_uploads`, {
      query: { status: opts.status, start_cursor: opts.startCursor, page_size: opts.pageSize },
    });
  }

  /**
   * POST /v1/file_uploads/{id}/send — push the bytes.
   *
   * Deliberately bypasses request(): this is the one endpoint that is NOT
   * JSON. The body must be multipart/form-data, and critically we must NOT
   * set content-type ourselves — the boundary parameter is generated by the
   * FormData serializer and an explicit header would clobber it, which fails
   * with an opaque 400.
   *
   * That also means this call sits outside the retry/refresh machinery in
   * request(). A binary body is not safely replayable across a stream-backed
   * FormData, so a failed send should be retried by re-driving the whole
   * upload rather than the single request.
   */
  async sendFileUpload(
    fileUploadId: string,
    file: Blob,
    opts: { filename?: string; partNumber?: number } = {}
  ): Promise<NotionFileUploadObject> {
    const form = new FormData();
    if (opts.filename !== undefined) form.append("file", file, opts.filename);
    else form.append("file", file);
    if (opts.partNumber !== undefined) form.append("part_number", String(opts.partNumber));

    const res = await this.fetchImpl(
      `${NOTION_API}/file_uploads/${stripDashes(fileUploadId)}/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.account.accessToken}`,
          "notion-version": NOTION_VERSION,
          // No content-type — FormData sets it, boundary included.
        },
        body: form,
      }
    );
    if (!res.ok) {
      const text = await res.text();
      let parsed: { message?: string } | null = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not json */
      }
      throw new Error(`Notion API ${res.status}: ${parsed?.message ?? text}`);
    }
    return (await res.json()) as NotionFileUploadObject;
  }

  /** POST /v1/file_uploads/{id}/complete — finalise a multi_part upload. */
  completeFileUpload(fileUploadId: string): Promise<NotionFileUploadObject> {
    return this.request<NotionFileUploadObject>(
      `/file_uploads/${stripDashes(fileUploadId)}/complete`,
      { method: "POST", body: {} }
    );
  }
}

// -----------------------------------------------------------------------------
// Types — loose typing; Notion's schemas are huge and we only need the shapes
// we actively touch in our converters.
// -----------------------------------------------------------------------------

export interface PaginatedList<T> {
  object: "list";
  results: T[];
  next_cursor: string | null;
  has_more: boolean;
  type?: string;
  /** See NotionRequestStatus. Present on data-source and view query responses. */
  request_status?: NotionRequestStatus;
}

/**
 * Since 2026-04-20, data source and view queries stop paginating at 10,000
 * results and say so in the response body:
 *
 *   { "request_status": { "type": "incomplete",
 *                         "incomplete_reason": "query_result_limit_reached" } }
 *
 * The dangerous part is that `has_more` goes false at the same time, so a
 * naive paginator sees a clean end-of-results and hands back a TRUNCATED set
 * that looks complete. Every paginating helper in this file therefore reports
 * the status rather than dropping it.
 */
export interface NotionRequestStatus {
  type: "complete" | "incomplete";
  /** e.g. "query_result_limit_reached". Left open — Notion may add reasons. */
  incomplete_reason?: string;
}

/** Result of a paginating helper that may have been cut short. */
export interface CollectedPages<T> {
  results: T[];
  /** Non-null when NOTION capped the result set. */
  incomplete: NotionRequestStatus | null;
  /** True when WE stopped early at the caller's maxResults. */
  truncatedLocally: boolean;
}

/**
 * Extract an `incomplete` request status from a response, or null if the
 * response is complete / doesn't carry the field at all.
 *
 * Fails soft on unknown shapes: a response from an endpoint or API version
 * that has never heard of `request_status` reads as complete, which is the
 * pre-2026-04-20 behaviour.
 */
export function incompleteStatusOf(res: unknown): NotionRequestStatus | null {
  if (!res || typeof res !== "object") return null;
  const rs = (res as { request_status?: unknown }).request_status;
  if (!rs || typeof rs !== "object") return null;
  const type = (rs as { type?: unknown }).type;
  if (type !== "incomplete") return null;
  const reason = (rs as { incomplete_reason?: unknown }).incomplete_reason;
  return {
    type: "incomplete",
    ...(typeof reason === "string" ? { incomplete_reason: reason } : {}),
  };
}

/**
 * Human-readable warning for a truncated result set. Tools append this to
 * their output so the caller sees the truncation instead of silently
 * reasoning over a partial answer.
 */
export function describeTruncation(collected: {
  incomplete: NotionRequestStatus | null;
  truncatedLocally: boolean;
  results: unknown[];
}): string | null {
  if (collected.incomplete) {
    const reason = collected.incomplete.incomplete_reason;
    if (reason === "query_result_limit_reached") {
      return (
        `⚠️ INCOMPLETE RESULTS — Notion capped this query at its 10,000-result pagination limit ` +
        `(request_status: incomplete, ${reason}). ${collected.results.length} row(s) returned. ` +
        `Narrow the filter to see the rest; do not treat this as the full set.`
      );
    }
    return (
      `⚠️ INCOMPLETE RESULTS — Notion returned request_status: incomplete` +
      `${reason ? ` (${reason})` : ""}. ${collected.results.length} row(s) returned; ` +
      `this is not the full set.`
    );
  }
  if (collected.truncatedLocally) {
    return (
      `⚠️ TRUNCATED — stopped after ${collected.results.length} row(s) at this tool's per-call cap. ` +
      `More rows exist. Narrow the filter or raise \`max_results\`.`
    );
  }
  return null;
}

export interface NotionPageObject {
  object: "page";
  id: string;
  created_time: string;
  last_edited_time: string;
  archived: boolean;
  in_trash?: boolean;
  parent: { type: string; [key: string]: unknown };
  properties: Record<string, unknown>;
  url: string;
  public_url?: string | null;
  icon?: NotionIcon | null;
  cover?: NotionCover | null;
  /** Only present on wiki-home pages. Absent / false on regular pages. */
  is_wiki_page?: boolean;
}

export interface NotionDatabaseObject {
  object: "database";
  id: string;
  title: NotionRichText[];
  description?: NotionRichText[];
  // Optional in API version 2025-09-03+ — properties moved onto data_sources.
  properties?: Record<string, unknown>;
  parent: { type: string; [key: string]: unknown };
  url: string;
  archived?: boolean;
  is_inline?: boolean;
  icon?: NotionIcon | null;
  cover?: NotionCover | null;
  // Each data-source summary under a database may carry either the legacy
  // `name` string or a 2025-09-03 `title` rich_text array. The
  // dataSourceDisplayName() helper in this file handles both.
  data_sources?: Array<{ id: string; name?: string; title?: NotionRichText[] }>;
}

export interface NotionDataSourceObject {
  object: "data_source";
  id: string;
  database_parent?: { database_id: string };
  /**
   * Legacy "name" field. API 2025-09-03 responses carry the display name under
   * `title` (as a rich_text array) instead. Both are optional here — use the
   * `dataSourceDisplayName()` helper in client-callers to pick the right one.
   */
  name?: string;
  /** API 2025-09-03 — display name as a rich_text array. */
  title?: NotionRichText[];
  properties: Record<string, unknown>;
}

/**
 * Extract the display name of a data source. Prefers the 2025-09-03 `title`
 * rich_text array, falls back to the legacy `name` string, then to a generic
 * "(untitled)" placeholder. Keep call sites short: `dataSourceDisplayName(ds)`.
 */
export function dataSourceDisplayName(
  ds: Pick<NotionDataSourceObject, "name" | "title"> | null | undefined
): string {
  if (!ds) return "(untitled)";
  if (Array.isArray(ds.title) && ds.title.length > 0) {
    const joined = ds.title.map((r) => r?.plain_text ?? "").join("").trim();
    if (joined) return joined;
  }
  if (typeof ds.name === "string" && ds.name.trim()) return ds.name;
  return "(untitled)";
}

export interface NotionBlockObject {
  object: "block";
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  [key: string]: unknown;
}

export interface NotionViewObject {
  object: "view";
  id: string;
  parent: { type: string; database_id?: string; [key: string]: unknown };
  name: string;
  type: "table" | "board" | "list" | "calendar" | "timeline" | "gallery" | "form" | "chart" | "map" | "dashboard";
  created_time: string;
  last_edited_time: string;
  url: string;
  data_source_id?: string | null;
  filter?: Record<string, unknown> | null;
  sorts?: Array<Record<string, unknown>> | null;
  configuration?: Record<string, unknown> | null;
}

/** POST /v1/views/{id}/queries response. `id` is the query id to page with. */
export interface NotionViewQueryObject {
  object: "view_query";
  id: string;
  view_id: string;
  /** ISO timestamp — the cached result set is dropped 15 minutes after creation. */
  expires_at?: string;
  total_count?: number;
  results: Array<{ object: "page"; id: string }>;
  next_cursor: string | null;
  has_more: boolean;
  request_status?: NotionRequestStatus;
}

/** GET /v1/custom_emojis result item. */
export interface NotionCustomEmojiObject {
  object: "custom_emoji";
  id: string;
  name: string;
  url: string;
}

/** File Upload object — POST/GET /v1/file_uploads. */
export interface NotionFileUploadObject {
  object: "file_upload";
  id: string;
  status: "pending" | "uploaded" | "expired" | "failed";
  filename?: string | null;
  content_type?: string | null;
  content_length?: number | null;
  upload_url?: string;
  complete_url?: string;
  expiry_time?: string | null;
}

export interface NotionUserObject {
  object: "user";
  id: string;
  type?: "person" | "bot";
  name?: string;
  avatar_url?: string | null;
  person?: { email?: string };
  bot?: unknown;
}

export interface NotionCommentObject {
  object: "comment";
  id: string;
  parent: { type: string; page_id?: string; block_id?: string };
  discussion_id: string;
  created_time: string;
  last_edited_time: string;
  created_by: { object: "user"; id: string };
  rich_text: NotionRichText[];
}

export type NotionRichText = {
  type: "text" | "mention" | "equation";
  plain_text: string;
  href?: string | null;
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  text?: { content: string; link?: { url: string } | null };
  mention?: unknown;
  equation?: { expression: string };
};

/**
 * Colours Notion accepts on a native `icon`. Defaults to "gray" when omitted.
 * Note "lightgray" is one word — not "light_gray".
 */
export const NATIVE_ICON_COLORS = [
  "gray", "lightgray", "brown", "yellow", "orange",
  "green", "blue", "purple", "pink", "red",
] as const;
export type NativeIconColor = (typeof NATIVE_ICON_COLORS)[number];

export type NotionIcon =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string; expiry_time?: string } }
  // Custom emoji: responses carry id + name + url, but a WRITE only needs id.
  // Both halves are optional here so the same type covers read and write.
  | { type: "custom_emoji"; custom_emoji: { id?: string; name?: string; url?: string } }
  // Native Notion icon (2026-03-25). Since 2026-07-01 `name` also accepts the
  // icon-picker labels shown in the UI ("star circle"), not just API names.
  | { type: "icon"; icon: { name: string; color?: NativeIconColor | string } };

export type NotionCover =
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string; expiry_time?: string } };

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Is the dev-only block-body validator switched on?
 *
 * Deliberately opt-IN and deliberately strict about what counts as on: the
 * default for anything unset, empty, misspelled or ambiguous is `false`, so a
 * typo in `wrangler.toml` leaves production exactly as it is today rather than
 * quietly enabling a diagnostic. `"0"` and `"false"` are accepted spellings of
 * off for the same reason — they are what people write when they mean off.
 */
export function validateBlockBodiesEnabled(raw: unknown): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return false;
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    default:
      return false;
  }
}

/**
 * Read a response header without assuming a full `Headers` implementation.
 * Test stubs commonly hand back a plain object for `headers`, and a
 * `Response`-shaped duck type is easier to fake than the real thing.
 */
function readHeader(res: { headers?: unknown }, name: string): string | null {
  const h = res.headers as
    | { get?: (n: string) => string | null }
    | Record<string, string>
    | undefined;
  if (!h) return null;
  if (typeof (h as { get?: unknown }).get === "function") {
    return (h as { get: (n: string) => string | null }).get(name) ?? null;
  }
  const rec = h as Record<string, string>;
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() === lower) return rec[k] ?? null;
  }
  return null;
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * Notion documents the value as "an integer number of seconds (in decimal)".
 * RFC 9110 also allows an HTTP-date, so we accept that form and resolve it
 * against `now` — a date in the past (clock skew, or a stale value) yields 0
 * rather than a negative sleep.
 *
 * Returns null when the header is absent or unparseable, which tells the
 * caller to fall back to the exponential backoff curve. Fail-soft on purpose:
 * a malformed header must not turn a retriable error into a hard failure.
 */
export function parseRetryAfterMs(raw: string | null | undefined, now: number): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // Integer seconds (the documented form). Reject anything with a sign or a
  // fractional part — those aren't valid delta-seconds and are more likely to
  // be a bug at the other end than an intentional delay.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000;
  }

  // HTTP-date form. Guard with a letter check before handing anything to
  // Date.parse: `Date.parse("-5")` and `Date.parse("1.5")` both SUCCEED, read
  // as the years -5 and 1.5, which would turn a malformed delta-seconds value
  // into a two-thousand-year sleep request. Every HTTP-date format RFC 9110
  // permits (IMF-fixdate, RFC 850, asctime) carries a day or month name, and
  // ISO-8601 carries `T`/`Z` — so requiring at least one letter admits every
  // real date form while rejecting bare numerics.
  if (!/[A-Za-z]/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

export function stripDashes(id: string): string {
  return id.replace(/-/g, "");
}

export function addDashes(id: string): string {
  const s = stripDashes(id);
  if (s.length !== 32) return id;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
