// -----------------------------------------------------------------------------
// notion_update_page — "update_properties" command.
//
// Matches the native Notion MCP's SQLite-style flat property map:
//   - Scalars (string | number | null) as values
//   - Date props split into "date:{name}:start|end|is_datetime"
//   - Place props split into "place:{name}:{name|address|latitude|longitude|google_place_id}"
//   - Checkbox props use "__YES__" / "__NO__"
//   - Number props use JS numbers
//   - Properties named "id" or "url" are prefixed "userDefined:" on the wire
//
// We normalise that flat format into Notion's native property value shape.
// We also keep backward-compat with callers who pass full Notion values
// directly (object values pass through unchanged), mirroring what
// notion_create_pages accepts.
// -----------------------------------------------------------------------------

import type { NotionClient } from "../../notion/client";
import { textErr, textOk, normalizeIconInput, normalizeCoverInput } from "./shared";
import type { ToolResult } from "../../mcp/types";
import {
  coerceScalarToPropertyValue,
  needsTypeResolution,
  resolveTypesForPage,
  UNKNOWN_TYPES,
  type PropertyTypeResolver,
} from "../../notion/property-values";

export interface UpdatePropertiesArgs {
  properties?: unknown;
  cover?: unknown;
  icon?: unknown;
  /** Special-case for page archive/trash — set via `properties.archived` or `properties.in_trash`. */
}

export async function updatePropertiesHandler(
  client: NotionClient,
  pageId: string,
  args: UpdatePropertiesArgs
): Promise<ToolResult> {
  const body: Record<string, unknown> = {};

  // properties — only required when the command is update_properties; may be
  // empty for the other commands (cover/icon/archive set alongside any command).
  const propsRaw = args.properties;

  // Ask the schema what these columns actually are before serializing. Only
  // worth a round trip when at least one value is an ambiguous bare string —
  // numbers, booleans, arrays and native property objects already carry their
  // own shape. Fails soft to the legacy heuristic (see property-values.ts).
  let resolveType: PropertyTypeResolver = UNKNOWN_TYPES;
  if (rawNeedsTypeResolution(propsRaw)) {
    resolveType = await resolveTypesForPage(client, pageId);
  }

  const { notionProps, inTrash, isLocked, error } = normaliseProperties(propsRaw, resolveType);
  if (error) return textErr(error);
  if (notionProps && Object.keys(notionProps).length > 0) {
    body.properties = notionProps;
  }
  // `archived` is removed from requests in 2026-03-11; `in_trash` replaced it.
  // We still ACCEPT `archived` from callers — it is a documented alias in the
  // tool schema and dropping it would break anyone using it — but it is
  // translated in normaliseProperties() and never reaches the wire.
  if (inTrash !== undefined) body.in_trash = inTrash;
  if (isLocked !== undefined) body.is_locked = isLocked;

  const icon = normalizeIconInput(args.icon);
  if (icon !== undefined) body.icon = icon;
  const cover = normalizeCoverInput(args.cover);
  if (cover !== undefined) body.cover = cover;

  if (Object.keys(body).length === 0) {
    return textErr("update_properties requires at least one of: properties, cover, icon.");
  }

  await client.updatePage(pageId, body);

  const touched: string[] = [];
  if (body.properties) touched.push(`${Object.keys(body.properties as Record<string, unknown>).length} properties`);
  if (body.cover !== undefined) touched.push(body.cover === null ? "cover removed" : "cover set");
  if (body.icon !== undefined) touched.push(body.icon === null ? "icon removed" : "icon set");
  if (body.in_trash !== undefined) touched.push(body.in_trash ? "moved to trash" : "restored from trash");
  if (body.is_locked !== undefined) touched.push(body.is_locked ? "locked" : "unlocked");
  return textOk(`Updated page ${pageId} — ${touched.join(", ")}.`);
}

export interface NormalisedProps {
  notionProps: Record<string, unknown>;
  /**
   * PATCH /v1/pages `in_trash`. A caller's `archived` key lands here too —
   * 2026-03-11 removed `archived` from the API, but it stays a valid INPUT
   * alias, so the translation happens here rather than at the wire.
   */
  inTrash?: boolean;
  /** PATCH /v1/pages `is_locked` — lock the page against edits in the UI. */
  isLocked?: boolean;
  error?: string;
}

/** Pre-scan the flat property bag for values whose target shape we can't
 *  determine without the schema. Mirrors the key handling in
 *  normaliseProperties() below so we never fetch a schema we won't use. */
export function rawNeedsTypeResolution(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const candidates: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    // Composite keys declare their own intent — never ambiguous.
    if (/^date:(.+):(start|end|is_datetime)$/.test(rawKey)) continue;
    if (/^place:(.+):(name|address|latitude|longitude|google_place_id)$/.test(rawKey)) continue;
    let key = rawKey;
    if (key.startsWith("userDefined:")) key = key.slice("userDefined:".length);
    if (key === "archived" || key === "in_trash") continue;
    candidates[key] = value;
  }
  return needsTypeResolution(candidates);
}

