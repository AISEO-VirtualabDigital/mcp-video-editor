/**
 * Timeline/clip tools — create tracks, add clips, split/trim/move/delete clips.
 *
 *   - add_track             : add a new track of a given kind
 *   - remove_track          : remove a track (its clips are dropped)
 *   - add_clip              : add a clip referencing a material to a track
 *   - add_video_clip        : convenience — also adds the material if missing
 *   - split_clip            : split a clip at a given timeline timestamp
 *   - trim_clip             : change source in/out and target end
 *   - move_clip             : move a clip on the timeline (targetStart)
 *   - delete_clip           : remove a clip
 *   - set_clip_speed        : set the playback speed of a clip (1.0 = normal)
 *   - set_track_volume      : set the whole-track volume multiplier
 *   - set_track_visibility  : show/hide a track
 *
 * All write operations honor dry-run (default true) and trigger a
 * ProjectChanged notification via the bus.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { executeWrite } from "../safety/dry-run.js";
import { bus } from "../notifications/events.js";
import { uid } from "../utils/id.js";
import { withRetry } from "../utils/fs.js";
import { safeStat } from "../utils/fs.js";
import { assertSafeExternalPath } from "../safety/path-guard.js";
import type { TrackKind, Material } from "../adapters/types.js";

const addTrackSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  kind: z.enum(["video", "audio", "text", "sticker", "effect"]).describe("Track kind."),
  volume: z.number().min(0).max(1).optional().describe("Whole-track volume 0..1 (audio tracks only)."),
  visible: z.boolean().optional().describe("Track visibility."),
  dryRun: z.boolean().default(true).describe("When true, the in-memory cache is mutated but the file is NOT written. Use save_project to persist."),
});

const removeTrackSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id to remove."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const addClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id where the clip will be appended."),
  materialId: z.string().min(1).describe("Material id to reference. Must already exist in project.materials."),
  sourceIn: z.number().int().min(0).default(0).describe("In-point on the source material, microseconds."),
  sourceOut: z.number().int().min(0).describe("Out-point on the source material, microseconds. If omitted, material.duration is used (pass 0 as sentinel and we'll auto-fill)."),
  targetStart: z.number().int().min(0).optional().describe("Where to place the clip on the timeline, microseconds. Defaults to the end of the last clip on this track."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const addVideoClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id (kind=video)."),
  sourcePath: z.string().min(1).describe("Absolute path to the source video file."),
  duration: z.number().int().min(1).describe("Duration of the source file in microseconds."),
  width: z.number().int().min(1).default(1920).describe("Source width px."),
  height: z.number().int().min(1).default(1080).describe("Source height px."),
  sourceIn: z.number().int().min(0).default(0).describe("Source in-point."),
  sourceOut: z.number().int().min(0).optional().describe("Source out-point. Defaults to duration."),
  targetStart: z.number().int().min(0).optional().describe("Timeline start; defaults to end of last clip on track."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const splitClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id to split."),
  at: z.number().int().min(0).describe("Timeline timestamp to split at, microseconds. Must be strictly between the clip's targetStart and targetEnd."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const trimClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  newSourceIn: z.number().int().min(0).optional().describe("New source in-point, microseconds."),
  newSourceOut: z.number().int().min(0).optional().describe("New source out-point, microseconds."),
  newTargetStart: z.number().int().min(0).optional().describe("New target start, microseconds."),
  newTargetEnd: z.number().int().min(0).optional().describe("New target end, microseconds."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const moveClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  newTargetStart: z.number().int().min(0).describe("New target start, microseconds. The end moves with the start (duration preserved)."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const deleteClipSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id to remove."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const setClipSpeedSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  clipId: z.string().min(1).describe("Clip id."),
  speed: z.number().min(0.1).max(10).describe("Playback speed multiplier (1.0 = normal, 2.0 = 2x fast)."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const setTrackVolumeSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  volume: z.number().min(0).max(1).describe("Volume 0..1."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

const setTrackVisibilitySchema = z.object({
  id: z.string().min(1).describe("Project id."),
  trackId: z.string().min(1).describe("Track id."),
  visible: z.boolean().describe("True to show, false to hide."),
  dryRun: z.boolean().default(true).describe("Same semantics as add_track."),
});

function findTrack(projectId: string, trackId: string) {
  const p = facade.getOpenProject(projectId);
  const t = p.tracks.find((x) => x.id === trackId);
  if (!t) {
    throw new Error(`Track ${trackId} not found in project ${projectId}.`);
  }
  return { p, t };
}

function recomputeDuration(p: Parameters<typeof facade.getOpenProject>[0]) {
  const proj = facade.getOpenProject(p);
  let max = 0;
  for (const t of proj.tracks) {
    for (const c of t.clips) {
      if (c.targetEnd > max) max = c.targetEnd;
    }
  }
  proj.duration = max;
}

/**
 * Helper — apply a mutating operation to an open project, optionally persisting
 * to disk if dryRun=false. The mutation runs on the in-memory project
 * regardless of dryRun, so the AI client can immediately query the new state.
 * Persistence only happens when dryRun=false.
 */
