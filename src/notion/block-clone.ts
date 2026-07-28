// -----------------------------------------------------------------------------
// Response-shape block tree → request-shape block tree.
//
// This is the one place that turns blocks we READ into blocks we WRITE. Before
// this file existed there were two of them — duplicate_page's `toBlockRequest`
// and apply_template's `cloneBlockForRequest` — and they drifted: the null-icon
// fix landed in one and had to be back-ported, the hosted-file rewrite landed
// in one and never reached the other, and the `tab.children` requirement
// reached neither. Every decision here is derived from ./block-write-schema.ts
// so there is a single table to update when Notion adds a block type.
//
// The two callers differ only in what they do with a block that has no write
// shape at all (duplicate_page leaves a visible placeholder; apply_template
// drops it), so that is the one thing they pass in.
//
// DEFERRAL
//
// Notion's request schema stops accepting nested `children` past a fixed depth,
// and stops accepting some block types earlier than that (see block-write-schema).
// When a subtree won't fit at the tier it landed on, we do NOT drop it and we do
// NOT emit an invalid body: we record it as `pending` and the caller appends it
// in a follow-up request, where it starts again at tier 1. That is why the
// clone result is a tree of ClonedBlock rather than a bare BlockRequest[].
// -----------------------------------------------------------------------------

import type { NotionBlockObject, NotionClient } from "./client";
import type { HydratedBlock } from "./markdown/from-blocks";
import type { BlockRequest } from "./markdown/to-blocks";
import {
  MEDIA_BLOCK_TYPES,
  UNWRITABLE_BLOCK_TYPES,
  blockWriteRule,
  childTierFor,
  childrenAllowedAtTier,
  isExpressibleAtTier,
} from "./block-write-schema";

/** Notion's per-call cap on `children`. */
export const CHILDREN_PER_REQUEST = 100;

/**
 * Why a source block could not be turned into a request block at all. The
 * caller decides whether that becomes a visible placeholder or a silent skip.
 */
export type UnclonableKind =
  /** child_database / unsupported / ai_block — no create shape exists. */
  | "no_write_shape"
  /** child_page — creating it means a separate page-create call, not a block. */
  | "child_page"
  /** A synced_block mirroring a block elsewhere; the link can't be recreated. */
  | "synced_reference";

export interface ClonePolicy {
  /** Substitute request for an unclonable block, or null to drop it. */
  substitute(block: HydratedBlock, kind: UnclonableKind): BlockRequest | null;
  /**
   * What to do with a synced_block that MIRRORS another block.
   *
   * `keep-link` re-emits the reference pointing at the same original — right
   * for apply_template, where the original is a block in the same workspace
   * that the new page can legitimately mirror.
   *
   * `substitute` hands it to substitute() — right for duplicate_page, which may
   * be copying into a context where mirroring the source is not what was asked
   * for, and which has always left a visible note instead.
   */
  syncedReference: "keep-link" | "substitute";
}

export interface ClonedBlock {
  /** Ready to send as one entry of a `children` array. */
  request: BlockRequest;
  /**
   * Source children that would not fit inline at this tier. The caller appends
   * them under this block once it exists — see resolvePendingChildren().
   */
  pending?: HydratedBlock[];
  /** Clone results for children that WERE inlined, index-aligned with them. */
  inlined?: ClonedBlock[];
}

/**
 * Sentinel: "this block cannot be expressed at the tier it was offered".
 * Never escapes this module — the parent turns it into `pending`, and the root
 * flattens it.
 */
const DEFER = Symbol("defer");
type Outcome = ClonedBlock | null | typeof DEFER;

/**
 * Strip response-only null fields from a block's type-body object in place.
 *
 * Notion's GET responses include fields like `icon: null`, `color: null`,
 * `caption: null` on most block bodies, but the POST/PATCH schema rejects
 * `null` for those — they must be an object or absent. One exception:
 * `synced_from: null` is the meaningful signal for a synced_block ORIGINAL
 * (vs a reference), so it survives.
 *
 * Kept exported because both tool paths and their regression tests reference it
 * by name; it is the fix for the first bug in this family.
 */
export function stripResponseOnlyNulls(body: Record<string, unknown>, type: string): void {
  for (const key of Object.keys(body)) {
    if (body[key] === null) {
      if (type === "synced_block" && key === "synced_from") continue;
      delete body[key];
    }
  }
}

/**
 * Media blocks read back as `{ type: "file", file: { url, expiry_time } }`,
 * a shape the write schema does not accept in any form — it takes `external`
 * or `file_upload`. Re-point at the signed URL as an external link so the block
 * still renders. The URL expires when the source's does; that is the best the
 * public API allows without re-uploading the bytes.
 */