export function normaliseProperties(
  raw: unknown,
  resolveType: PropertyTypeResolver = UNKNOWN_TYPES
): NormalisedProps {
  if (raw === undefined || raw === null) return { notionProps: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { notionProps: {}, error: "`properties` must be an object." };
  }
  const flat = raw as Record<string, unknown>;

  // Pass 1: collect date:/place: composite keys before iterating.
  const dateParts: Record<string, { start?: string | null; end?: string | null; isDatetime?: boolean }> = {};
  const placeParts: Record<string, Record<string, string | number | null>> = {};
  const simple: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(flat)) {
    const datem = key.match(/^date:(.+):(start|end|is_datetime)$/);
    if (datem) {
      const name = datem[1]!;
      const field = datem[2]!;
      if (!dateParts[name]) dateParts[name] = {};
      if (field === "is_datetime") {
        dateParts[name].isDatetime = value === 1 || value === true || value === "1";
      } else if (typeof value === "string" || value === null) {
        if (field === "start") dateParts[name].start = value as string | null;
        if (field === "end") dateParts[name].end = value as string | null;
      }
      continue;
    }
    const placem = key.match(/^place:(.+):(name|address|latitude|longitude|google_place_id)$/);
    if (placem) {
      const name = placem[1]!;
      const field = placem[2]!;
      if (!placeParts[name]) placeParts[name] = {};
      placeParts[name][field] = value as string | number | null;
      continue;
    }
    simple[key] = value;
  }

  const out: Record<string, unknown> = {};
  // Tracked separately so an explicit `in_trash` always wins over the legacy
  // `archived` alias when a caller passes both and they disagree — the newer
  // key is the one that names what the API actually does.
  let archivedAlias: boolean | undefined;
  let inTrash: boolean | undefined;
  let isLocked: boolean | undefined;

  for (const [rawKey, value] of Object.entries(simple)) {
    // Unwrap `userDefined:` prefix used to escape id/url property-name collisions.
    let key = rawKey;
    if (key.startsWith("userDefined:")) key = key.slice("userDefined:".length);

    // Top-level archive/trash controls. `archived` is the pre-2026-03-11 name;
    // it is still accepted from callers and folded into `in_trash` below.
    if (key === "archived") {
      if (typeof value === "boolean") archivedAlias = value;
      else archivedAlias = value === "__YES__" || value === 1;
      continue;
    }
    if (key === "in_trash") {
      if (typeof value === "boolean") inTrash = value;
      else inTrash = value === "__YES__" || value === 1;
      continue;
    }
    // `is_locked` (page lock) is on PATCH /v1/pages' body whitelist, alongside
    // archived / in_trash, so it belongs here rather than in `properties`.
    // Same __YES__/__NO__ sentinel handling as the other two for consistency
    // with the flat property-map format the native MCP uses.
    if (key === "is_locked") {
      if (typeof value === "boolean") isLocked = value;
      else isLocked = value === "__YES__" || value === 1;
      continue;
    }

    // Null clears the property.
    if (value === null) {
      out[key] = null;
      continue;
    }

    // Full Notion property value object — pass through unchanged (escape hatch).
    if (typeof value === "object" && !Array.isArray(value)) {
      out[key] = value;
      continue;
    }

    // Array-of-strings → multi_select shorthand.
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      out[key] = { multi_select: (value as string[]).map((name) => ({ name })) };
      continue;
    }

    // Scalars — serialize against the column's real type when the schema told
    // us one, otherwise fall back to the historical name/value heuristic.
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      out[key] = coerceScalarToPropertyValue(key, value, resolveType(key));
      continue;
    }

    // Unknown shape — pass through defensively so Notion can validate.
    out[key] = value;
  }

  // Assemble date composites.
  for (const [name, parts] of Object.entries(dateParts)) {
    if (parts.start === null && !parts.end) {
      out[name] = null;
      continue;
    }
    const date: Record<string, unknown> = {};
    if (parts.start !== undefined && parts.start !== null) date.start = parts.start;
    if (parts.end !== undefined) date.end = parts.end;
    out[name] = { date };
  }

  // Assemble place composites. Notion has no native "place" property type —
  // native MCP surfaces them as a formatted rich_text line. We do the same.
  for (const [name, parts] of Object.entries(placeParts)) {
    const label = (parts.name as string | undefined) ?? (parts.address as string | undefined) ?? "";
    if (!label) {
      out[name] = null;
      continue;
    }
    out[name] = {
      rich_text: [{ type: "text", text: { content: label } }],
    };
  }

  return { notionProps: out, inTrash: inTrash ?? archivedAlias, isLocked };
}
