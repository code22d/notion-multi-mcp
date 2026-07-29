// -----------------------------------------------------------------------------
// Notion's block WRITE schema, expressed as a table we can reason about.
//
// WHY THIS FILE EXISTS
//
// Three separate production bugs in this repo have now had the same shape: we
// took a block out of a GET response, handed it back to a POST/PATCH, and
// Notion rejected a field the *write* schema treats differently from the *read*
// schema.
//
//   1. `icon should be an object or undefined, instead was null`
//      → response-only nulls; fixed by stripResponseOnlyNulls().
//   2. `body.children[1].tab.children should be defined, instead was undefined`
//      → `tab` is the first container whose `children` the write schema makes
//        REQUIRED. The read shape is `{ type: "tab", tab: {} }`, so a naive
//        clone emits `tab: {}` and the whole request 400s.
//   3. media blocks read back as `{ type: "file", file: { url, expiry_time } }`,
//      a shape the write schema does not accept at all (external|file_upload).
//
// Every one of those was invisible to the test suite, because the suite stubs
// `fetch` and a stub accepts any body. The fix for the CLASS — not just the
// instance — is to write the write-schema down once, derive the clone path's
// decisions from it, and let tests assert emitted bodies against it.
//
// SOURCE OF TRUTH
//
// The table below is transcribed from the request types generated from Notion's
// own OpenAPI schema, vendored in this repo as a devDependency:
//   node_modules/@notionhq/client/build/src/api-endpoints/common.d.ts
// specifically the three depth-tiered request unions:
//   BlockObjectRequest                          (tier 1)
//   BlockObjectWithSingleLevelOfChildrenRequest (tier 2)
//   BlockObjectRequestWithoutChildren           (tier 3)
//
// THE TIER MODEL — the part that is easy to get wrong
//
// Notion does not accept arbitrarily deep `children` nesting in one request.
// The schema encodes the limit by *retyping* the children array at each level,
// and crucially the set of legal block types SHRINKS as you go deeper:
//
//   tier 1  every block type
//   tier 2  no `column_list`, no `column`
//   tier 3  no `column_list`, no `column`, no `table`; nothing carries children
//
// So "which types can be nested inline" is not one flat list (which is what
// duplicate_page's old `supportsInlineChildren()` assumed) — it depends on how
// deep in the request body you already are. A `column_list` inlined under a
// toggle is invalid no matter how valid it is at the top level.
//
// Anything a tier won't carry is not lost: the caller appends it in a follow-up
// request, where it starts again at tier 1.
// -----------------------------------------------------------------------------

/** Deepest tier the request schema defines. Tier 3 blocks carry no children. */
export const MAX_REQUEST_TIER = 3;

export interface BlockWriteRule {
  /** Does the write schema make `children` REQUIRED on this type? */
  childrenRequired: boolean;
  /** Deepest tier at which this block type may appear at all. */
  maxTier: number;
  /** Deepest tier at which it may carry a `children` array. 0 = never. */
  maxChildrenTier: number;
  /**
   * Tier its children occupy, relative to its own. Normally +1. `column_list`
   * is the exception: the schema gives it a dedicated `ColumnBlockWithChildren`
   * child type rather than the generic tier-2 union, so a column does NOT
   * consume a nesting level — column_list@1 → column@1 → content@2 → content@3.
   */
  childTierDelta: number;
  /** Fewest children a valid request may carry. Only meaningful when required. */
  minChildren?: number;
  /** Block types the schema permits as direct children, when it constrains them. */
  childTypes?: readonly string[];
}

/** A block that cannot carry children on write. */
const LEAF: BlockWriteRule = {
  childrenRequired: false,
  maxTier: MAX_REQUEST_TIER,
  maxChildrenTier: 0,
  childTierDelta: 1,
};

/** The common container shape: `children?` accepted at tiers 1–2, never at 3. */
const OPTIONAL_CHILDREN: BlockWriteRule = {
  childrenRequired: false,
  maxTier: MAX_REQUEST_TIER,
  maxChildrenTier: 2,
  childTierDelta: 1,
};

