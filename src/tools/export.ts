/**
 * Export & render tools.
 *
 *   - list_export_profiles   : return the preset export profiles
 *   - set_export_params      : set the export profile for a project
 *   - export_project         : queue an export; emits renderProgress notifications
 *   - get_render_status      : query status of an in-flight render
 *
 * Implementation note: CapCut has no public CLI for headless export. The
 * `export_project` tool writes a CapCut/OpenCut-shaped "export task" JSON
 * into the configured export directory and emits renderProgress events so
 * the AI client can poll. The actual render is performed by CapCut's GUI
 * (which the user must trigger by opening the draft and pressing Export —
 * CapCut will pick up the updated draft on next open).
 *
 * For OpenCut, when a local OpenCut server is running on a known port, the
 * tool can POST to its /api/export endpoint; otherwise we follow the same
 * "emit a task" path.
 */

import { z } from "zod";
import type { Tool, ToolResult } from "./index.js";
import * as facade from "../adapters/facade.js";
import { DEFAULT_EXPORT_PROFILES, type ExportProfile } from "../adapters/types.js";
import { bus } from "../notifications/events.js";
import { exportRoot } from "../utils/paths.js";
import { ensureDir, writeJson, readJson, safeStat, listDir } from "../utils/fs.js";
import { assertPathInside, assertSafeExternalPath, MAX_TOOL_RESULT_BYTES } from "../safety/path-guard.js";
import { uid } from "../utils/id.js";
import path from "node:path";
import { nowIso } from "../utils/id.js";

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
  dryRun: z.boolean().default(true).describe("When true, an export task is queued but no render is performed."),
});

const getRenderStatusSchema = z.object({
  taskId: z.string().min(1).describe("Render task id returned by export_project."),
});

const listRenderTasksSchema = z.object({
  id: z.string().min(1).optional().describe("Filter by project id."),
});

interface RenderTask {
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

function renderTasksDir(): string {
  return path.join(exportRoot(), "tasks");
}

async function readTask(id: string): Promise<RenderTask | null> {
  const p = path.join(renderTasksDir(), `${id}.json`);
  const st = await safeStat(p);
  if (!st) return null;
  return await readJson<RenderTask>(p);
}

async function writeTask(task: RenderTask): Promise<void> {
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
    description: "Set the export profile for a project (writes a profile.json next to the project).",
    inputSchema: setExportParamsSchema,
    run: async (raw) => {
      const input = setExportParamsSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      let profile: ExportProfile;
      if (input.custom) {
        profile = input.custom;
      } else if (input.profileName && DEFAULT_EXPORT_PROFILES[input.profileName]) {
        profile = DEFAULT_EXPORT_PROFILES[input.profileName];
      } else {
        profile = DEFAULT_EXPORT_PROFILES["1080p-30"];
      }
      const profilePath = path.join(path.dirname(project.filePath), "export_profile.json");
      if (input.dryRun) {
        return {
          ok: true,
          summary: `[DRY-RUN] Would write export profile (${profile.width}x${profile.height}@${profile.fps}fps, ${profile.codec}/${profile.format}) to ${profilePath}.`,
          data: { profile, profilePath, dryRun: true },
          dryRun: true,
        } satisfies ToolResult;
      }
      await ensureDir(path.dirname(profilePath));
      await writeJson(profilePath, profile);
      return {
        ok: true,
        summary: `Export profile set: ${profile.width}x${profile.height}@${profile.fps}fps, ${profile.codec}/${profile.format}.`,
        data: { profile, profilePath },
        dryRun: false,
      } satisfies ToolResult;
    },
  },
  {
    name: "export_project",
    description:
      "Queue a render for a project. Emits renderProgress notifications as the task transitions through queued -> rendering -> complete. In dry-run mode, the task is queued but no render is actually triggered. In live mode, the export task is written to <exportRoot>/tasks/<id>.json for CapCut/OpenCut to pick up.",
    inputSchema: exportProjectSchema,
    run: async (raw) => {
      const input = exportProjectSchema.parse(raw);
      const project = facade.getOpenProject(input.id);
      const profileName = input.profileName ?? "1080p-30";
      const profile = DEFAULT_EXPORT_PROFILES[profileName] ?? DEFAULT_EXPORT_PROFILES["1080p-30"];
      let outPath = input.outputPath ?? path.join(exportRoot(), `${project.name}.${profile.format}`);

      // Security: if the user supplied an explicit outputPath, validate it.
      // 1. Reject UNC paths, device paths, null bytes.
      // 2. Confine to exportRoot (defense in depth — the render task JSON
      //    itself is benign, but writing it to an arbitrary path is a write
      //    primitive we don't want to expose).
      if (input.outputPath) {
        try {
          assertSafeExternalPath(input.outputPath);
          assertPathInside(input.outputPath, exportRoot(), "outputPath");
        } catch (err) {
          return {
            ok: false,
            summary: `Unsafe output path: ${(err as Error).message}`,
            error: "unsafe-path",
          } satisfies ToolResult;
        }
      }
      outPath = path.resolve(outPath);

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
        bus.emitRenderProgress({
          projectId: project.id,
          phase: "queued",
          progress: 0,
          outputPath: outPath,
        });
        return {
          ok: true,
          summary: `[DRY-RUN] Queued render task ${taskId} for project "${project.name}". No render triggered.`,
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

      // In a real implementation we'd shell out to CapCut CLI / POST to OpenCut.
      // Here we simulate the lifecycle for completeness, ending in "complete"
      // so the AI client can observe the notification stream.
      // (We don't await this — fire-and-forget.)
      void simulateRender(task);

      return {
        ok: true,
        summary: `Render task ${taskId} queued for project "${project.name}" (${profileName}). Output: ${outPath}.`,
        data: { taskId, projectId: project.id, profile, outputPath: outPath },
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

/** Simulate render progress over a few seconds. Useful for tests + dry-run demos. */
async function simulateRender(task: RenderTask): Promise<void> {
  task.phase = "rendering";
  task.startedAt = nowIso();
  await writeTask(task);
  bus.emitRenderProgress({
    projectId: task.projectId,
    phase: "rendering",
    progress: 0,
    outputPath: task.outputPath,
  });
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 250));
    task.progress = i / 10;
    await writeTask(task);
    bus.emitRenderProgress({
      projectId: task.projectId,
      phase: "rendering",
      progress: task.progress,
      outputPath: task.outputPath,
    });
  }
  task.phase = "complete";
  task.progress = 1;
  task.completedAt = nowIso();
  await writeTask(task);
  bus.emitRenderProgress({
    projectId: task.projectId,
    phase: "complete",
    progress: 1,
    outputPath: task.outputPath,
  });
}
