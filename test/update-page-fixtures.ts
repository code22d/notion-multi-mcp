// -----------------------------------------------------------------------------
// Synthetic fixtures for notion_update_page's per-command pure logic + a
// minimal in-memory NotionClient shim the round-trip tests use to exercise
// the end-to-end handlers without touching real Notion.
// -----------------------------------------------------------------------------

import type { HydratedBlock } from "../src/notion/markdown/from-blocks";

const rt = (text: string, annotations: Record<string, boolean> = {}): unknown => ({
  type: "text",
  plain_text: text,
  href: null,
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: "default",
    ...annotations,
  },
  text: { content: text, link: null },
});

// -----------------------------------------------------------------------------
// Property-normalisation fixtures — scalar map → Notion property value shape.
// -----------------------------------------------------------------------------

export interface PropertyFixture {
  name: string;
  input: Record<string, unknown>;
  /** Expected Notion-shape props. `null` means the key should be cleared (pass-through null). */
  expected: Record<string, unknown>;
  /** If set, expect these archive/trash flags to be set at the top level. */
  expectedArchived?: boolean;
  expectedInTrash?: boolean;
}

export const PROPERTY_FIXTURES: PropertyFixture[] = [
  {
    name: "title-as-plain-string",
    input: { title: "Phase 5 writeup" },
    expected: { title: { title: [{ type: "text", text: { content: "Phase 5 writeup" } }] } },
  },
  {
    name: "number-and-checkbox-sentinels",
    input: { Score: 42, Done: "__YES__", Skip: "__NO__" },
    expected: {
      Score: { number: 42 },
      Done: { checkbox: true },
      Skip: { checkbox: false },
    },
  },
  {
    name: "null-clears-property",
    input: { Tags: null },
    expected: { Tags: null },
  },
  {
    name: "date-split-into-composite",
    input: {
      "date:Due:start": "2026-05-01",
      "date:Due:end": "2026-05-08",
      "date:Due:is_datetime": 0,
    },
    expected: {
      Due: { date: { start: "2026-05-01", end: "2026-05-08" } },
    },
  },
  {
    name: "userDefined-prefix-stripped",
    input: { "userDefined:URL": "https://example.com" },
    expected: {
      URL: { rich_text: [{ type: "text", text: { content: "https://example.com" } }] },
    },
  },
  {
    name: "archive-flag-lifted-to-top-level",
    input: { archived: true, Name: "Done" },
    expected: {
      Name: { title: [{ type: "text", text: { content: "Done" } }] },
    },
    expectedArchived: true,
  },
  {
    name: "array-of-strings-multi-select",
    input: { Tags: ["urgent", "review"] },
    expected: {
      Tags: { multi_select: [{ name: "urgent" }, { name: "review" }] },
    },
  },
  {
    name: "object-value-passes-through",
    input: { Status: { select: { name: "In progress" } } },
    expected: { Status: { select: { name: "In progress" } } },
  },
];

// -----------------------------------------------------------------------------
// Verification body fixtures
// -----------------------------------------------------------------------------

export interface VerificationFixture {
  name: string;
  input: {
    verification_status?: unknown;
    verification_expiry_days?: unknown;
    cover?: unknown;
    icon?: unknown;
  };
  /** Timestamp (ms) — lets us assert a deterministic expiration_date. */
  nowMs: number;
  expected: Record<string, unknown>;
}

export const VERIFICATION_FIXTURES: VerificationFixture[] = [
  {
    name: "unverified-simple",
    input: { verification_status: "unverified" },
    nowMs: 0,
    expected: { verification: { state: "unverified" } },
  },
  {
    name: "verified-indefinite",
    input: { verification_status: "verified" },
    nowMs: 0,
    expected: { verification: { state: "verified" } },
  },
  {
    name: "verified-with-30-day-expiry",
    input: { verification_status: "verified", verification_expiry_days: 30 },
    nowMs: 0,
    expected: {
      verification: {
        state: "verified",
        date: {
          start: "1970-01-01T00:00:00.000Z",
          end: "1970-01-31T00:00:00.000Z",
        },
      },
    },
  },
  {
    name: "verified-with-icon-riding-along",
    input: { verification_status: "verified", icon: "🚀" },
    nowMs: 0,
    expected: {
      verification: { state: "verified" },
      icon: { type: "emoji", emoji: "🚀" },
    },
  },
];

// -----------------------------------------------------------------------------
// Preservation-check fixtures
// -----------------------------------------------------------------------------