const RULES: Readonly<Record<string, BlockWriteRule>> = {
  // --- containers whose `children` is OPTIONAL -------------------------------
  paragraph: OPTIONAL_CHILDREN,
  bulleted_list_item: OPTIONAL_CHILDREN,
  numbered_list_item: OPTIONAL_CHILDREN,
  to_do: OPTIONAL_CHILDREN,
  toggle: OPTIONAL_CHILDREN,
  quote: OPTIONAL_CHILDREN,
  callout: OPTIONAL_CHILDREN,
  template: OPTIONAL_CHILDREN,
  heading_1: OPTIONAL_CHILDREN,
  heading_2: OPTIONAL_CHILDREN,
  heading_3: OPTIONAL_CHILDREN,
  heading_4: OPTIONAL_CHILDREN,
  synced_block: OPTIONAL_CHILDREN,

  // --- containers whose `children` is REQUIRED -------------------------------
  //
  // `tab` (2026-03-25). Read shape is `{ tab: {} }`; write shape is
  // `{ tab: { children: [...] } }` where every child MUST be a paragraph —
  // the paragraph's rich_text is the tab label, its `icon` the tab icon and
  // its `children` the tab's body.
  //
  // maxTier is 2 here, not 3, deliberately. The generated schema does define a
  // tier-3 `tab: EmptyObject` — a tab block with no tabs in it. We refuse to
  // emit that: it would mean silently dropping every tab's content and then
  // hoping a follow-up append can graft paragraphs onto a tab block, which is
  // unverified. Deferring the block to its own request instead is lossless.
  tab: {
    childrenRequired: true,
    maxTier: 2,
    maxChildrenTier: 2,
    childTierDelta: 1,
    minChildren: 1,
    childTypes: ["paragraph"],
  },
  // `table` also carries a REQUIRED `table_width` that must match the cell
  // count of every row. Absent from the tier-3 union entirely.
  table: {
    childrenRequired: true,
    maxTier: 2,
    maxChildrenTier: 2,
    childTierDelta: 1,
    minChildren: 1,
    childTypes: ["table_row"],
  },
  // Notion requires at least two columns in a column_list. Tier 1 only.
  column_list: {
    childrenRequired: true,
    maxTier: 1,
    maxChildrenTier: 1,
    childTierDelta: 0,
    minChildren: 2,
    childTypes: ["column"],
  },
  column: {
    childrenRequired: true,
    maxTier: 1,
    maxChildrenTier: 1,
    childTierDelta: 1,
    minChildren: 1,
  },
};

/**
 * Block types Notion returns on read but defines NO create shape for. Cloning
 * one is not a "fix the payload" problem — there is nothing to send.
 */
export const UNWRITABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "child_page",
  "child_database",
  "unsupported",
  "ai_block",
]);

/** Media blocks whose write body accepts only `external` or `file_upload`. */
export const MEDIA_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "image",
  "video",
  "pdf",
  "audio",
  "file",
]);

/**
 * Fields Notion returns on every block object but rejects on write.
 *
 * `object` is deliberately NOT in this set even though every read response
 * carries it. The generated request types declare `object?: "block"` on every
 * alternative (see `TableRowRequest`, `ColumnBlockWithChildrenRequest`), so the
 * write schema accepts it and reporting it would be a wrong verdict — the one
 * thing a diagnostic nobody can run against the real API must not produce.
 */
export const RESPONSE_ONLY_BLOCK_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "has_children",
  "archived",
  "in_trash",
  "parent",
  "request_id",
]);

/** Fields the write schema requires inside a given type body. */
const REQUIRED_BODY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  code: ["language", "rich_text"],
  equation: ["expression"],
  table_row: ["cells"],
  table: ["table_width"],
  // `synced_from` is required but nullable — null means "this is an original".
  synced_block: ["synced_from"],
};

export function blockWriteRule(type: string): BlockWriteRule {
  return RULES[type] ?? LEAF;
}

/** Does the write schema reject this block unless `children` is populated? */
export function requiresChildren(type: string): boolean {
  return blockWriteRule(type).childrenRequired;
}

/** May a block of this type appear at all at `tier` of a request body? */
export function isExpressibleAtTier(type: string, tier: number): boolean {
  if (UNWRITABLE_BLOCK_TYPES.has(type)) return false;
  return tier >= 1 && tier <= blockWriteRule(type).maxTier;
}

/** May a block of this type carry a `children` array at `tier`? */
export function childrenAllowedAtTier(type: string, tier: number): boolean {
  const rule = blockWriteRule(type);
  return rule.maxChildrenTier > 0 && tier <= rule.maxChildrenTier;
}

/** Which tier this block's inline children occupy. */
export function childTierFor(type: string, tier: number): number {
  return tier + blockWriteRule(type).childTierDelta;
}

// -----------------------------------------------------------------------------
// Validator
// -----------------------------------------------------------------------------

export interface BlockRequestProblem {
  /** JSON-ish path into the request body, e.g. `children[1].tab.children[0]`. */
  path: string;
  message: string;
}

/**
 * Check a request-shaped block array against the write schema and return every
 * problem found. Empty array = the body is well-formed as far as this table
 * knows.
 *
 * This is deliberately a pure function over the emitted body rather than an
 * assertion inside the client: the point is that a TEST can hold the exact
 * bytes we would have PUT on the wire and say "Notion would reject this",
 * without a network call. A stubbed `fetch` cannot do that — it accepts
 * anything — which is precisely why the tab bug shipped green.
 *
 * It is not a substitute for Notion's own validation and does not claim to be
 * complete; it encodes what the generated request types state outright.
 */