function rewriteHostedMedia(body: Record<string, unknown>, type: string): void {
  if (!MEDIA_BLOCK_TYPES.has(type)) return;
  if (body.type !== "file" || !body.file || typeof body.file !== "object") return;
  const file = body.file as { url?: string };
  if (!file.url) return;
  body.type = "external";
  body.external = { url: file.url };
  delete body.file;
}

/**
 * Clone a list of hydrated blocks for a request at `tier`.
 *
 * Tier 1 is the top level of a `children` array on create/append. Callers
 * outside this module should always pass 1 (the default) — deeper tiers are an
 * internal consequence of inlining.
 */
export function cloneBlockTree(
  blocks: HydratedBlock[],
  policy: ClonePolicy,
  tier = 1
): ClonedBlock[] {
  const out: ClonedBlock[] = [];
  for (const block of blocks) {
    const outcome = cloneOne(block, policy, tier);
    if (outcome === DEFER) {
      // There is no shallower tier to move it to, so keep the contents and lose
      // only the wrapper. Reachable only through degenerate shapes (e.g. a
      // column_list left with fewer than the two columns Notion requires).
      out.push(...cloneBlockTree(unwrapForFlatten(block), policy, tier));
    } else if (outcome) {
      out.push(outcome);
    }
  }
  return out;
}

/**
 * Single-block clone. Returns null when the block should vanish, DEFER when it
 * cannot be expressed at this tier, otherwise the request plus whatever still
 * needs appending afterwards.
 */
function cloneOne(block: HydratedBlock, policy: ClonePolicy, tier: number): Outcome {
  const type = block.type;
  if (!type) return null;

  if (type === "child_page") return fromSubstitute(policy.substitute(block, "child_page"));
  if (UNWRITABLE_BLOCK_TYPES.has(type)) {
    return fromSubstitute(policy.substitute(block, "no_write_shape"));
  }

  const rawBody = (block as unknown as Record<string, unknown>)[type];
  if (!rawBody || typeof rawBody !== "object") return null;

  // A synced_block with `synced_from` set MIRRORS a block elsewhere; its
  // children belong to that original and must not be re-sent, or the copy ends
  // up owning content it is supposed to be reflecting.
  const syncedFrom = type === "synced_block" ? (rawBody as Record<string, unknown>).synced_from : undefined;
  if (syncedFrom) {
    if (policy.syncedReference === "substitute") {
      return fromSubstitute(policy.substitute(block, "synced_reference"));
    }
    const blockId = (syncedFrom as { block_id?: unknown }).block_id;
    if (typeof blockId !== "string") return fromSubstitute(policy.substitute(block, "synced_reference"));
    return {
      request: { type, synced_block: { synced_from: { type: "block_id", block_id: blockId } } },
    };
  }

  if (!isExpressibleAtTier(type, tier)) return DEFER;

  // Deep clone so we never alias the caller's response objects.
  const payload = JSON.parse(JSON.stringify(rawBody)) as Record<string, unknown>;
  // Any `children` the response inlined is rebuilt from the hydrated tree below,
  // so it never survives from the response side.
  delete payload.children;
  stripResponseOnlyNulls(payload, type);
  rewriteHostedMedia(payload, type);

  const request: BlockRequest = { type, [type]: payload };
  const rule = blockWriteRule(type);
  const kids = childrenFor(block, type);
  const canCarryChildren = childrenAllowedAtTier(type, tier);
  const childTier = childTierFor(type, tier);

  if (rule.childrenRequired) {
    // `children` is not optional here — omitting it is an outright 400 naming a
    // field the user never supplied. If we can't populate it, the block cannot
    // be sent at this tier at all.
    if (!canCarryChildren) return DEFER;
    const { inlined, deferred } = cloneMany(kids, policy, childTier);
    if (inlined.length < (rule.minChildren ?? 1)) return DEFER;
    payload.children = inlined.map((c) => c.request);
    return deferred.length > 0
      ? { request, inlined, pending: deferred }
      : { request, inlined };
  }

  if (kids.length === 0) return { request };

  if (canCarryChildren) {
    const { inlined, deferred } = cloneMany(kids, policy, childTier);
    if (deferred.length === 0) {
      if (inlined.length > 0) payload.children = inlined.map((c) => c.request);
      return { request, inlined };
    }
  }

  // Optional children we can't inline. Defer the WHOLE level rather than a
  // subset: appended blocks land at the end, so splitting a level would
  // reorder it. One follow-up request keeps the original order intact.
  return { request, pending: kids };
}

function cloneMany(
  blocks: HydratedBlock[],
  policy: ClonePolicy,
  tier: number
): { inlined: ClonedBlock[]; deferred: HydratedBlock[] } {
  const inlined: ClonedBlock[] = [];
  const deferred: HydratedBlock[] = [];
  for (const block of blocks) {
    const outcome = cloneOne(block, policy, tier);
    if (outcome === DEFER) deferred.push(block);
    else if (outcome) inlined.push(outcome);
  }
  return { inlined, deferred };
}

