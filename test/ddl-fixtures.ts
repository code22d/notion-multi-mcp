// -----------------------------------------------------------------------------
// Synthetic fixtures for the DDL parser+emitter.
// Each fixture exercises one or more property types (MUST + SHOULD tiers) or
// ALTER operations, and asserts the emitted Notion request body matches the
// expected shape.
// -----------------------------------------------------------------------------

export interface CreateFixture {
  name: string;
  schema: string;
  /** Expected property config shapes in the emitted body. Matched by name;
   *  each expected object is compared as a subset of the actual. */
  expected: Record<string, unknown>;
}

export interface AlterFixture {
  name: string;
  statements: string;
  /** Same subset-match strategy as CreateFixture.expected. */
  expected: Record<string, unknown>;
}

export const CREATE_FIXTURES: CreateFixture[] = [
  {
    name: "simple: title + rich_text + date",
    schema: `CREATE TABLE ("Name" TITLE, "Notes" RICH_TEXT, "Due" DATE)`,
    expected: {
      Name: { type: "title", title: {} },
      Notes: { type: "rich_text", rich_text: {} },
      Due: { type: "date", date: {} },
    },
  },
  {
    name: "number with format",
    schema: `CREATE TABLE ("Name" TITLE, "Price" NUMBER FORMAT 'dollar', "Count" NUMBER)`,
    expected: {
      Price: { type: "number", number: { format: "dollar" } },
      Count: { type: "number", number: {} },
    },
  },
  {
    name: "select + multi_select with colors",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Status" SELECT('To Do':red, 'Doing':yellow, 'Done':green),
      "Tags" MULTI_SELECT('urgent':red, 'later':gray)
    )`,
    expected: {
      Status: {
        type: "select",
        select: {
          options: [
            { name: "To Do", color: "red" },
            { name: "Doing", color: "yellow" },
            { name: "Done", color: "green" },
          ],
        },
      },
      Tags: {
        type: "multi_select",
        multi_select: {
          options: [
            { name: "urgent", color: "red" },
            { name: "later", color: "gray" },
          ],
        },
      },
    },
  },
  {
    name: "status with group tokens (group dropped in emit)",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Lifecycle" STATUS('Planning':'To-do':blue, 'Doing':'In progress':yellow, 'Done':'Complete':green)
    )`,
    expected: {
      Lifecycle: {
        type: "status",
        status: {
          options: [
            { name: "Planning", color: "blue" },
            { name: "Doing", color: "yellow" },
            { name: "Done", color: "green" },
          ],
        },
      },
    },
  },
  {
    name: "scalar atoms",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Done" CHECKBOX,
      "URL" URL,
      "Email" EMAIL,
      "Phone" PHONE_NUMBER,
      "Assignees" PEOPLE,
      "Attachments" FILES
    )`,
    expected: {
      Done: { type: "checkbox", checkbox: {} },
      URL: { type: "url", url: {} },
      Email: { type: "email", email: {} },
      Phone: { type: "phone_number", phone_number: {} },
      Assignees: { type: "people", people: {} },
      Attachments: { type: "files", files: {} },
    },
  },
  {
    name: "audit timestamps + actors",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Created" CREATED_TIME,
      "CreatedBy" CREATED_BY,
      "Updated" LAST_EDITED_TIME,
      "UpdatedBy" LAST_EDITED_BY
    )`,
    expected: {
      Created: { type: "created_time", created_time: {} },
      CreatedBy: { type: "created_by", created_by: {} },
      Updated: { type: "last_edited_time", last_edited_time: {} },
      UpdatedBy: { type: "last_edited_by", last_edited_by: {} },
    },
  },
  {
    name: "relation: single and dual",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Parent" RELATION('abc123'),
      "Linked" RELATION('def456', DUAL)
    )`,
    expected: {
      Parent: {
        type: "relation",
        relation: {
          data_source_id: "abc123",
          type: "single_property",
          single_property: {},
        },
      },
      Linked: {
        type: "relation",
        relation: {
          data_source_id: "def456",
          type: "dual_property",
          dual_property: {},
        },
      },
    },
  },
  {
    name: "rollup: sum over relation",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Children" RELATION('ds1'),
      "Total" ROLLUP('Children', 'Price', 'sum')
    )`,
    expected: {
      Total: {
        type: "rollup",
        rollup: {
          function: "sum",
          relation_property_name: "Children",
          rollup_property_name: "Price",
        },
      },
    },
  },
  {
    name: "formula and unique_id with prefix",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Formula" FORMULA('prop("Price") * 1.1'),
      "ID" UNIQUE_ID PREFIX 'TASK'
    )`,
    expected: {
      Formula: { type: "formula", formula: { expression: 'prop("Price") * 1.1' } },
      ID: { type: "unique_id", unique_id: { prefix: "TASK" } },
    },
  },
  {
    name: "the kitchen sink — every MUST + SHOULD type at once",
    schema: `CREATE TABLE (
      "Name" TITLE,
      "Description" RICH_TEXT,
      "Status" SELECT('To Do':red, 'In Progress':yellow, 'Done':green),
      "Tags" MULTI_SELECT('urgent':red, 'later':gray),
      "Lifecycle" STATUS('Backlog':'To-do':default, 'Active':'In progress':blue, 'Shipped':'Complete':green),
      "Done" CHECKBOX,
      "Price" NUMBER FORMAT 'dollar',
      "Due" DATE,
      "URL" URL,
      "Contact" PHONE_NUMBER,
      "Email" EMAIL,
      "People" PEOPLE,
      "Files" FILES,
      "Parent" RELATION('ds-parent'),
      "Linked" RELATION('ds-other', DUAL),
      "Total" ROLLUP('Children', 'Price', 'sum'),
      "Formula" FORMULA('prop("Price") * 1.1'),
      "ID" UNIQUE_ID PREFIX 'TASK',
      "Created" CREATED_TIME,
      "CreatedBy" CREATED_BY,
      "Updated" LAST_EDITED_TIME,
      "UpdatedBy" LAST_EDITED_BY
    )`,
    expected: {
      Name: { type: "title" },
      Description: { type: "rich_text" },
      Status: { type: "select" },
      Tags: { type: "multi_select" },
      Lifecycle: { type: "status" },
      Done: { type: "checkbox" },
      Price: { type: "number", number: { format: "dollar" } },
      Due: { type: "date" },
      URL: { type: "url" },
      Contact: { type: "phone_number" },
      Email: { type: "email" },
      People: { type: "people" },
      Files: { type: "files" },
      Parent: { type: "relation" },
      Linked: { type: "relation" },
      Total: { type: "rollup" },
      Formula: { type: "formula" },
      ID: { type: "unique_id" },
      Created: { type: "created_time" },
      CreatedBy: { type: "created_by" },
      Updated: { type: "last_edited_time" },
      UpdatedBy: { type: "last_edited_by" },
    },
  },
  {
    name: "no leading CREATE TABLE (parenthesised column list only)",
    schema: `("Name" TITLE, "Flag" CHECKBOX)`,
    expected: {
      Name: { type: "title" },
      Flag: { type: "checkbox" },
    },
  },
];

export const ALTER_FIXTURES: AlterFixture[] = [
  {
    name: "single ADD COLUMN",
    statements: `ADD COLUMN "Priority" SELECT('High':red, 'Low':green)`,
    expected: {
      Priority: {
        type: "select",
        select: {
          options: [
            { name: "High", color: "red" },
            { name: "Low", color: "green" },
          ],
        },
      },
    },
  },
  {
    name: "DROP COLUMN → null",
    statements: `DROP COLUMN "Old"`,
    expected: { Old: null },
  },
  {
    name: "RENAME COLUMN",
    statements: `RENAME COLUMN "Old Name" TO "New Name"`,
    expected: { "Old Name": { name: "New Name" } },
  },
  {
    name: "ALTER COLUMN SET — options update",
    statements: `ALTER COLUMN "Status" SET SELECT('Open':yellow, 'Closed':green)`,
    expected: {
      Status: {
        type: "select",
        select: {
          options: [
            { name: "Open", color: "yellow" },
            { name: "Closed", color: "green" },
          ],
        },
      },
    },
  },
  {
    name: "ALTER COLUMN SET — NUMBER format change",
    statements: `ALTER COLUMN "Price" SET NUMBER FORMAT 'euro'`,
    expected: {
      Price: { type: "number", number: { format: "euro" } },
    },
  },
  {
    name: "semicolon-separated batch",
    statements: `ADD COLUMN "A" CHECKBOX; DROP COLUMN "B"; RENAME COLUMN "C" TO "D"`,
    expected: {
      A: { type: "checkbox" },
      B: null,
      D: undefined, // the key we expect to NOT appear — the rename key is "C"
      C: { name: "D" },
    },
  },
  {
    name: "newline-separated batch",
    statements: `ADD COLUMN "A" URL