export function validateBlockRequestTree(
  blocks: unknown,
  tier = 1,
  path = "children"
): BlockRequestProblem[] {
  const problems: BlockRequestProblem[] = [];
  if (!Array.isArray(blocks)) {
    return [{ path, message: `expected an array of blocks, got ${typeof blocks}` }];
  }
  blocks.forEach((raw, i) => {
    problems.push(...validateOne(raw, tier, `${path}[${i}]`));
  });
  return problems;
}

function validateOne(raw: unknown, tier: number, path: string): BlockRequestProblem[] {
  const problems: BlockRequestProblem[] = [];
  const push = (message: string) => problems.push({ path, message });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    push(`expected a block object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
    return problems;
  }
  const block = raw as Record<string, unknown>;

  const type = block.type;
  if (typeof type !== "string" || !type) {
    push("block has no `type`");
    return problems;
  }

  for (const field of RESPONSE_ONLY_BLOCK_FIELDS) {
    if (field in block) push(`carries response-only field \`${field}\` — write schema rejects it`);
  }

  if (UNWRITABLE_BLOCK_TYPES.has(type)) {
    push(`\`${type}\` has no create shape in the write schema and cannot be sent`);
    return problems;
  }
  if (!isExpressibleAtTier(type, tier)) {
    push(
      `\`${type}\` is not part of the request schema at nesting tier ${tier} ` +
        `(max tier ${blockWriteRule(type).maxTier}) — it must be appended in its own request`
    );
  }

  const body = block[type];
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    push(`\`${type}\` body is missing or not an object`);
    return problems;
  }
  const typeBody = body as Record<string, unknown>;

  // The stripResponseOnlyNulls class of bug: a null the read shape supplies
  // and the write shape refuses. synced_from: null is the one real signal.
  for (const [key, value] of Object.entries(typeBody)) {
    if (value !== null) continue;
    if (type === "synced_block" && key === "synced_from") continue;
    push(`\`${type}.${key}\` is null — the write schema wants an object or absence`);
  }

  for (const field of REQUIRED_BODY_FIELDS[type] ?? []) {
    if (!(field in typeBody)) push(`\`${type}.${field}\` is required by the write schema`);
  }

  if (MEDIA_BLOCK_TYPES.has(type)) {
    const kind = typeBody.type;
    if (kind !== undefined && kind !== "external" && kind !== "file_upload") {
      push(
        `\`${type}.type\` is "${String(kind)}" — media blocks accept only ` +
          `"external" or "file_upload" on write (a read-back \`file\` must be rewritten)`
      );
    }
    if ("file" in typeBody) {
      push(`\`${type}.file\` is a response-only shape — write schema takes \`external\`/\`file_upload\``);
    }
    // The union discriminates on the SOURCE KEY, not on `type` — `type` is
    // optional in both arms (`{ external: … }` / `{ file_upload: … }`). A body
    // carrying neither matches no arm however well-formed its `type` looks,
    // and checking `type` alone silently passed it.
    if (!("external" in typeBody) && !("file_upload" in typeBody)) {
      push(
        `\`${type}\` carries neither \`external\` nor \`file_upload\` — the write ` +
          `schema has no arm for a media block without a source`
      );
    }
  }

  // --- children --------------------------------------------------------------
  const rule = blockWriteRule(type);
  const children = typeBody.children;
  const hasChildren = children !== undefined;

  if (hasChildren && !childrenAllowedAtTier(type, tier)) {
    push(
      `\`${type}\` may not carry \`children\` at nesting tier ${tier} ` +
        `(children accepted up to tier ${rule.maxChildrenTier || 0})`
    );
  }
  if (rule.childrenRequired) {
    if (!hasChildren) {
      push(`\`${type}.children\` is required by the write schema but is absent`);
    } else if (!Array.isArray(children)) {
      push(`\`${type}.children\` must be an array`);
    } else if (children.length < (rule.minChildren ?? 1)) {
      push(
        `\`${type}.children\` has ${children.length} entries — the write schema ` +
          `requires at least ${rule.minChildren ?? 1}`
      );
    }
  }

  if (Array.isArray(children)) {
    if (rule.childTypes) {
      children.forEach((c, i) => {
        const ct = (c as Record<string, unknown> | null)?.type;
        if (typeof ct === "string" && !rule.childTypes!.includes(ct)) {
          problems.push({
            path: `${path}.${type}.children[${i}]`,
            message: `\`${type}\` accepts only ${rule.childTypes!.join("/")} children, got \`${ct}\``,
          });
        }
      });
    }
    problems.push(
      ...validateBlockRequestTree(children, childTierFor(type, tier), `${path}.${type}.children`)
    );
  }

  return problems;
}

/** Convenience for tests/assertions: a one-line summary of every problem. */
export function describeBlockRequestProblems(problems: BlockRequestProblem[]): string {
  return problems.map((p) => `${p.path}: ${p.message}`).join("\n");
}
