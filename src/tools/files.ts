// -----------------------------------------------------------------------------
// File Upload API tools + the HTML block it unlocks, plus custom emoji listing.
//
//   notion_upload_file        — create a file upload and push its bytes
//   notion_list_file_uploads  — enumerate prior uploads
//   notion_create_html_block  — upload an .html file and attach it as an embed
//   notion_list_custom_emojis — GET /v1/custom_emojis (ids for icon writes)
//
// WHY THE UPLOAD TOOL TAKES TEXT, NOT A PATH
//
// This is a Cloudflare Worker. It has no filesystem and no access to the
// caller's machine, so "upload /Users/me/report.pdf" is not something it can
// ever do — the bytes have to arrive inside the MCP call. MCP tool arguments
// are JSON, so the only two things that can arrive are a string and a
// base64 string. Both are offered, and the tool says plainly that it cannot
// read local paths rather than failing with a confusing "file not found".
//
// The practical consequence is that this is useful for TEXT artifacts — HTML,
// CSV, JSON, Markdown — and impractical for large binaries, which would have to
// be base64'd through the model's context. Notion's multi_part mode (>20MB) is
// deliberately NOT wired up for the same reason; see the report.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount, createNotionClient } from "../accounts/resolver";
import { stripDashes, type NotionFileUploadObject } from "../notion/client";

