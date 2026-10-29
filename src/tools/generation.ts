/**
 * Generation tools — programmatic video creation & rendering, inspired by
 * Remotion (React compositions), HyperFrames (HTML compositions), and the
 * shot-driven cinematic pipelines built on top of them (video-shotcraft).
 *
 *   - create_video      : create a new video project from a generation spec
 *   - render_project   : render a project to MP4 via a backend (Remotion / HyperFrames)
 *
 * Both tools honor the standard safety rails: dry-run by default, backups +
 * validation before writes, notifications via the bus, structured ToolResults.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { executeWrite } from "../safety/dry-run.js";
import { bus } from "../notifications/events.js";
import { withRetry, safeStat } from "../utils/fs.js";
import { uid, sToUs, nowIso } from "../utils/id.js";
import { assertValidProject } from "../safety/validator.js";
import { assertPathInside, assertSafeExternalPath } from "../safety/path-guard.js";
import { capcutDraftFolder, opencutProjectPath, opencutProjectsRoot, exportRoot } from "../utils/paths.js";
import { DEFAULT_EXPORT_PROFILES, type EditorProject, type Material, type Clip, type TextOverlay, type Track } from "../adapters/types.js";
import { writeTask, type RenderTask } from "./export.js";
import { startRenderJob, type RenderJob } from "../render/backends.js";
import path from "node:path";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// create_video
// ---------------------------------------------------------------------------

const createVideoClipSchema = z.object({
  sourceIn: z.number().min(0).describe("Source in-point, seconds."),
  sourceOut: z.number().min(0).describe("Source out-point, seconds."),
  targetStart: z.number().min(0).describe("Timeline start, seconds."),
  targetEnd: z.number().min(0).describe("Timeline end, seconds."),
  materialSourcePath: z.string().optional().describe("Absolute path of the source video. Required for video clips."),
  sourceWidth: z.number().int().positive().optional().describe("Source width in px."),
  sourceHeight: z.number().int().positive().optional().describe("Source height in px."),
  transitionInType: z.string().optional().describe("Transition type for the clip intro (e.g. \"fade\")."),
  transitionInDuration: z.number().min(0).default(0).describe("Intro transition duration, seconds."),
  transitionOutType: z.string().optional().describe("Transition type for the clip outro (e.g. \"slide\")."),
  transitionOutDuration: z.number().min(0).default(0).describe("Outro transition duration, seconds."),
});

const createVideoTextSchema = z.object({
  text: z.string().min(1).describe("Text content; use \\n for line breaks."),
  start: z.number().min(0).describe("Start on the timeline, seconds."),
  end: z.number().min(0).describe("End on the timeline, seconds."),
  fontSize: z.number().int().positive().optional().describe("Font size in px."),
  color: z.string().optional().describe("Text color hex, e.g. \"#FFFFFFFF\"."),
  bold: z.boolean().optional().describe("Bold flag."),
});

const createVideoAudioSchema = z.object({
  sourcePath: z.string().min(1).describe("Absolute path to the audio file."),
  start: z.number().min(0).describe("Start on the timeline, seconds."),
  duration: z.number().min(0.1).describe("Source duration, seconds."),
  volume: z.number().min(0).max(1).optional().describe("Clip volume 0..1."),
});

const createVideoSchema = z.object({
  name: z.string().min(1).describe("Display name for the generated video."),
  editor: z.enum(["capcut", "opencut"]).describe("Storage backend the generated timeline is written to."),
  engine: z.enum(["remotion", "hyperframes", "motion"]).default("remotion").describe("Generation engine the spec targets: Remotion (React composition), HyperFrames (HTML composition), or Motion (frame-stepping animation artifact)."),
  width: z.number().int().positive().default(1920).describe("Canvas width in px."),
  height: z.number().int().positive().default(1080).describe("Canvas height in px."),
  fps: z.number().int().positive().default(30).describe("Frames per second."),
  durationInSeconds: z.number().min(0.1).describe("Target video duration in seconds."),
  clips: z.array(createVideoClipSchema).optional().describe("Timeline clips to place in the generated video."),
  texts: z.array(createVideoTextSchema).optional().describe("Text overlays to place in the generated video."),
  audio: z.array(createVideoAudioSchema).optional().describe("Audio tracks (music/SFX) to place in the generated video."),
  dryRun: z.boolean().default(true).describe("When true, no files are written (dry-run default)."),
});

type CreateVideoInput = z.infer<typeof createVideoSchema>;

// ---------------------------------------------------------------------------
// create_video
// ---------------------------------------------------------------------------

/** Validate a create_video generation spec. Returns error message or null. */
function validateGenerationSpec(input: CreateVideoInput): string | null {
  if (!(input.durationInSeconds > 0)) return "durationInSeconds must be greater than 0.";
  for (const c of input.clips ?? []) {
    if (!(c.sourceOut > c.sourceIn)) return `Clip sourceOut (${c.sourceOut}s) must be greater than sourceIn (${c.sourceIn}s).`;
    if (!(c.targetEnd > c.targetStart)) return `Clip targetEnd (${c.targetEnd}s) must be greater than targetStart (${c.targetStart}s).`;
    if (!c.materialSourcePath) return "Every video clip requires materialSourcePath.";
    try {
      assertSafeExternalPath(c.materialSourcePath);
    } catch (err) {
      return `Unsafe materialSourcePath: ${(err as Error).message}`;
    }
  }
  for (const t of input.texts ?? []) {
    if (!(t.end > t.start)) return `Text overlay "${t.text.slice(0, 24)}…" must have end greater than start.`;
  }
  for (const a of input.audio ?? []) {
    if (!(a.duration > 0)) return "Audio duration must be greater than 0.";
  }
  return null;
}

