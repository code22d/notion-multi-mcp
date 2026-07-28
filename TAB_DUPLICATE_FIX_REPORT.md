# Tab duplication failure — root cause, fix, and audit of the bug class

Date: 2026-07-28
Commits: `dd2ad30` (fix), `159f1bf` (tests)
Pinned API version unchanged: `NOTION_VERSION = "2025-09-03"` in `src/notion/client.ts`.

**No live Notion calls were made in this session.** Everything below is established
from code, from Notion's request schema as vendored in this repo, or by executing
the pre-fix code locally. Section 6 lists exactly what that leaves unproven.

---

## 1. Root cause

**Cloning, not hydration.** Established by execution, not inference.

I extracted the pre-fix `src/` from `HEAD~1`, built the block tree for the page in the
bug report **with `has_children: true` and every child fully populated**, ran the old
`toBlockRequest` over it, and printed what it emitted:

```
--- OLD duplicate_page emitted body (children[1]) ---
{
  "type": "tab",
  "tab": {}
}
```

That is byte-identical to what Notion complained about, at the same index. The input
had children; the clone dropped them. So hydration is exonerated for this failure —
even a perfectly hydrated tree produced the rejected body.

The mechanism, in `src/tools/duplicate-move.ts` at `HEAD~1`:

```ts
if (block.children && block.children.length > 0 && supportsInlineChildren(type)) { … }

function supportsInlineChildren(type: string): boolean {
  return type === "toggle" || type === "quote" || type === "callout" ||
         type === "column_list" || type === "column" || type === "synced_block" ||
         type === "bulleted_list_item" || … ;   // no "tab", and no "paragraph"
}
```

`tab` was not on the list, so its children were never inlined, so `tab.children` was
absent, so Notion rejected the entire create request.

### Why the one-line fix would have been wrong

Adding `"tab"` to that list stops the 400 and **silently empties every tab.** A tab
block's children are *paragraphs* (each paragraph is one tab: rich_text = label,
`icon` = tab icon, `children` = tab body). `paragraph` was not on that list either, so
the tabs would have been inlined as bare labels with no content — and the old code
then set `block.children = undefined` as an "already inlined" marker, cutting the
follow-up append pass off from the bodies it would otherwise have attached.

The list is the actual defect. It conflated two different questions — *may this type
carry children on write?* and *do we choose to inline them?* — and had no
representation at all for the third question `tab` raises: *does the schema
**require** children?*

### The deeper problem the list was hiding

Notion's request schema does not accept arbitrarily deep inline `children`. It encodes
the limit by retyping the children array at each level, and **the set of legal block
types shrinks with depth**:

| nesting tier | what the schema accepts |
| --- | --- |
| 1 (top of a `children` array) | every block type |
| 2 | no `column_list`, no `column` |
| 3 | also no `table`; **nothing carries children** |

The old code inlined recursively with no notion of depth, so it could emit bodies that
were over-nested regardless of `tab`. Confirmed by running the pre-fix code (§3).

---

## 2. The fix

`src/notion/block-write-schema.ts` (new) writes the write schema down as a table:
which types are legal at which tier, which require `children`, what each container
accepts as a child, which fields are mandatory, which are response-only.

`src/notion/block-clone.ts` (new) derives every cloning decision from that table, and
replaces **both** previous clone implementations. Subtrees that don't fit at the tier
they landed on are not inlined into an invalid body and not dropped — they are
recorded as `pending` and appended in a follow-up request, where they start again at
tier 1.

`duplicate-move.ts` and `update-page/shared.ts` are now thin policy wrappers over it.
They differ in one thing only: what to do with a block that has no create shape
(duplicate_page leaves a visible italic note; apply_template drops it).

### Source of truth

The table is transcribed from the request types generated from Notion's own OpenAPI
spec, already vendored in this repo as a devDependency:

```
node_modules/@notionhq/client/build/src/api-endpoints/common.d.ts
```

The three depth-tiered unions there — `BlockObjectRequest`,
`BlockObjectWithSingleLevelOfChildrenRequest`, `BlockObjectRequestWithoutChildren` —
are where the tier model comes from. The decisive line for this bug:

```ts
type TabRequestWithNestedTabItemChildren = {
    children: Array<TabItemRequestWithSingleLevelOfChildren>;   // not `children?`
};
```

`children` is **required**, not optional. Compare `toggle`, `callout`, `quote`,
`synced_block` and the list items, all of which are `children?`.

### The childless-tab decision: **drop the block**

