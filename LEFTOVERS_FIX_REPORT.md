# Leftovers — audit findings 3–6, nested `<details>`, and the stubbed-fetch blind spot

Date: 2026-07-28
Baseline: `117f04a` — 878 passing, 0 failing, typecheck clean
Pinned API version unchanged: `NOTION_VERSION = "2025-09-03"` (`src/notion/client.ts:11`)

**No live Notion calls were made in this session.** Everything below is established from
code, from Notion's request schema as vendored in this repo, or by executing the code
locally. §5 lists exactly what that leaves unproven — items 5 and 6 both have real
unproven edges and I have tried to name them precisely.

---

## 1. Item-by-item

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 1 | Tab icon escaping asymmetry (audit Finding 4) | **done** | `src/notion/markdown/from-blocks.ts:499` (encode `&` then `"`); comment on the decoder at `src/notion/markdown/to-blocks.ts:543-550` |
| 2 | Inconsistent view-id parsing (audit Finding 6) | **done for update, reasoned skip for create** | `src/tools/views.ts:268` — `updateViewHandler` now uses `parseViewId`. `createViewHandler` deliberately unchanged; see below |
| 3 | Reclassify the OAuth refresh path (audit Finding 3) | **done** | `src/accounts/refresh.ts:21-42` (header), `src/accounts/resolver.ts:62-70` (proactive branch), `NOTION_API_CATCHUP_REPORT.md` §"Correction note — 2026-07-28" |
| 4 | Document two undisclosed behaviour changes (audit Finding 5) | **done** | `src/notion/view-dsl/emit.ts:555-566` (`IN ()`), `src/notion/client.ts:241-253` (5xx sleep total), plus the same dated note |
| 5 | Nested `<details>` does not round-trip | **done** | Parser: `src/notion/markdown/to-blocks.ts:166-213, 470-508`. Create path: `src/notion/block-clone.ts:293-351`, `src/tools/pages.ts:144-166`, `src/tools/update-page/replace.ts:111`, `src/tools/update-page/content.ts:166-180` |
| 6 | Body validator behind a dev flag (§7 proposal 4) | **done** | `src/notion/client.ts:96-147` (`checkBlockBody`), `:376`, `:401` (call sites), `:1045` (flag parser), `src/accounts/resolver.ts:28`, `src/mcp/types.ts:22`, `wrangler.toml:42-60`, `README.md:107-148` |

Two things were done beyond the brief and one thing was deliberately not done — both in §6.

### Item 2 — what I actually found

The report over-generalised, as suspected. **`createViewHandler` takes no view id at all.**
Its inputs are `database_id`, `data_source_id`, `name` and `type` (`views.ts:200-203`).
`parseViewId` extracts a `?v=<id>` query parameter or a `view://` URI — neither exists in a
database URL, and a database id is not a view id. Routing create through it would have been
a no-op that implied a capability the tool doesn't have. What create *does* need is dash
stripping, which it already does (`views.ts:242-243`); there is a test pinning that.

`updateViewHandler` was the real inconsistency and is fixed. Its `view_id` schema
description now matches `notion_get_view`'s, so the accepted forms are discoverable from
the tool listing rather than only from the code.

---

## 2. Item 5 in detail

### What the parser was doing wrong

Every one of the three HTML-ish containers was found with a **non-greedy** regex:

```ts
/^<details>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)\s*<\/details>\s*$/i
/<tab(\s[^>]*)?>\s*<summary>([\s\S]*?)<\/summary>\s*([\s\S]*?)\s*<\/tab>/gi
/<column>\s*([\s\S]*?)\s*<\/column>/gi
```

Non-greedy means *stop at the first closer*. For anything that nests, that is exactly
backwards: the **outer** element closes on the **innermost** closing tag.

I reproduced all four failure modes by running the pre-fix parser locally:

| input | pre-fix output |
| --- | --- |
| 5 nested `<details>` | one toggle whose body is the literal text `<details><summary>L2</summary>…`, followed by a paragraph reading `</details></details></details></details>` — the reported bug, exactly |
| `<tabs>` inside a `<tab>` | outer tab block survives; the inner `<tabs>` becomes literal text inside it |
| `<column-list>` inside a `<column>` | the inner list's columns are **hoisted** to the outer list — a 2-column layout silently becomes a 3-column one — and `<column-list>` leaks as text |
| `<details>` inside a `<tab>` | the whole `<tabs>` structure is destroyed: `<tabs>\n<tab><summary>A</summary>` and `</tab>\n</tabs>` come out as two literal paragraphs with the toggle stranded between them |

