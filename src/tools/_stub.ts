// -----------------------------------------------------------------------------
// Helper to build a "coming soon" tool. These register the same tool NAMES and
// SCHEMAS as the native Notion MCP, but return a not-implemented error. This
// lets us deploy the worker with Phase 1 tools today without breaking the MCP
// tool surface — Phases 2/3/4 just replace these handlers with real ones.
// -----------------------------------------------------------------------------

import type { ToolContext, ToolDef, ToolResult } from "../mcp/types";

export function notYetImplemented(phase: number, description: string) {
  return async (_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `This tool is not yet implemented in notion-multi-mcp (arriving in Phase ${phase}). ${description}`,
        },
      ],
    };
  };
}

export function makeStub(name: string, description: string, phase: number, inputSchema: Record<string, unknown>): ToolDef {
  return {
    name,
    description: `[Phase ${phase} stub] ${description}`,
    inputSchema,
    handler: notYetImplemented(phase, ""),
  };
}