/** Build a normalized EditorProject from a create_video generation spec. */
function buildGeneratedProject(input: CreateVideoInput): EditorProject {
  const id = uid(input.editor === "capcut" ? "draft_" : "proj_");
  const filePath = input.editor === "capcut" ? `${capcutDraftFolder(id)}/draft_content.json` : opencutProjectPath(id);

  const materials: Material[] = [];
  const materialIdBySource = new Map<string, string>();
  const videoTrack: Track = { id: uid("track_"), kind: "video", clips: [] };
  const audioTracks: Track[] = [];
  const texts: TextOverlay[] = [];
  let durationUs = sToUs(input.durationInSeconds);

  for (const c of input.clips ?? []) {
    const sourceIn = sToUs(c.sourceIn);
    const sourceOut = sToUs(c.sourceOut);
    const targetStart = sToUs(c.targetStart);
    const targetEnd = sToUs(c.targetEnd);
    const sourceDuration = sourceOut - sourceIn;
    if (!c.materialSourcePath) throw new Error("Video clip requires materialSourcePath.");
    let materialId = c.materialSourcePath ? materialIdBySource.get(c.materialSourcePath) : undefined;
    if (!materialId) {
      materialId = uid("mat_");
      if (c.materialSourcePath) materialIdBySource.set(c.materialSourcePath, materialId);
      materials.push({
        id: materialId,
        type: "video",
        sourcePath: c.materialSourcePath,
        duration: sourceDuration,
        width: c.sourceWidth ?? input.width,
        height: c.sourceHeight ?? input.height,
      });
    }
    const clip: Clip = {
      id: uid("clip_"),
      materialId,
      sourceIn,
      sourceOut,
      targetStart,
      targetEnd,
      ...(c.transitionInType ? { transitionIn: { type: c.transitionInType, duration: sToUs(c.transitionInDuration) } } : {}),
      ...(c.transitionOutType ? { transitionOut: { type: c.transitionOutType, duration: sToUs(c.transitionOutDuration) } } : {}),
    };
    videoTrack.clips.push(clip);
    videoTrack.clips.sort((a, b) => a.targetStart - b.targetStart);
    durationUs = Math.max(durationUs, targetEnd);
  }

  if ((input.audio ?? []).length > 0) {
    const audioTrack: Track = { id: uid("track_"), kind: "audio", clips: [] };
    for (const a of input.audio!) {
      const sourceIn = 0;
      const sourceOut = sToUs(a.duration);
      const targetStart = sToUs(a.start);
      const targetEnd = targetStart + sourceOut;
      let materialId = a.sourcePath ? materialIdBySource.get(a.sourcePath) : undefined;
      if (!materialId) {
        materialId = uid("mat_");
        if (a.sourcePath) materialIdBySource.set(a.sourcePath, materialId);
        materials.push({ id: materialId, type: "audio", sourcePath: a.sourcePath, duration: sourceOut, width: 0, height: 0 });
      }
      audioTrack.clips.push({
        id: uid("clip_"),
        materialId,
        sourceIn,
        sourceOut,
        targetStart,
        targetEnd,
        ...(typeof a.volume === "number" ? { volume: a.volume } : {}),
      });
    }
    audioTrack.clips.sort((a, b) => a.targetStart - b.targetStart);
    audioTracks.push(audioTrack);
  }

  for (const t of input.texts ?? []) {
    texts.push({
      id: uid("text_"),
      text: t.text,
      start: sToUs(t.start),
      end: sToUs(t.end),
      ...(t.fontSize !== undefined ? { fontSize: t.fontSize } : {}),
      ...(t.color ? { color: t.color } : {}),
      ...(t.bold !== undefined ? { bold: t.bold } : {}),
    });
    durationUs = Math.max(durationUs, sToUs(t.end));
  }

  const tracks = audioTracks.length > 0 ? [videoTrack, ...audioTracks] : [videoTrack];

  const project: EditorProject = {
    id,
    name: input.name,
    editor: input.editor,
    filePath,
    duration: durationUs,
    width: input.width,
    height: input.height,
    fps: input.fps,
    tracks,
    materials,
    texts,
    effects: [],
  };
  assertValidProject(project);
  return project;
}

