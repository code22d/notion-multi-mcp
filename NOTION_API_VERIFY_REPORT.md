# Notion API catch-up — independent verification

Date: 2026-07-28
Reviewer: second session, no involvement in the implementation
Base: `745717b` · Head: `8fa5374`
Working tree left untouched (`git status --porcelain` empty apart from this file).

---

## 1. Verdict

### `ship with follow-ups`

The report is substantially honest. I tried to break it and mostly failed. Every
`done` row I checked has real implementing code and a test that asserts something
meaningful — not smoke tests, not `assert(true)`. The numbers in §3 of the report
are exact: I reproduced **797 passed, 0 failed** and a clean typecheck. No
pre-existing test was deleted, weakened, skipped, or dropped from the `test`
script — all four new files are registered. The API version pin is untouched.
`src/notion/property-values.ts` was not modified at all. No token material is
logged or echoed; there is no `console.*` anywhere in `src/`.

Three things keep this off `ship it`:

1. A **429 with no `Retry-After` now sends 5 requests instead of 3**, which
   contradicts the report's own stated rationale for the attempt bump and makes
   workspace-level rate-limit contention slightly worse in exactly the case the
   change was written for (§4.1).
2. `notion_query_view` is the one feature where the "backwards-compatible on
   `2025-09-03`" premise is genuinely shaky. The report flags this as a risk;
   I checked the docs and the risk is real, not theoretical (§4.2).
3. The entire OAuth refresh mechanism is **dead code against every currently
   connected account** — both the proactive and reactive branches. The report
   discloses this for the proactive branch only.

None of these are regressions. Nothing here breaks something that works today.

---

## 2. Claim audit

### Part 1 — robustness

| Claim | Reported | Verified | Evidence |
| --- | --- | --- | --- |
| Honour `Retry-After` on 429/529 | done | **confirmed** | `src/notion/client.ts:143-186`, `parseRetryAfterMs` at `client.ts:962-999`. `test/client-retry.ts` asserts the exact observed sleep sequence: `eq(h.sleeps, [3000, 7000], "slept exactly the advertised delays, not 100/400")` |
| HTTP-date form accepted | done | **confirmed** | `client.ts:988-998`; test `[parseRetryAfterMs] HTTP-date form` pins a fixed instant, asserts 5000ms and past-date→0 |
| `Date.parse("-5")` / `"1.5"` hazard guarded | done | **confirmed** | Letter-required guard at `client.ts:990`; tests `"negative delta-seconds rejected"`, `"fractional delta-seconds rejected"` |
| Exponential fallback kept | done | **confirmed** | `client.ts:174`; test `[429] no Retry-After ⇒ original 100/400/900 curve` |
| 60s single-sleep + 60s total ceilings | done | **confirmed** | `client.ts:164-172, 177-182`; tests assert `sleeps == []` on `Retry-After: 3600`, and `[40_000]` then refusal on 40+40 |
| 5 attempts for 429, 3 for 5xx | done | **confirmed but questionable** | `client.ts:41-42, 158-160`. See Finding 1 — the extra attempts also apply when no header is present, which the report's rationale does not cover |
| 529 needs no extra branch | done | **confirmed** | `client.ts:150`; two dedicated 529 tests, including 529+`Retry-After` |
| Non-429 error handling unchanged | (implied) | **confirmed** | `client.ts:151-155` throws immediately; test loops 400/401/403/404 asserting one call, zero sleeps, and `Notion API ${status}` message shape |
| No unbounded/blocking sleep | (implied) | **confirmed** | Both ceilings enforced before `await this.sleepImpl`; `sleepImpl` seam means the suite never really sleeps |
| Persist `refresh_token` + `expires_at` | done | **confirmed** | `src/oauth/token.ts:141-153`, `src/oauth/flow.ts:130-134`. Fields spread conditionally |
| Backwards-compatible with records lacking both | done | **confirmed** | `isTokenExpired` returns `false` when `expiresAt` is not a number (`token.ts:200`). `AccountStore` round-trips the whole object as JSON (`store.ts:156`) so no schema migration exists to break. Test `[isTokenExpired] absent expiresAt ⇒ never expired (migration safety)` |
| **No existing account needs re-authorization** | done | **confirmed** | Nothing in `resolveAccount` or `NotionClient` requires `refreshToken`/`expiresAt`; both paths return null/false and fall through to today's behaviour |
| Refresh path (expiry + `unauthorized`) | done | **confirmed, but inert today** | `resolver.ts:59-62` (proactive), `client.ts:131-147` + `accounts/refresh.ts:77-90` (reactive). 4 client-level tests including the once-per-request latch and the no-hook-behaves-as-before case. See Finding 3 |
| Never log/echo token material | done | **confirmed** | `redactTokenMaterial` (`token.ts:67-72`) is on the only path that surfaces a token-endpoint body (`token.ts:100`). Grep: no `console.*` in `src/`; the only `accessToken` reads are the two `Authorization` headers |
| Align hardcoded `2022-06-28` | done | **confirmed** | `token.ts:94` uses `NOTION_VERSION`; the old literal is gone from `flow.ts` |

