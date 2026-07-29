# Close-out — the block-id cliff, the validator, and API `2026-03-11`

Date: 2026-07-28
Baseline: `c04f07a` — 993 passing, 0 failing, typecheck clean, `NOTION_VERSION = "2025-09-03"`
Final: `c658491` — **1401 passing, 0 failing**, typecheck clean, `NOTION_VERSION = "2026-03-11"`

Three commits, one per item, in the order the brief asked for:

| commit | item |
| --- | --- |
| `e28629e` | 1 — name the cost of the full fallback, and stop hitting it on depth |
| `7d490b7` | 2 — prove `VALIDATE_BLOCK_BODIES`, and fix what proving it found |
| `c658491` | 3 — upgrade to API version `2026-03-11` |

**No live Notion calls were made in this session.** Everything below is established
from code, from the request types generated from Notion's OpenAPI spec and vendored
here as a devDependency, or by running the code locally. §7 is the live-verification
handoff and is the most important section in this document.

---

## 1. Item-by-item

| # | Item | Status | Where |
| --- | --- | --- | --- |
| 1a | Warn in the tool result when the full fallback fires | **done** | `src/tools/update-page/content.ts:211-243` (`fullFallback`), message at `:235` |
| 1b | Document the trade in README + tool description | **done** | `README.md` §"`notion_update_page` — when block ids survive"; `src/tools/pages.ts:84-90` |
| 1c | Narrow the fallback | **done, two of three triggers removed** | `src/notion/block-clone.ts:372` (`appendInChunks` takes a position), `:419` (`appendClonedTree`), `src/tools/update-page/replace.ts:46` (`replaceBlockRange` fits + defers), `src/tools/update-page/diff.ts:113,145` |
| 2 | Prove the validator through the `logImpl` seam | **done — 98 assertions** | `test/validate-block-bodies.ts` |
| 2b | Fix what proving it found | **done, 2 defects** | `src/notion/block-write-schema.ts:186` (false positive), `:341` (false negative) |
| 3a | `after` → `position` | **done** | `src/notion/client.ts:34` (`BlockPosition`), `src/notion/block-clone.ts:372-406`, `src/tools/update-page/diff.ts:54-64` |
| 3b | `archived` → `in_trash` | **done, alias still accepted** | `src/tools/update-page/properties.ts:61-66, 163, 174-179, 248`; reads at `src/tools/fetch.ts:80`, types at `src/notion/client.ts:869, 890, 938` |
| 3c | `transcription` → `meeting_notes` | **confirmed, no change needed** | `src/notion/markdown/from-blocks.ts:230-239`; asserted in `test/write-schema-vs-sdk.ts` |
| 3d | Re-derive the write-schema table against `2026-03-11` | **done — nothing changed, and it is now checked on every run** | `test/write-schema-vs-sdk.ts` (265 assertions) |
| 3e | §7 proposal 5 (generate the table from the `.d.ts`) | **done, in check form rather than generate form** | see §4.4 for the reasoning |
| — | `NOTION_VERSION` bump | **done** | `src/notion/client.ts:23` |

Nothing in the brief was left undone. Three defects beyond the brief were found and
fixed; they are in §5.

---

## 2. Item 1 — the block-ID cliff

### 2.1 What the warning now says

The full path is reached through one function, `fullFallback`
(`src/tools/update-page/content.ts:211`). Its return value is what the caller sees.
Before, it was one line naming the reason. Now:

```
Full fallback — entire page changed. Replaced page 3acde14e… content — deleted 5
existing blocks, appended 5 new blocks.

⚠️  This rewrote the whole page: every block was deleted and recreated, so block ids
were NOT preserved and any block-level comments that were attached to them are gone.
The page's content is intact — this is a structural cost, not a content loss.
update_content's fast and medium paths keep ids and comments; this edit could not use
either, for the reason above.
```

Three things it deliberately does:

- **Names the loss, not just the event.** "Content updated" reads like a success. The
  cost is discovered later, by someone looking for a comment thread.
- **Bounds it.** "Content is intact" matters: a user who reads "everything was deleted"
  and stops there will go looking for missing text that is not missing.
- **Says what would have avoided it.** The reason is already in the first line; the
  warning points back at it rather than restating it.

