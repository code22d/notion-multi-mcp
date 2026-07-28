# Notion API catch-up — implementation report

Date: 2026-07-28
Branch: `main`
Baseline commit: `745717b`
Commits added: `511c4bc`, `5461eab`, `f0e46e9`, `0221b00`

**API version was NOT bumped.** `src/notion/client.ts` still pins
`NOTION_VERSION = "2025-09-03"`. Everything below is a backwards-compatible
addition.

---

## 1. Summary table

### Part 1 — robustness gaps

| Item | Status | Notes |
| --- | --- | --- |
| 1.1 Honour `Retry-After` on 429 / 529 | **done** | Integer-seconds and HTTP-date forms; exponential fallback kept; 60s single-sleep and 60s total-sleep ceilings; 5 attempts for 429, 3 for 5xx |
| 1.1 Confirm 529 needs no extra branch | **done** | Confirmed. `529 >= 500` already routes it to the retry arm, and `Retry-After` is now read on both classes. Pinned by an explicit 529 test so a refactor of the status predicate can't silently drop it |
| 1.2 Persist `refresh_token` + `expires_at` | **done** | Both optional; absent behaves exactly as today |
| 1.2 Refresh path (expiry + `unauthorized`) | **done** | Proactive in `resolveAccount`, reactive in `NotionClient`, once per request |
| 1.2 Migrate existing accounts forward | **done** | No re-authorization needed — see §4.2 |
| 1.2 Never log/echo token material | **done** | `redactTokenMaterial()` on the only path that surfaces a token-endpoint body |
| 1.2 Align hardcoded `2022-06-28` | **done** | Both grants now read the shared `NOTION_VERSION` |

### Part 2 — higher value

| Item | Status | Notes |
| --- | --- | --- |
| Views: retrieve | **done** | `notion_get_view` |
| Views: delete | **done** | `notion_delete_view` |
| Views: list (per database + per data source) | **done** | `notion_list_views` |
| Views: query with pagination | **done** | `notion_query_view`; create-query → page → delete-query, cache released in `finally` |
| Comment update + delete | **done** | `notion_update_comment`, `notion_delete_comment`, with capability-hint errors |
| Multi-value filters (select/status/multi_select) | **done** | `IN (…)` / `NOT IN (…)` — see §4.3 |
| Relative date filter values | **done** | Seven bare keywords; own `FilterValue` kind so misuse errors clearly |
| `"me"` people filter value | **done** | People columns only; internal-integration caveat documented in the tool description |
| `request_status` incomplete handling | **done** | Detected in both paginators, surfaced as a leading banner |

### Part 2 — lower value

| Item | Status | Notes |
| --- | --- | --- |
| Status option groups (DDL) | **done** | Parser already read them; emitter now emits them. Old syntax unchanged |
| Tab blocks | **done** | Read and write. Markdown choice explained in §4.4 |
| File Upload API | **partial** | `single_part` fully wired. **`multi_part` (>20MB) deliberately not implemented** — see §4.5 |
| HTML blocks | **done** | `notion_create_html_block` (upload `.html` → attach via `embed.file_upload`) |
| Native icons (`type: "icon"`) | **done** | `normalizeIconInput` + `duplicate_page` clone path both round-trip; heavily tested (§4.6) |
| `filter.in_trash` on search | **done** | Merged into the filter object, not assigned over it |
| `is_archived` on data source query | **done** | Required adding `notion_query_data_source` — no tool exposed a data-source query at all |
| `is_locked` on update page | **done** | Reserved key in the flat property map, lifted onto the PATCH body |
| `is_locked` on update database | **done** | Applied to the parent database, where the field actually lives |
| List custom emojis | **done** | `notion_list_custom_emojis` |
| `agent_id` parent type | **done (verified, no code change needed)** | Both handlers already fail soft correctly. Verified and pinned with a test; comments added so the fall-through isn't mistaken for an oversight. See §4.7 |

### Minor hygiene

| Item | Status | Notes |
| --- | --- | --- |
| `notion_fetch` description mentions both domains | **done** | Also verified the parser handles `app.notion.com`, `notion.so`, `*.notion.site`, and bare UUIDs |
| `TODO(2026-03-11)` on `body.archived` | **done** | Behaviour left exactly intact |