A `tab` with no tabs has no valid representation Notion will accept, so doing nothing
is not an option — it produces a 400 naming a field the user never supplied and cannot
act on, and it takes the whole page down with it, not just that block.

I chose **drop** over **synthesise an empty paragraph child**:

- An empty tab block renders as nothing in Notion. Dropping it loses no content —
  there is no content. The other option is the lossy one: synthesising a child
  *invents* a visible empty tab that was never in the source, so the duplicate stops
  being a duplicate.
- The failure mode of dropping is bounded and invisible. The failure mode of
  synthesising is a phantom UI element the user then has to find and delete, in a
  page they asked to be a copy.
- It is consistent with how this codebase already treats structurally-empty input
  elsewhere, and with fail-soft: keep the request valid, lose the least.

Blocks either side of a dropped tab are unaffected — tested explicitly.

Related guard, same reasoning applied differently: a `column_list` left with fewer
than the two columns Notion requires is **unwrapped to its contents** rather than
dropped, because there *is* content to preserve. It flattens past the columns as well,
since a bare `column` outside a `column_list` is not a valid block either.

### Other changes in the fix, and why

- **Hydration now descends into required-children containers regardless of
  `has_children`** (`shouldDescendInto`). This did not cause the reported bug. It is
  cheap insurance against the one thing I cannot verify from here (§6): if that flag
  is ever wrong for a `tab`, the cost is a rejected request, not a cosmetically empty
  block. The price is one extra empty list call for a genuinely empty table/tab.
- **`breadcrumb` and `table_of_contents` now clone properly.** They were being
  degraded to placeholder notes; the schema says both are creatable at tier 1. Valid
  before, lossy before, correct now.
- **The clone no longer mutates the source tree.** The old code blanked
  `block.children` as an inlined-marker, which meant cloning the same tree twice gave
  different answers the second time.
- **`synced_block` references** are now explicit policy rather than an accident:
  duplicate_page substitutes a note (unchanged behaviour), apply_template re-emits the
  link (unchanged behaviour) but no longer re-sends the mirrored children, which
  belong to the original.

---

## 3. Container-type audit

Every clonable container, checked against the write schema. "Verdict" columns are the
result of **running** the pre-fix and post-fix code and validating the emitted body —
not inspection alone. Reproduce with `npx tsx test/block-write-schema.ts`.

### Schema facts (transcribed from the generated request types)

| type | `children` | legal at tiers | other required fields |
| --- | --- | --- | --- |
| `tab` | **required** | 1–2 (3 only as an empty `{}`) | children must all be `paragraph` |
| `table` | **required** | 1–2 | `table_width`; children must be `table_row` |
| `column_list` | **required** | **1 only** | ≥2 children, all `column` |
| `column` | **required** | **1 only** | — |
| `synced_block` | optional | 1–3 | `synced_from` (nullable) |
| `toggle`, `callout`, `quote`, `to_do`, `paragraph`, `bulleted_list_item`, `numbered_list_item`, `template`, `heading_1..4` | optional | 1–3 | — |
| `table_row` | n/a (leaf) | 1–3 | `cells` |
| `image`/`video`/`pdf`/`audio`/`file` | n/a | 1–3 | body must be `external` or `file_upload` |
| `child_page`, `child_database`, `unsupported`, `ai_block` | — | **no create shape at all** | — |

### Verdicts

| case | duplicate_page before | apply_template before | after |
| --- | --- | --- | --- |
| `tab`, top level | ❌ `tab.children` absent | ✅ valid | ✅ |
| `tab`, childless | ❌ `tab.children` absent | ❌ `tab.children` absent | ✅ dropped |
| `tab`, nested in a toggle | ❌ `tab.children` absent | ❌ over-nested (tiers 4–5) | ✅ deferred + appended |
| `table` with rows | ✅ valid | ✅ valid | ✅ |
| `table`, no rows | ❌ invalid | ❌ invalid | ✅ dropped |
| `column_list`, top level, 2 cols | ✅ valid | ✅ valid | ✅ |
| `column_list`, 1 col | ❌ below Notion's minimum | ❌ below minimum | ✅ unwrapped |
| `column_list` nested in a toggle | ❌ tier-2 `column_list`/`column` | ❌ same | ✅ deferred + appended |
| `synced_block` original | ✅ valid | ✅ valid | ✅ |
| `synced_block` reference | ✅ (placeholder note) | ⚠ re-sent mirrored children | ✅ link only |
| 5 levels of toggles | ❌ tiers 4–5 | ❌ tiers 4–5 | ✅ split across requests |
| notion-hosted image | ✅ rewritten to external | ❌ **`{type:"file"}` sent as-is** | ✅ both paths rewrite |
| `child_page`/`child_database`/`unsupported`/`ai_block` | ✅ placeholder | ✅ skipped | ✅ |
| `breadcrumb` / `table_of_contents` | ⚠ valid but degraded to a note | ✅ cloned | ✅ cloned properly |