export interface PreservationFixture {
  name: string;
  existing: HydratedBlock[];
  newMarkdown: string;
  /** IDs (unnormalised) that SHOULD be flagged as missing from the new markdown. */
  expectedMissingIds: string[];
}

const childPage = (id: string, title: string): HydratedBlock =>
  ({
    object: "block",
    id,
    type: "child_page",
    has_children: false,
    child_page: { title },
  }) as unknown as HydratedBlock;

const childDb = (id: string, title: string): HydratedBlock =>
  ({
    object: "block",
    id,
    type: "child_database",
    has_children: false,
    child_database: { title },
  }) as unknown as HydratedBlock;

const para = (text: string): HydratedBlock =>
  ({
    object: "block",
    id: `p-${text.slice(0, 6)}`,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [rt(text)], color: "default" },
  }) as unknown as HydratedBlock;

export const PRESERVATION_FIXTURES: PreservationFixture[] = [
  {
    name: "no-child-pages-always-passes",
    existing: [para("Hello"), para("World")],
    newMarkdown: "Completely different content",
    expectedMissingIds: [],
  },
  {
    name: "child-page-id-referenced-via-id-attr",
    existing: [para("Intro"), childPage("1234567890abcdef1234567890abcdef", "Sub Doc")],
    newMarkdown: 'Intro and <page id="1234567890abcdef1234567890abcdef">Sub Doc</page>',
    expectedMissingIds: [],
  },
  {
    name: "child-page-id-referenced-via-url-attr",
    existing: [childPage("abcdef1234567890abcdef1234567890", "Notes")],
    newMarkdown: '<page url="https://www.notion.so/Notes-abcdef1234567890abcdef1234567890">Notes</page>',
    expectedMissingIds: [],
  },
  {
    name: "child-page-missing-triggers-flag",
    existing: [childPage("1111111111111111aaaaaaaaaaaaaaaa", "Dropped Page")],
    newMarkdown: "Brand new content without any references",
    expectedMissingIds: ["1111111111111111aaaaaaaaaaaaaaaa"],
  },
  {
    name: "child-db-missing-triggers-flag",
    existing: [childDb("2222222222222222bbbbbbbbbbbbbbbb", "Tasks DB")],
    newMarkdown: "No databases referenced here",
    expectedMissingIds: ["2222222222222222bbbbbbbbbbbbbbbb"],
  },
  {
    name: "hyphenated-id-normalised-against-stripped-input",
    existing: [childPage("12345678-90ab-cdef-1234-567890abcdef", "Dashed")],
    newMarkdown: '<page id="1234567890abcdef1234567890abcdef">Dashed</page>',
    expectedMissingIds: [],
  },
];

// -----------------------------------------------------------------------------
// Block-clone fixtures (apply_template)
// -----------------------------------------------------------------------------

export interface CloneFixture {
  name: string;
  input: HydratedBlock;
  /** Expected request-shape output, or null when the block should be skipped. */
  expected: Record<string, unknown> | null;
}

export const CLONE_FIXTURES: CloneFixture[] = [
  {
    name: "paragraph-cloned-without-id-or-timestamps",
    input: {
      object: "block",
      id: "abc",
      created_time: "2026-01-01T00:00:00.000Z",
      last_edited_time: "2026-01-01T00:00:00.000Z",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Hello")], color: "default" },
    } as unknown as HydratedBlock,
    expected: {
      type: "paragraph",
      paragraph: { rich_text: [rt("Hello")], color: "default" },
    },
  },
  {
    name: "child-page-skipped",
    input: childPage("deadbeef", "Should be skipped"),
    expected: null,
  },
  {
    name: "child-database-skipped",
    input: childDb("cafebabe", "Should be skipped"),
    expected: null,
  },
  {
    name: "unsupported-block-skipped",
    input: {
      object: "block",
      id: "x",
      type: "unsupported",
      has_children: false,
      unsupported: {},
    } as unknown as HydratedBlock,
    expected: null,
  },
  {
    name: "toggle-with-children-cloned-recursively",
    input: {
      object: "block",
      id: "t1",
      type: "toggle",
      has_children: true,
      toggle: { rich_text: [rt("Click me")], color: "default" },
      children: [
        {
          object: "block",
          id: "t2",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [rt("inside")], color: "default" },
        } as unknown as HydratedBlock,
      ],
    } as unknown as HydratedBlock,
    expected: {
      type: "toggle",
      toggle: {
        rich_text: [rt("Click me")],
        color: "default",
        children: [
          {
            type: "paragraph",
            paragraph: { rich_text: [rt("inside")], color: "default" },
          },
        ],
      },
    },
  },
];