### Part 2 — higher value

| Claim | Reported | Verified | Evidence |
| --- | --- | --- | --- |
| Views: retrieve | done | **confirmed** | `notion_get_view`, `views.ts:87`; `client.getView` pre-existed |
| Views: delete | done | **confirmed** | `client.ts:374`; test `[deleteView] issues a DELETE and tolerates the partial response` |
| Views: list (db + data source) | done | **confirmed** | `client.ts:384-402`; test asserts the right query param per scope |
| Views: query with pagination | done | **confirmed (code) / at-risk (runtime)** | `client.ts:411-475`; 5 `queryViewAll` tests incl. cache release in `finally` and a failed release not failing the query. **Endpoint path independently confirmed correct** — see §4.2 |
| Comment update + delete | done | **confirmed** | `client.ts:462-476`, `comments.ts` `explainCommentMutationError`; 4 tests on the 404/403/passthrough/non-Error branches |
| Multi-value filters | done | **confirmed** | `view-dsl/emit.ts:435-470`; single-value forms untouched. 46 new DSL fixtures, view suite 70→116 |
| Relative date filter values | done | **confirmed** | `emit.ts:481-497, 540-547`; own `FilterValue` kind, type-pinned at `emit.ts:315-316` |
| `"me"` people filter | done | **confirmed** | `emit.ts:500-530`; rejected on non-people types with a specific message; caveat in `FILTER_DSL_HELP` (`views.ts:23-38`) |
| `request_status` incomplete handling | done | **confirmed** | `incompleteStatusOf` / `describeTruncation` (`client.ts:686-750`), wired into both paginators and surfaced as a leading banner (`databases.ts:214`, `views.ts`). Tests cover first-page and later-page detection, and local vs Notion truncation wording |

### Part 2 — lower value

| Claim | Reported | Verified | Evidence |
| --- | --- | --- | --- |
| Status option groups (DDL) | done | **confirmed** | `ddl/emit.ts:187-203`, `normalizeStatusGroup` at `:293-306`. Tests assert omitted-group sends no `group` key at all |
| Tab blocks | done | **confirmed** | `from-blocks.ts:400-490` (read), `to-blocks.ts:419-456` (write). Read/write/round-trip tests incl. `contains(md, "<summary>**Bold** label</summary>")` — the claim in §4.4 is real. **Block shape independently confirmed against Notion docs** |
| File Upload API | partial | **confirmed partial** | `client.ts:552-648`, `tools/files.ts`. `multi_part` genuinely absent; reasoning holds (see §5) |
| HTML blocks | done | **confirmed** | `files.ts:200-215`. **Embed JSON shape matches Notion's docs byte-for-byte** (`{"type":"embed","embed":{"type":"file_upload","file_upload":{"id":…}}}`) |
| Native icons round-trip | done | **confirmed** | `src/notion/icons.ts:41-123`. Every pre-existing spelling preserved; `sanitizeIconForWrite` returns `undefined` never `null`, pinned by a loop over `[null, undefined, "", 0, false]` |
| `duplicate_page` clone path | done | **confirmed** | `duplicate-move.ts:135-141` — `if (clonedIcon) body.icon = clonedIcon`. No path can assign `null`. The 2026-07 null-icon bug class is closed, not reopened |
| `filter.in_trash` on search | done | **confirmed** | `search.ts:75-80` merges rather than assigns. **Confirmed against docs**: `in_trash` is optional alongside `property`/`value`, and valid standalone — both shapes the code can emit |
| `is_archived` on data source query | done | **confirmed** | `databases.ts:200-202`. **Confirmed against docs** |
| `is_locked` on update page | done | **confirmed** | `update-page/properties.ts:69, 181-187`; 6 tests incl. "does NOT leak into the properties map". **Confirmed against docs** |
| `is_locked` on update database | done | **confirmed** | `databases.ts:207, 230`, applied on the second PATCH to the parent database. **Confirmed against docs** — `is_locked` is on `PATCH /v1/databases`, not the data source. The placement decision is right |
| List custom emojis | done | **confirmed** | `client.ts:530-540`, `files.ts:234-260`; tests assert params forwarded and absent ones omitted |
| `agent_id` parent — no code change needed | done (verified) | **confirmed** | `property-values.ts` is byte-identical to base (`git diff --stat` empty). The test stubs `getDatabase`/`getDataSource` to throw and asserts they are never called for an `agent_id` parent. That is a real assertion, not a comment |
| `notion_fetch` description | done | **confirmed** | `fetch.ts:31-33`. Parser is domain-agnostic by inspection (`fetch.ts:158-170`); no test was added, but the change is description-only |
| `TODO(2026-03-11)` on `body.archived` | done | **confirmed** | `properties.ts:62-68`; both `archived` and `in_trash` still sent, tests pin it |