### Not implemented (out of scope, no attempt made)

| Item | Status | Reason |
| --- | --- | --- |
| Views: `quick_filters` on create/update | **skipped** | Not in the task scope; the View DSL has no directive for it. Would need a new grammar clause |
| Views: dashboard grid layout / widget placement | **skipped** | The emitter already rejects dashboard configuration with a clear error, unchanged from before |
| Views: `position` / `placement` on create | **skipped** | Not in scope |
| File upload `multi_part` mode | **skipped** | See §4.5 — not usefully drivable from a Worker |
| File upload `external_url` mode | **skipped** | Not in scope; the client method accepts the mode but no tool exposes it |

**Nothing was blocked on the version upgrade.** Every item in the task worked
as a backwards-compatible addition on `2025-09-03`. See §6 for what remains for
the `2026-03-11` upgrade itself.

---

## 2. Files changed

`33 files changed, 4771 insertions(+), 150 deletions(-)` since `745717b`.

### Retry / transport

| File | What and why |
| --- | --- |
| `src/notion/client.ts` (+623) | `parseRetryAfterMs()`, per-class attempt counts, two sleep ceilings, `refreshAccessToken` hook, `fetchImpl`/`sleepImpl`/`nowImpl` test seams. Plus every new endpoint: views (delete/list/query×3), comments (update/delete), data-source query, custom emojis, file uploads. Plus `incompleteStatusOf()` / `describeTruncation()` / `CollectedPages` and the two paginators |

### OAuth

| File | What and why |
| --- | --- |
| `src/oauth/token.ts` (new, 202) | One implementation of the token endpoint for both grants, so the `notion-version` header and the redacting error path can't diverge. `tokenFieldsFromResponse`, `mergeTokenFields`, `isTokenExpired`, `redactTokenMaterial` |
| `src/oauth/flow.ts` (+52/-…) | Persists the full pair; delegates the code exchange to `token.ts`; drops the hardcoded `2022-06-28` |
| `src/accounts/refresh.ts` (new, 90) | Exchanges and persists. Fails soft everywhere; recovers from a lost refresh race by re-reading the store |
| `src/accounts/resolver.ts` (+28) | Proactive refresh on known expiry; `createNotionClient()` factory that wires the reactive hook |
| `src/mcp/types.ts` (+18) | Optional `refreshToken` / `expiresAt` on `NotionAccount`, with the migration contract in the doc comments |

### Views

| File | What and why |
| --- | --- |
| `src/tools/views.ts` (+300) | Four new tools; `parseViewId()`; shared `FILTER_DSL_HELP` so create and update can't document different dialects |

### View DSL

| File | What and why |
| --- | --- |
| `src/notion/view-dsl/ast.ts` (+46) | `not_in` operator; `relative_date` and `me` value kinds; `RELATIVE_DATE_VALUES`; grammar docs |
| `src/notion/view-dsl/lexer.ts` (+5) | Seven relative-date keywords and `ME` |
| `src/notion/view-dsl/parser.ts` (+72) | `NOT IN`; shared `parseInList`; relative-date and `ME` atoms |
| `src/notion/view-dsl/emit.ts` (+139) | Array forms for select/status/multi_select; relative dates on date columns only; `ME` on people columns only; type-pinning; much better misuse messages |

### Comments

| File | What and why |
| --- | --- |
| `src/tools/comments.ts` (+141) | Two tools plus `explainCommentMutationError()` — the 404-means-not-yours and 403-means-insert-capability hints |

### Databases

| File | What and why |
| --- | --- |
| `src/tools/databases.ts` (+180) | New `notion_query_data_source` (reuses the View DSL, `is_archived`, truncation reporting); `is_locked` on the parent-database PATCH |
| `src/notion/ddl/emit.ts` (+43) | Emits status option `group`; `normalizeStatusGroup()` |

### Markdown / blocks / icons

| File | What and why |
| --- | --- |
| `src/notion/icons.ts` (new, 123) | `normalizeIconInput` + `sanitizeIconForWrite` moved here so the converter can use them without depending on `tools/` |
| `src/notion/markdown/from-blocks.ts` (+96) | `renderTabs()` and `tabIconAttribute()` replacing the opaque `<!-- notion:tab -->` |
| `src/notion/markdown/to-blocks.ts` (+39) | `<tabs>` → tab block whose children are paragraphs |
| `src/tools/update-page/shared.ts` (+18/-…) | Re-exports the icon helpers from their new home; every existing import path still resolves |
| `src/tools/duplicate-move.ts` (+24) | Clone path routes `source.icon` through `sanitizeIconForWrite`; `agent_id` documented in `sourceParent` |