So **yes, the other container syntaxes shared the flaw**, and they also failed *across*
families. The fourth row is a separate mechanism worth naming: the pre-processor
(`splitOnDetails`) ran over the whole document before anything else looked at it and
extracted `<details>` spans wherever they appeared — including out of the middle of a
`<tabs>` block that a different parser owned.

### How deep nesting works now

Two changes, both in `to-blocks.ts`:

1. **`findMatchingClose(source, tag, from)`** (`to-blocks.ts:166-183`) counts depth instead
   of stopping at the first closer. Its tag patterns are exact about word boundaries so
   `<tab>` cannot match `<tabs>` and `<column>` cannot match `<column-list>` — without that,
   a nested `<tabs>` inside a `<tab>` miscounts in both directions. `parseContainer`
   (`:476`) and `scanContainerItems` (`:492`) are the two shapes built on it: "this string
   is exactly one balanced element" and "walk the direct item children of a container
   body, skipping any that belong to a nested one".

2. **The pre-processor stops at the outermost container** (`splitOnContainers`,
   `to-blocks.ts:186-213`). It now carves out `<details>`, `<tabs>` **and** `<column-list>`
   spans as opaque `container_block` segments and does not descend. Parsing is left
   entirely to `tryHtmlBlock`, so each syntax has exactly one implementation, and inner
   containers are reached only by recursion through `markdownToBlocks` on the parent's
   body — which is what makes depth unbounded.

An opener that never balances, or whose closer has content after it on the same line, is
not treated as a container: the scan resumes after that opener so a later well-formed one
still lands, and the malformed one degrades to the literal-text paragraph it produced
before. A balanced span that `tryHtmlBlock` still can't parse (`<details>` with no
`<summary>`) is lexed directly rather than re-entering the pre-processor, which would
recurse forever.

The reported input now produces `toggle > toggle > toggle > toggle > toggle > paragraph`
with all six pieces of text intact and no tag anywhere in any `rich_text`.

### Round trip

`test/nested-containers.ts` drives `to-blocks → from-blocks → to-blocks` and asserts the
structure and the content are identical, and that the *markdown* is a fixed point (a second
render produces the same string). The nested `<tabs>`, nested `<column-list>` and
`<details>`-inside-`<tab>` cases each get their own structural assertions.

### The create path, and trees deeper than the write schema allows

Fixing the parser exposed the next problem: **markdown has no depth limit, Notion's request
body does.** Five nested toggles is a tier-5 body; the write schema stops carrying children
after tier 2 and stops accepting `column_list` after tier 1. Before this change,
`notion_create_pages` sent `markdownToBlocks()` output verbatim — so the *fixed* parser
would have turned a silent-mangling bug into a 400 that loses the whole page.

`appendClonedTree`/`resolvePendingChildren` already solve this for `duplicate_page` and
`apply_template`, but they operate on hydrated **response**-shape trees. Rather than write a
second implementation — which is precisely the drift that produced this bug family — I
widened the engine's input type:

- **`CloneSource`** (`block-clone.ts:52-56`) is the structural minimum the engine actually
  reads: a `type`, a body under that key, and children at `block.children`. `HydratedBlock`
  satisfies it; nothing in the engine reads `id`/`object`.
- **`liftRequestChildren`** (`block-clone.ts:320`) moves `block[type].children` up to
  `block.children`, recursively and without mutating the caller's array (the update-page
  diff planner also consumes that array).
- **`fitRequestTree`** (`block-clone.ts:349`) is the two composed, with a policy whose
  branches are unreachable for authored markdown (no `child_page`, no unwritable types, no
  synced references) and is documented as such.

Wired in at three places:

- `notion_create_pages` (`pages.ts:144-166`) — fit, create with the first 100, then
  `resolvePendingChildren` **before** appending overflow, because that resolver pairs by
  index against the page's children and that is only unambiguous while they are all the page
  holds.