DROP COLUMN "B"
ALTER COLUMN "C" SET CHECKBOX`,
    expected: {
      A: { type: "url" },
      B: null,
      C: { type: "checkbox" },
    },
  },
  {
    name: "mixed-separator batch (semicolons AND newlines)",
    statements: `ADD COLUMN "A" EMAIL;
DROP COLUMN "B";
RENAME COLUMN "C" TO "D";`,
    expected: {
      A: { type: "email" },
      B: null,
      C: { name: "D" },
    },
  },
  {
    name: "ALTER with RELATION DUAL",
    statements: `ALTER COLUMN "Linked" SET RELATION('ds-xyz', DUAL)`,
    expected: {
      Linked: {
        type: "relation",
        relation: {
          data_source_id: "ds-xyz",
          type: "dual_property",
          dual_property: {},
        },
      },
    },
  },
  {
    name: "ALTER with UNIQUE_ID PREFIX",
    statements: `ALTER COLUMN "ID" SET UNIQUE_ID PREFIX 'PROJ'`,
    expected: {
      ID: { type: "unique_id", unique_id: { prefix: "PROJ" } },
    },
  },
  {
    name: "ADD STATUS with group tokens (group silently dropped)",
    statements: `ADD COLUMN "Phase" STATUS('Start':'To-do':blue, 'Mid':'In progress':yellow, 'End':'Complete':green)`,
    expected: {
      Phase: {
        type: "status",
        status: {
          options: [
            { name: "Start", color: "blue" },
            { name: "Mid", color: "yellow" },
            { name: "End", color: "green" },
          ],
        },
      },
    },
  },
];

// Negative fixtures — inputs that should cause a parse or emit error.
export const ERROR_FIXTURES: Array<{ name: string; schema?: string; statements?: string; expectMessageMatches: RegExp }> = [
  {
    name: "missing TITLE column",
    schema: `CREATE TABLE ("Notes" RICH_TEXT)`,
    expectMessageMatches: /exactly one TITLE column/,
  },
  {
    name: "two TITLE columns",
    schema: `CREATE TABLE ("A" TITLE, "B" TITLE)`,
    expectMessageMatches: /TITLE columns/,
  },
  {
    name: "duplicate column name",
    schema: `CREATE TABLE ("Name" TITLE, "Name" CHECKBOX)`,
    expectMessageMatches: /duplicate column name/,
  },
  {
    name: "unknown color (mauve is not a keyword — caught at lex)",
    schema: `CREATE TABLE ("Name" TITLE, "X" SELECT('a':mauve))`,
    // Lex rejects unknown bare words — identifiers must be double-quoted.
    expectMessageMatches: /unknown keyword "mauve"/,
  },
  {
    name: "known-shape but invalid color position — e.g. TEXT isn't a colour",
    // TEXT lexes as a keyword (alias for RICH_TEXT) but isn't a valid colour —
    // exercises the parser's parseColor validation path.
    schema: `CREATE TABLE ("Name" TITLE, "X" SELECT('a':TEXT))`,
    expectMessageMatches: /unknown colour/,
  },
  {
    name: "unknown rollup function",
    schema: `CREATE TABLE ("Name" TITLE, "T" ROLLUP('r','t','bogus'))`,
    expectMessageMatches: /unknown ROLLUP function/,
  },
  {
    name: "unquoted identifier",
    schema: `CREATE TABLE (Name TITLE)`,
    expectMessageMatches: /unknown keyword/,
  },
  {
    name: "ALTER: missing TO in RENAME",
    statements: `RENAME COLUMN "A" "B"`,
    expectMessageMatches: /expected TO/,
  },
  {
    name: "ALTER: double-modify same column",
    statements: `ADD COLUMN "A" URL; DROP COLUMN "A"`,
    expectMessageMatches: /appears in multiple ALTER operations/,
  },
];
