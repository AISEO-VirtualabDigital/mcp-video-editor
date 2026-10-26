/**
 * Audio tools.
 *
 *   - add_audio_clip        : add an audio material + clip to an audio track
 *   - adjust_volume         : set clip-level volume (0..1)
 *   - adjust_track_volume   : set whole-track volume (alias of timeline's set_track_volume)
 *   - fade_in               : add a fade-in on a clip
 *   - fade_out              : add a fade-out on a clip
 *   - split_audio           : split an audio clip at a timestamp (alias of split_clip)
 *   - denoise               : mark an audio clip as denoised (writes the vendor field)
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { executeWrite } from "../safety/dry-run.js";
import { bus } from "../notifications/events.js";
import { withRetry } from "../utils/fs.js";
import { safeStat } from "../utils/fs.js";
import { assertSafeExternalPath } from "../safety/path-guard.js";
import { uid } from "../utils/id.js";

const addAudioClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Audio track id (kind=audio). Use add_track first if missing."),
  sourcePath: z.string().min(1).describe("Absolute path to the audio file."),
  duration: z.number().int().min(1).describe("Source duration in microseconds."),
  sourceIn: z.number().int().min(0).default(0).describe("Source in-point, microseconds."),
  sourceOut: z.number().int().min(0).optional().describe("Source out-point. Defaults to duration."),
  targetStart: z.number().int().min(0).optional().describe("Timeline start; defaults to end of last clip on track."),
  volume: z.number().min(0).max(1).optional().describe("Clip-level volume 0..1."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const adjustVolumeSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  volume: z.number().min(0).max(1).describe("Volume 0..1."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const adjustTrackVolumeSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  volume: z.number().min(0).max(1).describe("Track volume 0..1."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const fadeInSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  duration: z.number().int().positive().describe("Fade duration, microseconds."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const fadeOutSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  duration: z.number().int().positive().describe("Fade duration, microseconds."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const splitAudioSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  at: z.number().int().min(0).describe("Timeline timestamp to split at, microseconds."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

const denoiseSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  enable: z.boolean().default(true).describe("True to enable, false to disable."),
  dryRun: z.boolean().default(true).describe("When true, in-memory only."),
});

async function applyAudioMutation(
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

export const audioTools: Tool[] = [
  {
    name: "add_audio_clip",
    description: "Add an audio file as a material + clip on an audio track. Verifies the source exists when not dry-run.",
    inputSchema: addAudioClipSchema,
    run: async (raw) => {
      const input = addAudioClipSchema.parse(raw);
      // Validate the source path against UNC, device paths, null bytes, etc.
      try {
        assertSafeExternalPath(input.sourcePath);
      } catch (err) {
        return {
          ok: false,
          summary: `Unsafe source path: ${(err as Error).message}`,
          error: "unsafe-path",
        } satisfies ToolResult;
      }
      if (!input.dryRun) {
        const st = await safeStat(input.sourcePath);
        if (!st) {
          return {
            ok: false,
            summary: `Audio file not found: ${input.sourcePath}`,
            error: "not-found",
          } satisfies ToolResult;
        }
        if (st.isSymbolicLink()) {
          return {
            ok: false,
            summary: `Refused to add symlink as source: ${input.sourcePath}.`,
            error: "symlink-refused",
          } satisfies ToolResult;
        }
      }
      return applyAudioMutation(
        input.id,
        `Add audio clip ${input.sourcePath}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          if (track.kind !== "audio") throw new Error(`Track ${input.trackId} is kind=${track.kind}, not audio.`);
          let material = project.materials.find((m) => m.sourcePath === input.sourcePath);
          if (!material) {
            material = {
              id: uid("mat_"),
              type: "audio",
              sourcePath: input.sourcePath,
              duration: input.duration,
              width: 0,
              height: 0,
            };
            project.materials.push(material);
          }
          const sourceOut = input.sourceOut ?? material.duration;
          const duration = Math.max(0, sourceOut - input.sourceIn);
          const targetStart =
            input.targetStart ?? (track.clips.length > 0 ? Math.max(...track.clips.map((c) => c.targetEnd)) : 0);
          track.clips.push({
            id: uid("clip_"),
            materialId: material.id,
            sourceIn: input.sourceIn,
            sourceOut,
            targetStart,
            targetEnd: targetStart + duration,
            volume: input.volume,
          });
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "adjust_volume",
    description: "Set the volume multiplier (0..1) for one clip.",
    inputSchema: adjustVolumeSchema,
    run: async (raw) => {
      const input = adjustVolumeSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Set clip ${input.clipId} volume=${input.volume}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          clip.volume = input.volume;
        },
      );
    },
  },
  {
    name: "adjust_track_volume",
    description: "Set the whole-track volume (0..1) for an audio-capable track.",
    inputSchema: adjustTrackVolumeSchema,
    run: async (raw) => {
      const input = adjustTrackVolumeSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Set track ${input.trackId} volume=${input.volume}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          track.volume = input.volume;
        },
      );
    },
  },
  {
    name: "fade_in",
    description: "Add a fade-in on a clip (linear ramp from 0 to clip volume).",
    inputSchema: fadeInSchema,
    run: async (raw) => {
      const input = fadeInSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Fade-in ${input.duration}us on clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (!clip.raw) clip.raw = {};
          (clip.raw as Record<string, unknown>).fade_in = { duration: input.duration };
        },
      );
    },
  },
  {
    name: "fade_out",
    description: "Add a fade-out on a clip (linear ramp from clip volume to 0).",
    inputSchema: fadeOutSchema,
    run: async (raw) => {
      const input = fadeOutSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Fade-out ${input.duration}us on clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (!clip.raw) clip.raw = {};
          (clip.raw as Record<string, unknown>).fade_out = { duration: input.duration };
        },
      );
    },
  },
  {
    name: "split_audio",
    description: "Split an audio clip at a timestamp — equivalent to split_clip but scoped to audio tracks.",
    inputSchema: splitAudioSchema,
    run: async (raw) => {
      const input = splitAudioSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Split audio clip ${input.clipId} at ${input.at}us`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (input.at <= clip.targetStart || input.at >= clip.targetEnd) {
            throw new Error(`Split point must be strictly inside the clip.`);
          }
          const leftDuration = input.at - clip.targetStart;
          const leftSourceOut = clip.sourceIn + leftDuration;
          const rightClip = {
            id: uid("clip_"),
            materialId: clip.materialId,
            sourceIn: leftSourceOut,
            sourceOut: clip.sourceOut,
            targetStart: input.at,
            targetEnd: clip.targetEnd,
            volume: clip.volume,
          };
          clip.sourceOut = leftSourceOut;
          clip.targetEnd = input.at;
          track.clips.push(rightClip);
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "denoise",
    description: "Enable or disable audio denoise on a clip (writes the vendor field; CapCut honors materials.audios[].denoise).",
    inputSchema: denoiseSchema,
    run: async (raw) => {
      const input = denoiseSchema.parse(raw);
      return applyAudioMutation(
        input.id,
        `Denoise ${input.enable ? "on" : "off"} on clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          const material = project.materials.find((m) => m.id === clip.materialId);
          if (material) {
            if (!material.raw) material.raw = {};
            (material.raw as Record<string, unknown>).denoise = input.enable;
          }
        },
      );
    },
  },
];