The same trade is now in `README.md` (a three-row table of which path preserves what,
plus the exact conditions that force the full path) and in the `notion_update_page`
tool description (`src/tools/pages.ts:84-90`), so it is visible from the tool listing
before anyone relies on id preservation.

### 2.2 Narrowing the fallback — done, and further than expected

**Decision: narrow it.** Two of the three triggers are gone. It was contained and
neither change risks correctness; the third is left, deliberately, and the warning is
the mitigation for it.

The full path had three triggers. Taking them in the order they were removed:

**(a) The reported one — insertion nested deeper than one request body can carry.**
The medium path is one positioned append, and `appendClonedTree` had no way to express
a position, so a tree needing follow-up appends could not use it. The fix is that
`appendClonedTree` now takes one and applies it to the **top-level append only**
(`block-clone.ts:419`). That is not a compromise — the follow-up appends resolve
deferred subtrees under blocks the first append just created, and those blocks hold
nothing else, so the end of them is the only place their children can go. There is no
position to lose. `replaceBlockRange` (`replace.ts:46`) now fits and defers exactly
like `replace_content` and the create path, which also removes the last write path
that was not going through the shared engine.

**(b) An edit at the top of the page.** This one is Item 3's payoff and is described in
§4.1: `position: { type: "start" }` did not exist before `2026-03-11`. There was
genuinely no way to say "put this at the beginning", which is why the old code bailed.

**(c) An insertion over 100 blocks.** *Not* narrowed, on purpose. It needs several
positioned appends in sequence, and `appendInChunks` does now walk the position forward
between chunks so the order would hold — but only if every chunk's response comes back
carrying the blocks it created. Nothing has observed that against the real API. Trading
a *correct if slightly lossy* result for an *ordering guarantee resting on an unverified
assumption* is the wrong direction, so this stays a full rewrite and the warning names
what it cost. Reasoned at `content.ts:57-66`. If the live smoke test confirms append
responses echo `results` reliably, this becomes a two-line change.

