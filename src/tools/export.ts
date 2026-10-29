/**
 * Export & render tools.
 *
 *   - list_export_profiles   : return the preset export profiles
 *   - set_export_params      : set the export profile for a project
 *   - export_project         : record a render request for a future backend
 *   - get_render_status      : query the recorded request
 *
 * No renderer is currently connected. Live requests are stored as queued
 * tasks and are never reported as rendering or complete.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { DEFAULT_EXPORT_PROFILES, type ExportProfile } from "../adapters/types.js";
import { bus } from "../notifications/events.js";
import { exportRoot } from "../utils/paths.js";
import { ensureDir, writeJson, readJson, safeStat, listDir } from "../utils/fs.js";
import { assertPathInside, assertSafeExternalPath } from "../safety/path-guard.js";
import { uid } from "../utils/id.js";
import path from "node:path";
import { nowIso } from "../utils/id.js";
import { executeWrite } from "../safety/dry-run.js";

const listExportProfilesSchema = z.object({});

const setExportParamsSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  profileName: z.string().optional().describe('Preset name, e.g. "1080p-30".'),
  custom: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().int().positive(),
      videoBitrate: z.number().int().positive(),
      audioBitrate: z.number().int().positive(),
      format: z.enum(["mp4", "mov", "webm"]),
      codec: z.enum(["h264", "h265", "av1", "vp9"]),
    })
    .optional()
    .describe("Override the preset with a fully custom profile."),
  dryRun: z.boolean().default(true).describe("When true, the export profile is NOT written to disk."),
});

const exportProjectSchema = z.object({
  id: z.string().min(1).describe("Project id."),
  profileName: z.string().optional().describe('Preset name to use. Defaults to "1080p-30".'),
  outputPath: z.string().optional().describe('Override the output file path. Defaults to <exportRoot>/<projectName>.mp4.'),
  dryRun: z.boolean().default(true).describe("When true, return a request preview without storing a task."),
});

const getRenderStatusSchema = z.object({
  taskId: z.string().min(1).describe("Render task id returned by export_project."),
});

const listRenderTasksSchema = z.object({
  id: z.string().min(1).optional().describe("Filter by project id."),
});

export interface RenderTask {
  id: string;
  projectId: string;
  profile: ExportProfile;
  outputPath: string;
  phase: "queued" | "rendering" | "complete" | "error";
  progress: number;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export function renderTasksDir(): string {
  return path.join(exportRoot(), "tasks");
}

export async function readTask(id: string): Promise<RenderTask | null> {
  const p = path.join(renderTasksDir(), `${id}.json`);
  const st = await safeStat(p);
  if (!st) return null;
  return await readJson<RenderTask>(p);
}

export async function writeTask(task: RenderTask): Promise<void> {
  await ensureDir(renderTasksDir());
  await writeJson(path.join(renderTasksDir(), `${task.id}.json`), task);
}

export const exportTools: Tool[] = [
  {
    name: "list_export_profiles",
    description: "List the preset export profiles (1080p-30, 1080p-60, 4k-30, 4k-60, 720p-30).",
    inputSchema: listExportProfilesSchema,
    run: async () => {
      return {
        ok: true,
        summary: `${Object.keys(DEFAULT_EXPORT_PROFILES).length} preset profiles.`,
        data: { profiles: DEFAULT_EXPORT_PROFILES },
      } satisfies ToolResult;
    },
  },
  {
    name: "set_export_params",
    description: "Set the export profile for a project (backs up an existing profile before writing).",
    inputSchema: setExportParamsSchema,
    run: async (raw) => {
      const input = setExportParamsSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      let profile: ExportProfile;
      if (input.custom) {
        profile = input.custom;
      } else {
        const profileName = input.profileName ?? "1080p-30";
        if (!Object.hasOwn(DEFAULT_EXPORT_PROFILES, profileName)) {
          return {
            ok: false,
            summary: `Unknown export profile "${profileName}". Use list_export_profiles to see supported profiles.`,
            error: "unknown-profile",
          } satisfies ToolResult;
        }
        profile = DEFAULT_EXPORT_PROFILES[profileName];
      }
      const profilePath = path.join(path.dirname(project.filePath), "export_profile.json");
      return executeWrite({
        dryRun: input.dryRun,
        targetPath: profilePath,
        newValue: profile,
        description: `Set export profile (${profile.width}x${profile.height}@${profile.fps}fps, ${profile.codec}/${profile.format})`,
        apply: async () => {
          await ensureDir(path.dirname(profilePath));
          await writeJson(profilePath, profile);
        },
      }).then((result) => ({
        ...result,
        data: { profile, profilePath, ...(result.data as object | undefined) },
      }));
    },
  },
  {
    name: "export_project",
    description:
      "Record a render request for a project. No renderer is currently connected, so this tool does not create a video file; live requests remain queued for a future renderer integration.",
    inputSchema: exportProjectSchema,
    run: async (raw) => {
      const input = exportProjectSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      const profileName = input.profileName ?? "1080p-30";
      if (!Object.hasOwn(DEFAULT_EXPORT_PROFILES, profileName)) {
        return {
          ok: false,
          summary: `Unknown export profile "${profileName}". Use list_export_profiles to see supported profiles.`,
          error: "unknown-profile",
        } satisfies ToolResult;
      }
      const profile = DEFAULT_EXPORT_PROFILES[profileName];
      const outPath = input.outputPath
        ? path.resolve(input.outputPath)
        : path.resolve(path.join(exportRoot(), `${path.basename(project.name)}.${profile.format}`));

      try {
        if (input.outputPath) {
          assertSafeExternalPath(input.outputPath);
        }
        assertPathInside(outPath, exportRoot(), "outputPath");
      } catch (err) {
        return {
          ok: false,
          summary: `Unsafe output path: ${(err as Error).message}`,
          error: "unsafe-path",
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

      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Render request preview for project "${project.name}". No task was stored and no video was rendered.`,
          data: { taskId, projectId: project.id, profile, outputPath: outPath, dryRun: true },
          dryRun: true,
        } satisfies ToolResult;
      }

      await writeTask(task);
      bus.emitRenderProgress({
        projectId: project.id,
        phase: "queued",
        progress: 0,
        outputPath: outPath,
      });

      return {
        ok: true,
        summary: `Render request ${taskId} recorded for project "${project.name}" (${profileName}). No renderer is connected; no video file was created.`,
        data: { taskId, projectId: project.id, profile, outputPath: outPath, phase: "queued" },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
  {
    name: "get_render_status",
    description: "Return the current status of a render task.",
    inputSchema: getRenderStatusSchema,
    run: async (raw) => {
      const input = getRenderStatusSchema.parse(raw);
      const task = await readTask(input.taskId);
      if (!task) {
        return { ok: false, summary: `Render task ${input.taskId} not found.`, error: "not-found" } satisfies ToolResult;
      }
      return {
        ok: true,
        summary: `Render ${task.id}: phase=${task.phase}, progress=${(task.progress * 100).toFixed(1)}%`,
        data: task,
      } satisfies ToolResult;
    },
  },
  {
    name: "list_render_tasks",
    description: "List all render tasks (optionally filtered by project id).",
    inputSchema: listRenderTasksSchema,
    run: async (raw) => {
      const input = listRenderTasksSchema.parse(raw);
      const dir = renderTasksDir();
      const entries = await listDir(dir);
      const tasks: RenderTask[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const t = await readJson<RenderTask>(path.join(dir, entry));
        if (!input.id || t.projectId === input.id) tasks.push(t);
      }
      tasks.sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1));
      return {
        ok: true,
        summary: `${tasks.length} render task(s).`,
        data: { tasks },
      } satisfies ToolResult;
    },
  },
];
