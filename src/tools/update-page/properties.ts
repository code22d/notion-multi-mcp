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
  const { notionProps, archived, inTrash, error } = normaliseProperties(propsRaw);
  if (error) return textErr(error);
  if (notionProps && Object.keys(notionProps).length > 0) {
    body.properties = notionProps;
  }
  if (archived !== undefined) body.archived = archived;
  if (inTrash !== undefined) body.in_trash = inTrash;

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
  if (body.archived !== undefined) touched.push(body.archived ? "archived" : "unarchived");
  if (body.in_trash !== undefined) touched.push(body.in_trash ? "moved to trash" : "restored from trash");
  return textOk(`Updated page ${pageId} — ${touched.join(", ")}.`);
}

export interface NormalisedProps {
  notionProps: Record<string, unknown>;
  archived?: boolean;
  inTrash?: boolean;
  error?: string;
}

export function normaliseProperties(raw: unknown): NormalisedProps {
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
  let archived: boolean | undefined;
  let inTrash: boolean | undefined;

  for (const [rawKey, value] of Object.entries(simple)) {
    // Unwrap `userDefined:` prefix used to escape id/url property-name collisions.
    let key = rawKey;
    if (key.startsWith("userDefined:")) key = key.slice("userDefined:".length);

    // Top-level archive/trash controls.
    if (key === "archived") {
      if (typeof value === "boolean") archived = value;
      else archived = value === "__YES__" || value === 1;
      continue;
    }
    if (key === "in_trash") {
      if (typeof value === "boolean") inTrash = value;
      else inTrash = value === "__YES__" || value === 1;
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

    if (typeof value === "number") {
      out[key] = { number: value };
      continue;
    }

    if (typeof value === "boolean") {
      out[key] = { checkbox: value };
      continue;
    }

    if (typeof value === "string") {
      if (value === "__YES__") {
        out[key] = { checkbox: true };
        continue;
      }
      if (value === "__NO__") {
        out[key] = { checkbox: false };
        continue;
      }
      // Title property gets title rich_text; everything else defaults to rich_text.
      if (key.toLowerCase() === "title" || key === "Title" || key === "Name") {
        out[key] = { title: [{ type: "text", text: { content: value } }] };
      } else {
        out[key] = { rich_text: [{ type: "text", text: { content: value } }] };
      }
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

  return { notionProps: out, archived, inTrash };
}