The subtree-narrowing the brief floated ("replace only the affected subtree's nearest
expressible ancestor") turned out to be unnecessary — deferral already achieves the same
outcome without any new logic, because a deferred subtree restarts at tier 1 in its own
request. There is nothing left for it to solve.

### 2.3 What `full` is left with

Exactly two triggers: **every block on the page changed** (nothing to preserve, so the
rewrite costs nothing that wasn't already gone) and **an insertion over 100 blocks**.

---

## 3. Item 2 — proving the validator

`test/validate-block-bodies.ts`, 98 assertions, every one through the client's real
seams (`logImpl` for what it says, `fetchImpl` for what actually reaches the wire).
`test/handler-wiring.ts`'s existing section is left alone: it covers the neighbouring
question of whether the env var reaches the client through a real `ToolContext` and the
real `console.warn`. The two overlap at the boundary and neither subsumes the other.

### 3.1 Every property proven

**1. Off by default.**
- Flag absent ⇒ **zero log calls** — asserted as `logs.length === 0`, not as an empty
  message, so a call that logged `""` would fail.
- The body reaching `fetchImpl` is compared **as a string** between a validating client
  and a non-validating one: byte-identical. And compared against
  `JSON.stringify(callerBody)`, so "identical to each other but both mangled" fails too.
- The comparison is only meaningful if the same body *does* log with the flag on — that
  is asserted in the same block.
- Proven for both call sites (`createPage`, `appendBlockChildren`), and for the
  early-return case (a body with no `children` is silent even with the flag on).
- The caller's object is not mutated: `JSON.stringify(body)` before and after.

**2. On when flagged.**
- On: `"1"`, `"true"`, `"yes"`, `"on"`, boolean `true`, plus case (`"TRUE"`, `"YES"`)
  and surrounding whitespace (`"  On  "`, `"1 "`, `"\ttrue\n"`).
- Off: `undefined`, `null`, `""`, `"   "`, `"0"`, `"false"`, boolean `false`, `"no"`,
  `"off"`, `"maybe"`, `"truthy"`, `1`, `0`, `{}`, `[]`, `["1"]`. Seventeen spellings.
- **Each verdict is driven all the way to the log.** A correct parser nobody reads is
  the view-id bug again, so five on-spellings and seven off-spellings go through
  `new NotionClient(...)` and the log count is asserted, along with the request still
  going out in every off case.

**3. Never throws.**
- A log sink that throws unconditionally: no exception escapes, request still sent.
- **The validator itself throwing.** `children` is a `Proxy` over a real array that
  raises on `forEach` — which `validateBlockRequestTree` walks with, and which
  `JSON.stringify` does not touch. So the throw lands strictly inside the validator,
  after the flag test and before the request. No exception escapes, the request goes
  out, the log stays quiet, and the body Notion receives is asserted to be the real one
  rather than a degraded copy.
- One honest limit, asserted rather than hidden: a body whose `children` **getter**
  throws does still throw — from `JSON.stringify` when the request is serialised. The
  test asserts it fails **identically with the flag off**, so the check adds no failure
  mode the caller did not already have. A "never throws" guarantee that quietly meant
  "throws slightly earlier" would be worth nothing.

**4. Never leaks.** A `createPage` body carrying eleven canaries — page title, body
rich_text, media caption, code content, equation expression, table-row cell, callout
icon URL, signed media URL, bookmark URL, a `child_page` title, and the account's access
token (set to `ntn_SECRETTOKENVALUE…`, i.e. genuinely token-shaped). None appears in the
log. Plus regexes for **both** of Notion's credential formats (`ntn_`, `secret_`), so a
value that isn't in the canary list can't slip through either. Meanwhile ten specific
violations *are* asserted present, with array paths — a leak test that passed because
nothing was logged at all would prove nothing.

The 20-problem cap is also pinned: 30 bad blocks ⇒ the true total (`30 block(s)`) is
stated, exactly 20 problems are spelled out, and `… and 10 more` accounts for the rest.
Truncation that silently dropped the count would read as "that's all of them".

**5. Catches the real bugs.** All three production 400s — `{"type":"tab","tab":{}}`, a
paragraph carrying `icon: null`, an image carrying a notion-hosted `file` — asserted
reported through **both** `createPage` and `appendBlockChildren`, six assertions.

**6. Doesn't cry wolf.** One well-formed create body containing a table with a row, a
tab with a paragraph carrying its own child, a two-column `column_list`, an external
image, a `file_upload` file, a `synced_block` original with children, a code block, an
equation, a breadcrumb, a table_of_contents, a divider, a heading, and a two-deep toggle
chain — every block type this repo emits, at every legal tier. Zero log output. A
validator that fires on healthy input is one people learn to ignore, which is worse
than not having one.

### 3.2 What the validator got wrong, and was fixed

Two defects, both real, both found by writing the tests rather than by inspection.

**(a) False positive — `object` (`block-write-schema.ts:186`).** `object` was in
`RESPONSE_ONLY_BLOCK_FIELDS`, so a block carrying `object: "block"` was reported as
"carries response-only field `object` — write schema rejects it". The generated request
types declare `object?: "block"` on **every** alternative of every tier union — see
`TableRowRequest`, `ColumnBlockWithChildrenRequest`, `TabItemRequestWithoutChildren`. The
write schema accepts it. Reporting a field Notion accepts is the single worst failure
mode for a diagnostic nobody can run against the real API: it teaches the reader that
the output is noise. Removed from the set, with the reason recorded at the declaration
so it isn't "helpfully" added back.

Not currently reachable from this codebase's own emitters (the clone builds
`{ type, [type]: payload }`), which is why it had never been noticed — but it is exactly
the shape a caller handing us raw blocks would produce.

**(b) False negative — media blocks with no source (`block-write-schema.ts:341`).** The
media check discriminated on `typeBody.type`. The write schema's union discriminates on
the **source key**, and `type` is optional in both arms:

```ts
type MediaContentWithFileAndCaptionRequest =
  | { external: ExternalFileRequest; type?: "external"; caption?: … }
  | { file_upload: FileUploadIdRequest; type?: "file_upload"; caption?: … };
```

So `{ "type": "image", "image": { "caption": [] } }` matches no arm, is a guaranteed
400, and the validator passed it as fine. It now checks that one of `external` /
`file_upload` is present. Same family as the three bugs the file exists for: a body the
read side produces that the write side has no case for.

---

## 4. Item 3 — API version `2026-03-11`

### 4.1 `after` → `position`

`BlockPosition` (`client.ts:34`) is written exactly as Notion's `ContentPositionSchema`
so nothing has to translate on the way out:

```ts
export type BlockPosition =
  | { type: "after_block"; after_block: { id: string } }
  | { type: "start" }
  | { type: "end" };
```

**Every touchpoint, found by grep rather than by trusting the earlier analysis.** There
was exactly one place sending `after`: `replaceBlockRange` in
`src/tools/update-page/replace.ts`. The brief was right to ask me to re-check
`block-clone.ts` and `appendClonedTree` specifically, since both were written after
that conclusion — but they did not send `after`; `appendInChunks` sent
`{ children: slice }` and nothing else. It does now carry a position, because Item 1
gave it one.

- `appendInChunks` (`block-clone.ts:372`) takes `position?: BlockPosition`, applies it
  to the first chunk, and **walks it forward** to `after_block` on the last created
  block for each subsequent chunk. Both `after_block` and `start` name a fixed spot, so
  re-using either would place chunk 2 in front of chunk 1.
- `end` is the default and is never sent, so an unpositioned append emits the same
  bytes it always did. Asserted.
- `appendClonedTree` (`:419`) and `replaceBlockRange` (`replace.ts:46`) pass it through.
- `UpdatePlan`'s medium variant (`diff.ts:54-64`) carries `position` instead of
  `afterId`.

**The payoff, and why it justified the upgrade on its own.** `position: { type: "start" }`
is a prepend. Its absence — not any design choice in this repo — was the reason
`update_content` had to rewrite a whole page whenever the edit touched the top of it.
The planner now emits a medium plan positioned at `start` (`diff.ts:145-156`), so
everything below the edit keeps its ids and its comments.

### 4.2 `archived` → `in_trash`

The `TODO(2026-03-11)` in `properties.ts` is discharged. `body.archived` is no longer
sent, and `NormalisedProps.archived` is gone.

**`archived` is still accepted as an input key**, as the brief required — it is
documented in the tool schema and removing it would break callers. It is translated
(`properties.ts:174-179`, folded in at `:248`) and never forwarded. Tracked in a
separate `archivedAlias` variable so an explicit `in_trash` **wins** when both are given
and disagree, rather than the two racing on object-key order. The tool description
(`update-page/index.ts:40-43`) now says all of that.

Read sites:

- `src/tools/fetch.ts:80` — was `Archived: …`, now `In trash: …`, reading
  `page.in_trash ?? page.archived`. The fallback is deliberate: `2026-03-11` removes
  `archived` from responses, but reporting "not in trash" for a trashed page is worse
  than three characters of defensiveness.
- `NotionPageObject`, `NotionDatabaseObject`, `NotionBlockObject`
  (`client.ts:869, 890, 938`) — `archived` replaced by `in_trash?`.
- `RESPONSE_ONLY_BLOCK_FIELDS` keeps **both** names, which is correct: it lists fields a
  *read response* might carry that must not be forwarded, and an older response can
  still carry `archived`.

Not affected, checked: `search.ts`'s `filter.in_trash` and `databases.ts`'s `in_trash`
were already on the new name. `databases.ts`'s `is_archived` is an unrelated
data-source **query** parameter (Notion 2026-07-15), not the removed field.

### 4.3 `transcription` → `meeting_notes`

Confirmed already handled, and confirmed to need nothing on the write side.

`from-blocks.ts:230-239` lists both. Worth being precise: the `default` arm renders
either identically, so the explicit cases are documentation, not behaviour. They are
kept — and now annotated — so the rename is findable by grep.

The write side needs nothing, and this is now **asserted** rather than assumed:
`test/write-schema-vs-sdk.ts` checks that neither `transcription` nor `meeting_notes`
appears in any of the three request unions at any tier. Neither has a create shape.

### 4.4 Re-deriving the write-schema table — what changed: **nothing**

This was the part most likely to bite, and the brief was right to single it out.
`block-write-schema.ts` is a hand transcription of version-dependent generated types.

**How I established it.** The vendored SDK was `@notionhq/client` 5.20.0. The upgrade
guide names v5.12.0 as the first release supporting `2026-03-11`, so 5.20.0 already
covered it — but "already covered it" is exactly the kind of claim that should not rest
on a version number. I installed 5.23.2 (latest, published 2026-07-15) into a scratch
directory, extracted the three depth-tiered request unions from both copies
programmatically, and compared:

```
in tier1 not tier2:  column_list column
in tier2 not tier3:  table
in tier2 not tier1:  (none)
in tier3 not tier2:  (none)
```

Identical between 5.20.0 and 5.23.2, and identical to what the table encodes. Same 31 /
29 / 28 alternatives, the same four types with required `children`, the same element
types for the constrained containers.

Stronger than that: the raw declaration text of all three unions is **byte-identical**
across the two SDK versions — 495 lines, `diff` clean. Plenty else moved between 5.20.0
and 5.23.2 (three minor releases; twelve `api-endpoints` files differ, plus new
`meeting-notes.d.ts` and `async-tasks.d.ts` — feature additions, not schema changes; and
`start_cursor?: string` widened to `string | null` on list block children). None of it
touched the block write schema.

**So: nothing changed. The table was correct before this session and is correct now.**

**And it is no longer taken on trust.** `test/write-schema-vs-sdk.ts` (265 assertions)
reads the `.d.ts` and checks every row on each run:

- tier membership **in both directions** — every type the SDK accepts at a tier is
  expressible per the table, and every type the table thinks is expressible is in the
  SDK's union. The second direction is what catches a stale `maxTier`.
- `children` required / optional / not accepted, per type per tier, plus a check that a
  type's requiredness is consistent across tiers (the table stores it as one flag).
- exactly four types make `children` required: `column`, `column_list`, `tab`, `table`.
- the constrained child types (`tab`→paragraph, `table`→table_row,
  `column_list`→column), verified twice: the SDK names a dedicated element type, and
  that element type really does hold the block the allow-list claims.
- `column_list`'s `childTierDelta: 0` — confirmed against `ColumnWithChildrenRequest`
  taking the tier-2 union, which is what makes a column not consume a nesting level.
- the required body fields for `code`, `equation`, `table_row`, `table`, `synced_block`.
- no unwritable type (`child_page`, `child_database`, `unsupported`, `ai_block`) has a
  request shape at any tier — nor does `transcription` or `meeting_notes`.
- `2026-03-11`'s own shapes: `AppendBlockChildrenBodyParameters` takes
  `position?: ContentPositionSchema`, `after` carries `@deprecated Use \`position\``,
  and `ContentPositionSchema` has `after_block` (with an object payload, not a bare id),
  `start` and `end`.

**Deliberate narrowings are listed with reasons, not silently tolerated.** The table is
allowed to be *stricter* than the SDK where that is a judgement call — currently one
entry: `tab` at tier 3, which the SDK defines as `tab: EmptyObject`. Emitting that would
mean dropping every tab's content. It is never allowed to be more permissive.

**Verified the check can actually fail.** Two perturbations, both caught:

```
tab.childrenRequired: true → false
  ✗ `tab.children` is required, and the table says so

column_list.maxTier: 1 → 2
  ✗ tier 2: `column_list` is absent from the SDK union and the table agrees it is not expressible
```

The devDependency is bumped to `^5.23.2`. Nothing imports the SDK at runtime; it is a
type reference and now a test fixture.

**§7 proposal 5 — generate the table instead of transcribing it. Judgement: this is the
form worth having, and it is done.** A generator would strip the reasoning out of the
comments, and half this file's value is the reasoning (`tab`'s narrowing, `column_list`'s
tier delta, the three bugs in the header). A generated table would also be a build
artifact nobody reads until it is wrong. The check keeps the hand-written table and
takes nothing in it on trust: a dependency bump surfaces a schema change as a failing
assertion, which is exactly what the proposal was for.