### Files / uploads

| File | What and why |
| --- | --- |
| `src/tools/files.ts` (new, 360) | Four tools; `buildBlob`, `guessContentType`, `explainUploadError` |
| `src/mcp/tools.ts` (+4) | Registers them |

### Flags and hygiene

| File | What and why |
| --- | --- |
| `src/tools/search.ts` (+25) | `in_trash`, merged into the existing filter object |
| `src/tools/update-page/properties.ts` (+24) | `is_locked`; `TODO(2026-03-11)` on `body.archived` |
| `src/tools/update-page/index.ts` (+14) | Schema descriptions for the reserved keys and the new icon spellings |
| `src/tools/fetch.ts` (+17) | Description names both `app.notion.com` and `notion.so` |
| `src/tools/pages.ts`, `src/tools/users.ts` (+6, +5) | Mechanical: `createNotionClient(account, ctx)` |

### Tests

| File | What |
| --- | --- |
| `test/client-retry.ts` (new, 394) | 53 cases — retry policy, no real sleeping |
| `test/oauth-tokens.ts` (new, 522) | 58 cases — token pair, migration, refresh, races, redaction |
| `test/api-surface.ts` (new, 629) | 90 cases — `request_status`, paginators, view ids, comment errors, icons, `agent_id` |
| `test/api-surface-2.ts` (new, 409) | 90 cases — tab blocks, status groups, `is_locked`, upload helpers |
| `test/view-fixtures.ts` (+271) | 46 new DSL fixtures (30 success, 16 error) |
| `package.json` | Four new test files registered in the `test` script |

---

## 3. Test evidence

### Before

```
npm test   → 460 passed, 0 failed
npm run typecheck → clean
```

(Per file: roundtrip 36, ddl 40, view 70, duplicate 42, update-page 94,
account-store 26, comments 48, bug-regressions 51, property-values 53.)

### After

Actual tail of `npm test`, one line per test file:

```
  36 passed, 0 failed          test/roundtrip.ts
=== DDL round-trip: 40 passed, 0 failed ===
=== View DSL round-trip: 116 passed, 0 failed ===     (was 70; +46 new fixtures)
=== duplicate_page: 42 passed, 0 failed ===
  94 passed, 0 failed          test/update-page-roundtrip.ts
26 passed, 0 failed            test/account-store.ts
48 passed, 0 failed            test/comments.ts
51 passed, 0 failed            test/bug-regressions.ts
53 passed, 0 failed            test/property-values.ts
53 passed, 0 failed            test/client-retry.ts        (new)
58 passed, 0 failed            test/oauth-tokens.ts        (new)
90 passed, 0 failed            test/api-surface.ts         (new)
90 passed, 0 failed            test/api-surface-2.ts       (new)
```

```
TOTAL: 797 passed, 0 failed
```

```
> notion-multi-mcp@0.1.0 typecheck
> tsc --noEmit
```

Typecheck exits clean with no output.

**460 → 797 passing (+337). 0 failing throughout. No pre-existing test was
modified or deleted** — the only edit to an existing test file was *appending*
fixtures to `test/view-fixtures.ts`.

Additional check: all 29 registered tools construct without error
(`registerAllTools` enumerated; 20 pre-existing + 9 new).

---

## 4. Design decisions and trade-offs

### 4.1 Retry ceiling and attempt count

**Attempts: 5 for 429, 3 for 5xx (unchanged).**

The two failures mean different things. When Notion returns 429 with a
`Retry-After`, it is telling us exactly when the request will succeed — waiting
and retrying is very likely to work, so extra attempts are cheap in
expectation. A 5xx carries no such promise, so its original count is kept.

**Ceilings: 60s per sleep, 60s total per request.**

A Worker cannot sleep indefinitely — the MCP client's HTTP request is held open
the whole time, and Claude Desktop / Code will time out the tool call long
before Cloudflare complains. Two independent bounds:

