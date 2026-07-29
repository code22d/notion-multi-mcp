// -----------------------------------------------------------------------------
// block-write-schema.ts vs the SDK's generated request types — a drift check.
//
// Run with:
//   tsx test/write-schema-vs-sdk.ts
//
// WHY THIS EXISTS
//
// src/notion/block-write-schema.ts is a HAND TRANSCRIPTION of the request types
// generated from Notion's OpenAPI spec. Everything the clone path decides —
// which types are legal at which nesting tier, which containers must carry
// `children`, what each one accepts as a child — is derived from that table. If
// the transcription goes stale, every one of those decisions inherits the
// staleness silently, and the failure mode is a 400 in production with a green
// suite behind it. That is precisely the shape of the bug this table was
// written to prevent.
//
// TAB_DUPLICATE_FIX_REPORT.md §7 proposal 5 suggested GENERATING the table from
// the `.d.ts` instead. This is the same idea in the form that is actually worth
// having: the table stays hand-written, because half its value is the reasoning
// in its comments and a generator would strip that — but nothing in it is taken
// on trust. Every row is checked against the SDK on every test run, so a
// dependency bump surfaces a schema change as a failing assertion instead of a
// silent divergence.
//
// It parses the `.d.ts` as text. That is fragile against a formatting change in
// the SDK's build, and deliberately so: it fails loudly and tells you the
// layout moved, rather than quietly checking nothing. A check that can't tell
// "no drift" from "I couldn't look" is worse than no check.
//
// DELIBERATE NARROWINGS
//
// The table is allowed to be STRICTER than the SDK where that is a documented
// judgement call, and those are listed in NARROWED below with their reasons.
// It is never allowed to be more permissive: that is the direction that emits
// bodies Notion rejects.
// -----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import {
  MAX_REQUEST_TIER,
  UNWRITABLE_BLOCK_TYPES,
  blockWriteRule,
  childrenAllowedAtTier,
  isExpressibleAtTier,
  requiresChildren,
} from "../src/notion/block-write-schema.ts";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq<T>(got: T, want: T, msg: string): void {
  const sg = JSON.stringify(got);
  const sw = JSON.stringify(want);
  if (sg === sw) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}\n    got:  ${sg}\n    want: ${sw}`);
  }
}

// -----------------------------------------------------------------------------
// Locate the generated types
// -----------------------------------------------------------------------------

const SDK_DIR = path.resolve("node_modules/@notionhq/client/build/src/api-endpoints");
const COMMON = path.join(SDK_DIR, "common.d.ts");
const BLOCKS = path.join(SDK_DIR, "blocks.d.ts");

if (!fs.existsSync(COMMON) || !fs.existsSync(BLOCKS)) {
  console.error(
    `  ✗ cannot find the SDK's generated request types.\n` +
      `    Looked for:\n      ${COMMON}\n      ${BLOCKS}\n` +
      `    Either @notionhq/client is not installed (run npm install) or its build\n` +
      `    layout moved. If the layout moved, this check needs updating — and so\n` +
      `    does the SOURCE OF TRUTH comment at the top of block-write-schema.ts.`
  );
  process.exit(1);
}

const common = fs.readFileSync(COMMON, "utf8");
const blocks = fs.readFileSync(BLOCKS, "utf8");
const sdkVersion = JSON.parse(
  fs.readFileSync(path.resolve("node_modules/@notionhq/client/package.json"), "utf8")
).version as string;

console.log(`\n[source] @notionhq/client ${sdkVersion}`);

// -----------------------------------------------------------------------------
// A very small .d.ts reader
//
// Top-level declarations start at column 0; everything inside one is indented.
// That is enough structure to slice declarations apart and to split a union on
// its `} | {` seams without needing a parser.
// -----------------------------------------------------------------------------