The one honest weakness: it parses the `.d.ts` as **text**. A formatting change in the
SDK's build would break it. That is deliberate — it exits loudly saying the layout moved
and pointing at the SOURCE-OF-TRUTH comment. A check that cannot tell "no drift" from
"I couldn't look" is worse than no check.

---

## 5. Bugs found and fixed beyond the brief

Three, in descending order of impact.

**5.1 The fast path was unreachable for an edit to the first block.**
`src/tools/update-page/diff.ts`. The `prefix === 0` bail returned `full` *before* the
fast-path check ran. But the fast path is `PATCH /v1/blocks/{id}` — it names its target
by id and needs no anchor at all. So a one-word edit to a single-block page, or to the
first block of any page, deleted and recreated every block on it, losing every id and
every block-level comment, in order to preserve an anchor nothing was going to use. The
fast-path check is now first (`diff.ts:113`), with the ordering constraint written down
so it doesn't regress. This is the same loss Item 1 is about, from a different cause, and
I would not have found it without restructuring that function for `position: start`.

**5.2 Validator false positive on `object`.** §3.2(a).

**5.3 Validator false negative on media blocks with no source.** §3.2(b).

Two smaller things, in the test harness rather than in shipped code, both of which were
letting assertions be weaker than they looked:

- **The fake client ignored `after:`**, appending everything to the end. A test could not
  tell a positioned append from an unpositioned one by looking at the resulting page. It
  now inserts behind the named sibling, which is what makes the ordering assertion in
  §6.3 mean anything.