Two findings beyond the reported bug are worth calling out, both the same family:

1. **`apply_template` never had the hosted-media rewrite.** A template containing any
   uploaded image/video/pdf emitted `{ "type": "file", "file": { "url": … } }`, a
   shape the write schema has no case for. duplicate_page fixed this long ago and the
   fix never crossed over — the exact drift the shared engine now prevents.
2. **Both paths could over-nest.** Any tree deeper than three levels, or any
   `column_list` below the top level, produced an invalid body on both paths.

`⚠` = valid request, wrong or lossy content. `❌` = a body Notion's documented schema
rejects.

---

## 4. `apply_template` — affected, but not by the reported reproduction

**Not affected by the exact bug reported**, and I want to be precise about that rather
than claim a broader fix than I made. Running the pre-fix `cloneBlockForRequest` on
the reproduction tree gives `VALID`.

The reason is a genuine difference, not luck. `cloneBlockForRequest` attached children
whenever `block.children` was non-empty, with no type gate at all — so a tab at the
top level got its `children` by accident of a more permissive rule. duplicate_page's
allow-list gated on type and had no `tab` entry.

**It was affected by the same class**, in four ways, all now fixed: childless tabs,
tabs nested below the top level, any tree deeper than three levels, and hosted media.
The over-nesting cases were arguably worse there than in duplicate_page, because
`apply_template` had no follow-up append pass at all — it sent one request and
whatever the body could not carry was simply gone. It now uses `appendClonedTree`.

---

## 5. Test evidence

### Before (baseline, unmodified tree)

```
TOTAL: 805 passed, 0 failed
```
`npm run typecheck` — clean, no output.

### After

```
36 passed, 0 failed                       (roundtrip)
=== DDL round-trip: 40 passed, 0 failed ===
=== View DSL round-trip: 116 passed, 0 failed ===
=== duplicate_page: 45 passed, 0 failed ===
94 passed, 0 failed                       (update-page round-trip)
26 passed, 0 failed                       (account store)
48 passed, 0 failed                       (comments)
51 passed, 0 failed                       (bug regressions)
53 passed, 0 failed                       (property values)
61 passed, 0 failed                       (client retry)
58 passed, 0 failed                       (oauth tokens)
90 passed, 0 failed                       (api surface)
90 passed, 0 failed                       (api surface 2)
=== block write schema: 70 passed, 0 failed ===

TOTAL: 878 passed, 0 failed
```
`npm run typecheck` — clean, no output.

805 → 878. Three pre-existing `duplicate_page` assertions changed on purpose, and I
should be explicit that they are behaviour changes, not test-fitting:

- `source.children cleared after inline` — asserted the source-tree mutation described
  in §2. Replaced with the opposite assertion (the tree is not mutated) plus a check
  that cloning twice yields the same body.
- two `column_list` assertions — the fixture was a **one-column** column_list, below
  Notion's documented minimum. Replaced with a realistic two-column fixture, plus a
  new explicit test for the degenerate case.

### What the new tests assert that the old ones did not

**The emitted body shape.** That is the whole point.

Every other test in this suite asserts against a stubbed `fetch`, and a stub accepts
any body. A test can assert "we called `appendBlockChildren` with a tab block" and
pass while emitting a body Notion refuses outright — which is exactly what happened
for 805 tests.

`test/block-write-schema.ts` holds the bytes and checks them against the write-schema
table. Concretely:

- `assertValid(body, …)` fails unless **every** block in the emitted tree satisfies the
  schema — required fields, legal tier, allowed child types, no response-only nulls,
  no response-only fields, no unwritable types.
- **Section 1 proves the validator is capable of failing** before anything relies on
  it: it asserts that each body which caused a *real production 400* is rejected —
  the bare `{"type":"tab","tab":{}}`, a paragraph carrying `icon: null`, an image
  carrying a notion-hosted `file` — and then that well-formed bodies pass, so it isn't
  an always-fail stub.