function declarations(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = src.split("\n");
  let name: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (name) out.set(name, buf.join("\n"));
  };
  for (const line of lines) {
    const m = line.match(/^(?:export )?(?:declare )?type ([A-Za-z0-9_]+) = (.*)$/);
    if (m) {
      flush();
      name = m[1]!;
      buf = [m[2]!];
    } else if (/^(?:export )?(?:declare|interface|const|function) /.test(line)) {
      flush();
      name = null;
      buf = [];
    } else if (name) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

const DECLS = declarations(common);

/** Split a union declaration body into its top-level alternatives. */
function alternatives(body: string): string[] {
  return body.split(/\n\} \| \{\n/).map((part, i, all) => {
    const head = i === 0 ? part : `{\n${part}`;
    return i === all.length - 1 ? head : `${head}\n}`;
  });
}

/** Top-level fields of an object literal body, as `name` → `declaration`. */
function fields(objectBody: string, indent: number): Array<[string, string, boolean]> {
  const re = new RegExp(`^ {${indent}}([A-Za-z0-9_]+)(\\??): (.*)$`);
  const out: Array<[string, string, boolean]> = [];
  for (const line of objectBody.split("\n")) {
    const m = line.match(re);
    if (m) out.push([m[1]!, m[3]!, m[2] === "?"]);
  }
  return out;
}

type ChildrenKind = "required" | "optional" | "none";

interface SdkBlock {
  /** Block type key, e.g. "paragraph". */
  key: string;
  children: ChildrenKind;
  /** The declared element type of `children`, when it has one. */
  childrenOf?: string;
  /** Fields the payload declares as required. */
  requiredFields: string[];
}

/**
 * Read one alternative of a block-request union: which block type it is, and
 * what its payload says about `children`. The payload is either written inline
 * or is a named alias, so alias resolution is part of the job.
 */
function readAlternative(alt: string): SdkBlock | null {
  const disc = alt.match(/^ {4}type\??: "([a-z_0-9]+)";$/m);
  if (!disc) return null;
  const key = disc[1]!;

  const decl = alt.match(new RegExp(`^ {4}${key}\\??: (.*)$`, "m"));
  if (!decl) return { key, children: "none", requiredFields: [] };

  let payload: string;
  let indent: number;
  if (decl[1]!.trim() === "{") {
    payload = alt;
    indent = 8;
  } else {
    const aliasName = decl[1]!.replace(/;$/, "").trim();
    const alias = DECLS.get(aliasName);
    if (!alias) return { key, children: "none", requiredFields: [] };
    // EmptyObject and friends resolve to something with no fields at all.
    payload = alias;
    indent = 4;
  }

  const fs_ = fields(payload, indent);
  const childrenField = fs_.find(([n]) => n === "children");
  const requiredFields = fs_.filter(([n, , opt]) => !opt && n !== "children").map(([n]) => n);
  if (!childrenField) return { key, children: "none", requiredFields };
  const elem = childrenField[1]!.match(/Array<([A-Za-z0-9_]+)>/)?.[1];
  return {
    key,
    children: childrenField[2] ? "optional" : "required",
    childrenOf: elem,
    requiredFields,
  };
}

function readTier(unionName: string): Map<string, SdkBlock> {
  const body = DECLS.get(unionName);
  if (!body) {
    console.error(`  ✗ union ${unionName} not found in common.d.ts — the SDK's type layout moved`);
    failed++;
    return new Map();
  }
  const out = new Map<string, SdkBlock>();
  for (const alt of alternatives(body)) {
    const b = readAlternative(alt);
    if (b) out.set(b.key, b);
  }
  return out;
}

const TIERS: Array<Map<string, SdkBlock>> = [
  new Map(), // index 0 unused — tiers are 1-based
  readTier("BlockObjectRequest"),
  readTier("BlockObjectWithSingleLevelOfChildrenRequest"),
  readTier("BlockObjectRequestWithoutChildren"),
];

console.log("\n[sanity] the parse produced something that looks like the schema");
{
  eq(TIERS.length - 1, MAX_REQUEST_TIER, "one union read per tier the table knows about");
  for (let t = 1; t <= MAX_REQUEST_TIER; t++) {
    assert(TIERS[t]!.size > 20, `tier ${t} yielded ${TIERS[t]!.size} block types (a real union, not a parse failure)`);
  }
  assert(TIERS[1]!.has("paragraph"), "…including paragraph, so the discriminant regex is finding keys");
  eq(TIERS[1]!.get("tab")?.children, "required", "…and tab.children reads as REQUIRED, the fact this table exists for");
}

// -----------------------------------------------------------------------------
// Deliberate narrowings — the table is stricter than the SDK, on purpose
// -----------------------------------------------------------------------------

const NARROWED: Array<{ type: string; tier: number; why: string }> = [
  {
    type: "tab",
    tier: 3,
    why:
      "the SDK defines a tier-3 `tab: EmptyObject` — a tab block with no tabs. Emitting it would " +
      "mean dropping every tab's content and hoping a follow-up append can graft paragraphs onto " +
      "a tab block, which nothing has verified. Deferring the whole block is lossless instead.",
  },
];

console.log("\n[tier membership] every type the SDK accepts at a tier, and no others");
for (let tier = 1; tier <= MAX_REQUEST_TIER; tier++) {
  const sdk = TIERS[tier]!;
  for (const key of sdk.keys()) {
    const narrowed = NARROWED.find((n) => n.type === key && n.tier === tier);
    if (narrowed) {
      assert(
        !isExpressibleAtTier(key, tier),
        `tier ${tier}: \`${key}\` is deliberately narrowed out — ${narrowed.why.slice(0, 60)}…`
      );
      continue;
    }
    assert(isExpressibleAtTier(key, tier), `tier ${tier}: \`${key}\` is expressible, as the SDK says`);
  }
  // The other direction: nothing the table thinks is legal is absent from the
  // SDK's union. This is the one that catches a stale MAX-tier.
  const known = new Set<string>([...TIERS[1]!.keys(), ...UNWRITABLE_BLOCK_TYPES]);
  for (const key of known) {
    if (sdk.has(key)) continue;
    assert(
      !isExpressibleAtTier(key, tier),
      `tier ${tier}: \`${key}\` is absent from the SDK union and the table agrees it is not expressible`
    );
  }
}

console.log("\n[children] required / optional / not accepted, per tier");
for (let tier = 1; tier <= MAX_REQUEST_TIER; tier++) {
  for (const [key, b] of TIERS[tier]!) {
    if (NARROWED.some((n) => n.type === key && n.tier === tier)) continue;
    if (!isExpressibleAtTier(key, tier)) continue;
    eq(
      childrenAllowedAtTier(key, tier),
      b.children !== "none",
      `tier ${tier}: \`${key}\` ${b.children === "none" ? "cannot" : "can"} carry children`
    );
  }
}

console.log("\n[children] the REQUIRED ones — the class that produced the tab bug");
{
  // A type's `children` requiredness must be consistent across every tier that
  // accepts children at all, because the table records it as a single flag.
  const requiredInSdk = new Set<string>();
  const optionalInSdk = new Set<string>();
  for (let tier = 1; tier <= MAX_REQUEST_TIER; tier++) {
    for (const [key, b] of TIERS[tier]!) {
      if (b.children === "required") requiredInSdk.add(key);
      if (b.children === "optional") optionalInSdk.add(key);
    }
  }
  eq(
    [...requiredInSdk].sort(),
    ["column", "column_list", "tab", "table"],
    "exactly four types make `children` required"
  );
  for (const key of requiredInSdk) {
    assert(requiresChildren(key), `\`${key}.children\` is required, and the table says so`);
    assert(!optionalInSdk.has(key), `…and \`${key}\` is never optional-children at another tier`);
  }
  for (const key of optionalInSdk) {
    assert(!requiresChildren(key), `\`${key}.children\` is optional, and the table says so`);
  }
}

console.log("\n[child types] the containers whose children the schema constrains");
{
  // tab takes paragraphs, table takes rows, column_list takes columns. Each is
  // encoded as a `childTypes` allow-list; the SDK states it by naming a
  // dedicated element type rather than the generic tier union.
  const cases: Array<[string, number, string, string[]]> = [
    ["tab", 1, "TabItemRequestWithSingleLevelOfChildren", ["paragraph"]],
    ["tab", 2, "TabItemRequestWithoutChildren", ["paragraph"]],
    ["table", 1, "TableRowRequest", ["table_row"]],
    ["column_list", 1, "ColumnBlockWithChildrenRequest", ["column"]],
  ];
  for (const [key, tier, expectedElem, expectedChildTypes] of cases) {
    eq(TIERS[tier]!.get(key)?.childrenOf, expectedElem, `SDK: \`${key}\`@${tier} children are ${expectedElem}`);
    eq(
      [...(blockWriteRule(key).childTypes ?? [])],
      expectedChildTypes,
      `table: \`${key}\` accepts only ${expectedChildTypes.join("/")}`
    );
  }
  // …and the element type really does hold what the allow-list claims.
  for (const [elem, blockKey] of [
    ["TabItemRequestWithSingleLevelOfChildren", "paragraph"],
    ["TabItemRequestWithoutChildren", "paragraph"],
    ["TableRowRequest", "table_row"],
    ["ColumnBlockWithChildrenRequest", "column"],
  ] as const) {
    const body = DECLS.get(elem) ?? "";
    assert(
      new RegExp(`^ {4}${blockKey}: `, "m").test(body),
      `SDK: ${elem} really is a \`${blockKey}\` block`
    );
  }
}

console.log("\n[column_list] the tier delta that makes a column not consume a level");
{
  // column_list's children are a DEDICATED column type, not the tier-2 union —
  // which is why the table gives column_list childTierDelta 0 and column
  // childTierDelta 1: column_list@1 → column@1 → content@2.
  eq(blockWriteRule("column_list").childTierDelta, 0, "table: a column does not consume a nesting level");
  eq(blockWriteRule("column").childTierDelta, 1, "table: a column's CONTENT does");
  const columnBody = DECLS.get("ColumnWithChildrenRequest") ?? "";
  assert(
    columnBody.includes("Array<BlockObjectWithSingleLevelOfChildrenRequest>"),
    "SDK: a column's children are the tier-2 union, confirming the +1"
  );
}

console.log("\n[required body fields] what each payload declares non-optional");
{
  const expected: Record<string, string[]> = {
    code: ["language", "rich_text"],
    equation: ["expression"],
    table_row: ["cells"],
    table: ["table_width"],
    synced_block: ["synced_from"],
  };
  for (const [key, want] of Object.entries(expected)) {
    const b = TIERS[1]!.get(key) ?? TIERS[2]!.get(key);
    eq([...(b?.requiredFields ?? [])].sort(), [...want].sort(), `SDK: \`${key}\` requires ${want.join(", ")}`);
  }
}

console.log("\n[unwritable] types with no create shape anywhere");
{
  for (const key of UNWRITABLE_BLOCK_TYPES) {
    for (let tier = 1; tier <= MAX_REQUEST_TIER; tier++) {
      assert(!TIERS[tier]!.has(key), `\`${key}\` has no request shape at tier ${tier}`);
    }
  }
  // The rename that landed in 2026-03-11. Neither name has a create shape, so
  // the write side needs nothing — but assert it rather than assume it.
  for (const key of ["transcription", "meeting_notes"]) {
    for (let tier = 1; tier <= MAX_REQUEST_TIER; tier++) {
      assert(!TIERS[tier]!.has(key), `\`${key}\` has no request shape at tier ${tier} either`);
    }
  }
}

// -----------------------------------------------------------------------------
// 2026-03-11: `position` replaced `after` on append
// -----------------------------------------------------------------------------

console.log("\n[2026-03-11] the append endpoint's `position` parameter");
{
  const params = blocks.match(/type AppendBlockChildrenBodyParameters = \{[\s\S]*?\n\};/)?.[0] ?? "";
  assert(params.length > 0, "found AppendBlockChildrenBodyParameters");
  assert(/\n {4}position\?: ContentPositionSchema;/.test(params), "…it takes `position?: ContentPositionSchema`");
  assert(/@deprecated Use `position` instead/.test(params), "…and `after` is marked deprecated, as the guide says");

  const schema = DECLS.get("ContentPositionSchema") ?? "";
  assert(schema.includes('type: "after_block"'), "ContentPositionSchema has an `after_block` arm");
  assert(/after_block: \{/.test(schema), "…whose payload is an object (not a bare id string)");
  assert(schema.includes('type: "start"'), "…a `start` arm");
  assert(schema.includes('type: "end"'), "…and an `end` arm");
}

// -----------------------------------------------------------------------------
console.log(`\n=== write schema vs SDK: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