- **The fake client did not materialise an appended block's inline children.** A
  brand-new block listed the *page's* children as its own (via a `__root__` fallback),
  so any test driving deferral resolution through it would have paired subtrees against
  the wrong blocks. It now registers every created block, leaves included.

---

## 6. Test evidence

### 6.1 Counts

| | baseline `c04f07a` | after item 1 | after item 2 | final `c658491` |
| --- | --- | --- | --- | --- |
| passing | 993 | 1020 | 1118 | **1401** |
| failing | 0 | 0 | 0 | **0** |
| typecheck | clean | clean | clean | clean |

Final run, `npm test` (exit 0):

```
  36 passed, 0 failed                       (roundtrip)
=== DDL round-trip: 40 passed, 0 failed ===
=== View DSL round-trip: 116 passed, 0 failed ===
=== duplicate_page: 45 passed, 0 failed ===
 134 passed, 0 failed                       (update-page round-trip)   ← 94
  26 passed, 0 failed                       (account store)
  48 passed, 0 failed                       (comments)
  51 passed, 0 failed                       (bug regressions)
  53 passed, 0 failed                       (property values)
  62 passed, 0 failed                       (client retry)             ← 61
  58 passed, 0 failed                       (oauth tokens)
  90 passed, 0 failed                       (api surface)
  94 passed, 0 failed                       (api surface 2)            ← 90
=== block write schema: 70 passed, 0 failed ===
=== write schema vs SDK: 265 passed, 0 failed ===                      ← new
=== nested containers: 47 passed, 0 failed ===
=== handler wiring: 68 passed, 0 failed ===
=== VALIDATE_BLOCK_BODIES: 98 passed, 0 failed ===                     ← new
```

