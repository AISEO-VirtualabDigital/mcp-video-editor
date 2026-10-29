/**
 * Shot library tools — expose the motion shot catalog (video-shotcraft style)
 * to AI clients so they can browse shots and apply them during generation.
 *
 *   - list_shots : list shot categories and available shot cards
 *   - get_shot   : fetch a single shot card by id
 *
 * Read-only tools.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import { SHOT_CATEGORIES, SHOTS, listShots, getShot, type ShotCard } from "../data/shots.js";

const listShotsSchema = z.object({
  category: z.string().optional().describe("Filter by shot category id, e.g. 'camera'. Omit to list all categories + shots."),
});

const getShotSchema = z.object({
  shotId: z.string().min(1).describe("Shot card id, e.g. 'exploded-view' or 'spotlight-sweep'."),
});

export const shotsTools: Tool[] = [
  {
    name: "list_shots",
    description: "List the available motion shot library: categories with shot counts, and the shot cards an agent can apply when generating a video.",
    inputSchema: listShotsSchema,
    run: async (raw) => {
      const input = listShotsSchema.parse(raw);
      const shots = listShots(input.category);
      const categories = input.category ? SHOT_CATEGORIES.filter((c) => c.id === input.category) : SHOT_CATEGORIES;
      return {
        ok: true,
        summary: `Found ${shots.length} shot(s)${input.category ? ` in category "${input.category}"` : ""} across ${categories.length} categor(ies).`,
        data: { categories, shots, count: shots.length },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_shot",
    description: "Get a single motion shot card by id, including its motion type, description, and duration guidance.",
    inputSchema: getShotSchema,
    run: async (raw) => {
      const input = getShotSchema.parse(raw);
      const shot: ShotCard | undefined = getShot(input.shotId);
      if (!shot) {
        return { ok: false, summary: `Shot "${input.shotId}" not found in the shot library.`, error: "not-found" } satisfies ToolResult;
      }
      return {
        ok: true,
        summary: `Shot "${shot.id}" (${shot.label}) — motionType=${shot.motionType}, duration=${shot.durationSeconds}s.`,
        data: { shot },
      } satisfies ToolResult;
    },
  },
];