/** Escape text content for safe interpolation into an HTML document. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render the HyperFrames `index.html` composition scaffold for a project. */
function buildHyperframesHtml(project: EditorProject, compositionId: string): string {
  const videoTrack = project.tracks.find((t) => t.kind === "video");
  const audioTrack = project.tracks.find((t) => t.kind === "audio");
  const lines: string[] = [];
  lines.push("<!doctype html>");
  lines.push('<html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#000;overflow:hidden}</style></head>');
  lines.push("<body>");
  lines.push(`<div id="stage" data-composition-id="${compositionId}" data-start="0" data-width="${project.width}" data-height="${project.height}">`);
  if (videoTrack) {
    for (const c of videoTrack.clips) {
      const material = project.materials.find((m) => m.id === c.materialId);
      if (!material) continue;
      const duration = c.sourceOut - c.sourceIn;
      lines.push(
        `<video class="clip" data-start="${(c.sourceIn / 1_000_000).toFixed(3)}" data-duration="${(duration / 1_000_000).toFixed(3)}" data-track-index="0" src="${escapeHtml(material.sourcePath)}" muted playsinline />`,
      );
    }
  }
  if (audioTrack) {
    for (const c of audioTrack.clips) {
      const material = project.materials.find((m) => m.id === c.materialId);
      if (!material) continue;
      const duration = c.sourceOut - c.sourceIn;
      lines.push(
        `<audio class="clip" data-start="${(c.sourceIn / 1_000_000).toFixed(3)}" data-duration="${(duration / 1_000_000).toFixed(3)}" data-track-index="1" src="${escapeHtml(material.sourcePath)}" data-volume="${c.volume ?? 1}"></audio>`,
      );
    }
  }
  const textIds: string[] = [];
  for (const t of project.texts) {
    const textId = `text_${t.id.slice(5)}`;
    textIds.push(textId);
    lines.push(
      `<div class="clip" id="${textId}" data-start="${(t.start / 1_000_000).toFixed(3)}" data-duration="${((t.end - t.start) / 1_000_000).toFixed(3)}" data-track-index="2" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#FFFFFFFF;font-size:${t.fontSize ?? 64}px;font-weight:${t.bold ? 700 : 400};">${escapeHtml(t.text)}</div>`,
    );
  }
  lines.push("</div>");
  lines.push("<script src=\"https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js\"></script>");
  lines.push("<script>");
  lines.push("  window.__timelines = window.__timelines || {};");
  lines.push("  const tl = gsap.timeline({ paused: true });");
  for (const tid of textIds) {
    lines.push(`  tl.from("#${tid}", { opacity: 0, y: 40, duration: 0.8, ease: "power2.out" });`);
  }
  lines.push(`  window.__timelines.${compositionId} = tl;`);
  lines.push("</script>");
  lines.push("</body></html>");
  return lines.join("\n");
}