`npm run typecheck` — clean, exit 0. Both new files are registered in `package.json`'s
`test` script.

### 6.2 Tests that changed, and why — none of it test-fitting

Nine assertions changed. Every one is a behaviour change stated in this report:

| was | now | why |
| --- | --- | --- |
| `plan.afterId === "b1"` (×2) | `plan.position === {type:"after_block",…}` | §4.1 |
| `appendBody.after === "b1"` (×2) | `appendBody.position === {…}` | §4.1 |
| `first-block edit → full` | `→ fast`, targeting the original block id | §5.1 — the old assertion was pinning the bug |
| full-fallback end-to-end on a 1-block page | same test on a 2-block page where both change | that page now takes the fast path; the full path needs a fixture that still reaches it |
| `r.archived === true` (×2) | `r.inTrash === true`, and `"archived" in r` is false | §4.2 |
| `notion-version === "2025-09-03"` | `=== NOTION_VERSION` **and** `NOTION_VERSION === "2026-03-11"` | asserted from the constant *and* the literal, so "we send whatever the constant says" can't pass with an empty constant |

No test was weakened, skipped or deleted. `FULL_FALLBACK_PAGE` was renamed
`FIRST_BLOCK_EDIT_PAGE` (its role changed) and two fixtures added:
`ENTIRE_PAGE_CHANGED_PAGE` and `START_POSITION_PAGE`.

### 6.3 What the new assertions actually assert

**`test/validate-block-bodies.ts` (98).** Enumerated in §3.1. The ones that carry the
most weight: byte-comparison of the emitted body string between validating and
non-validating clients; the `Proxy` that makes the validator itself throw; eleven
canaries plus two token-format regexes; and the well-formed body that must produce
*zero* output.

**`test/write-schema-vs-sdk.ts` (265).** Enumerated in §4.4, including proof that it
fails on a perturbed table.

**`test/update-page-roundtrip.ts` (+40).**