### Report accuracy nits

| Claim | Status |
| --- | --- |
| "797 passed, 0 failed" | **confirmed** — reproduced exactly |
| "460 → 797 (+337)" | **confirmed** — unchanged files still total 390, view fixtures 70→116 |
| "No pre-existing test was modified or deleted" | **confirmed** — `git diff --numstat test/` shows `271 0` for `view-fixtures.ts` and `0` deletions everywhere |
| "33 files changed, 4771 insertions, 150 deletions" | **confirmed** (34/5367 including the report file itself) |
| "29 registered tools (20 pre-existing + 9 new)" | **overstated split** — base has **18** tools, head has **29**, so **11** are new. Total is right; the decomposition is wrong. Trivial, but it is the one number in the report that does not reconcile |

---

## 3. Actual test and typecheck output

```
$ npm run typecheck
> notion-multi-mcp@0.1.0 typecheck
> tsc --noEmit

(no output, exit 0)
```

```
$ npm test
  36 passed, 0 failed          test/roundtrip.ts
=== DDL round-trip: 40 passed, 0 failed ===
=== View DSL round-trip: 116 passed, 0 failed ===
=== duplicate_page: 42 passed, 0 failed ===
  94 passed, 0 failed          test/update-page-roundtrip.ts
26 passed, 0 failed            test/account-store.ts
48 passed, 0 failed            test/comments.ts
51 passed, 0 failed            test/bug-regressions.ts
53 passed, 0 failed            test/property-values.ts
53 passed, 0 failed            test/client-retry.ts
58 passed, 0 failed            test/oauth-tokens.ts
90 passed, 0 failed            test/api-surface.ts
90 passed, 0 failed            test/api-surface-2.ts
```

**Total: 797 passed, 0 failed.** Exit 0.

Registration check — `package.json` `test` script gained exactly four entries and
lost none:

```
… && tsx test/property-values.ts && tsx test/client-retry.ts && tsx test/oauth-tokens.ts
&& tsx test/api-surface.ts && tsx test/api-surface-2.ts
```

Scope-drift check: `git diff --name-only 745717b..HEAD` outside `src/`, `test/`,
`package.json` and the report → **nothing**. No `.skip`, no `.only`, no
commented-out registrations, no `@ts-ignore` / `@ts-expect-error` / `as any`
introduced anywhere in `src/`.

---

## 4. Findings, most to least serious

### Finding 1 — a persistent 429 with no `Retry-After` now costs 5 requests instead of 3

`src/notion/client.ts:41` (`MAX_ATTEMPTS_429 = 5`) combined with `client.ts:158-160`
and `:174`.

When Notion sends `Retry-After`, the report's justification is sound: we know when
the window opens, so extra attempts are cheap. But the attempt count is raised for
the whole 429 class, header or not. With no header the client now issues **5**
requests with sleeps `100, 400, 900, 1600` (3.0s) where it previously issued 3
(1.4s).

That directly contradicts the report's own reasoning three paragraphs later:

