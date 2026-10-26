/**
 * MCP server setup — registers every tool with the SDK's high-level
 * `McpServer`, wires the notification bus to MCP server-sent notifications,
 * and exposes a single `start()` function the entry point calls.
 *
 * Transport: stdio (works with Cursor, Claude Desktop, Codex, Antigravity,
 * OpenCode, KiloCode — they all speak stdio MCP).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { allTools, type Tool } from "./tools/index.js";
import { bus } from "./notifications/events.js";
import type { ProjectChangedEvent, RenderProgressEvent } from "./adapters/types.js";
import { formatUs } from "./utils/id.js";
import { truncateForToolResult } from "./safety/dry-run.js";

const SERVER_NAME = "mcp-video-editor";
const SERVER_VERSION = "1.0.0";

export interface ServerContext {
  mcp: McpServer;
  /** Send a custom notification. Returns true if the notification was sent. */
  notify: (name: string, payload: unknown) => Promise<boolean>;
}

let ctxSingleton: ServerContext | null = null;

/**
 * Build the McpServer, register all tools, subscribe the notification bus,
 * and return the singleton context. Idempotent.
 */
export function buildServer(): ServerContext {
  if (ctxSingleton) return ctxSingleton;

  const mcp = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: {},
        logging: {},
      },
      instructions:
        "MCP server for editing videos in CapCut and OpenCut. All write tools default to dryRun=true — pass dryRun=false to persist. Time units are microseconds (1_000_000 = 1s).",
    },
  );

  // Register every tool. We pass the Zod schema shape so the SDK exposes a
  // JSON-schema description to the AI client AND validates input.
  for (const tool of allTools) {
    registerToolWithMcp(mcp, tool);
  }

  // Wire the notification bus to MCP server-sent notifications.
  // Use the SDK's built-in `notifications/message` for log events, and
  // custom `notifications/*` URIs for project/render events so clients that
  // subscribe to specific notification types can filter.
  const notify = async (name: string, payload: unknown): Promise<boolean> => {
    try {
      // The MCP SDK's `Server.notification()` accepts a typed notification
      // object. For custom notifications we send them via the low-level
      // protocol — see Server.notification in shared/protocol.d.ts.
      // We use `notifications/message` for everything with a structured
      // payload, which all 6 clients (Cursor, Claude, Codex, Antigravity,
      // OpenCode, KiloCode) handle out of the box.
      await (mcp.server as unknown as {
        notification: (n: { method: string; params: unknown }) => Promise<void>;
      }).notification({
        method: name,
        params: payload,
      });
      return true;
    } catch (err) {
      // Swallow — never let a notification failure crash a tool call.
      bus.log("warning", `Failed to send notification ${name}: ${(err as Error).message}`);
      return false;
    }
  };

  // Subscribe bus listeners -> notify()
  bus.onProjectChanged(async (e: ProjectChangedEvent) => {
    await notify("notifications/projectChanged", e);
  });
  bus.onRenderProgress(async (e: RenderProgressEvent) => {
    await notify("notifications/renderProgress", e);
  });
  bus.onLog(async (entry) => {
    await notify("notifications/message", {
      level: entry.level,
      data: entry.message,
      logger: SERVER_NAME,
      timestamp: entry.at,
    });
  });

  ctxSingleton = { mcp, notify };
  return ctxSingleton;
}

/**
 * Register a single tool. We translate our `Tool` shape into the SDK's
 * `registerTool` config.
 */
function registerToolWithMcp(mcp: McpServer, tool: Tool): void {
  // ZodObject -> ZodRawShape. The SDK accepts the shape and will produce a
  // JSON-schema definition for the client.
  const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
  mcp.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: shape as Record<string, never>,
      annotations: {
        // Hint clients that these tools can be slow (render, save).
        readOnlyHint: tool.name.startsWith("get_") || tool.name === "list_projects" || tool.name === "list_export_profiles",
        destructiveHint: tool.name === "delete_project",
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await tool.run(args);
        // Apply size cap to the structured payload so an oversized timeline
        // (e.g. 100MB of clips) doesn't DoS the AI client's context window.
        const summaryText = formatToolResultText(tool.name, result);
        const dataText = JSON.stringify(result.data ?? {}, null, 2);
        const { text: truncatedData, truncated } = truncateForToolResult(dataText);
        return {
          content: [
            {
              type: "text",
              text: summaryText,
            },
            {
              type: "text",
              text: truncatedData,
            },
            ...(truncated
              ? [
                  {
                    type: "text" as const,
                    text: `[payload truncated: exceeded 1 MiB limit. Use get_clips with a specific trackId to fetch a subset.]`,
                  },
                ]
              : []),
          ],
          isError: !result.ok,
        };
      } catch (err) {
        const e = err as Error;
        bus.log("error", `Tool ${tool.name} threw: ${e.message}`);
        return {
          content: [
            {
              type: "text",
              text: `Tool "${tool.name}" failed: ${e.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}

/** Format a ToolResult as a human-readable string for the AI client. */
function formatToolResultText(toolName: string, result: {
  ok: boolean;
  summary: string;
  error?: string;
  dryRun?: boolean;
  backupPath?: string;
}): string {
  const lines: string[] = [];
  lines.push(`[${result.ok ? "OK" : "FAIL"}] ${toolName}`);
  lines.push(result.summary);
  if (result.dryRun) {
    lines.push(`(dry-run mode — pass dryRun=false to persist)`);
  }
  if (result.backupPath) {
    lines.push(`(backup written: ${result.backupPath})`);
  }
  if (result.error) {
    lines.push(`error: ${result.error}`);
  }
  // Format any durations in summary if they look like microseconds.
  return lines.join("\n");
}

/** Start the MCP server on stdio. Returns when the transport closes. */
export async function startServer(): Promise<void> {
  const { mcp } = buildServer();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  // The transport keeps the process alive until the client disconnects.
}

/** Helper for tools to query durations of currently-open projects (used by some tool summaries). */
export function _internal_nowFormatted(): string {
  return formatUs(Date.now() * 1000);
}