- **The deep medium-path insertion** — the exact shape from the bug report. Asserts it
  is the *medium* path, that only the replaced paragraph is deleted (the heading keeps
  its id), that more than one append went out, that the first carries
  `position: after_block`, that the follow-ups carry **no** position, that **every
  emitted body passes `validateBlockRequestTree`** (a stub accepts anything; the bytes
  are checked against the write schema instead), that all six content markers `L1`–`L6`
  reach the wire, and that the page ends up with the heading still first.
- **The fallback warning** — asserts the result says ids were not preserved, names
  comments, and says the content is intact.
- **`appendInChunks` position chaining** — 150 blocks, two chunks, chunk 2 does not
  re-use the original position, and all 150 land in request order with chunk 2
  immediately behind chunk 1. This only means something because the fake client now
  honours `after:` (§5).
- **`position: start`** — planner emits it, handler sends it, only the affected block is
  deleted, the tail paragraph keeps its id, and the summary says where the insert went.
- **The full path still exists** — a page where every block changes takes it, sends no
  `position` and no `after`.

---

## 7. Live-verification checklist — the handoff

Nothing below has met the real API. Ordered by **risk**, which is not the same as
order of importance: the top items are where a wrong assumption produces silently wrong
*content*, the bottom items produce a loud error you cannot miss.

### Tier 1 — wrong content, no error. Test these first.

1. **`update_content` where the insertion is nested deeper than one request body.**
   Five nested `<details>` substituted in, on a page with an unchanged heading above.
   The whole deferral machinery runs anchored for the first time: `DELETE` the affected
   block, `PATCH .../children` with `position: after_block` plus deferred subtrees, then
   `GET /v1/blocks/{id}/children` at each level and a further `PATCH` per subtree.
   Check: **all five levels of content present, in order**; the heading kept its id; the
   new content is *after* the heading and not at the end of the page.
   *If the append response's `results` come back reordered or short, content attaches to
   the wrong block — and nothing errors.* This is the single highest-risk item in the
   repo.

2. **The same, unanchored, through `notion_create_pages`.** Five nested `<details>` as a
   new page. Same machinery, no position. Flagged as item 1 in
   `LEFTOVERS_FIX_REPORT.md` §5 and still unproven.

3. **`position: { type: "start" }`.** Edit the FIRST block of a multi-block page in a way
   that is not a 1:1 leaf swap — e.g. change text inside a toggle that sits at index 0,
   with a paragraph below it. Check: the new content is at the **top**, the paragraph
   below kept its id, and the result says "Medium path … at the top of the page". If
   Notion rejects `start`, this errors loudly (tier 3) — but if it *silently appends to
   the end instead*, the page is reordered with no error at all. Verify placement
   visually, not just the absence of an error.

4. **`position: { type: "after_block" }` on an ordinary medium edit.** Page with an
   unchanged heading, edit the paragraphs below it. Check: content lands directly under
   the heading, not at the end of the page. This is the most-used path and the shape of
   the request changed.

5. **The block-id claim itself.** Put a block-level comment on a paragraph, run a
   `update_content` edit on a *different* paragraph, then re-read the comments. The
   comment must still be there. Then force a full fallback (change every block) and
   confirm the comment is gone — and that the tool result warned you. This proves the
   whole premise the fast/medium paths rest on, which nothing has ever confirmed.

6. **`duplicate_page` and `apply_template` on a page containing a tab block.** The
   original bug. Also worth: a childless tab (should vanish, neighbours intact), a tab
   nested inside a toggle (deferred, then appended — see 7), and a notion-hosted image
   (must arrive as an external link, on **both** paths).

7. **Appending children to a `tab` block.** Reachable only via 6's nested case.
   `TAB_DUPLICATE_FIX_REPORT.md` §6.3 flagged it and it is still unproven: nobody has
   seen Notion accept `PATCH /v1/blocks/{tab_id}/children`.

### Tier 2 — the version bump's compliance surface

8. **`archived` still works as an input alias.** `notion_update_page` with
   `properties: { archived: true }` must trash the page — the request now carries only
   `in_trash`. Then `{ archived: false }` to restore. Then both keys disagreeing
   (`{ archived: true, in_trash: false }`) — `in_trash` must win, i.e. the page stays out
   of the trash.

9. **`in_trash` reads back.** `notion_fetch` a trashed page: the output line must read
   `In trash: yes`. If it says `no`, the response field is named something other than
   `in_trash` and §4.2's fallback needs a third name.