> Clamping would be worse than failing: retrying before the window Notion named
> just spends another request against the limit we are already over, making the
> workspace-level contention worse for every other connector sharing the budget.

Two extra blind retries against a workspace-level rate limit are the same
behaviour the report argues against. This is a change for the worse in precisely
the scenario (shared workspace budget, several connectors) that motivated the
work. Not a correctness bug — nothing breaks — but the policy should be
`5 attempts only when a Retry-After was present, 3 otherwise`. That is a
one-line change and the existing seams make it trivially testable.

### Finding 2 — `notion_query_view` may not work on the pinned `2025-09-03`

`src/notion/client.ts:411-475`, `src/tools/views.ts` `notion_query_view`.

I checked this independently rather than taking the report's word.

**Good news, and the report was too pessimistic about itself:** the endpoint paths
are **right**. Notion's *Working with views* guide gives verbatim:

- `POST /v1/views/{view_id}/queries`
- `GET /v1/views/{view_id}/queries/{query_id}`
- `DELETE /v1/views/{view_id}/queries/{query_id}`

The report called the path choice "the single most likely thing to be wrong." It
isn't wrong. The changelog form (`/query` + `/query_results`) is the outlier.

**Bad news:** the version question is real. The guide's info box states *"The Views
API requires API version `2025-09-03` or later"* — which covers list/retrieve/
create/update/delete. But every code example in the **query** section, and the
`create-view-query` reference page's version enum, pin `2026-03-11`. The docs draw
a visible line between view CRUD and the view query workflow.

So the report's summary line **"Nothing was blocked on the version upgrade"** is
not established for this one item. Under the task's ground rule 1 ("If you find
one that genuinely requires `2026-03-11`, do not implement it — list it under
Blocked on version upgrade"), `notion_query_view` should have been shipped as
`done, unverified — may be gated on 2026-03-11` rather than plain `done`. The
report does flag it as risk #2 and unverified item #2, so this is an
over-confident summary row rather than a concealment. The other three view tools
(get/delete/list) are explicitly covered by the `2025-09-03` floor and are fine.

**One live call settles it.** Everything else about the tool is correct.

### Finding 3 — the refresh machinery is entirely inert against every existing account

`src/accounts/refresh.ts:44`, `src/oauth/token.ts:200`, `src/accounts/resolver.ts:59`.

