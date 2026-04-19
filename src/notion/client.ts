// -----------------------------------------------------------------------------
// Thin wrapper around the Notion REST API. One instance per tool invocation —
// bound to a specific account's access token. Handles auth headers, error
// translation, and a small retry on 429/5xx.
// -----------------------------------------------------------------------------

import type { NotionAccount } from "../mcp/types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2025-09-03";

export class NotionClient {
  constructor(private readonly account: NotionAccount) {}

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

    // Simple retry for 429 and 5xx
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url.toString(), { method, headers, body });
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

      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Notion API ${res.status}: ${msg}`);
        // Exponential backoff (100ms, 400ms, 900ms)
        await sleep(100 * Math.pow(attempt + 1, 2));
        continue;
      }

      // Non-retriable
      throw new Error(`Notion API ${res.status}: ${msg}`);
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
    filter?: { value: "page" | "database"; property: "object" };
    start_cursor?: string;
    page_size?: number;
  }): Promise<PaginatedList<NotionPageObject | NotionDatabaseObject>> {
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
}

export interface NotionDatabaseObject {
  object: "database";
  id: string;
  title: NotionRichText[];
  description?: NotionRichText[];
  properties: Record<string, unknown>;
  parent: { type: string; [key: string]: unknown };
  url: string;
  archived?: boolean;
  is_inline?: boolean;
  icon?: NotionIcon | null;
  cover?: NotionCover | null;
  data_sources?: Array<{ id: string; name: string }>;
}

export interface NotionDataSourceObject {
  object: "data_source";
  id: string;
  database_parent?: { database_id: string };
  name: string;
  properties: Record<string, unknown>;
}

export interface NotionBlockObject {
  object: "block";
  id: string;
  type: string;
  has_children?: boolean;
  archived?: boolean;
  [key: string]: unknown;
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

export function stripDashes(id: string): string {
  return id.replace(/-/g, "");
}

export function addDashes(id: string): string {
  const s = stripDashes(id);
  if (s.length !== 32) return id;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