- **Single-sleep cap (60s)** stops a hostile or buggy `Retry-After: 86400` from
  parking a Worker for a day.
- **Total-sleep budget (60s)** stops five 30s waits from summing to 2.5
  minutes.

Exceeding either raises an error naming the advertised delay *and* the ceiling,
rather than clamping and retrying early. Clamping would be worse than failing:
retrying before the window Notion named just spends another request against the
limit we are already over, making the workspace-level contention worse for
every other connector sharing the budget.

**The trade-off, stated plainly:** a genuine 5-minute rate-limit window now
produces a clear error after ~60s instead of a 5-minute hang. That is the right
side to err on for an interactive MCP tool, but it does mean a heavily
rate-limited workspace will see errors that a long-sleeping client would have
ridden out. If that turns out to be common in practice, the total budget is a
one-line change.

**A non-obvious parsing hazard, guarded:** `Date.parse("-5")` and
`Date.parse("1.5")` both *succeed*, read as the years -5 and 1.5. Without a
guard, a malformed delta-seconds value would parse as a date two millennia away
and be requested as a sleep. Every HTTP-date form RFC 9110 permits carries a
day or month name, so `parseRetryAfterMs` requires at least one letter before
handing anything to `Date.parse`. Both cases are pinned by tests.

### 4.2 OAuth migration contract

Three rules, in decreasing order of how easy they are to get wrong:

1. **Absent `expiresAt` means "never expired."** Every record written before
   this change lacks the field, so `isTokenExpired()` returns false for all of
   them. They are never pre-emptively refreshed and behave exactly as they do
   today. **No connected account needs re-authorization.**
2. **An absent `refresh_token` in a response KEEPS the stored one.** The
   refresh grant is documented to return `refresh_token: null`. Clearing ours
   on that response would strip the account's ability to ever refresh again,
   converting a recoverable state into re-authorize-from-scratch.
3. **An absent `expires_in` CLEARS the stored expiry.** "No known expiry" is
   precisely the pre-2026 long-lived-token behaviour; carrying a stale past
   expiry forward would make every subsequent request attempt a refresh.

Both fields are spread conditionally, so an integration returning neither
writes a record byte-identical to the old shape.

**Refresh-token rotation race.** Notion rotates refresh tokens. Two concurrent
isolates that both see an expired token will both refresh, and the loser's
grant is rejected because its refresh token was already spent. On failure the
code re-reads the account from KV and adopts the winner's token. This is a
mitigation, not a lock — KV has no compare-and-swap. See §6.

### 4.3 DSL syntax for multi-value filters

**Chosen: `IN ("a", "b")` and `NOT IN ("a", "b")`.**

`IN` already existed in the grammar (it emitted `equals: [...]` for
select/status and `contains: [...]` for multi_select); `NOT IN` and the
`does_not_equal` / `does_not_contain` array forms are new.

Alternatives considered and rejected:

- **Overloading `=` with a list — `"Status" = ("a", "b")`.** Rejected because
  the grammar already uses parentheses for filter grouping
  (`("A" = "x") AND ("B" = "y")`), so `= (` is visually ambiguous with a
  compound filter and would be a genuine parser hazard.
- **A dedicated `ANY OF` / `NONE OF` keyword pair.** Reads well but adds two
  keywords to do what SQL's `IN`/`NOT IN` already say, and the sibling DDL
  parser is explicitly SQL-flavoured.

Emitted mapping:

| DSL | select / status | multi_select |
| --- | --- | --- |
| `IN (…)` | `equals: [...]` | `contains: [...]` |
| `NOT IN (…)` | `does_not_equal: [...]` | `does_not_contain: [...]` |

Single-value forms are byte-for-byte unchanged.

**Relative dates and `ME` are their own `FilterValue` kinds, not strings.**
This is the decision that earns its keep: `"Name" = TODAY` on a text column now
produces *"TODAY is a relative-date value and is only valid on DATE properties.
Quote it ('today') if you really meant the literal text."* If they were plain
strings it would emit `{rich_text: {equals: "today"}}` — a literal search for
the word "today" that matches nothing and looks like a Notion bug. Both kinds
also pin the inferred column type, so `= TODAY` resolves to `date` and
`CONTAINS ME` to `people` even with no schema resolver available.

