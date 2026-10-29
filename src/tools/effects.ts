/**
 * Transitions/effects/animations tools.
 *
 *   - add_transition       : add a transition between two clips on the same track
 *   - remove_transition    : remove a transition from a clip
 *   - add_filter           : add a filter over a timeline window
 *   - add_effect           : add a generic effect (e.g. shake, glitch, vignette)
 *   - remove_effect        : remove an effect by id
 *   - add_sticker          : add a sticker (emoji/shape) at a position+window
 *   - add_animation        : add an animation preset to a clip
 *
 * Transition handling: in CapCut, transitions live on `materials.transitions`
 * and are referenced from a segment's `extra_material_refs`. In our normalized
 * model we store them inline on the Clip via `transitionIn`/`transitionOut`.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { executeWrite } from "../safety/dry-run.js";
import { bus } from "../notifications/events.js";
import { withRetry } from "../utils/fs.js";
import { uid } from "../utils/id.js";
import { EFFECTS, listEffects, getEffect, type EffectCategory, type VideoEffect } from "../data/effects.js";

const listEffectsSchema = z.object({
  category: z.string().optional().describe("Filter by effect category, e.g. 'face-tracked', 'kinetic-text', 'color-grade', 'motion', 'sticker', 'ambient'. Omit to list all."),
});

const getEffectSchema = z.object({
  effectId: z.string().min(1).describe("Effect id, e.g. 'orbit', 'locked-on', 'moody', 'comment-box'."),
});

const addTransitionSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id to attach the transition to."),
  type: z.string().min(1).describe('Transition preset, e.g. "fade", "slide_left", "zoom_in", "whip_pan".'),
  duration: z.number().int().positive().default(500_000).describe("Duration of the transition, microseconds (default 500ms)."),
  side: z.enum(["in", "out"]).default("in").describe('"in" attaches to the clip start; "out" attaches to the clip end.'),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const removeTransitionSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  side: z.enum(["in", "out"]).describe("Which side to clear."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const addFilterSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  type: z.string().min(1).describe('Filter preset, e.g. "vivid", "warm", "cool", "vintage", "noir".'),
  start: z.number().int().min(0).describe("Effect start, microseconds."),
  end: z.number().int().min(0).describe("Effect end, microseconds."),
  intensity: z.number().min(0).max(1).default(1).describe("Filter intensity 0..1."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const addEffectSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  type: z.string().min(1).describe('Effect preset, e.g. "shake", "glitch", "vignette", "rgb_split", "light_leak".'),
  start: z.number().int().min(0).describe("Effect start, microseconds."),
  end: z.number().int().min(0).describe("Effect end, microseconds."),
  params: z.record(z.unknown()).optional().describe("Vendor-specific effect parameters."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const removeEffectSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  effectId: z.string().min(1).describe("Effect id to remove."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const addStickerSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  stickerId: z.string().min(1).describe('Sticker preset id, e.g. "emoji_smile", "arrow_up".'),
  start: z.number().int().min(0).describe("Sticker start on timeline, microseconds."),
  end: z.number().int().min(0).describe("Sticker end on timeline, microseconds."),
  x: z.number().describe("X position on canvas, px."),
  y: z.number().describe("Y position on canvas, px."),
  scale: z.number().min(0.01).max(10).default(1).describe("Sticker scale (1 = native)."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const addAnimationSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  type: z.string().min(1).describe('Animation preset, e.g. "fade_in", "slide_up", "zoom_out", "bounce".'),
  duration: z.number().int().positive().default(500_000).describe("Animation duration, microseconds."),
  side: z.enum(["in", "out"]).default("in").describe("Animation side: in (clip start) or out (clip end)."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const applyFaceEffectSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  effectId: z.string().min(1).describe("Face-tracked effect id from the catalog, e.g. 'orbit', 'locked-on', 'noise'."),
  start: z.number().int().min(0).describe("Effect start, microseconds."),
  end: z.number().int().min(0).describe("Effect end, microseconds."),
  params: z.record(z.unknown()).optional().describe("Effect params."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

async function applyEffectMutation(
  projectId: string,
  description: string,
  dryRun: boolean,
  mutate: () => void | Promise<void>,
): Promise<ToolResult> {
  const project = facade.getOpenProject(projectId);
  await mutate();
  facade.cacheProject(project);
  if (dryRun) {
    return {
      ok: true,
      summary: `[DRY-RUN] ${description}. In-memory cache updated; NOT written to disk.`,
      data: { projectId, dryRun: true },
      dryRun: true,
    } satisfies ToolResult;
  }
  return await executeWrite({
    dryRun: false,
    targetPath: project.filePath,
    newValue: project,
    description,
    apply: async () => {
      await withRetry(() => facade.saveProject(project));
      bus.emitProjectChanged({
        projectId: project.id,
        kind: project.editor,
        change: "draft-written",
        filePath: project.filePath,
      });
    },
  });
}

export const effectsTools: Tool[] = [
  {
    name: "add_transition",
    description: "Attach a transition (fade/slide/zoom/etc.) to the start or end of a clip.",
    inputSchema: addTransitionSchema,
    run: async (raw) => {
      const input = addTransitionSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Add ${input.type} transition ${input.side} clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          const ref = { type: input.type, duration: input.duration };
          if (input.side === "in") clip.transitionIn = ref;
          else clip.transitionOut = ref;
        },
      );
    },
  },
  {
    name: "remove_transition",
    description: "Remove a transition (in or out) from a clip.",
    inputSchema: removeTransitionSchema,
    run: async (raw) => {
      const input = removeTransitionSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Remove transition ${input.side} from clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (input.side === "in") delete clip.transitionIn;
          else delete clip.transitionOut;
        },
      );
    },
  },
  {
    name: "add_filter",
    description: "Add a filter preset over a timeline window. Filters alter the look (vivid/warm/cool/vintage/noir).",
    inputSchema: addFilterSchema,
    run: async (raw) => {
      const input = addFilterSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Add ${input.type} filter (${input.start}-${input.end}us, intensity=${input.intensity})`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          project.effects.push({
            id: uid("filter_"),
            type: `filter:${input.type}`,
            start: input.start,
            end: input.end,
            params: { intensity: input.intensity },
          });
        },
      );
    },
  },
  {
    name: "add_effect",
    description: "Add a generic effect (shake/glitch/vignette/etc.) over a timeline window.",
    inputSchema: addEffectSchema,
    run: async (raw) => {
      const input = addEffectSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Add ${input.type} effect (${input.start}-${input.end}us)`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          project.effects.push({
            id: uid("fx_"),
            type: input.type,
            start: input.start,
            end: input.end,
            params: input.params,
          });
        },
      );
    },
  },
  {
    name: "remove_effect",
    description: "Remove an effect by id (filters, transitions on timeline, generic effects).",
    inputSchema: removeEffectSchema,
    run: async (raw) => {
      const input = removeEffectSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Remove effect ${input.effectId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          project.effects = project.effects.filter((e) => e.id !== input.effectId);
        },
      );
    },
  },
  {
    name: "add_sticker",
    description: "Add a sticker (emoji/shape) at a position+window. Internally creates a sticker material + clip on a sticker track.",
    inputSchema: addStickerSchema,
    run: async (raw) => {
      const input = addStickerSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Add sticker ${input.stickerId} at (${input.x}, ${input.y})`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          // Ensure a sticker track exists.
          let track = project.tracks.find((t) => t.kind === "sticker");
          if (!track) {
            track = { id: uid("track_"), kind: "sticker", clips: [] };
            project.tracks.push(track);
          }
          const materialId = uid("mat_");
          project.materials.push({
            id: materialId,
            type: "sticker",
            sourcePath: `sticker://${input.stickerId}`,
            duration: input.end - input.start,
            width: 128,
            height: 128,
          });
          track.clips.push({
            id: uid("clip_"),
            materialId,
            sourceIn: 0,
            sourceOut: input.end - input.start,
            targetStart: input.start,
            targetEnd: input.end,
            // Sticker position/scale live on raw for vendor round-trip.
            raw: { x: input.x, y: input.y, scale: input.scale, sticker_id: input.stickerId },
          });
        },
      );
    },
  },
  {
    name: "add_animation",
    description: "Add an animation preset (fade_in/slide_up/etc.) to the start or end of a clip.",
    inputSchema: addAnimationSchema,
    run: async (raw) => {
      const input = addAnimationSchema.parse(raw);
      return applyEffectMutation(
        input.id,
        `Add ${input.type} animation ${input.side} clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (!clip.raw) clip.raw = {};
          const key = input.side === "in" ? "animation_in" : "animation_out";
          (clip.raw as Record<string, unknown>)[key] = { type: input.type, duration: input.duration };
        },
      );
    },
  },
  {
    name: "list_effects",
    description: "List the available video effects catalog (face-tracked, kinetic-text, color-grade, motion, sticker, ambient) with face-safety info.",
    inputSchema: listEffectsSchema,
    run: async (raw) => {
      const input = listEffectsSchema.parse(raw);
      const effects = listEffects(input.category);
      const categories = input.category ? [...new Set(effects.map((e) => e.category))] : [...new Set(EFFECTS.map((e) => e.category))];
      return {
        ok: true,
        summary: `Found ${effects.length} effect(s)${input.category ? ` in category "${input.category}"` : ""}.`,
        data: { effects, categories, count: effects.length },
      } satisfies ToolResult;
    },
  },
  {
    name: "get_effect",
    description: "Get a single video effect by id, including category, face-safety, and timing hint.",
    inputSchema: getEffectSchema,
    run: async (raw) => {
      const input = getEffectSchema.parse(raw);
      const effect: VideoEffect | undefined = getEffect(input.effectId);
      if (!effect) {
        return { ok: false, summary: `Effect "${input.effectId}" not found.`, error: "not-found" } satisfies ToolResult;
      }
      return {
        ok: true,
        summary: `Effect "${effect.id}" (${effect.category}) — ${effect.description}`,
        data: { effect },
      } satisfies ToolResult;
    },
  },
];
