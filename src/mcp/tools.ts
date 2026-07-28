// -----------------------------------------------------------------------------
// Central tool registry. Every tool module exports a `registerXxxTools` fn;
// this file calls them all in order.
// -----------------------------------------------------------------------------

import type { ToolDef } from "./types";
import { registerAccountTools } from "../accounts/tools";
import { registerFetchTool } from "../tools/fetch";
import { registerSearchTool } from "../tools/search";
import { registerUserTools } from "../tools/users";
import { registerCommentTools } from "../tools/comments";
import { registerPageTools } from "../tools/pages";
import { registerDatabaseTools } from "../tools/databases";
import { registerViewTools } from "../tools/views";
import { registerDuplicateAndMoveTools } from "../tools/duplicate-move";
import { registerFileTools } from "../tools/files";

export function registerAllTools(register: (def: ToolDef) => void): void {
  // Account management (no Notion API calls — pure KV)
  registerAccountTools(register);

  // Phase 1 — read-only tools
  registerFetchTool(register);
  registerSearchTool(register);
  registerUserTools(register);

  // Phase 2 — page + content
  registerPageTools(register);

  // Phase 3 — databases
  registerDatabaseTools(register);

  // Phase 4 — views, comments, duplicate/move
  registerViewTools(register);
  registerCommentTools(register);
  registerDuplicateAndMoveTools(register);

  // 2026 API catch-up — file uploads, HTML blocks, custom emojis
  registerFileTools(register);
}
