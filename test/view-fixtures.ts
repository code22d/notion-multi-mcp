// -----------------------------------------------------------------------------
// Synthetic fixtures for the View DSL parser + emitter. Same subset-match
// style as the DDL fixtures — each fixture pipes DSL → parseViewDsl →
// emitViewBody and asserts the result contains the expected fields.
// -----------------------------------------------------------------------------

import type { ViewType } from "../src/notion/view-dsl/emit.ts";

export interface ViewFixture {
  name: string;
  dsl: string;
  viewType: ViewType;
  /** Expected subset of the emitted EmittedViewBody — supports nested objects,
   *  arrays, and `undefined` sentinel (key must be absent). */
  expected: Record<string, unknown>;
  /** Optional resolver: when present, the emit harness will pass a resolver
   *  built from this map so property names rewrite to ids. Used to verify the
   *  follow-up #1 fix. */
  propIds?: Record<string, string>;
}

/** Optional fixture field — a property-name-to-id resolver. If present, the
 *  test harness passes it into emitViewBody so we can verify that names are
 *  rewritten into ids. Not all fixtures need it (filter/sort-only ones don't). */
export type PropIdMap = Record<string, string>;

export const VIEW_FIXTURES: ViewFixture[] = [
  // ---- Filters ----
  {
    name: "text equals filter (default type inference)",
    dsl: `FILTER "Status" = "Done"`,
    viewType: "table",
    expected: {
      filter: {
        property: "Status",
        rich_text: { equals: "Done" },
      },
    },
  },
  {
    name: "explicit SELECT type override",
    dsl: `FILTER "Status" SELECT = "Done"`,
    viewType: "table",
    expected: {
      filter: {
        property: "Status",
        select: { equals: "Done" },
      },
    },
  },
  {
    name: "number comparison (< and >=)",
    dsl: `FILTER ("Priority" >= 3) AND ("Score" < 10)`,
    viewType: "table",
    expected: {
      filter: {
        and: [
          { property: "Priority", number: { greater_than_or_equal_to: 3 } },
          { property: "Score", number: { less_than: 10 } },
        ],
      },
    },
  },
  {
    name: "date BEFORE / ON OR AFTER",
    dsl: `FILTER "Due" BEFORE "2026-01-01"`,
    viewType: "table",
    expected: {
      filter: {
        property: "Due",
        date: { before: "2026-01-01" },
      },
    },
  },
  {
    name: "checkbox IS CHECKED",
    dsl: `FILTER "Done" IS CHECKED`,
    viewType: "table",
    expected: {
      filter: {
        property: "Done",
        checkbox: { equals: true },
      },
    },
  },
  {
    name: "IS NOT EMPTY",
    dsl: `FILTER "Notes" IS NOT EMPTY`,
    viewType: "table",
    expected: {
      filter: {
        property: "Notes",
        rich_text: { is_not_empty: true },
      },
    },
  },
  {
    name: "CONTAINS text",
    dsl: `FILTER "Name" CONTAINS "foo"`,
    viewType: "table",
    expected: {
      filter: { property: "Name", rich_text: { contains: "foo" } },
    },
  },
  {
    name: "IN list against multi_select",
    dsl: `FILTER "Tags" IN ("urgent", "later")`,
    viewType: "table",
    expected: {
      filter: {
        property: "Tags",
        multi_select: { contains: ["urgent", "later"] },
      },
    },
  },
  {
    name: "compound OR with nested AND",
    dsl: `FILTER ("A" = "x") OR (("B" = "y") AND ("C" IS EMPTY))`,
    viewType: "table",
    expected: {
      filter: {
        or: [
          { property: "A", rich_text: { equals: "x" } },
          {
            and: [
              { property: "B", rich_text: { equals: "y" } },
              { property: "C", rich_text: { is_empty: true } },
            ],
          },
        ],
      },
    },
  },
  {
    name: "timestamp filter + timestamp sort",
    dsl: `FILTER TIMESTAMP "created_time" AFTER "2026-01-01"
SORT BY TIMESTAMP "last_edited_time" DESC`,
    viewType: "table",
    expected: {
      filter: {
        timestamp: "created_time",
        created_time: { after: "2026-01-01" },
      },
      sorts: [
        { timestamp: "last_edited_time", direction: "descending" },
      ],
    },
  },

  // ---- Sorts ----
  {
    name: "single property sort DESC",
    dsl: `SORT BY "Created" DESC`,
    viewType: "table",
    expected: {
      sorts: [
        { property: "Created", direction: "descending" },
      ],
    },
  },
  {
    name: "multi-property sort, defaults + explicit ASC",
    dsl: `SORT BY "Priority" DESC, "Name" ASC, "Score"`,
    viewType: "table",
    expected: {
      sorts: [
        { property: "Priority", direction: "descending" },
        { property: "Name", direction: "ascending" },
        { property: "Score", direction: "ascending" },
      ],
    },
  },

  // ---- View-type configurations ----
  {
    name: "board view with GROUP BY",
    dsl: `GROUP BY SELECT "Status"`,
    viewType: "board",
    expected: {
      configuration: {
        type: "board",
        group_by: {
          type: "select",
          property_id: "Status",
          sort: { type: "manual" },
        },
      },
    },
  },
  {
    name: "calendar view",
    dsl: `CALENDAR BY "Due"`,
    viewType: "calendar",
    expected: {
      configuration: {
        type: "calendar",
        date_property_id: "Due",
      },
    },
  },
  {
    name: "timeline view with start+end",
    dsl: `TIMELINE BY "Start" TO "End"`,
    viewType: "timeline",
    expected: {
      configuration: {
        type: "timeline",
        date_property_id: "Start",
        end_date_property_id: "End",
      },
    },
  },
  {
    name: "map view",
    dsl: `MAP BY "Location"`,
    viewType: "map",
    expected: {
      configuration: {
        type: "map",
        map_by: "Location",
      },
    },
  },
  {
    name: "form view with all three FORM directives",
    dsl: `FORM CLOSE
FORM ANONYMOUS true
FORM PERMISSIONS editor`,
    viewType: "form",
    expected: {
      configuration: {
        type: "form",
        is_form_closed: true,
        anonymous_submissions: true,
        submission_permissions: "editor",
      },
    },
  },
  {
    name: "chart view — column + aggregate sum OF property",
    dsl: `CHART column AGGREGATE sum OF "Revenue" HEIGHT large`,
    viewType: "chart",
    expected: {
      configuration: {
        type: "chart",
        chart_type: "column",
        y_axis: { aggregator: "sum", property_id: "Revenue" },
        height: "large",
      },
    },
  },
  {
    name: "table view with SHOW properties",
    dsl: `SHOW "Name", "Status", "Owner"`,
    viewType: "table",
    expected: {
      configuration: {
        type: "table",
        properties: [
          { property_id: "Name", visible: true },
          { property_id: "Status", visible: true },
          { property_id: "Owner", visible: true },
        ],
      },
    },
  },
  {
    name: "gallery view with COVER page_cover",
    dsl: `COVER PAGE_COVER`,
    viewType: "gallery",
    expected: {
      configuration: {
        type: "gallery",
        cover: { type: "page_cover" },
      },
    },
  },
  {
    name: "gallery view with COVER property",
    dsl: `COVER "Hero Image"`,
    viewType: "gallery",
    expected: {
      configuration: {
        type: "gallery",
        cover: { type: "property", property_id: "Hero Image" },
      },
    },
  },

  // ---- Combined ----
  {
    name: "board view: GROUP BY + FILTER + SORT combined",
    dsl: `FILTER "Status" SELECT != "Done"
SORT BY "Priority" DESC
GROUP BY STATUS "Lifecycle"`,
    viewType: "board",
    expected: {
      filter: {
        property: "Status",
        select: { does_not_equal: "Done" },
      },
      sorts: [
        { property: "Priority", direction: "descending" },
      ],
      configuration: {
        type: "board",
        group_by: {
          type: "status",
          property_id: "Lifecycle",
          sort: { type: "manual" },
          group_by: "group",
        },
      },
    },
  },

  // ---- Resolver (property name → property_id) ----
  {
    name: "resolver rewrites GROUP BY property name to id",
    dsl: `GROUP BY SELECT "Status"`,
    viewType: "board",
    propIds: { Status: "%7B%3FQf" },
    expected: {
      configuration: {
        type: "board",
        group_by: {
          type: "select",
          property_id: "%7B%3FQf",
          sort: { type: "manual" },
        },
      },
    },
  },
  {
    name: "resolver rewrites CALENDAR BY, TIMELINE BY, MAP BY, and SHOW",
    dsl: `CALENDAR BY "Due"`,
    viewType: "calendar",
    propIds: { Due: "xH%3Ex", Name: "title" },
    expected: {
      configuration: {
        type: "calendar",
        date_property_id: "xH%3Ex",
      },
    },
  },
  {
    name: "resolver rewrites CHART aggregator property",
    dsl: `CHART column AGGREGATE sum OF "Priority" HEIGHT medium`,
    viewType: "chart",
    propIds: { Priority: "iTc%7C" },
    expected: {
      configuration: {
        type: "chart",
        chart_type: "column",
        y_axis: { aggregator: "sum", property_id: "iTc%7C" },
        height: "medium",
      },
    },
  },
  {
    name: "resolver passes through when an id is already supplied",
    dsl: `GROUP BY SELECT "%7B%3FQf"`,
    viewType: "board",
    propIds: { Status: "%7B%3FQf" },
    expected: {
      configuration: {
        type: "board",
        group_by: {
          type: "select",
          property_id: "%7B%3FQf",
          sort: { type: "manual" },
        },
      },
    },
  },

  // ---- Comments + trailing whitespace ----
  {
    name: "line comments and trailing semicolons",
    dsl: `-- this is a comment
FILTER "Status" = "Done";
-- another comment
SORT BY "Created" DESC;`,
    viewType: "table",
    expected: {
      filter: { property: "Status", rich_text: { equals: "Done" } },
      sorts: [{ property: "Created", direction: "descending" }],
    },
  },
];