The report discloses that the *proactive* branch is dead ("no existing account has
an `expiresAt`"). The **reactive** branch is equally dead, and that is not stated:
`refreshAccountToken` returns `null` immediately when `!account.refreshToken`
(`refresh.ts:44`), and no account written before this change has one.

So the whole feature — ~380 lines across `token.ts`, `refresh.ts`, the
`onUnauthorized` hook, and the 13-call-site `createNotionClient` refactor — cannot
execute at all until an account is re-authorized against a post-2026-06-08
connection. It is correctly built, well tested against stubs, and completely
unexercised in production.

This is not a defect. It is the right thing to build ahead of need, and the
migration safety (which is what actually matters — no re-auth required) is
verified. But "**done**" on the refresh path row reads as "working," and the
honest status is "**implemented, unreachable until re-auth**." Worth knowing
before anyone assumes token recovery is live.

### Finding 4 — asymmetric HTML-attribute escaping on tab icons

`src/notion/markdown/from-blocks.ts:487` escapes only `"` → `&quot;` on write-out.
`src/notion/markdown/to-blocks.ts:421-422` decodes both `&quot;` **and** `&amp;` on
read-back.

An icon URL containing a literal `&amp;` (common in poorly-encoded URLs) would be
silently rewritten to `&` on the round trip. Encoding should escape `&` first, or
decoding should not handle `&amp;`. Impact is near-zero — it needs an `external`
tab icon whose URL contains that exact sequence — but it is a genuine
round-trip asymmetry in a converter whose whole job is round-tripping.

### Finding 5 — two small undocumented behaviour changes

Neither is a regression; both are absent from the report's design-decisions
section, which otherwise documents this level of detail carefully.

- **`IN ()` with an empty list now errors.** `view-dsl/emit.ts:551` — previously
  `equals: []` was emitted. Better behaviour, undocumented change.
- **A persistent 5xx now sleeps 500ms total instead of 1400ms.** The old loop slept
  after its final attempt and then threw; the new one breaks first
  (`client.ts:160`). Strictly an improvement — the trailing sleep was pure waste —
  but the report says 5xx behaviour is "unchanged from the original code," which
  is true of the attempt count and not of the sleep total.

### Finding 6 — inconsistent view-id parsing across the view tools

`views.ts:167-183` adds `parseViewId` (accepts `view://`, a URL with `?v=`, or a
bare id) and the four new tools use it. `createViewHandler` and
`updateViewHandler` still do a bare `.trim()` (`views.ts:262`). A user who pastes
a Notion URL into `notion_get_view` succeeds and into `notion_update_view` fails.
Cosmetic; pre-existing behaviour was not regressed.

---

## 5. Skipped / blocked items — does the reasoning hold?

| Item | Their reason | My read |
| --- | --- | --- |
| File upload `multi_part` | "Not usefully drivable from a Worker" | **Holds, and it is the right call.** MCP tool args are JSON; a 20MB file is ~27MB of base64 through the model's context. The chunking machinery would serve a path that cannot be reached from this transport. The `413` error message names the limit and says multi-part is not implemented, which is the correct failure mode |
| File upload `external_url` | "Not in scope; client method accepts the mode, no tool exposes it" | **Holds.** Client method is a two-line surface, no dead complexity |
| Views `quick_filters` | "No DSL directive; would need a new grammar clause" | **Holds.** Correctly listed as a follow-up rather than half-built |
| Views dashboard grid / `position` / `placement` | "Not in scope" | **Holds.** The emitter's pre-existing dashboard rejection is unchanged |
| "Nothing was blocked on the version upgrade" | — | **Push back.** See Finding 2. True for everything except `notion_query_view`, where the docs' query examples all pin `2026-03-11` |
| §5 "no live API calls were made" | — | **Consistent with what I can see.** There is no evidence of live calls anywhere in the diff, and nothing in the report claims a live verification it did not do. The `notion_fetch` row says the parser was "verified" for `app.notion.com` — that verification is by code inspection (the parser pulls a trailing 32-hex id from the last path segment and is domain-agnostic), and the task prompt itself had already stated it was verified live. Not an inflated claim |

The report's §5 list of twelve unverifiable items is accurate and, if anything,
harder on itself than warranted — item 1 (the view query paths) turns out to be
correct, and items relating to `is_locked`, `in_trash`, `is_archived`, the HTML
embed shape and the tab-block child shape I was able to confirm from the docs
without a live call.

---

## 6. What a human should look at, in priority order

1. **One live `notion_query_view` call on `ReneCEO`.** Settles Finding 2. If it
   400s on `2025-09-03`, the tool needs to be marked blocked and pulled from
   registration until the version bump. ~2 minutes. Highest value by a wide
   margin.
2. **Decide the 429 attempt policy** (Finding 1). Recommend: 5 attempts only when
   a `Retry-After` was present, 3 otherwise. One line in `client.ts:158`.
3. **One live `duplicate_page` on a page with a native (`type: "icon"`) icon.**
   This is the previously-buggy area. The unit tests are genuinely good and I
   found no way to get a `null` into the request body, but this bug class has bitten
   this repo before and the check is cheap.
4. **One live tab-block write.** The paragraph-children shape is confirmed against
   the docs, but it is the second-most-likely thing to need adjustment and it is
   the only new *write* path with a non-obvious body shape.
5. **Reclassify the refresh path** (Finding 3) so nobody assumes token recovery is
   live. Optionally force a re-auth of `ReneCEO` to actually exercise it once.
6. **Skim the `createNotionClient` refactor.** The report calls this the largest
   blast radius. I checked it mechanically: zero `new NotionClient(` call sites
   remain outside the factory itself, every migrated site passes `ctx`, and the
   suite is green. I found nothing wrong, but 13 sites is worth a human's eyes.
7. Findings 4–6 are cleanup, not blockers.

---

## Bottom line

The implementation is careful, the comments explain *why* rather than *what*, the
tests assert real behaviour with real seams instead of mocking themselves into
tautologies, and the report told the truth about what it did not verify. The
diff contains no regressions I could find: the retry change leaves non-429
handling byte-identical, token persistence is backwards-compatible and requires
no re-authorization, `property-values.ts` is untouched, and the null-icon bug
class stays closed.

The follow-ups are one policy decision, one live call, and some cleanup.
