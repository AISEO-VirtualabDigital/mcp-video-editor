/**
 * Inspect/query tools — read-only operations that return project state for the
 * AI assistant to reason about. No writes, no dry-run needed.
 *
 *   - get_project_state   : top-level summary (canvas, fps, track count, etc.)
 *   - get_timeline         : paginated timeline structure
 *   - get_clips            : paginated clips on a specific track (or all)
 *   - get_track_info       : details about one track
 *   - get_materials         : all materials in the project
 *   - get_texts            : all text overlays
 *   - get_effects          : all effects
 *   - get_open_project_ids : ids of all projects currently loaded in cache
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";

const getProjectStateSchema = z.object({
  id: z.string().min(1).describe("Project id."),
});

const getTimelineSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  offset: z.number().int().min(0).default(0).describe("Number of clips to skip."),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum clips to return."),
});

const getClipsSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).optional().describe("If omitted, returns clips across all tracks."),
  offset: z.number().int().min(0).default(0).describe("Number of clips to skip."),
  limit: z.number().int().min(1).max(200).default(50).describe("Maximum clips to return."),
});

const getTrackInfoSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
});

const getMaterialsSchema = z.object({
  id: z.string().min(1).describe("Project id."),
});

const getTextsSchema = z.object({
  id: z.string().min(1).describe("Project id."),
});

const getEffectsSchema = z.object({
  id: z.string().min(1).describe("Project id."),
});

const getOpenProjectIdsSchema = z.object({});

export const inspectTools: Tool[] = [
  {
    name: "get_project_state",
    description:
      "Return the top-level state of an open project: id, name, editor, canvas, fps, track count, materials count, etc.",
    inputSchema: getProjectStateSchema,
    run: async (raw) => {
      const input = getProjectStateSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      return {
        ok: true,
        summary: `Project "${p.name}" (${p.editor}, ${p.width}x${p.height}@${p.fps}fps, duration=${p.duration}us, tracks=${p.tracks.length}, materials=${p.materials.length}).`,
        data: {
          id: p.id,
          name: p.name,
          editor: p.editor,
          filePath: p.filePath,
          duration: p.duration,
          width: p.width,
          height: p.height,
          fps: p.fps,
          trackCount: p.tracks.length,
          materialsCount: p.materials.length,
          textsCount: p.texts.length,
          effectsCount: p.effects.length,
        },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_timeline",
    description: "Return paginated timeline clips and track metadata. Use offset/limit to fetch subsequent pages.",
    inputSchema: getTimelineSchema,
    run: async (raw) => {
      const input = getTimelineSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      const allClips = p.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          trackId: track.id,
          clip: {
            id: clip.id,
            materialId: clip.materialId,
            sourceIn: clip.sourceIn,
            sourceOut: clip.sourceOut,
            targetStart: clip.targetStart,
            targetEnd: clip.targetEnd,
            volume: clip.volume,
            speed: clip.speed,
          },
        })),
      );
      const page = allClips.slice(input.offset, input.offset + input.limit);
      return {
        ok: true,
        summary: `Timeline: returned ${page.length} of ${allClips.length} clips (offset=${input.offset}, limit=${input.limit}) across ${p.tracks.length} tracks.`,
        data: {
          duration: p.duration,
          totalClips: allClips.length,
          offset: input.offset,
          limit: input.limit,
          hasMore: input.offset + page.length < allClips.length,
          tracks: p.tracks.map((t) => ({
            id: t.id,
            kind: t.kind,
            visible: t.visible ?? true,
            volume: t.volume ?? 1,
            clipCount: t.clips.length,
            clips: page.filter((entry) => entry.trackId === t.id).map((entry) => entry.clip),
          })),
        },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_clips",
    description: "Return a page of clips on one track (or all tracks when trackId is omitted).",
    inputSchema: getClipsSchema,
    run: async (raw) => {
      const input = getClipsSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      if (input.trackId) {
        const t = p.tracks.find((x) => x.id === input.trackId);
        if (!t) {
          return { ok: false, summary: `Track ${input.trackId} not found.`, error: "not-found" } satisfies ToolResult;
        }
        const clips = t.clips.slice(input.offset, input.offset + input.limit);
        return {
          ok: true,
          summary: `Track ${t.id} (${t.kind}): returned ${clips.length} of ${t.clips.length} clips.`,
          data: {
            trackId: t.id,
            kind: t.kind,
            total: t.clips.length,
            offset: input.offset,
            limit: input.limit,
            hasMore: input.offset + clips.length < t.clips.length,
            clips,
          },
        } satisfies ToolResult;
      }
      const all = p.tracks.flatMap((t) =>
        t.clips.map((c) => ({ trackId: t.id, trackKind: t.kind, ...c })),
      );
      const clips = all.slice(input.offset, input.offset + input.limit);
      return {
        ok: true,
        summary: `Returned ${clips.length} of ${all.length} clips across ${p.tracks.length} tracks.`,
        data: {
          total: all.length,
          offset: input.offset,
          limit: input.limit,
          hasMore: input.offset + clips.length < all.length,
          clips,
        },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_track_info",
    description: "Return details about a single track.",
    inputSchema: getTrackInfoSchema,
    run: async (raw) => {
      const input = getTrackInfoSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      const t = p.tracks.find((x) => x.id === input.trackId);
      if (!t) {
        return { ok: false, summary: `Track ${input.trackId} not found.`, error: "not-found" } satisfies ToolResult;
      }
      return {
        ok: true,
        summary: `Track ${t.id} (${t.kind}, ${t.clips.length} clips, visible=${t.visible ?? true}).`,
        data: t,
      } satisfies ToolResult;
    },
  },
  {
    name: "get_materials",
    description: "Return all materials in the project (videos, audios, images, texts, stickers).",
    inputSchema: getMaterialsSchema,
    run: async (raw) => {
      const input = getMaterialsSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      return {
        ok: true,
        summary: `${p.materials.length} materials.`,
        data: { materials: p.materials },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_texts",
    description: "Return all text overlays in the project.",
    inputSchema: getTextsSchema,
    run: async (raw) => {
      const input = getTextsSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      return {
        ok: true,
        summary: `${p.texts.length} text overlays.`,
        data: { texts: p.texts },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_effects",
    description: "Return all effects in the project.",
    inputSchema: getEffectsSchema,
    run: async (raw) => {
      const input = getEffectsSchema.parse(raw);
      const p = facade.getOpenProject(input.id);
      return {
        ok: true,
        summary: `${p.effects.length} effects.`,
        data: { effects: p.effects },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_open_project_ids",
    description: "Return ids of all projects currently loaded in the in-memory cache.",
    inputSchema: getOpenProjectIdsSchema,
    run: async () => {
      const ids = facade.listOpenProjectIds();
      return {
        ok: true,
        summary: `${ids.length} open project(s).`,
        data: { ids },
      } satisfies ToolResult;
    },
  },
];