Both are documented in the tool descriptions, including the internal-integration
caveat: `"me"` resolves to the authorizing user only for *public* integrations.
This connector is a public OAuth integration so it does resolve here, but a DSL
copied into an internal integration will silently match zero rows.

### 4.4 Markdown representation for tab blocks

**Chosen:**

```
<tabs>
  <tab icon="📋"><summary>Overview</summary>
    Content of the first tab.
  </tab>
  <tab><summary>Details</summary>
    Content of the second tab.
  </tab>
</tabs>
```

Two decisions:

**Why `<tabs>`/`<tab>` at all.** This file already renders `toggle` as
`<details><summary>` and `column_list`/`column` as
`<column-list>`/`<column>`. A tab block is the same kind of thing — a container
with labelled sections — so it gets the same treatment. Inventing a new syntax
(fenced blocks, `::: tabs` directives) would mean a second escaping and
round-trip path in a converter that already has one that works.

**Why the label is a `<summary>` child, not a `label="…"` attribute.** The
obvious `<tab label="Overview">` is wrong: a tab's label is **rich text**. An
HTML attribute can only hold a flattened string, so a bold or linked tab label
would be silently destroyed on every read — a lossy round trip in a tool whose
entire job is round-tripping. `<summary>` is exactly how this file already
carries a toggle's rich-text label, so it reuses that machinery. There is a
test asserting `**Bold** label` survives.

The icon has no rich text to lose, so it stays an attribute, spelled the same
way `normalizeIconInput` accepts (`📋`, `icon:pizza:blue`, `custom_emoji:<id>`,
`https://…`) so it parses straight back.

**The shape that is easy to get backwards:** a tab block's direct children must
be **paragraphs** — the paragraph's `rich_text` is the label, its `icon` the
icon, its `children` the content. Emitting nested `tab` children produces a 400
that reads like an unrelated schema error. The tests assert the paragraph
structure explicitly.

### 4.5 File uploads: what was deliberately not built

**`single_part` is complete. `multi_part` (>20MB) is not implemented.**

This is a Cloudflare Worker. It has no filesystem and no access to the caller's
machine, so `upload("/Users/me/report.pdf")` can never work. MCP tool arguments
are JSON, so the bytes must arrive *inside the call* — as text or base64. The
tool takes both and says plainly that it cannot read local paths, rather than
failing with a confusing "file not found".

The honest consequence: this is genuinely useful for **text artifacts** (HTML,
CSV, JSON, Markdown) and impractical for large binaries, which would have to
travel base64-encoded through the model's context window. A 20MB file is ~27MB
of base64 — far beyond any usable context. Implementing multi-part would add
chunking machinery for a path that cannot be reached from this transport. It is
skipped on purpose, and the error path names the limit instead of leaving the
user to guess.

**`sendFileUpload` deliberately bypasses `request()`.** It is the one non-JSON
endpoint: the body must be `multipart/form-data` and we must *not* set
`content-type`, because the boundary parameter comes from the FormData
serializer and an explicit header clobbers it into an opaque 400. That also
places it outside the retry/refresh machinery, which is correct — a binary body
is not safely replayable.

**HTML blocks force a `.html`/`.htm` extension.** Notion keys the HTML-block
rendering off the file *extension*, not the MIME type, so an upload named
`block.txt` with `content_type: text/html` renders as a plain attachment. That
is a wrong-looking result rather than an error, so the tool corrects it.

### 4.6 Icons — the flagged risk area

The task called this out because the `duplicate_page` null-icon bug came from
here. Two things were done and both are heavily tested:

**`normalizeIconInput` gained two spellings** — `icon:<name>[:<color>]` and
`custom_emoji:<id>`. Every pre-existing spelling is byte-for-byte unchanged,
including the three-way return (`undefined` = leave alone, `null` = clear,
object = set) that the bug turned on. Colour is only split off a trailing
`:word` when the word *is* one of Notion's ten colours, so a picker label
containing a colon isn't mangled.