async function applyMutation(
  projectId: string,
  description: string,
  dryRun: boolean,
  mutate: () => void | Promise<void>,
): Promise<ToolResult> {
  const project = facade.getOpenProject(projectId);
  await mutate();
  facade.cacheProject(project); // make sure latest is in cache
  recomputeDuration(projectId);

  if (dryRun) {
    return {
      ok: true,
      summary: `[DRY-RUN] ${description}. In-memory cache updated; NOT written to disk. Use save_project to persist.`,
      data: { projectId, dryRun: true },
      dryRun: true,
    } satisfies ToolResult;
  }

  // Persist now (with backup).
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

export const timelineTools: Tool[] = [
  {
    name: "add_track",
    description: "Add a new track to a project. Track kind can be video/audio/text/sticker/effect.",
    inputSchema: addTrackSchema,
    run: async (raw) => {
      const input = addTrackSchema.parse(raw);
      return applyMutation(
        input.id,
        `Add ${input.kind} track`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = {
            id: uid("track_"),
            kind: input.kind as TrackKind,
            clips: [],
            ...(typeof input.volume === "number" ? { volume: input.volume } : {}),
            ...(typeof input.visible === "boolean" ? { visible: input.visible } : {}),
          };
          project.tracks.push(track);
        },
      );
    },
  },
  {
    name: "remove_track",
    description: "Remove a track and all its clips from a project.",
    inputSchema: removeTrackSchema,
    run: async (raw) => {
      const input = removeTrackSchema.parse(raw);
      return applyMutation(
        input.id,
        `Remove track ${input.trackId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          project.tracks = project.tracks.filter((t) => t.id !== input.trackId);
        },
      );
    },
  },
  {
    name: "add_clip",
    description:
      "Add a clip referencing an existing material to a track. The clip is appended at the end of the track (or at targetStart if given).",
    inputSchema: addClipSchema,
    run: async (raw) => {
      const input = addClipSchema.parse(raw);
      return applyMutation(
        input.id,
        `Add clip on track ${input.trackId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const material = project.materials.find((m) => m.id === input.materialId);
          if (!material) throw new Error(`Material ${input.materialId} not found.`);
          const sourceOut = input.sourceOut > 0 ? input.sourceOut : material.duration;
          const duration = Math.max(0, sourceOut - input.sourceIn);
          const targetStart =
            input.targetStart ?? (track.clips.length > 0 ? Math.max(...track.clips.map((c) => c.targetEnd)) : 0);
          track.clips.push({
            id: uid("clip_"),
            materialId: input.materialId,
            sourceIn: input.sourceIn,
            sourceOut,
            targetStart,
            targetEnd: targetStart + duration,
          });
          // Re-sort by targetStart so subsequent operations are predictable.
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "add_video_clip",
    description:
      "Convenience: add a video material AND a clip referencing it, in one call. Verifies the source file exists. Useful when the AI knows the file path but no material exists yet.",
    inputSchema: addVideoClipSchema,
    run: async (raw) => {
      const input = addVideoClipSchema.parse(raw);
      // Validate the source path against UNC, device paths, null bytes, etc.
      // We do this even in dry-run mode so the AI gets feedback on unsafe
      // paths before committing to a save.
      try {
        assertSafeExternalPath(input.sourcePath);
      } catch (err) {
        return {
          ok: false,
          summary: `Unsafe source path: ${(err as Error).message}`,
          error: "unsafe-path",
        } satisfies ToolResult;
      }
      // Verify the source file exists (only meaningful when not dry-run; skip on dry-run).
      if (!input.dryRun) {
        const st = await safeStat(input.sourcePath);
        if (!st) {
          return {
            ok: false,
            summary: `Source file not found: ${input.sourcePath}`,
            error: "not-found",
          } satisfies ToolResult;
        }
        if (st.isSymbolicLink()) {
          return {
            ok: false,
            summary: `Refused to add symlink as source: ${input.sourcePath}. Resolve the symlink to its real target first.`,
            error: "symlink-refused",
          } satisfies ToolResult;
        }
      }
      return applyMutation(
        input.id,
        `Add video clip ${input.sourcePath}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          if (track.kind !== "video" && track.kind !== "audio") {
            throw new Error(`Track ${input.trackId} is kind ${track.kind}, not video/audio.`);
          }
          // Add material if not already present.
          let material = project.materials.find((m) => m.sourcePath === input.sourcePath);
          if (!material) {
            material = {
              id: uid("mat_"),
              type: "video",
              sourcePath: input.sourcePath,
              duration: input.duration,
              width: input.width,
              height: input.height,
            } satisfies Material;
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
          });
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "split_clip",
    description:
      "Split a clip at a timeline timestamp. The original clip is shortened; a new clip with the same materialId is appended for the remainder.",
    inputSchema: splitClipSchema,
    run: async (raw) => {
      const input = splitClipSchema.parse(raw);
      return applyMutation(
        input.id,
        `Split clip ${input.clipId} at ${input.at}us`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (input.at <= clip.targetStart || input.at >= clip.targetEnd) {
            throw new Error(`Split point ${input.at} must be strictly inside [${clip.targetStart}, ${clip.targetEnd}].`);
          }
          const leftDuration = input.at - clip.targetStart;
          const rightDuration = clip.targetEnd - input.at;
          const leftSourceOut = clip.sourceIn + leftDuration;
          // Shorten the original clip.
          const rightClip = {
            id: uid("clip_"),
            materialId: clip.materialId,
            sourceIn: leftSourceOut,
            sourceOut: clip.sourceOut,
            targetStart: input.at,
            targetEnd: clip.targetEnd,
          };
          clip.sourceOut = leftSourceOut;
          clip.targetEnd = input.at;
          // Make sure rightDuration wasn't lost.
          rightClip.targetEnd = input.at + rightDuration;
          track.clips.push(rightClip);
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "trim_clip",
    description:
      "Trim/move a clip's source and target time ranges. Only the supplied fields are updated.",
    inputSchema: trimClipSchema,
    run: async (raw) => {
      const input = trimClipSchema.parse(raw);
      return applyMutation(
        input.id,
        `Trim clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          if (typeof input.newSourceIn === "number") clip.sourceIn = input.newSourceIn;
          if (typeof input.newSourceOut === "number") clip.sourceOut = input.newSourceOut;
          if (typeof input.newTargetStart === "number") {
            const dur = clip.targetEnd - clip.targetStart;
            clip.targetStart = input.newTargetStart;
            clip.targetEnd = input.newTargetStart + dur;
          }
          if (typeof input.newTargetEnd === "number") clip.targetEnd = input.newTargetEnd;
          if (clip.targetEnd < clip.targetStart) {
            throw new Error("trim would result in targetEnd < targetStart.");
          }
          if (clip.sourceOut < clip.sourceIn) {
            throw new Error("trim would result in sourceOut < sourceIn.");
          }
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "move_clip",
    description: "Move a clip on the timeline (duration preserved). Does NOT prevent overlap — caller's responsibility.",
    inputSchema: moveClipSchema,
    run: async (raw) => {
      const input = moveClipSchema.parse(raw);
      return applyMutation(
        input.id,
        `Move clip ${input.clipId} to ${input.newTargetStart}us`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          const dur = clip.targetEnd - clip.targetStart;
          clip.targetStart = input.newTargetStart;
          clip.targetEnd = input.newTargetStart + dur;
          track.clips.sort((a, b) => a.targetStart - b.targetStart);
        },
      );
    },
  },
  {
    name: "delete_clip",
    description: "Delete a clip from a track.",
    inputSchema: deleteClipSchema,
    run: async (raw) => {
      const input = deleteClipSchema.parse(raw);
      return applyMutation(
        input.id,
        `Delete clip ${input.clipId}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          track.clips = track.clips.filter((c) => c.id !== input.clipId);
        },
      );
    },
  },
  {
    name: "set_clip_speed",
    description: "Set the playback speed multiplier on a clip (1.0 = normal).",
    inputSchema: setClipSpeedSchema,
    run: async (raw) => {
      const input = setClipSpeedSchema.parse(raw);
      return applyMutation(
        input.id,
        `Set clip ${input.clipId} speed to ${input.speed}x`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          const clip = track.clips.find((c) => c.id === input.clipId);
          if (!clip) throw new Error(`Clip ${input.clipId} not found.`);
          clip.speed = input.speed;
          // Adjust target duration to match new effective duration.
          const sourceDur = clip.sourceOut - clip.sourceIn;
          const newTargetDur = Math.round(sourceDur / input.speed);
          clip.targetEnd = clip.targetStart + newTargetDur;
        },
      );
    },
  },
  {
    name: "set_track_volume",
    description: "Set the whole-track volume (0..1) for an audio-capable track.",
    inputSchema: setTrackVolumeSchema,
    run: async (raw) => {
      const input = setTrackVolumeSchema.parse(raw);
      return applyMutation(
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
    name: "set_track_visibility",
    description: "Show or hide a track.",
    inputSchema: setTrackVisibilitySchema,
    run: async (raw) => {
      const input = setTrackVisibilitySchema.parse(raw);
      return applyMutation(
        input.id,
        `Set track ${input.trackId} visible=${input.visible}`,
        input.dryRun,
        () => {
          const project = facade.getOpenProject(input.id);
          const track = project.tracks.find((t) => t.id === input.trackId);
          if (!track) throw new Error(`Track ${input.trackId} not found.`);
          track.visible = input.visible;
        },
      );
    },
  },
];