// -----------------------------------------------------------------------------
// End-to-end update_content / replace_content fixtures against a fake client
// -----------------------------------------------------------------------------

export interface PageFixture {
  name: string;
  /** Starting page tree (hydrated response shape). */
  existing: HydratedBlock[];
}

export const HELLO_WORLD_PAGE: PageFixture = {
  name: "hello-world",
  existing: [
    {
      object: "block",
      id: "b1",
      type: "heading_1",
      has_children: false,
      heading_1: { rich_text: [rt("Hello, world")], color: "default", is_toggleable: false },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "b2",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("This is a paragraph about Alice.")], color: "default" },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "b3",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Alice is the protagonist.")], color: "default" },
    } as unknown as HydratedBlock,
  ],
};

export const PAGE_WITH_CHILD: PageFixture = {
  name: "page-with-child",
  existing: [
    {
      object: "block",
      id: "p1",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Intro")], color: "default" },
    } as unknown as HydratedBlock,
    childPage("3333333333333333cccccccccccccccc", "Sub Doc"),
  ],
};

// Phase 5.5 — dispatch-path fixtures. Each is designed to trigger a specific
// path when a substring substitution is applied, so the end-to-end tests can
// assert the correct API calls.

/** Two blocks, single-word edit in the 2nd. Heading stays as common prefix. */
export const FAST_PATH_PAGE: PageFixture = {
  name: "fast-path-page",
  existing: [
    {
      object: "block",
      id: "fp-heading",
      type: "heading_1",
      has_children: false,
      heading_1: { rich_text: [rt("Title")], color: "default", is_toggleable: false },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "fp-paragraph",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Hello Alice")], color: "default" },
    } as unknown as HydratedBlock,
  ],
};

/** Only one block — any edit hits the first block → full fallback. */
export const FULL_FALLBACK_PAGE: PageFixture = {
  name: "full-fallback-page",
  existing: [
    {
      object: "block",
      id: "ff-only",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Alice says hi")], color: "default" },
    } as unknown as HydratedBlock,
  ],
};

/** Outer paragraph + toggle containing a paragraph child. Edit in the child
 *  renders into the toggle's span → affected block has children → NOT fast. */
export const NESTED_TOGGLE_PAGE: PageFixture = {
  name: "nested-toggle-page",
  existing: [
    {
      object: "block",
      id: "nt-outer",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Outer")], color: "default" },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "nt-toggle",
      type: "toggle",
      has_children: true,
      toggle: { rich_text: [rt("Hide")], color: "default" },
      children: [
        {
          object: "block",
          id: "nt-inner",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [rt("Inner Alice")], color: "default" },
        } as unknown as HydratedBlock,
      ],
    } as unknown as HydratedBlock,
  ],
};

/**
 * Heading (untouched, so it can serve as the `after:` anchor) plus one
 * placeholder paragraph. Substituting a deeply-nested container in for
 * PLACEHOLDER drives a MEDIUM plan whose insertion is too deep for a single
 * request body — the shape that used to bail to a whole-page replace and take
 * every block id (and its comments) with it.
 */
export const DEEP_INSERT_PAGE: PageFixture = {
  name: "deep-insert-page",
  existing: [
    {
      object: "block",
      id: "di-heading",
      type: "heading_1",
      has_children: false,
      heading_1: { rich_text: [rt("Title")], color: "default", is_toggleable: false },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "di-body",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("PLACEHOLDER")], color: "default" },
    } as unknown as HydratedBlock,
  ],
};

/** Markdown that nests five levels — deeper than one request body can carry. */
export const FIVE_DEEP_MARKDOWN = `<details><summary>L1</summary>
<details><summary>L2</summary>
<details><summary>L3</summary>
<details><summary>L4</summary>
<details><summary>L5</summary>
Deepest content marker L6-BODY.
</details>
</details>
</details>
</details>
</details>`;

/** Three-block page used by the span-tracker tests. Non-trivial offsets. */
export const THREE_BLOCK_PAGE: PageFixture = {
  name: "three-block-page",
  existing: [
    {
      object: "block",
      id: "tb-1",
      type: "heading_2",
      has_children: false,
      heading_2: { rich_text: [rt("Section")], color: "default", is_toggleable: false },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "tb-2",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("First paragraph.")], color: "default" },
    } as unknown as HydratedBlock,
    {
      object: "block",
      id: "tb-3",
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: [rt("Second paragraph.")], color: "default" },
    } as unknown as HydratedBlock,
  ],
};