- `replace_content` (`replace.ts:111`) — same seam, was `appendInChunks`.
- `update_content`'s medium path (`content.ts:166-180`) — **not** fitted. That path is one
  `after:`-anchored append and `appendClonedTree` has no `after`, so a tree too deep to fit
  in one body cannot be split without losing the anchor. It now falls back to the full path,
  which does handle deferral, using the bail-out that path already had for the 100-block cap.
  The cost is the id preservation the medium path exists for; the alternative is a 400.

Shallow content is untouched: `fitRequestTree` returns byte-identical requests (asserted),
`resolvePendingChildren` early-returns without an API call when nothing is pending, and the
"ordinary content still takes exactly one request" test pins that no extra list/append
happens.

One behaviour worth flagging because it is a **fail-soft, not a fix**: a `<column-list>`
nested inside a `<column>` cannot be deferred. A `column` must carry at least one child at
send time and its only child is the tier-illegal inner list, so the outer wrapper gives way
— the inner list is promoted to the top level with the other column's content beside it.
Content and the inner layout survive; the outer two-column arrangement does not. That is the
same "unwrap, don't drop" rule the clone path already applies to a below-minimum
`column_list`. It is asserted explicitly rather than left to be discovered.

### The deferral machinery has still never met the live API

`TAB_DUPLICATE_FIX_REPORT.md` §6.3 flagged that `appendClonedTree`'s follow-up appends had
never run against Notion, because until now no input could produce a tree deep enough.
**That is still true, and it is now reachable from ordinary user input** — five nested
`<details>` in a `notion_create_pages` call. This is the single most valuable thing for a
live smoke test to exercise.

---

## 3. Item 6 in detail

### The flag

`VALIDATE_BLOCK_BODIES`. Parsed by `validateBlockBodiesEnabled` (`client.ts:1045`), read by
`createNotionClient` (`resolver.ts:28`), declared on `Env` (`types.ts:22`), documented in
`README.md:107-148` and `wrangler.toml:42-60`.

On: `"1"`, `"true"`, `"yes"`, `"on"` (case-insensitive, trimmed). **Everything else is
off** — unset, `""`, `"0"`, `"false"`, a typo, a non-string. A misspelling in `wrangler.toml`
leaves production as it is rather than quietly enabling a diagnostic.

### What is validated

Exactly the two methods that carry blocks:

- `createPage(body)` (`client.ts:376`) — `notion_create_pages`, `duplicate_page`
- `appendBlockChildren(blockId, body)` (`client.ts:401`) — every append path

`checkBlockBody` reads `body.children` and returns immediately if it is absent, so a
property-only `createPage` or a `{after}` append does nothing at all. When present it runs
`validateBlockRequestTree` from `block-write-schema.ts` — the same table and the same
validator the tests use.

### Proof it cannot throw or change production behaviour

- **Cannot throw.** The whole body of `checkBlockBody` is inside one `try { … } catch {}`
  (`client.ts:127-146`). That catch covers the validator *and* the log sink. A test asserts
  it: with a `logImpl` that throws unconditionally, `appendBlockChildren` does not throw and
  the request still goes out.
- **Cannot suppress a request.** `checkBlockBody` returns `void` and is called as a
  statement immediately before `this.request(...)`. There is no branch in which its result
  affects whether or what is sent. Tests assert the body arrives at `fetchImpl`
  byte-for-byte, both with the flag on and off.
- **Cannot mutate.** `validateBlockRequestTree` is a pure read; the body object is never
  reassigned. The byte-for-byte assertion covers this too.
- **Off by default.** `validateBlockBodies` defaults to `opts.validateBlockBodies === true`,
  i.e. `false`. With it off the cost is one boolean test on two methods and nothing else
  runs. The `VALIDATE_BLOCK_BODIES unset ⇒ no log, request unchanged` test pins it.

### What the log line looks like

```
[notion-multi-mcp] VALIDATE_BLOCK_BODIES: appendBlockChildren would send 1 block(s) Notion's write schema rejects. Sending anyway.
  children[0]: `tab.children` is required by the write schema but is absent
```

Path, block type, violation. Capped at 20 problems with an `… and N more` tail so one
malformed 100-block body can't bury the console. Default sink is `console.warn` — the first
`console.*` in `src/`, added deliberately and at one site only.

**It cannot emit sensitive material.** The validator's messages are assembled from block
type names, field names, tier numbers and array indices — never from values. A test drives a
create carrying a secret page title, secret body text, a signed media URL and the account's
access token, and asserts none of the four appears in the log while the real defects still
do.