- Deferral is asserted to be **lossless**, not merely valid: a five-level toggle chain
  and a nested `column_list` are driven through a recording client, and the tests
  assert both that every request in the sequence validates *and* that the deepest
  content ("L5", both columns) actually arrives.

**Direct evidence they would have caught this bug.** I ran the pre-fix `toBlockRequest`
from `HEAD~1` against the new validator on the reproduction page:

```
children[1]: `tab.children` is required by the write schema but is absent
```

Same index, same field name, same complaint Notion made.

---

## 6. What remains unverified without a live call

Listed plainly. A live smoke test should target these first.

1. **Notion agrees with the table.** `block-write-schema.ts` is a transcription of
   generated types, not the server. If the SDK's generated schema lags Notion's actual
   validator, my "valid" verdicts inherit that lag. Nothing here was confirmed against
   a running API.
2. **Whether a tab block's response actually reports `has_children: true`.** I proved
   the bug does not depend on it (the clone dropped populated children), but I could
   not observe a real tab block response. `shouldDescendInto` now descends regardless,
   so this should not matter — but that mitigation is itself untested against the API.
3. **That appending to a created tab block works**, if it is ever reached. A tab nested
   below tier 2 is deferred and its paragraphs appended in a follow-up call. I have not
   seen Notion accept `appendBlockChildren` against a `tab` block. I deliberately chose
   *not* to emit the tier-3 `tab: {}` form the schema permits, precisely because it
   depends on this; deferral is the conservative path, but the append is still unproven.
4. **The exact nesting depth Notion enforces at runtime.** The tiers come from the type
   structure. The server may be more lenient (in which case I defer more than
   necessary — a cost in API calls, not correctness) or stricter in some corner.
5. **`column_list` minimum of two columns.** Documented, not encoded in the generated
   types (no `minItems`), and I could not test it. If Notion actually accepts one
   column, the unwrap is unnecessary. It is not unsafe either way — content survives.
6. **`table_width` consistency.** The clone carries `table_width` through unchanged and
   does not verify it equals each row's cell count. A source table where those disagree
   would still be rejected. I judged synthesising a width worse than passing through
   what Notion itself returned.
7. **Whether the append-response `results` order matches request order.** The
   `apply_template` path pairs deferred subtrees against `appendBlockChildren`'s
   `results` by index. Notion documents returning the appended blocks; I have not
   observed it. If a response ever came back short or reordered, the resolver attaches
   fewer subtrees rather than grafting content onto the wrong block — it takes
   `min(created, cloned)` — so the failure mode is missing content, not corruption.
8. **The `synced_block` reference behaviour change in `apply_template`.** It no longer
   re-sends the mirrored children. I believe sending them was wrong; I have not seen
   either behaviour against the API.

---

## 7. Structural proposal

This was the third failure of one family: *a field the write schema won't accept, taken
straight from a read response.* The first produced `stripResponseOnlyNulls()`. The
second (hosted media) was fixed on one path and never reached the other. The third is
this one.

**Implemented here**, because it is contained (two new files, both pure, plus thin
wrappers):

1. **One clone path.** There were two, and they drifted — measurably: the null-icon fix
   had to be back-ported, and the media fix never was. `apply_template` inherits three
   fixes for free in this commit purely by no longer being a second copy.
2. **The write schema as data, in one file.** Adding a block type is now a table entry,
   not a change to a recursive function in two places. `tab` would have been one line.
3. **A validator over the emitted body, usable from tests without a network.** This is
   the seam that was missing. Stubbed `fetch` can only prove we made a call; this proves
   what we would have said.

**Proposed, not implemented** — each needs a judgement call that is Rene's:

4. **Run the validator in the client, behind a dev flag.** `NotionClient` could validate
   `children` on create/append when an env flag is set and log (never throw) on
   problems. That would catch this class in `wrangler dev` against a real workspace,
   which is the one place tests can't reach. I did not implement it because it changes
   request-path behaviour and I cannot test it against a live API from here.
5. **Regenerate the table instead of transcribing it.** A small script could derive
   `block-write-schema.ts` from `@notionhq/client`'s `.d.ts` at build time, so a
   dependency bump surfaces a schema change as a diff. Worth it only if the SDK stays
   a devDependency and its type layout stays stable — a transcription that silently
   goes stale would be worse than the honest one that is here now.
6. **Apply the same treatment to page/database property writes.** The block path now
   has a schema table; `property-values.ts` encodes similar knowledge in code. If a
   fourth bug in this family appears, that is where I would expect it.
