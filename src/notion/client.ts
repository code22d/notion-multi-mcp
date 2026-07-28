// -----------------------------------------------------------------------------
// Thin wrapper around the Notion REST API. One instance per tool invocation —
// bound to a specific account's access token. Handles auth headers, error
// translation, and a small retry on 429/5xx.
// -----------------------------------------------------------------------------

import type { NotionAccount } from "../mcp/types";

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
// Attempt counts differ by class, because the two failures mean different
// things:
//   - 429 gets MAX_ATTEMPTS_429 tries. When Notion tells us exactly how long to
//     wait, sleeping that long and retrying is very likely to succeed, so extra
//     attempts are cheap in expectation.
//   - 5xx gets MAX_ATTEMPTS_5XX tries (unchanged from the original code). A
//     server error carries no promise that waiting helps.
//
// Two ceilings bound the worst case, because a Cloudflare Worker cannot sleep
// indefinitely — the MCP client's HTTP request is held open the whole time:
//   - MAX_SINGLE_SLEEP_MS caps one sleep, so a hostile or buggy Retry-After
//     (e.g. "86400") can't park a Worker for a day.
//   - MAX_TOTAL_SLEEP_MS caps the sum across all attempts of one request.
// Exceeding either is surfaced as a clear error naming the advertised delay,
// rather than silently clamping and retrying too early (which would just burn
// another request against the limit we're already over).
const MAX_ATTEMPTS_429 = 5;
const MAX_ATTEMPTS_5XX = 3;
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
}

export class NotionClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;

  constructor(private readonly account: NotionAccount, opts: NotionClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input as RequestInfo, init));
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.nowImpl = opts.nowImpl ?? (() => Date.now());
    this.onUnauthorized = opts.onUnauthorized;
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
    // Bound the loop by the larger of the two budgets; the per-class check
    // inside decides when to actually give up.
    const maxAttempts = Math.max(MAX_ATTEMPTS_429, MAX_ATTEMPTS_5XX);
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
      const attemptsForClass = isRateLimited ? MAX_ATTEMPTS_429 : MAX_ATTEMPTS_5XX;
      if (attempt >= attemptsForClass) break;

      // Prefer Notion's advertised delay; fall back to the original
      // exponential curve (100ms, 400ms, 900ms, …) when the header is absent.
      const advertised = parseRetryAfterMs(readHeader(res, "retry-after"), this.nowImpl());
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
    filter?: { value: "page" | "data_source"; property: "object" };
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

export type NotionIcon =
  | { type: "emoji"; emoji: string }
  | { type: "external"; external: { url: string } }
  | { type: "file"; file: { url: string; expiry_time?: string } }
  | { type: "custom_emoji"; custom_emoji: { id: string; name: string; url: string } };

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