---

## 4. Test evidence

### Before

```
TOTAL: 878 passed, 0 failed
```
`npm run typecheck` — clean, exit 0.

### After

```
  36 passed, 0 failed                       (roundtrip)
=== DDL round-trip: 40 passed, 0 failed ===
=== View DSL round-trip: 116 passed, 0 failed ===
=== duplicate_page: 45 passed, 0 failed ===
  94 passed, 0 failed                       (update-page round-trip)
26 passed, 0 failed                         (account store)
48 passed, 0 failed                         (comments)
51 passed, 0 failed                         (bug regressions)
53 passed, 0 failed                         (property values)
61 passed, 0 failed                         (client retry)
58 passed, 0 failed                         (oauth tokens)
90 passed, 0 failed                         (api surface)
90 passed, 0 failed                         (api surface 2)
=== block write schema: 70 passed, 0 failed ===
=== nested containers: 47 passed, 0 failed ===
=== handler wiring: 68 passed, 0 failed ===

TOTAL: 993 passed, 0 failed
```
`npm test` exit 0. `npm run typecheck` — clean, exit 0.

**878 → 993 (+115).** No pre-existing test was modified, weakened, skipped or removed —
every one of the fourteen original counts above is identical to the baseline. Both new
files are registered in `package.json`'s `test` script.

### What the new tests assert

**`test/nested-containers.ts` (47)**

- The exact reported input produces five nested toggles and one body paragraph — asserted as
  a type chain and a text sequence, plus a negative assertion that no `</details>` or
  `<summary>` appears in any `rich_text` (the visible symptom of the bug).
- `to-blocks → from-blocks → to-blocks` preserves structure and content, and the markdown is
  a fixed point.
- Nested `<tabs>` stays a tab block rather than literal text; nested `<column-list>` keeps
  its own two columns rather than hoisting them; `<details>` inside `<tab>` is parsed by the
  tab rather than stolen by the pre-processor.
- An unbalanced `<details>` does not swallow the rest of the document.
- **Tab icon (item 1):** an external icon URL containing `&amp;`, `&` and `"` survives
  `from-blocks → to-blocks` byte-for-byte, and again on a second pass. Asserts the encoder
  actually emits `&amp;amp;` and does *not* emit a bare `&`.
- `fitRequestTree` returns shallow content byte-identically with nothing pending; splits the
  five-toggle chain into bodies that all pass `validateBlockRequestTree`; and every one of
  the six content markers arrives across the split requests (driven through a recording
  client that materialises inline children the way Notion does, so the deferral resolver's
  walk is really exercised).
- The nested-`column_list` unwrap is asserted for what it is, including that no content is
  lost.

**`test/handler-wiring.ts` (68)** — these go in through `register(def)` with a real
`ToolContext`, stubbing only `globalThis.fetch` and KV. That is the seam where "the helper
is right but nobody called it" shows up, which is the shape of item 2.

- `notion_update_view` given a pasted `notion.so/...?v=<dashed uuid>&pvs=4` sends
  `PATCH /v1/views/<bare id>` — and the `view://`, dashed and bare forms all normalise to the
  same id.
- `notion_create_view` takes no view id; asserts its two ids are dash-stripped, with the
  reasoning in a comment so the next reader doesn't re-open the question.
- `notion_create_pages` with the five-level chain: more than one request went out
  (deferral engaged), **every** emitted body passes `validateBlockRequestTree`, and all six
  markers appear on the wire. Ordinary content still takes exactly one request with exactly
  the converter's children.
- `replace_content` with the same input: same assertions.
- `validateBlockBodiesEnabled` — five on-spellings, nine off-spellings including `undefined`,
  `""`, `"0"`, `"maybe"`, a number and an object.
- Flag off ⇒ nothing logged and the body reaches `fetchImpl` unmodified.
- Flag on ⇒ one log line naming the flag, the operation, the path and the violation; request
  still sent; body still unmodified.
- Flag on ⇒ no page title, body text, media URL or access token in the log, while the real
  defects are named.
- A log sink that throws does not break the request.
- A childless `createPage` is silent.
- The env var reaches the client through the real `createNotionClient` + `ToolContext`,
  logging to the real `console.warn` — and a well-formed create body containing a table,
  a tab block and the five-deep chain logs nothing (a validator that cries wolf is one people
  learn to ignore).

