/**
 * Tool registry — defines the `Tool` interface that every tool module exports
 * arrays of, plus the central registry that aggregates them all.
 *
 * Each `Tool` has:
 *   - name        : MCP tool name (must be unique across the server)
 *   - description : human-readable description shown to the AI client
 *   - inputSchema : a Zod schema. We expose `.shape` to the MCP server so it
 *                   can produce a JSON-schema definition the AI client can use.
 *   - run         : async function that takes the parsed args and returns a ToolResult.
 */

import type { z } from "zod";
import type { ToolResult } from "../adapters/types.js";
export type { ToolResult } from "../adapters/types.js";
import { projectTools } from "./project.js";
import { timelineTools } from "./timeline.js";
import { textTools } from "./text.js";
import { effectsTools } from "./effects.js";
import { audioTools } from "./audio.js";
import { exportTools } from "./export.js";
import { inspectTools } from "./inspect.js";
import { generationTools } from "./generation.js";
import { shotsTools } from "./shots.js";
import { voiceTools } from "./voice.js";
import { exchangeTools } from "./exchange.js";

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  run: (raw: unknown) => Promise<ToolResult>;
}

/** All tools aggregated in one array — the MCP server registers these. */
export const allTools: Tool[] = [
  ...projectTools,
  ...timelineTools,
  ...textTools,
  ...effectsTools,
  ...audioTools,
  ...exportTools,
  ...inspectTools,
  ...generationTools,
  ...shotsTools,
  ...voiceTools,
  ...exchangeTools,
];

/** Lookup helper. */
export function findTool(name: string): Tool | undefined {
  return allTools.find((t) => t.name === name);
}
