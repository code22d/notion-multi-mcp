// -----------------------------------------------------------------------------
// Synthetic fixtures for the Markdown ↔ Notion block converter.
//
// Each fixture is a hand-crafted `BlockObjectResponse`-shaped tree covering
// one or more CORE block types. The round-trip test walks them through:
//
//   blocks → (from-blocks) → markdown → (to-blocks) → request-shaped blocks
//
// and asserts that the request-shaped output preserves block types, order,
// and the plain-text content of each block's rich_text runs.
// -----------------------------------------------------------------------------

import type { HydratedBlock } from "../src/notion/markdown/from-blocks";

type Fixture = {
  name: string;
  /** Hydrated response-shape blocks (what Notion returns from GET). */
  blocks: HydratedBlock[];
  /**
   * Expected block types in the request-shape output, in order (each matches
   * a single top-level block). Nested children are walked separately in the
   * test using `expectedChildren`.
   */
  expectedTypes: string[];
  /** Expected plain-text concatenation per block, in order. */
  expectedPlain: string[];
};

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

const basics: Fixture = {
  name: "basics-paragraph-headings-lists",
  blocks: [
    {
      object: "block",
      id: "b1",
      type: "heading_1",
      has_children: false,
      heading_1: { rich_text: [rt("Phase 2 Sandbox")], color: "default", is_toggleable: false },
    } as HydratedBlock,
    {
      object: "block",
      id: "b2",
      type: "heading_2",
      has_children: false,
      heading_2: { rich_text: [rt("Overview")], color: "default", is_toggleable: false },
    } as HydratedBlock,
    {
      object: "block",
      id: "b3",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          rt("This is a paragraph with "),
          rt("bold", { bold: true }),
          rt(" and "),
          rt("italic", { italic: true }),
          rt(" plus "),
          rt("code", { code: true }),
          rt(" inside."),
        ],
        color: "default",
      },
    } as HydratedBlock,
    {
      object: "block",
      id: "b4",
      type: "bulleted_list_item",
      has_children: false,
      bulleted_list_item: { rich_text: [rt("first item")], color: "default" },
    } as HydratedBlock,
    {
      object: "block",
      id: "b5",
      type: "bulleted_list_item",
      has_children: false,
      bulleted_list_item: { rich_text: [rt("second item")], color: "default" },
    } as HydratedBlock,
    {
      object: "block",
      id: "b6",
      type: "numbered_list_item",
      has_children: false,
      numbered_list_item: { rich_text: [rt("one")], color: "default" },
    } as HydratedBlock,
    {
      object: "block",
      id: "b7",
      type: "numbered_list_item",
      has_children: false,
      numbered_list_item: { rich_text: [rt("two")], color: "default" },
    } as HydratedBlock,
    {
      object: "block",
      id: "b8",
      type: "divider",
      has_children: false,
      divider: {},
    } as HydratedBlock,
  ],
  expectedTypes: [
    "heading_1",
    "heading_2",
    "paragraph",
    "bulleted_list_item",
    "bulleted_list_item",
    "numbered_list_item",
    "numbered_list_item",
    "divider",
  ],
  expectedPlain: [
    "Phase 2 Sandbox",
    "Overview",
    "This is a paragraph with bold and italic plus code inside.",
    "first item",
    "second item",
    "one",
    "two",
    "",
  ],
};

const todosAndQuotes: Fixture = {
  name: "todos-quotes-code",
  blocks: [
    {
      object: "block",
      id: "c1",
      type: "to_do",
      has_children: false,
      to_do: { rich_text: [rt("Ship Phase 2")], color: "default", checked: true },
    } as HydratedBlock,
    {
      object: "block",
      id: "c2",
      type: "to_do",
      has_children: false,
      to_do: { rich_text: [rt("Write round-trip tests")], color: "default", checked: false },
    } as HydratedBlock,
    {
      object: "block",
      id: "c3",
      type: "quote",
      has_children: false,
      quote: { rich_text: [rt("Make it work, then make it fast.")], color: "default" },
    } as HydratedBlock,
    {
      object: "block",
      id: "c4",
      type: "code",
      has_children: false,
      code: {
        rich_text: [rt("function hi() {\n  return 'world';\n}")],
        language: "javascript",
        caption: [rt("Greet the world")],
      },
    } as HydratedBlock,
  ],
  expectedTypes: ["to_do", "to_do", "quote", "code"],
  expectedPlain: [
    "Ship Phase 2",
    "Write round-trip tests",
    "Make it work, then make it fast.",
    "function hi() {\n  return 'world';\n}",
  ],
};

const richExtensions: Fixture = {
  name: "callout-toggle-links",
  blocks: [
    {
      object: "block",
      id: "e1",
      type: "callout",
      has_children: false,
      callout: {
        rich_text: [rt("This is a callout with useful info.")],
        color: "blue_background",
        icon: { type: "emoji", emoji: "💡" },
      },
    } as HydratedBlock,
    {
      object: "block",
      id: "e2",
      type: "toggle",
      has_children: true,
      toggle: { rich_text: [rt("Click to expand")], color: "default" },
      children: [
        {
          object: "block",
          id: "e2a",
          type: "paragraph",
          has_children: false,
          paragraph: { rich_text: [rt("Hidden content inside the toggle.")], color: "default" },
        } as HydratedBlock,
      ],
    } as HydratedBlock,
    {
      object: "block",
      id: "e3",
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          rt("See "),
          {
            type: "text",
            plain_text: "Anthropic",
            href: "https://anthropic.com",
            annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
            text: { content: "Anthropic", link: { url: "https://anthropic.com" } },
          } as unknown,
          rt(" for more."),
        ],
        color: "default",
      },
    } as HydratedBlock,
  ],
  expectedTypes: ["callout", "toggle", "paragraph"],
  expectedPlain: ["This is a callout with useful info.", "Click to expand", "See Anthropic for more."],
};

const structural: Fixture = {
  name: "table-and-nested-list",
  blocks: [
    {
      object: "block",
      id: "t1",
      type: "table",
      has_children: true,
      table: { table_width: 2, has_column_header: true, has_row_header: false },
      children: [
        {
          object: "block",
          id: "t1r1",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[rt("Name")], [rt("Role")]] },
        } as HydratedBlock,
        {
          object: "block",
          id: "t1r2",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[rt("Rene")], [rt("CEO")]] },
        } as HydratedBlock,
        {
          object: "block",
          id: "t1r3",
          type: "table_row",
          has_children: false,
          table_row: { cells: [[rt("Claude")], [rt("Agent")]] },
        } as HydratedBlock,
      ],
    } as HydratedBlock,
    {
      object: "block",
      id: "t2",
      type: "bulleted_list_item",
      has_children: true,
      bulleted_list_item: { rich_text: [rt("outer")], color: "default" },
      children: [
        {
          object: "block",
          id: "t2a",
          type: "bulleted_list_item",
          has_children: false,
          bulleted_list_item: { rich_text: [rt("inner")], color: "default" },
        } as HydratedBlock,
      ],
    } as HydratedBlock,
  ],
  expectedTypes: ["table", "bulleted_list_item"],
  expectedPlain: ["", "outer"],
};

export const FIXTURES: Fixture[] = [basics, todosAndQuotes, richExtensions, structural];