/**
 * Children we are willing to offer to the request, filtered by what the write
 * schema says this container accepts. Notion's own responses already satisfy
 * this (a tab's children really are all paragraphs); the filter exists so a
 * surprise child type degrades to "one block missing" instead of a 400 that
 * takes the entire page with it.
 */
function childrenFor(block: HydratedBlock, type: string): HydratedBlock[] {
  const kids = block.children ?? [];
  const allowed = blockWriteRule(type).childTypes;
  if (!allowed) return kids;
  return kids.filter((k) => typeof k.type === "string" && allowed.includes(k.type));
}

/**
 * What to promote in place of a block we had to give up on. A bare `column`
 * outside a `column_list` is not a valid block, so a discarded column_list
 * flattens to its columns' contents rather than to the columns themselves.
 */
function unwrapForFlatten(block: HydratedBlock): HydratedBlock[] {
  const kids = block.children ?? [];
  return kids.flatMap((k) => (k.type === "column" ? k.children ?? [] : [k]));
}

function fromSubstitute(request: BlockRequest | null): ClonedBlock | null {
  return request ? { request } : null;
}

// -----------------------------------------------------------------------------
// Appending — resolving whatever the request body couldn't carry
// -----------------------------------------------------------------------------

/** Does anything in this cloned tree still need a follow-up append? */
export function hasPendingWork(cloned: ClonedBlock[]): boolean {
  return cloned.some(
    (c) => (c.pending && c.pending.length > 0) || (c.inlined ? hasPendingWork(c.inlined) : false)
  );
}

/** Append request blocks under `parentId` in 100-item chunks, collecting the
 *  blocks Notion created so callers can address them by id. */
export async function appendInChunks(
  client: Pick<NotionClient, "appendBlockChildren">,
  parentId: string,
  blocks: BlockRequest[]
): Promise<NotionBlockObject[]> {
  const created: NotionBlockObject[] = [];
  for (let i = 0; i < blocks.length; i += CHILDREN_PER_REQUEST) {
    const slice = blocks.slice(i, i + CHILDREN_PER_REQUEST);
    const res = await client.appendBlockChildren(parentId, { children: slice });
    const results = (res as { results?: unknown })?.results;
    if (Array.isArray(results)) created.push(...(results as NotionBlockObject[]));
  }
  return created;
}

type AppendClient = Pick<NotionClient, "appendBlockChildren" | "listAllBlockChildren">;

/**
 * Append a cloned tree under `parentId` and then resolve everything the request
 * bodies couldn't carry inline.
 *
 * Uses the append RESPONSE to address the new blocks rather than re-listing the
 * parent's children, because the parent may already have content — re-listing
 * would pair our clones against blocks that were there before.
 */
export async function appendClonedTree(
  client: AppendClient,
  parentId: string,
  cloned: ClonedBlock[],
  policy: ClonePolicy
): Promise<void> {
  const created = await appendInChunks(client, parentId, cloned.map((c) => c.request));
  if (!hasPendingWork(cloned)) return;
  await resolveAgainst(client, created, cloned, policy);
}

/**
 * Resolve pending children for blocks that already exist as `parentId`'s
 * children, in the same order as `cloned`. Used after a page create, where the
 * parent is new and therefore holds exactly these blocks and nothing else.
 */
export async function resolvePendingChildren(
  client: AppendClient,
  parentId: string,
  cloned: ClonedBlock[],
  policy: ClonePolicy
): Promise<void> {
  if (!hasPendingWork(cloned)) return;
  const created = await client.listAllBlockChildren(parentId);
  await resolveAgainst(client, created, cloned, policy);
}

async function resolveAgainst(
  client: AppendClient,
  created: NotionBlockObject[],
  cloned: ClonedBlock[],
  policy: ClonePolicy
): Promise<void> {
  // `cloned` holds one entry per block we actually emitted, in emit order, so
  // pairing by index is sound — blocks we skipped never entered the array.
  // A short `created` list (a client that doesn't echo results) simply means we
  // resolve fewer subtrees rather than grafting content onto the wrong block.
  const n = Math.min(created.length, cloned.length);
  for (let i = 0; i < n; i++) {
    const c = cloned[i]!;
    const dst = created[i]!;

    // Inlined children first: their ids come from listing this block's children,
    // which is only unambiguous while the inlined set is all that's there.
    if (c.inlined && c.inlined.length > 0 && hasPendingWork(c.inlined)) {
      const grandchildren = await client.listAllBlockChildren(dst.id);
      await resolveAgainst(client, grandchildren, c.inlined, policy);
    }

    if (c.pending && c.pending.length > 0) {
      const sub = cloneBlockTree(c.pending, policy, 1);
      if (sub.length > 0) await appendClonedTree(client, dst.id, sub, policy);
    }
  }
}