export function registerFileTools(register: (def: ToolDef) => void): void {
  register({
    name: "notion_upload_file",
    description:
      "Upload a file to Notion and return a file_upload id you can attach to a block, page icon, cover, or files property. " +
      "Provide the CONTENT inline as `content` (text) or `content_base64` (binary) — this server runs on Cloudflare Workers " +
      "and cannot read files from your machine, so a local path will not work. " +
      "Best suited to text artifacts (HTML, CSV, JSON, Markdown). Files over 20MB need Notion's multi-part flow, which is not wired up here.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        filename: { type: "string", description: "File name including extension, e.g. 'report.html'." },
        content: { type: "string", description: "File contents as text. Use this for HTML/CSV/JSON/Markdown." },
        content_base64: { type: "string", description: "File contents as base64. Use this for binary files." },
        content_type: {
          type: "string",
          description: "MIME type, e.g. 'text/html'. Inferred from the filename extension when omitted.",
        },
      },
      required: ["account", "filename"],
      additionalProperties: false,
    },
    handler: uploadFileHandler,
  });

  register({
    name: "notion_list_file_uploads",
    description:
      "List file uploads made by this integration, with their ids and statuses. " +
      "Use this to find the id of something you uploaded earlier so you can attach it.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        status: { type: "string", enum: ["pending", "uploaded", "expired", "failed"] },
        start_cursor: { type: "string" },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: listFileUploadsHandler,
  });

  register({
    name: "notion_create_html_block",
    description:
      "Add an HTML block to a Notion page (Notion 2026-07-03). Notion renders the HTML interactively in a sandboxed iframe, " +
      "the same as the /html command in the app. " +
      "This is a two-step operation under the hood: the HTML is uploaded via the File Upload API, then attached as an " +
      "embed block with `embed.file_upload`. Pass the markup as `html`.",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        parent_block_id: {
          type: "string",
          description: "Page id (or block id) to append the HTML block to.",
        },
        html: { type: "string", description: "The HTML markup." },
        filename: {
          type: "string",
          description: "Optional name for the uploaded file. Must end in .html or .htm. Defaults to 'block.html'.",
        },
      },
      required: ["account", "parent_block_id", "html"],
      additionalProperties: false,
    },
    handler: createHtmlBlockHandler,
  });

  register({
    name: "notion_list_custom_emojis",
    description:
      "List the workspace's custom emojis with their ids, names, and image URLs. Optionally filter by `name`. " +
      "The id is what you need to set a custom emoji as a page/database icon (pass `custom_emoji:<id>` to an icon parameter).",
    inputSchema: {
      type: "object",
      properties: {
        ...ACCOUNT_PARAM_SCHEMA,
        name: { type: "string", description: "Filter by emoji name." },
        start_cursor: { type: "string" },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["account"],
      additionalProperties: false,
    },
    handler: listCustomEmojisHandler,
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

async function uploadFileHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const filename = typeof args.filename === "string" ? args.filename.trim() : "";
  if (!filename) return textErr("`filename` is required (including the extension, e.g. 'report.html').");

  const blob = buildBlob(args, filename);
  if (typeof blob === "string") return textErr(blob);

  try {
    const upload = await client.createFileUpload({
      mode: "single_part",
      filename,
      content_type: blob.type,
    });
    const sent = await client.sendFileUpload(upload.id, blob, { filename });
    return {
      content: [
        {
          type: "text",
          text: [
            `✅ Uploaded **${filename}** (${blob.size} bytes, ${blob.type})`,
            `file_upload id: ${sent.id}`,
            `status: ${sent.status}`,
            "",
            "Attach it with a file object: `{ \"type\": \"file_upload\", \"file_upload\": { \"id\": \"" + sent.id + "\" } }`",
          ].join("\n"),
        },
      ],
    };
  } catch (e) {
    return textErr(explainUploadError(e));
  }
}

async function listFileUploadsHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  try {
    const page = await client.listFileUploads({
      ...(typeof args.status === "string" ? { status: args.status } : {}),
      ...(typeof args.start_cursor === "string" ? { startCursor: args.start_cursor } : {}),
      ...(typeof args.page_size === "number" ? { pageSize: args.page_size } : {}),
    });
    const lines: string[] = [`# File uploads (${page.results.length})`, ""];
    if (page.results.length === 0) lines.push("_(none)_");
    for (const f of page.results) {
      lines.push(`- **${f.filename ?? "(unnamed)"}** — ${f.status}\n  id: ${f.id}${f.content_type ? ` · ${f.content_type}` : ""}`);
    }
    if (page.has_more && page.next_cursor) {
      lines.push("", `_More available. Pass \`start_cursor: "${page.next_cursor}"\` to continue._`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return textErr(`notion_list_file_uploads failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function createHtmlBlockHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  const parentId = typeof args.parent_block_id === "string" ? args.parent_block_id.trim() : "";
  const html = typeof args.html === "string" ? args.html : "";
  if (!parentId) return textErr("`parent_block_id` is required.");
  if (!html) return textErr("`html` is required and cannot be empty.");

  // Notion keys the HTML-block behaviour off the file EXTENSION, not the MIME
  // type — an upload named 'block.txt' with content_type text/html renders as
  // a plain file attachment instead. Enforce it here rather than letting the
  // user discover it as a wrong-looking result.
  let filename = typeof args.filename === "string" && args.filename.trim() ? args.filename.trim() : "block.html";
  if (!/\.html?$/i.test(filename)) filename = `${filename}.html`;

  try {
    const upload = await client.createFileUpload({
      mode: "single_part",
      filename,
      content_type: "text/html",
    });
    const sent = await client.sendFileUpload(upload.id, new Blob([html], { type: "text/html" }), { filename });

    const appended = await client.appendBlockChildren(stripDashes(parentId), {
      children: [
        {
          type: "embed",
          embed: { type: "file_upload", file_upload: { id: sent.id } },
        },
      ],
    });

    const blockId = appended.results?.[0]?.id ?? "(unknown)";
    return {
      content: [
        {
          type: "text",
          text: [
            `✅ Added HTML block to ${parentId}`,
            `block id: ${blockId}`,
            `file_upload id: ${sent.id} (${filename}, ${html.length} chars)`,
          ].join("\n"),
        },
      ],
    };
  } catch (e) {
    return textErr(explainUploadError(e, "notion_create_html_block"));
  }
}

async function listCustomEmojisHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = createNotionClient(account, ctx);

  try {
    const page = await client.listCustomEmojis({
      ...(typeof args.name === "string" ? { name: args.name } : {}),
      ...(typeof args.start_cursor === "string" ? { startCursor: args.start_cursor } : {}),
      ...(typeof args.page_size === "number" ? { pageSize: args.page_size } : {}),
    });
    const lines: string[] = [`# Custom emojis (${page.results.length})`, ""];
    if (page.results.length === 0) {
      lines.push("_(none — this workspace has no custom emojis, or none matched the filter)_");
    }
    for (const e of page.results) {
      lines.push(`- **:${e.name}:** — id: ${e.id}\n  ${e.url}`);
    }
    if (page.results.length > 0) {
      lines.push("", "_Set one as an icon by passing `custom_emoji:<id>` to an `icon` parameter._");
    }
    if (page.has_more && page.next_cursor) {
      lines.push("", `_More available. Pass \`start_cursor: "${page.next_cursor}"\` to continue._`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  } catch (e) {
    return textErr(`notion_list_custom_emojis failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Build the upload Blob from the tool args, or return an error string. */
export function buildBlob(args: Record<string, unknown>, filename: string): Blob | string {
  const text = typeof args.content === "string" ? args.content : undefined;
  const b64 = typeof args.content_base64 === "string" ? args.content_base64 : undefined;
  if (text === undefined && b64 === undefined) {
    return (
      "Provide the file contents as `content` (text) or `content_base64` (binary). " +
      "This server runs on Cloudflare Workers and cannot read files from your machine, so a local path won't work."
    );
  }
  if (text !== undefined && b64 !== undefined) {
    return "Provide exactly one of `content` or `content_base64`, not both.";
  }

  const contentType =
    typeof args.content_type === "string" && args.content_type.trim()
      ? args.content_type.trim()
      : guessContentType(filename);

  if (text !== undefined) {
    return new Blob([text], { type: contentType });
  }

  try {
    const binary = atob(b64!);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
  } catch {
    return "`content_base64` is not valid base64.";
  }
}

/**
 * Guess a MIME type from the filename extension.
 *
 * Only the text-ish formats this tool is actually useful for, plus the common
 * binaries. Unknown extensions fall back to application/octet-stream, which
 * Notion accepts — it keys HTML-block rendering off the extension anyway.
 */
export function guessContentType(filename: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
    case "htm":  return "text/html";
    case "css":  return "text/css";
    case "js":   return "text/javascript";
    case "json": return "application/json";
    case "csv":  return "text/csv";
    case "md":   return "text/markdown";
    case "txt":  return "text/plain";
    case "svg":  return "image/svg+xml";
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "pdf":  return "application/pdf";
    default:     return "application/octet-stream";
  }
}

/**
 * Turn an upload failure into something actionable. The two that actually
 * happen are a missing capability and an over-limit file, and neither reads
 * clearly from Notion's raw message.
 */
export function explainUploadError(err: unknown, toolName = "notion_upload_file"): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^Notion API 403\b/.test(msg)) {
    return (
      `${toolName} failed: Notion returned 403.\n\n` +
      `File uploads require the "Insert content" capability on the integration. ` +
      `Enable it at https://www.notion.so/profile/integrations — open the integration, go to Capabilities.\n\n` +
      `Original error: ${msg}`
    );
  }
  if (/^Notion API 413\b/.test(msg) || /too large|exceeds/i.test(msg)) {
    return (
      `${toolName} failed: the file exceeds this workspace plan's upload limit, or Notion's 20MB ` +
      `single-part cap. Files over 20MB need Notion's multi-part upload flow, which this tool does not implement.\n\n` +
      `Original error: ${msg}`
    );
  }
  return `${toolName} failed: ${msg}`;
}

function textErr(text: string): ToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Re-exported for tests. */
export type { NotionFileUploadObject };
