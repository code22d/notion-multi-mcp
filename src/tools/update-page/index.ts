// -----------------------------------------------------------------------------
// notion_update_page — top-level dispatcher.
//
// Entry point: updatePageHandler(args, ctx). Resolves the account, validates
// the `command` and `page_id`, then hands off to the per-command handler.
//
// The input schema is also exported here so pages.ts can register it without
// re-declaring the per-command field list.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolResult } from "../../mcp/types";
import { ACCOUNT_PARAM_SCHEMA, resolveAccount } from "../../accounts/resolver";
import { NotionClient, stripDashes } from "../../notion/client";
import { updatePropertiesHandler } from "./properties";
import { updateVerificationHandler } from "./verification";
import { applyTemplateHandler } from "./template";
import { replaceContentHandler } from "./replace";
import { updateContentHandler } from "./content";
import { textErr } from "./shared";

export const UPDATE_PAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    ...ACCOUNT_PARAM_SCHEMA,
    page_id: {
      type: "string",
      description: "The ID of the page to update, with or without dashes.",
    },
    command: {
      type: "string",
      enum: ["update_properties", "update_content", "replace_content", "apply_template", "update_verification"],
    },
    properties: {
      type: "object",
      description:
        "Required for `update_properties`. Flat map of property names to scalar values (string | number | null). " +
        "Date props split into `date:{name}:start|end|is_datetime`. Place props split into " +
        "`place:{name}:{name|address|latitude|longitude|google_place_id}`. Checkboxes use `__YES__`/`__NO__`. " +
        "Properties colliding with `id` or `url` must be prefixed `userDefined:`.",
    },
    content_updates: {
      type: "array",
      description:
        "Required for `update_content`. Array of `{ old_str, new_str, replace_all_matches? }` operations applied " +
        "in order against the page's rendered Notion-flavored Markdown. Use notion_fetch first to see the exact text.",
      items: {
        type: "object",
        properties: {
          old_str: { type: "string" },
          new_str: { type: "string" },
          replace_all_matches: { type: "boolean" },
        },
        required: ["old_str", "new_str"],
      },
      maxItems: 100,
    },
    new_str: {
      type: "string",
      description: "Required for `replace_content`. The new page content as Notion-flavored Markdown.",
    },
    template_id: {
      type: "string",
      description: "Required for `apply_template`. The page id to clone onto the target.",
    },
    cover: {
      type: "string",
      description: "Page cover — an https URL, or \"none\" to remove. Can be set alongside any command.",
    },
    icon: {
      type: "string",
      description:
        "Page icon — an emoji character, a `:name:` custom emoji, an https URL, or \"none\" to remove. " +
        "Can be set alongside any command.",
    },
    verification_status: {
      type: "string",
      enum: ["verified", "unverified"],
      description: "Required for `update_verification`.",
    },
    verification_expiry_days: {
      type: "integer",
      minimum: 1,
      description:
        "Optional for `update_verification` when status=verified. Number of days until the verification expires.",
    },
    allow_deleting_content: {
      type: "boolean",
      description:
        "For `replace_content` and `update_content`: allow deleting existing child pages/databases that " +
        "aren't referenced in the new content. Default false — operations will error out listing the affected items.",
    },
  },
  required: ["account", "page_id", "command"],
  additionalProperties: false,
} as const;

export async function updatePageHandler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const account = await resolveAccount(args, ctx);
  const client = new NotionClient(account);

  const pageIdRaw = args.page_id;
  if (typeof pageIdRaw !== "string" || !pageIdRaw) {
    return textErr("`page_id` is required.");
  }
  const pageId = stripDashes(pageIdRaw);

  const command = args.command;
  switch (command) {
    case "update_properties":
      return updatePropertiesHandler(client, pageId, {
        properties: args.properties,
        cover: args.cover,
        icon: args.icon,
      });
    case "update_verification":
      return updateVerificationHandler(client, pageId, {
        verification_status: args.verification_status,
        verification_expiry_days: args.verification_expiry_days,
        cover: args.cover,
        icon: args.icon,
      });
    case "apply_template":
      return applyTemplateHandler(client, pageId, args.template_id);
    case "replace_content": {
      const newStr = args.new_str;
      if (typeof newStr !== "string") {
        return textErr("`replace_content` requires a `new_str` string (the new page content as Markdown).");
      }
      return replaceContentHandler(client, pageId, newStr, {
        allowDeletingContent: args.allow_deleting_content === true,
      });
    }
    case "update_content":
      return updateContentHandler(client, pageId, args.content_updates, {
        allowDeletingContent: args.allow_deleting_content === true,
      });
    default:
      return textErr(
        `Unknown command ${JSON.stringify(command)}. Expected one of: update_properties, update_content, replace_content, apply_template, update_verification.`
      );
  }
}