---

## 5. What remains unverified without a live call

Stated plainly. Items 5 and 6 are where the exposure is.

1. **The deferral machinery has still never run against Notion.** This is the big one.
   `TAB_DUPLICATE_FIX_REPORT.md` §6.3 noted it and said no input could reach it; that is no
   longer true. A five-level `<details>` chain through `notion_create_pages` now issues a
   `POST /v1/pages`, then a `GET /v1/blocks/{id}/children` at each level down to the deferral
   point, then a `PATCH .../children`. Everything about that sequence — that the append is
   accepted, that listing a just-created block returns its inline children, that they come
   back in request order — is modelled by a stub I wrote and confirmed by nothing. If the
   ordering assumption is wrong the failure mode is content attached to the wrong block, not
   a rejected request. **Test this first.**
2. **Whether Notion's real tier limits match the table.** Unchanged from the previous
   report: `block-write-schema.ts` is a transcription of generated types. If the server is
   more lenient I defer more than necessary (extra API calls, not incorrectness); if it is
   stricter somewhere, a body I call valid is refused.
3. **Whether the validator's verdicts match Notion's.** Item 6 inherits (2) entirely. A
   false positive costs a log line — that is the whole design — but a false *negative* means
   the flag gives false confidence. It cannot catch anything the table doesn't know about.
4. **Whether `console.warn` output actually surfaces in `wrangler tail`/`wrangler dev`.**
   `[observability] enabled = true` is set in `wrangler.toml` and the log sink is a plain
   `console.warn`, but I have not run `wrangler dev` and cannot confirm the line appears
   where the README says it will. Cheap to check; nothing depends on it but the feature's
   usefulness.
5. **`notion_update_view` with a pasted URL against the real API.** The id normalisation is
   asserted against the outgoing URL, so the client-side half is proven. That Notion accepts
   that id for a view PATCH is the same assumption the other four view tools already make.
6. **The tab-icon fix on a real external icon.** The round trip is proven through both
   converters; that Notion returns an `external` tab icon whose URL contains `&amp;` is
   hypothetical, which is why this was a near-zero-impact finding to begin with.
7. **Everything `NOTION_API_VERIFY_REPORT.md` §6 and `TAB_DUPLICATE_FIX_REPORT.md` §6 still
   list** is unchanged by this session — in particular Finding 2 (`notion_query_view` may be
   gated on `2026-03-11`), which still needs one live call and is the highest-value check
   after item 1 above.

---

## 6. What I did beyond the brief, and what I chose not to do

### Done beyond the brief (both small, both the same seam as item 5)

- **`replace_content` gets the same depth handling** (`replace.ts:111`). It is the other
  place authored markdown is sent verbatim, it had the identical hole, and the fix is the
  same one line. Leaving it broken while fixing create would have been an odd place to stop.
- **`update_content`'s medium path bails to the full path when the tree is too deep**
  (`content.ts:171`). Not a fix so much as a refusal to send a body I know Notion rejects,
  reusing the fallback that path already had.

### Not done, with reasons

- **`createViewHandler` was not routed through `parseViewId`.** It has no view id. Detailed
  in §1. The report over-generalised; forcing the helper in would have implied a capability
  the tool doesn't have.
- **The `after:`-anchored append was not taught to defer.** `appendClonedTree` appends at the
  end; there is no way to preserve an `after:` anchor across a split without a design for
  positional inserts that Notion's `2026-03-11` `position` parameter would change anyway.
  Falling back to the full path is the honest answer today.
- **The validator was not made to run in tests by default.** It would have been easy to
  switch it on for the whole suite, and tempting. I didn't: `test/block-write-schema.ts` and
  the two new files already assert emitted bodies explicitly, and a globally-on validator
  that only logs would add noise no assertion depends on — the opposite of the "real
  assertions with real seams" the rest of the suite is built on. The flag's purpose is the
  *live* gap, which tests structurally cannot reach.
- **`block-write-schema.ts` is still a transcription, not generated** (§7 proposal 5 of the
  tab report). Out of scope here, and still the right call only if the SDK stays a
  devDependency with a stable type layout.
- **No `NOTION_VERSION` bump, no push, no deploy.**