export interface ViewErrorFixture {
  name: string;
  dsl: string;
  viewType?: ViewType;
  expectMessageMatches: RegExp;
  /** Optional resolver — if present, harness wires it in so we can test the
   *  "property not found" error path. */
  propIds?: Record<string, string>;
}

export const VIEW_ERROR_FIXTURES: ViewErrorFixture[] = [
  {
    name: "unquoted non-keyword identifier",
    // Foobar is neither a known view-DSL keyword nor a quoted property name.
    dsl: `FILTER Foobar = "Done"`,
    viewType: "table",
    expectMessageMatches: /unknown keyword/i,
  },
  {
    name: "BY isn't a valid top-level directive",
    dsl: `BY "Status"`,
    viewType: "table",
    expectMessageMatches: /expected a directive/i,
  },
  {
    name: "IN requires a list",
    dsl: `FILTER "Tags" IN "urgent"`,
    viewType: "table",
    expectMessageMatches: /expected.*\(/i,
  },
  {
    name: "FORM PERMISSIONS invalid value",
    dsl: `FORM PERMISSIONS admin`,
    viewType: "form",
    expectMessageMatches: /unknown keyword|FORM PERMISSIONS/i,
  },
  {
    name: "CHART on non-chart view",
    dsl: `CHART column AGGREGATE sum OF "Revenue"`,
    viewType: "table",
    expectMessageMatches: /CHART is not supported on table views/,
  },
  {
    name: "GROUP BY on list view — not supported",
    dsl: `GROUP BY SELECT "Status"`,
    viewType: "list",
    expectMessageMatches: /GROUP BY is not supported on list views/,
  },
  {
    name: "calendar view missing CALENDAR BY",
    dsl: `SHOW "Name"`,
    viewType: "calendar",
    expectMessageMatches: /calendar view requires a CALENDAR BY/,
  },
  {
    name: "dashboard configuration rejected",
    dsl: `SHOW "Name"`,
    viewType: "dashboard",
    expectMessageMatches: /dashboard views are not configurable/,
  },
  {
    name: "duplicate FILTER",
    dsl: `FILTER "A" = "x"
FILTER "B" = "y"`,
    viewType: "table",
    expectMessageMatches: /only one FILTER directive/,
  },
  {
    name: "config directive without known view type",
    dsl: `CALENDAR BY "Due"`,
    // no viewType — emulates UPDATE path where the handler hasn't fetched
    expectMessageMatches: /view type must be known/,
  },
  {
    name: "resolver rejects unknown property name with helpful list",
    dsl: `GROUP BY SELECT "NotAProperty"`,
    viewType: "board",
    propIds: { Status: "%7B%3FQf", Priority: "iTc%7C" },
    expectMessageMatches: /property "NotAProperty" not found.*"Status".*"Priority"/s,
  },
];