**`duplicate_page` now routes `source.icon` through `sanitizeIconForWrite`**,
which strips response-only fields the write schema rejects (a custom emoji's
`name`/`url`, a native icon's presentation extras) and **returns `undefined`,
never `null`** — so `if (icon) body.icon = icon` stays safe. There is an
explicit test looping over falsy inputs asserting no `null` can reach the
request body.

**`file` icons pass through untouched.** A file icon's signed URL expires and
arguably cannot be re-attached, but `duplicate_page` has always forwarded it.
This change exists to fix native icons and custom emojis, not to broaden into
untested ground — which is exactly how the original bug happened. There is a
test pinning the pass-through so a future "improvement" is a deliberate choice.

### 4.7 `agent_id` parent — verified, no code change

Checked both places the task named, and both were already correct:

- `resolveTypesForPage` in `property-values.ts` matches only `data_source_id`
  and `database_id`, and falls through to unknown column types otherwise. An
  `agent_id` parent yields `UNKNOWN_TYPES`, not a throw. **Verified with a test**
  that also asserts no spurious `getDatabase`/`getDataSource` call is made.
- `duplicate_page`'s `sourceParent` returns `null` for anything it doesn't
  recognise, which the caller turns into a clear "pass `parent` explicitly"
  error. This is the correct answer, not a gap — there is no way to create a
  page under an agent via the public API.

Only comments were added, naming `agent_id` so a future reader doesn't mistake
the fall-through for an oversight.

### 4.8 Where the docs were ambiguous

**View query endpoint path — genuine contradiction between two official
pages.** The changelog entry for 2026-03-19 lists:

```
POST /v1/views/:view_id/query
GET  /v1/views/:view_id/query_results/:query_id
```

while the *Working with views* guide and the `create-view-query` /
`get-view-query-results` reference pages all give:

```
POST /v1/views/{view_id}/queries
GET  /v1/views/{view_id}/queries/{query_id}
```

**I implemented the `/queries` form** — three pages agree on it against the
changelog's one, and the reference pages are the more authoritative source for
paths. **This is unverified against the live API** (see §5). If it is wrong, it
is a two-line fix in `createViewQuery` / `getViewQueryResults` /
`deleteViewQuery`.

**Views API and the pinned API version.** Every views reference page shows
`Notion-Version: 2026-03-11` in its example, because that is the docs' current
default — not necessarily a requirement. Views launched 2026-03-19, *after*
`2026-03-11` shipped, and this repo's pre-existing `createView`/`updateView`
were built against `2025-09-03`. Notion normally makes new endpoints available
regardless of the version header. **Unverified** — see §5.

**`expires_in` on the refresh grant.** Notion's OpenAPI spec for the refresh
grant does *not* document an `expires_in` field. The code treats it as optional
and handles its absence as "no known expiry", which is the safe reading.

**Custom emoji by name on write.** The docs show `{ id }` as the write shape.
The pre-existing `:name:` spelling is kept because it is what a human types,
but whether Notion resolves names on write is not documented either way. The
new `custom_emoji:<id>` spelling and `notion_list_custom_emojis` (which returns
ids) give a path that is certainly correct.

---

## 5. What I could NOT verify

**No live API calls were made against any account.** Per the ground rules I
avoided `VirtualLatinos` entirely, and I did not exercise `ReneCEO` either —
every new behaviour is covered by unit tests against stubbed `fetch`, which
verifies *our* logic but not Notion's acceptance of our request shapes.

Concretely, the following compile and are unit-tested but have **not** been
confirmed against the live API:

1. **The view query endpoint paths** (`/queries` vs `/query` + `/query_results`).
   This is the single most likely thing to be wrong — see §4.8.
2. **Whether the Views endpoints work on the pinned `2025-09-03`.** Views
   launched after `2026-03-11` shipped. The pre-existing create/update code
   suggests they do, but I did not confirm it, and I did not confirm the four
   *new* view endpoints specifically.
3. **`request_status: incomplete` in the wild.** Reaching it requires a
   >10,000-row data source. The detection logic is tested against synthetic
   responses matching the documented shape; I have not seen a real one.
4. **Multi-value filter arrays being accepted by Notion.** The emitted JSON
   matches the documented shape exactly, but no live query was run.
5. **Relative date and `"me"` resolution.** `"me"` in particular is documented
   to resolve only for public integrations; I could not confirm behaviour
   either way without a live call.
6. **Tab block writes.** The paragraph-children shape follows the docs, but a
   real `POST /v1/blocks/{id}/children` with a tab block was never sent.
   This is the second most likely thing to need adjustment.
7. **HTML block rendering.** The upload-then-embed sequence follows the
   documented flow, but I did not confirm Notion renders the result as an
   interactive HTML block rather than a file attachment.
8. **File upload multipart encoding.** The FormData/no-content-type approach
   follows Notion's own guidance, but no real upload was performed.
9. **Status option `group` acceptance**, and specifically whether Notion
   accepts `"To-do"` with that exact capitalisation and hyphen on a *create*
   as well as an update.
10. **`is_locked` on the database PATCH.** Placed on the database object based
    on the endpoint's body whitelist, not on an observed successful call.
11. **The refresh grant end-to-end.** Exercised only against a stubbed token
    endpoint. The refresh-race recovery in particular has never run for real.
12. **Anything plan-gated.** Workspace-level rate limits scale to plan; I could
    not test 429 behaviour against a real limit, only against a stubbed one.

**Nothing in this report should be read as "confirmed working in production."**
The claims I am confident in are about *our* code's behaviour — parsing,
shaping, fail-soft paths, and the absence of regressions — all of which the 797
tests do cover.

---

## 6. Risks and follow-ups

### Review these most closely

1. **The `createNotionClient` refactor (13 call sites).** The largest
   blast-radius change. Each site went from `new NotionClient(account)` to
   `createNotionClient(account, ctx)`. It typechecks and the full suite passes,
   but it touches every tool. Worth a skim of the diff for a site that lost its
   `ctx`.
2. **The view query paths.** See §4.8 and §5 — a documented contradiction
   resolved by majority, not by observation.
3. **Refresh-token rotation under concurrency.** The re-read-on-failure recovery
   is a mitigation, not a lock. Cloudflare KV has no compare-and-swap, so two
   isolates refreshing simultaneously can still end up in a state where one
   token is spent. For a single-user worker this is very unlikely; if it ever
   matters, the fix is a Durable Object or a short-lived KV lease. **Note also
   that this path cannot fire at all today** — no existing account has an
   `expiresAt`, so the proactive branch is dead until an account is
   re-authorized against a post-2026-06-08 connection.
4. **The retry total-sleep budget (60s).** A deliberate call (§4.1). If the
   workspace-level rate limit turns out to hand back multi-minute
   `Retry-After` values in practice, this will surface as errors where a
   patient client would have succeeded.
5. **`sanitizeIconForWrite` in the duplicate path.** It is the previously-buggy
   area. The `undefined`-never-`null` contract is what matters; the tests pin
   it, but it deserves human eyes.

### Follow-ups worth doing

- **A live smoke test on `ReneCEO`** covering, in priority order: a view query,
  a tab-block write, an HTML block, and a multi-value filter. Roughly 20
  minutes, and it would convert most of §5 from "unverified" to "confirmed".
  I did not do this because the ground rules preferred unit tests and I judged
  a full live pass to be outside the session's remit — but it is the single
  highest-value next step.
- **`quick_filters`** on views — a real API feature with no DSL directive yet.
- **File upload `multi_part`** if a non-MCP ingestion path ever exists.
- **Custom emoji write-by-name** — confirm whether Notion resolves it, and if
  not, make `normalizeIconInput` resolve names to ids via
  `listCustomEmojis` before writing.

### Remaining for the `2026-03-11` upgrade

The version is still pinned at `2025-09-03`. Three documented breaking changes,
plus what this session left marked:

1. **`in_trash` replaces `archived`.** `archived` is removed entirely. Grep for
   `TODO(2026-03-11)` — currently one hit, in
   `src/tools/update-page/properties.ts`, where both are sent. Delete the
   `archived` line and its plumbing in `normaliseProperties`. Also audit
   `NotionPageObject.archived` and its read sites (`src/tools/fetch.ts` prints
   `Archived: …`).
2. **`position` replaces `after`** on append-block-children. Nothing in this
   repo currently sends `after`, so this may be a no-op — worth confirming
   before assuming it.
3. **`meeting_notes` replaces `transcription`.** `from-blocks.ts` already
   handles both type names in one branch, so this should survive the bump
   as-is.

Everything added this session was written against `2025-09-03` shapes and
should carry forward unchanged, with one thing to re-check: the views reference
docs are written for `2026-03-11`, so if any view request/response shape
differs between versions, the four new view tools are where it would show up.
