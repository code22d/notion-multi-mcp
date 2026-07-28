// -----------------------------------------------------------------------------
// Regression tests for the type-blind property serializer.
//
// The bug: every string-valued property was serialized as `rich_text` unless
// the key happened to be called "title"/"Name". Notion then rejected the write
// with e.g. "Status is expected to be status". It looked status-specific only
// because the types that worked took other code paths (dates via `date:` keys,
// numbers via typeof, checkboxes via __YES__, multi-select via the array
// shorthand). select / status / url / email / phone_number / people / relation
// were all broken; rich_text worked by accident.
//
// Fix: resolve the column's real type from the data source schema first
// (src/notion/property-values.ts), fail-soft to the old heuristic.
// -----------------------------------------------------------------------------

import {
  coerceScalarToPropertyValue,
  makePropertyTypeResolver,
  needsTypeResolution,
  resolveTypesForPage,
  resolveTypesForParent,
  UNKNOWN_TYPES,
  type SchemaSource,
} from "../src/notion/property-values.ts";
import { normaliseProperties, rawNeedsTypeResolution } from "../src/tools/update-page/properties.ts";

let passed = 0;
let failed = 0;

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg !== sw) {
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

// A schema resembling the VirtualLatinos task database that surfaced the bug.
const SCHEMA = {
  Name: { id: "title", type: "title", title: {} },
  Status: { id: "abc", type: "status", status: {} },
  Stage: { id: "def", type: "select", select: {} },
  Tags: { id: "ghi", type: "multi_select", multi_select: {} },
  Priority: { id: "jkl", type: "number", number: {} },
  Done: { id: "mno", type: "checkbox", checkbox: {} },
  Due: { id: "pqr", type: "date", date: {} },
  Owner: { id: "stu", type: "people", people: {} },
  Link: { id: "vwx", type: "url", url: {} },
  Contact: { id: "yz1", type: "email", email: {} },
  Phone: { id: "yz2", type: "phone_number", phone_number: {} },
  Parent: { id: "yz3", type: "relation", relation: {} },
  Notes: { id: "yz4", type: "rich_text", rich_text: {} },
  Computed: { id: "yz5", type: "formula", formula: {} },
};

const resolve = makePropertyTypeResolver(SCHEMA);

// -----------------------------------------------------------------------------
console.log("\n— the reported bug: status column —");

eq(
  coerceScalarToPropertyValue("Status", "Done", resolve("Status")),
  { status: { name: "Done" } },
  "status column serializes to `status`, not rich_text"
);

// Prove the old behaviour was wrong, i.e. this is what used to be sent.
const legacyStatus = { rich_text: [{ type: "text", text: { content: "Done" } }] };
assert(
  JSON.stringify(coerceScalarToPropertyValue("Status", "Done", resolve("Status"))) !==
    JSON.stringify(legacyStatus),
  "status no longer emits the rich_text payload Notion rejected"
);

// -----------------------------------------------------------------------------
console.log("\n— the other types that were silently broken —");

eq(
  coerceScalarToPropertyValue("Stage", "Review", resolve("Stage")),
  { select: { name: "Review" } },
  "select column"
);
eq(
  coerceScalarToPropertyValue("Link", "https://example.com", resolve("Link")),
  { url: "https://example.com" },
  "url column"
);
eq(
  coerceScalarToPropertyValue("Contact", "a@b.com", resolve("Contact")),
  { email: "a@b.com" },
  "email column"
);
eq(
  coerceScalarToPropertyValue("Phone", "+1-555-0100", resolve("Phone")),
  { phone_number: "+1-555-0100" },
  "phone_number column"
);
eq(
  coerceScalarToPropertyValue("Owner", "user-id-1", resolve("Owner")),
  { people: [{ object: "user", id: "user-id-1" }] },
  "people column"
);
eq(
  coerceScalarToPropertyValue("Parent", "page-id-1", resolve("Parent")),
  { relation: [{ id: "page-id-1" }] },
  "relation column"
);
eq(
  coerceScalarToPropertyValue("Due", "2026-07-28", resolve("Due")),
  { date: { start: "2026-07-28" } },
  "date column from a bare string"
);
eq(
  coerceScalarToPropertyValue("Tags", "urgent", resolve("Tags")),
  { multi_select: [{ name: "urgent" }] },
  "multi_select from a bare string → one option"
);
eq(
  coerceScalarToPropertyValue("Tags", "a, b", resolve("Tags")),
  { multi_select: [{ name: "a, b" }] },
  "multi_select does NOT split on commas (option names may contain them)"
);
eq(
  coerceScalarToPropertyValue("Priority", "3", resolve("Priority")),
  { number: 3 },
  "number column parses a numeric string"
);
eq(
  coerceScalarToPropertyValue("Priority", "abc", resolve("Priority")),
  { number: null },
  "number column with unparseable string → null, not NaN"
);
eq(
  coerceScalarToPropertyValue("Done", "true", resolve("Done")),
  { checkbox: true },
  "checkbox column from a truthy string"
);

// -----------------------------------------------------------------------------
console.log("\n— clearing values —");

eq(
  coerceScalarToPropertyValue("Status", "", resolve("Status")),
  { status: null },
  "empty string clears a status"
);
eq(
  coerceScalarToPropertyValue("Stage", "", resolve("Stage")),
  { select: null },
  "empty string clears a select"
);
eq(coerceScalarToPropertyValue("Link", "", resolve("Link")), { url: null }, "empty string clears a url");
eq(
  coerceScalarToPropertyValue("Owner", "", resolve("Owner")),
  { people: [] },
  "empty string clears people"
);

// -----------------------------------------------------------------------------
console.log("\n— no regressions on what already worked —");

eq(
  coerceScalarToPropertyValue("Notes", "hello", resolve("Notes")),
  { rich_text: [{ type: "text", text: { content: "hello" } }] },
  "rich_text column unchanged"
);
eq(
  coerceScalarToPropertyValue("Name", "My page", resolve("Name")),
  { title: [{ type: "text", text: { content: "My page" } }] },
  "title column unchanged"
);
eq(
  coerceScalarToPropertyValue("Anything", "hello", undefined),
  { rich_text: [{ type: "text", text: { content: "hello" } }] },
  "unknown type falls back to legacy rich_text"
);
eq(
  coerceScalarToPropertyValue("Name", "x", undefined),
  { title: [{ type: "text", text: { content: "x" } }] },
  "unknown type still honours the legacy title-by-name heuristic"
);
eq(
  coerceScalarToPropertyValue("Whatever", "__YES__", undefined),
  { checkbox: true },
  "__YES__ sentinel still works"
);
eq(
  coerceScalarToPropertyValue("Whatever", "__NO__", undefined),
  { checkbox: false },
  "__NO__ sentinel still works"
);
eq(
  coerceScalarToPropertyValue("Priority", 7, resolve("Priority")),
  { number: 7 },
  "numeric value into a number column"
);
eq(
  coerceScalarToPropertyValue("Computed", "x", resolve("Computed")),
  { rich_text: [{ type: "text", text: { content: "x" } }] },
  "read-only formula column passes through so Notion returns its own error"
);

// -----------------------------------------------------------------------------
console.log("\n— end-to-end through normaliseProperties —");

{
  const { notionProps } = normaliseProperties({ Status: "Done", Priority: 2 }, resolve);
  eq(notionProps.Status, { status: { name: "Done" } }, "normaliseProperties emits a status value");
  eq(notionProps.Priority, { number: 2 }, "normaliseProperties keeps numbers numeric");
}

{
  // Native property objects remain the documented escape hatch.
  const native = { status: { name: "Blocked" } };
  const { notionProps } = normaliseProperties({ Status: native }, resolve);
  eq(notionProps.Status, native, "object values pass through untouched");
}

{
  const { notionProps, inTrash } = normaliseProperties({ in_trash: true, Status: "Done" }, resolve);
  assert(inTrash === true, "in_trash still extracted alongside typed properties");
  eq(notionProps.Status, { status: { name: "Done" } }, "…and the status still serializes");
}

{
  const { notionProps } = normaliseProperties({ Status: null }, resolve);
  eq(notionProps.Status, null, "explicit null still clears a property");
}

// -----------------------------------------------------------------------------
console.log("\n— only fetch the schema when it can change the answer —");

assert(needsTypeResolution({ Status: "Done" }), "bare string ⇒ needs the schema");
assert(!needsTypeResolution({ Priority: 3 }), "number ⇒ no fetch");
assert(!needsTypeResolution({ Done: true }), "boolean ⇒ no fetch");
assert(!needsTypeResolution({ Tags: ["a", "b"] }), "array shorthand ⇒ no fetch");
assert(!needsTypeResolution({ Status: { status: { name: "x" } } }), "native object ⇒ no fetch");
assert(!needsTypeResolution({ Name: "My page" }), "title-by-name ⇒ no fetch");
assert(!needsTypeResolution({ Flag: "__YES__" }), "boolean sentinel ⇒ no fetch");

assert(
  !rawNeedsTypeResolution({ "date:Due:start": "2026-07-28" }),
  "date: composite keys declare their own intent ⇒ no fetch"
);
assert(
  !rawNeedsTypeResolution({ "place:Where:name": "Austin" }),
  "place: composite keys ⇒ no fetch"
);
assert(!rawNeedsTypeResolution({ in_trash: true }), "in_trash alone ⇒ no fetch");
assert(rawNeedsTypeResolution({ "userDefined:url": "x" }), "userDefined: prefix is unwrapped first");

// -----------------------------------------------------------------------------
console.log("\n— schema resolution walks page → parent → data source —");

function fakeClient(opts: {
  page?: unknown;
  database?: unknown;
  dataSource?: unknown;
  throwOn?: "page" | "database" | "dataSource";
}): SchemaSource & { calls: Record<string, number> } {
  const calls = { getPage: 0, getDatabase: 0, getDataSource: 0 };
  return {
    calls,
    async getPage() {
      calls.getPage++;
      if (opts.throwOn === "page") throw new Error("boom");
      return opts.page;
    },
    async getDatabase() {
      calls.getDatabase++;
      if (opts.throwOn === "database") throw new Error("boom");
      return opts.database;
    },
    async getDataSource() {
      calls.getDataSource++;
      if (opts.throwOn === "dataSource") throw new Error("boom");
      return opts.dataSource;
    },
  };
}

{
  const c = fakeClient({
    page: { parent: { type: "data_source_id", data_source_id: "ds-1" } },
    dataSource: { properties: SCHEMA },
  });
  const r = await resolveTypesForPage(c, "page-1");
  eq(r("Status"), "status", "data_source_id parent resolves the schema");
  assert(c.calls.getDataSource === 1, "…with exactly one data source fetch");
}

{
  const c = fakeClient({
    page: { parent: { type: "database_id", database_id: "db-1" } },
    database: { data_sources: [{ id: "ds-1", name: "x" }] },
    dataSource: { properties: SCHEMA },
  });
  const r = await resolveTypesForPage(c, "page-1");
  eq(r("Stage"), "select", "legacy database_id parent resolves via first data source");
}

{
  const c = fakeClient({ page: { parent: { type: "page_id", page_id: "p-1" } } });
  const r = await resolveTypesForPage(c, "page-1");
  eq(r("Status"), undefined, "page parent has no column schema");
  assert(c.calls.getDataSource === 0, "…and we don't fetch one");
}

{
  const c = fakeClient({ throwOn: "page" });
  const r = await resolveTypesForPage(c, "page-1");
  eq(r("Status"), undefined, "fetch failure fails soft to unknown types");
}

{
  const c = fakeClient({ dataSource: { properties: SCHEMA } });
  const r = await resolveTypesForParent(c, { type: "data_source_id", data_source_id: "ds-1" });
  eq(r("Owner"), "people", "create path resolves straight from the declared parent");
  assert(c.calls.getPage === 0, "…without fetching a page");
}

{
  const r = await resolveTypesForParent(fakeClient({}), { type: "page_id" });
  eq(r("Status"), undefined, "page parent on the create path ⇒ unknown types");
}

eq(UNKNOWN_TYPES("anything"), undefined, "UNKNOWN_TYPES resolver returns undefined");

// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