10. **Deep nesting on page create with a `position`-free append** — the >100-block path.
    A `replace_content` with 150+ blocks. Confirms `appendInChunks` chunking is unchanged
    by the position work.

11. **A status/select property write and a view query.** Neither touches anything changed
    here, but both are version-sensitive surfaces and this is the first request under
    `2026-03-11`.

12. **`notion_query_view`.** `NOTION_API_CATCHUP_REPORT.md` Finding 2 suspected it might
    be gated on `2026-03-11`. If it was, it should start working now; if it was already
    working, nothing changes. Either way this closes a question that has been open across
    three reports.

13. **`is_archived` on `notion_query_data_source` and `in_trash` on `notion_search`.**
    Both are documented as Notion 2026-07-15 additions and were being sent on a
    2025-09-03 pin already, so the bump moves *toward* them rather than away — but they
    are the two parameters most likely to be version-gated, and nobody has run either.

14. **Trash / untrash round trip** on a page, then `notion_search` with
    `in_trash: true` to confirm it is findable there.

### Tier 3 — loud failures; a smoke test catches these for free

15. Page create with deep nesting (covered by 2). Any 400 here names the field.
16. `VALIDATE_BLOCK_BODIES=1 npx wrangler dev`, then run 1, 2 and 6 through it and watch
    the console. Two things to learn: **whether `console.warn` actually surfaces** in
    `wrangler dev` / `wrangler tail` (untested, README claims it does), and whether the
    validator's verdicts match Notion's — a body it calls valid that gets a 400 is a
    false negative, and a log line against a request that *succeeds* is a false positive.
    Both are worth knowing and neither is knowable from here.

### Things I would specifically like exercised that the brief's list doesn't cover

- **The comment-preservation claim (5).** It is the justification for the entire
  fast/medium architecture and has never been tested end-to-end.
- **Placement, not just success (3 and 4).** `position` failing silently to the default
  (`end`) is the failure mode that a "did it error?" check misses entirely.
- **A tab block nested inside a toggle (6/7).** The only way to reach the tab-append path.

---

## 8. Still open

Stated plainly. Two of these are worth a future session; the rest are single checks.

1. **The >100-block insertion still forces a full rewrite** (§2.2c). Removing it is a
   two-line change gated on one observation: that `appendBlockChildren` responses
   reliably echo the blocks they created, in order. Live checklist items 1 and 10 answer
   it. **Worth a follow-up session only if it turns out to matter in practice** — a
   100-block single edit is rare.

2. **Tests are not typechecked.** `tsconfig.json` has `"include": ["src/**/*.ts"]`, and
   `tsx` strips types without checking them. That is how `FULL_FALLBACK_PAGE is not
   defined` survived a clean `npm run typecheck` in this session and only surfaced at
   runtime. Pre-existing, out of scope here, and a real gap: **worth a future session**,
   because adding `test/**/*.ts` to `include` will surface a batch of casts that need
   looking at rather than silencing.

3. **`block-write-schema.ts` remains a transcription.** Now checked against the SDK on
   every run (§4.4), which was the point of the proposal — but the SDK is still not
   Notion. If the generated types lag the server, both the table and the checker inherit
   the lag together, and neither will tell you.

4. **The `.d.ts` checker is text-based** and will break on an SDK formatting change. It
   fails loudly by design, but "loudly" means a failing test that needs a human to look
   at the parser rather than the schema.

5. **`update_content`'s medium path still deletes and recreates the affected run.** Ids
   inside that run are not preserved — only ids *outside* it. The fast path is the only
   one that preserves an id it edits, and it only handles a 1:1 same-type leaf swap.
   Widening it (e.g. to a leaf whose type changes, via delete+create of just that block)
   would shrink the medium path's footprint further. Not attempted; not obviously worth
   it.

6. **Nothing in this session was run against Notion**, which is §7 in one line. The suite
   is 1401 green and every one of those assertions is against a stubbed `fetch` or a pure
   function. Green means the code does what I think it does. It does not mean Notion
   agrees.

7. **`NOTION_API_CATCHUP_REPORT.md` and `NOTION_API_VERIFY_REPORT.md` now describe a
   pinned `2025-09-03`** in several places. They are dated historical documents and I
   have not rewritten them; this report supersedes them on the version question. If they
   are going to be kept as living docs rather than a record, that is a small cleanup for
   a future session.
