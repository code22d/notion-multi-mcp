# Phase 2–4 Roadmap

Phase 1 (read-only tools + account management + comments + moves) ships the deployable worker. Phases 2–4 fill in the write-heavy tools that depend on three converters/parsers.

## Phase 2 — Notion-flavored Markdown converter

The native Notion MCP accepts `content` as Markdown with several extensions:
- **Standard CommonMark** — headings, paragraphs, bold/italic/code, lists, tables, code blocks, blockquotes
- **Task lists** — `- [ ]` and `- [x]`
- **Callouts** — `> [!NOTE]`, `> [!WARNING]`, etc., with optional emoji
- **Toggle blocks** — `<details><summary>Title</summary>body</details>` or similar
- **Columns** — typically indicated by a custom syntax
- **Page/database references** — `<page url="...">` and `<database url="...">` tags to preserve or embed child pages
- **Synced blocks, templates, embeds, equations, dividers** — various special forms
- **Rich text inline formatting** — bold/italic/strike/underline/code combinations

**Implementation outline**:
1. `markdown/to-blocks.ts` — token-stream parser. Use a small Markdown tokenizer (marked or a hand-rolled one — CF Workers can bundle small deps). Emit a tree of Notion blocks.
2. `markdown/from-blocks.ts` — recursive renderer. Walks a block tree, emits Markdown. Handles the custom tag set in both directions.
3. Tests against a set of round-trip fixtures.

**Tools upgraded in Phase 2**:
- `notion_create_pages` — parse `content` → blocks, POST to `/v1/pages` with `children`, set properties
- `notion_update_page` — `update_properties`, `update_content` (string-diff style), `replace_content`, `apply_template`, `update_verification`
- `notion_duplicate_page` — walks blocks and re-creates under the new parent (uses block walker)

## Phase 3 — SQL DDL parser

The native MCP accepts DDL for database creation and updates. Examples from its docs:

```sql
CREATE TABLE ("Name" TITLE, "Status" SELECT('To Do':red, 'Done':green), "Due Date" DATE)
ADD COLUMN "Priority" SELECT('High':red, 'Low':green)
DROP COLUMN "Old"
RENAME COLUMN "Status" TO "Project Status"
ALTER COLUMN "Status" SET SELECT('Open':yellow, 'Done':green)
```

Types to support:
- Simple: `TITLE`, `RICH_TEXT`, `DATE`, `PEOPLE`, `CHECKBOX`, `URL`, `EMAIL`, `PHONE_NUMBER`, `STATUS`, `FILES`
- Parameterized: `SELECT('opt':color, ...)`, `MULTI_SELECT(...)`, `NUMBER FORMAT 'dollar'`, `FORMULA('expression')`
- Relational: `RELATION('ds_id')`, `RELATION('ds_id', DUAL)`, `RELATION('ds_id', DUAL 'synced_name' 'synced_id')`
- Rollup: `ROLLUP('rel_prop', 'target_prop', 'function')`
- Special: `UNIQUE_ID PREFIX 'X'`, `CREATED_TIME`, `LAST_EDITED_TIME`
- Modifiers: `COMMENT 'description text'`

**Implementation outline**:
1. `ddl/lexer.ts` — tokenizer (handles double-quoted identifiers, single-quoted strings, parens, colons, keywords)
2. `ddl/parser.ts` — recursive-descent parser emitting an AST
3. `ddl/emit-notion.ts` — AST → Notion `properties` JSON for POST/PATCH

**Tools upgraded in Phase 3**:
- `notion_create_database` — parse schema, call `/v1/databases` (POST)
- `notion_update_data_source` — parse ALTER statements, call `/v1/data_sources/{id}` (PATCH)

## Phase 4 — View DSL parser

The native MCP accepts a configuration DSL for views:

```
FILTER "Status" = "Done"
SORT BY "Created" DESC
GROUP BY "Priority"
CALENDAR BY "Due Date"
TIMELINE BY "Start" TO "End"
MAP BY "Location"
CHART column AGGREGATE SUM OF "Revenue" COLOR "#ff0000" HEIGHT 400
FORM CLOSE / OPEN / ANONYMOUS true / PERMISSIONS editor
SHOW "Name", "Status"
COVER "Image"
```

**Implementation outline**: similar lexer/parser pattern as DDL, with directive-specific AST nodes. Cloudflare Workers' CPU time budget is tight but plenty for tens of directives.

**Note on public API support**: Notion's public REST API coverage of view *creation/update* via the public API has historically been limited — as of the current Notion-Version, many view operations go through the internal (private) API. If Phase 4 hits an API wall, we document gracefully (return a clear "not supported by Notion public API yet" message) rather than silently fail.

**Tools upgraded in Phase 4**:
- `notion_create_view`, `notion_update_view`

---

## Recommended build order

1. **Phase 2 Markdown converter** — highest ROI; unlocks `create_pages` and `update_page` which are the most-used tools
2. **Phase 3 DDL parser** — second-highest ROI; unblocks database workflows
3. **Phase 4 View DSL + duplicate-page** — polish; some pieces may hit public-API limits

Each phase is its own session: fresh context, focused tests, deployable at the end.