function projectDirFor(project: EditorProject): string {
  if (project.editor === "capcut") return path.dirname(project.filePath);
  return opencutProjectsRoot();
}

const renderProjectSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  engine: z.enum(["remotion", "hyperframes", "motion"]).default("hyperframes").describe("Render backend to use (motion renders via frame-stepping + ffmpeg, backed by Remotion)."),
  entry: z.string().optional().describe("Remotion entry file, e.g. 'src/index.ts'. Required for remotion renders."),
  compositionId: z.string().optional().describe("Remotion composition id. Defaults to the project name."),
  outputPath: z.string().optional().describe("Output MP4 path. Defaults to <exportRoot>/<projectName>.mp4."),
  dryRun: z.boolean().default(true).describe("When true, no render is started."),
});

export const generationTools: Tool[] = [
  {
    name: "create_video",
    description:
      "Create a new video project from a programmatic generation spec (composition timeline: clips, texts, audio). Author the video for the Remotion (React), HyperFrames (HTML), or Motion (frame-stepping animation) engine. Honors dry-run by default.",
    inputSchema: createVideoSchema,
    run: async (raw) => {
      const input = createVideoSchema.parse(raw);
      const specError = validateGenerationSpec(input);
      if (specError) {
        return { ok: false, summary: `Invalid generation spec: ${specError}`, error: "invalid-spec" } satisfies ToolResult;
      }
      let project: EditorProject;
      let html: string | null = null;
      try {
        project = buildGeneratedProject(input);
        html = input.engine === "hyperframes" || input.engine === "motion" ? buildHyperframesHtml(project, project.name) : null;
      } catch (err) {
        const e = err as Error;
        return { ok: false, summary: `Failed to build generated project: ${e.message}`, error: "build-failed" } satisfies ToolResult;
      }

      const description = `Create ${input.editor} video project "${input.name}" (${input.width}x${input.height}@${input.fps}fps, ${input.durationInSeconds}s, engine=${input.engine}, ${(input.clips ?? []).length} clips, ${(input.texts ?? []).length} texts, ${(input.audio ?? []).length} audio tracks)`;

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] ${description}. No files written.`,
          data: {
            id: project.id,
            name: project.name,
            editor: project.editor,
            engine: input.engine,
            duration: project.duration,
            width: project.width,
            height: project.height,
            fps: project.fps,
            tracks: project.tracks.length,
            materials: project.materials.length,
            texts: project.texts.length,
            filePath: project.filePath,
          },
          dryRun: true,
        } satisfies ToolResult;
      }

      const writeResult = await executeWrite({
        dryRun: false,
        targetPath: project.filePath,
        newValue: project,
        description,
        apply: async () => {
          facade.cacheProject(project);
          await withRetry(() => facade.saveProject(project));
          bus.emitProjectChanged({
            projectId: project.id,
            kind: project.editor,
            change: "draft-written",
            filePath: project.filePath,
          });
        },
      });
      if (!writeResult.ok) return writeResult;

      let htmlWritten = false;
      if (html) {
        try {
          const dir = projectDirFor(project);
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, "index.html"), html, "utf-8");
          htmlWritten = true;
        } catch (err) {
          const e = err as Error;
          return {
            ok: false,
            summary: `Created project but failed to write HyperFrames index.html: ${e.message}`,
            error: "html-write-failed",
            data: { id: project.id },
            dryRun: false,
            backupPath: writeResult.backupPath,
          } satisfies ToolResult;
        }
      }

      return {
        ok: true,
        summary: `Created ${input.editor} video project "${input.name}" (${input.width}x${input.height}@${input.fps}fps, ${input.durationInSeconds}s, engine=${input.engine}).${htmlWritten ? " HyperFrames index.html scaffold written." : ""}`,
        data: {
          id: project.id,
          name: project.name,
          editor: project.editor,
          engine: input.engine,
          duration: project.duration,
          width: project.width,
          height: project.height,
          fps: project.fps,
          tracks: project.tracks.length,
          materials: project.materials.length,
          texts: project.texts.length,
          filePath: project.filePath,
          htmlWritten,
        },
        dryRun: false,
        backupPath: writeResult.backupPath,
      } satisfies ToolResult;
    },
  },
  {
    name: "render_project",
    description:
      "Render a video project to MP4 via an open-source backend: Remotion (`npx remotion render`) or HyperFrames (`npx hyperframes render`). Creates a render task, spawns the backend, streams progress, writes output under the export root.",
    inputSchema: renderProjectSchema,
    run: async (raw) => {
      const input = renderProjectSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      const profile = DEFAULT_EXPORT_PROFILES["1080p-30"];
      const outPath = input.outputPath ? path.resolve(input.outputPath) : path.resolve(path.join(exportRoot(), `${project.name}.${profile.format}`));
      try {
        assertPathInside(outPath, exportRoot(), "outputPath");
      } catch (err) {
        return { ok: false, summary: `Unsafe output path: ${(err as Error).message}`, error: "unsafe-path" } satisfies ToolResult;
      }

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Render ${input.engine} project "${project.name}" to ${outPath}. No render started.`,
          data: { projectId: project.id, engine: input.engine, outputPath: outPath, dryRun: true },
          dryRun: true,
        } satisfies ToolResult;
      }

      const taskId = uid("render_");
      const task: RenderTask = {
        id: taskId,
        projectId: project.id,
        profile,
        outputPath: outPath,
        phase: "queued",
        progress: 0,
        queuedAt: nowIso(),
      };
      await writeTask(task);
      bus.emitRenderProgress({
        projectId: project.id,
        phase: "queued",
        progress: 0,
        outputPath: outPath,
      });

      const job: RenderJob = {
        engine: input.engine,
        projectName: project.name,
        entry: input.entry,
        compositionId: input.compositionId,
        outputPath: outPath,
        cwd: input.engine === "hyperframes" || input.engine === "motion" ? projectDirFor(project) : undefined,
      };
      const { promise } = startRenderJob(job);
      const result = await promise;

      if (result.code === 0) {
        task.phase = "complete";
        task.progress = 1;
        task.completedAt = nowIso();
        task.error = undefined;
        await writeTask(task);
        bus.emitRenderProgress({
          projectId: project.id,
          phase: "complete",
          progress: 1,
          outputPath: outPath,
        });
        return {
          ok: true,
          summary: `Render completed for project "${project.name}" via ${input.engine}. Output: ${outPath}`,
          data: { taskId, projectId: project.id, engine: input.engine, outputPath: outPath, phase: "complete" },
          dryRun: false,
        } satisfies ToolResult;
      }

      task.phase = "error";
      task.completedAt = nowIso();
      task.error = (result.stderr || result.stdout || "unknown renderer error").slice(-4000);
      await writeTask(task);
      bus.emitRenderProgress({
        projectId: project.id,
        phase: "error",
        progress: 0,
        outputPath: outPath,
        error: task.error,
      });
      return {
        ok: false,
        summary: `Render via ${input.engine} failed (exit=${result.code}). See task ${taskId} for details.`,
        data: { taskId, projectId: project.id, engine: input.engine, outputPath: outPath, phase: "error", error: task.error },
        dryRun: false,
        error: task.error,
      } satisfies ToolResult;
    },
  },
];
